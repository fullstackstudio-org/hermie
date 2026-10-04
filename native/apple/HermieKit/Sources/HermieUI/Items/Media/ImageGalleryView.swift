import HermieMarkdown
import SwiftUI

#if os(macOS)
  import AppKit
  import UniformTypeIdentifiers
#endif

/// The full-screen view of a message's pictures: swipe (or the arrow keys, on a Mac) between them,
/// pinch or double tap to zoom, share, and on a Mac save a copy.
///
/// It is presented by the chat screen (`imageGalleryHost`), from the store's `presentation`, and not
/// by the row that was tapped: the list may recycle that row while the gallery is up.
struct ImageGalleryView: View {
  @State private var model: ImageGalleryModel
  let store: MessageImageStore
  let close: () -> Void

  @State private var file: URL?

  init(model: ImageGalleryModel, store: MessageImageStore, close: @escaping () -> Void) {
    _model = State(initialValue: model)
    self.store = store
    self.close = close
  }

  /// The pictures are decoded at most this large (the longer side, in pixels).
  static let fullPixels = 3072

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      pages
    }
    .overlay(alignment: .top) { chrome }
    .preferredColorScheme(.dark)
    .task(id: model.current?.reference) {
      file = nil
      guard let reference = model.current?.reference else { return }
      file = await store.file(reference)
    }
    .task(id: model.index) {
      // The neighbours decode while the reader looks at this one, so a swipe lands on a picture.
      for index in model.preload where index != model.index {
        _ = await store.image(model.images[index].reference, maxPixel: Self.fullPixels)
      }
    }
    #if os(macOS)
      .frame(minWidth: 520, idealWidth: 880, minHeight: 420, idealHeight: 660)
      .focusable()
      .focusEffectDisabled()
      .onKeyPress(.leftArrow) { model.previous() ? .handled : .ignored }
      .onKeyPress(.rightArrow) { model.next() ? .handled : .ignored }
      .onExitCommand(perform: close)
    #endif
  }

  // MARK: Pages

  private var selection: Binding<Int> {
    Binding(get: { model.index }, set: { model.select($0) })
  }

  @ViewBuilder private var pages: some View {
    #if os(iOS)
      TabView(selection: selection) {
        ForEach(Array(model.images.enumerated()), id: \.element.id) { index, image in
          ImageGalleryPage(image: image, store: store, pixels: Self.fullPixels)
            .tag(index)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .ignoresSafeArea()
    #else
      if let image = model.current {
        ImageGalleryPage(image: image, store: store, pixels: Self.fullPixels)
          .id(image.id)
      }
    #endif
  }

  // MARK: Chrome

  private var chrome: some View {
    HStack(spacing: 12) {
      Button(action: close) {
        Label(Strings.Chat.Viewer.close, systemImage: "xmark")
          .labelStyle(.iconOnly)
          .font(.body.weight(.semibold))
          .frame(width: 36, height: 36)
          .background(.ultraThinMaterial, in: Circle())
      }
      .buttonStyle(.plain)
      .keyboardShortcut(.cancelAction)
      .accessibilityIdentifier("hermie.gallery.close")

      Spacer(minLength: 0)

      if let position = model.position {
        Text(NativeStrings.Media.position(current: position.current, total: position.total))
          .font(.subheadline.weight(.medium).monospacedDigit())
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(.ultraThinMaterial, in: Capsule())
          .accessibilityIdentifier("hermie.gallery.position")
      }

      Spacer(minLength: 0)

      #if os(macOS)
        if model.hasPrevious || model.hasNext {
          stepButton("chevron.left", enabled: model.hasPrevious) { model.previous() }
          stepButton("chevron.right", enabled: model.hasNext) { model.next() }
        }
        Button(action: save) {
          Label(Strings.Chat.Viewer.download, systemImage: "arrow.down.to.line")
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .frame(width: 36, height: 36)
            .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(file == nil)
      #endif

      if let file {
        ShareLink(item: file) {
          Label(Strings.Chat.Viewer.share, systemImage: "square.and.arrow.up")
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .frame(width: 36, height: 36)
            .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
      } else {
        Color.clear.frame(width: 36, height: 36)
      }
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  #if os(macOS)
    private func stepButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
      Button(action: action) {
        Image(systemName: symbol)
          .font(.body.weight(.semibold))
          .frame(width: 36, height: 36)
          .background(.ultraThinMaterial, in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!enabled)
    }

    /// Saves a copy of the picture where the reader chooses.
    private func save() {
      guard let file, let name = model.current?.name else { return }
      let panel = NSSavePanel()
      panel.nameFieldStringValue = name
      if let type = UTType(filenameExtension: file.pathExtension) { panel.allowedContentTypes = [type] }
      guard panel.runModal() == .OK, let destination = panel.url else { return }
      try? FileManager.default.removeItem(at: destination)
      try? FileManager.default.copyItem(at: file, to: destination)
    }
  #endif
}

/// One picture of the gallery, fitted to the screen, with pinch, pan and double tap.
struct ImageGalleryPage: View {
  let image: MessageImage
  let store: MessageImageStore
  let pixels: Int

  @State private var data: MediaImageData?
  @State private var failed = false
  @State private var zoom = ImageZoom()
  @State private var scaleAtGestureStart: CGFloat = 1
  @State private var offsetAtGestureStart: CGSize = .zero

  init(image: MessageImage, store: MessageImageStore, pixels: Int) {
    self.image = image
    self.store = store
    self.pixels = pixels
    _data = State(initialValue: store.cached(image.reference, maxPixel: pixels))
  }

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        if let data {
          picture(data, in: proxy.size)
        } else if failed {
          VStack(spacing: 8) {
            Image(systemName: "photo")
              .font(.largeTitle)
            Text(image.name)
              .font(.callout)
              .multilineTextAlignment(.center)
            Text(NativeStrings.Media.unavailable)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          .foregroundStyle(.white)
          .padding()
        } else {
          ProgressView()
            .tint(.white)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(image.label)
    .accessibilityAddTraits(.isImage)
    .task(id: image.reference) {
      guard data == nil else { return }
      if let loaded = await store.image(image.reference, maxPixel: pixels) {
        data = loaded
      } else {
        failed = true
      }
    }
  }

  private func picture(_ data: MediaImageData, in container: CGSize) -> some View {
    let fitted = MediaImageLayout.fitted(aspect: data.aspect, in: container)
    return Image(decorative: data.image, scale: 1)
      .resizable()
      .scaledToFit()
      .frame(width: fitted.width, height: fitted.height)
      .scaleEffect(zoom.scale)
      .offset(zoom.offset)
      .frame(width: container.width, height: container.height)
      .contentShape(Rectangle())
      .gesture(
        MagnifyGesture()
          .onChanged { value in
            zoom.setScale(scaleAtGestureStart * value.magnification)
            zoom.offset = ImageZoom.clampedOffset(zoom.offset, scale: zoom.scale, fitted: fitted, container: container)
          }
          .onEnded { _ in
            scaleAtGestureStart = zoom.scale
            offsetAtGestureStart = zoom.offset
          }
      )
      // Panning only while zoomed in, so a swipe at rest still pages to the next picture.
      .gesture(
        DragGesture()
          .onChanged { value in
            let proposed = CGSize(
              width: offsetAtGestureStart.width + value.translation.width,
              height: offsetAtGestureStart.height + value.translation.height)
            zoom.offset = ImageZoom.clampedOffset(proposed, scale: zoom.scale, fitted: fitted, container: container)
          }
          .onEnded { _ in offsetAtGestureStart = zoom.offset },
        isEnabled: zoom.isZoomed
      )
      .onTapGesture(count: 2) {
        withAnimation(.snappy(duration: 0.25)) {
          zoom.toggle()
        }
        scaleAtGestureStart = zoom.scale
        offsetAtGestureStart = zoom.offset
      }
  }
}

// MARK: - Presenting

/// Shows the gallery over the chat when the store has one to show: full screen on a phone, a sheet on
/// a Mac.
struct ImageGalleryHost: ViewModifier {
  let store: MessageImageStore?

  private var presentation: Binding<MessageImageStore.Presentation?> {
    Binding(
      get: { store?.presentation },
      set: { if $0 == nil { store?.dismissGallery() } })
  }

  func body(content: Content) -> some View {
    #if os(iOS)
      content.fullScreenCover(item: presentation) { presented in gallery(presented) }
    #else
      content.sheet(item: presentation) { presented in gallery(presented) }
    #endif
  }

  @ViewBuilder private func gallery(_ presented: MessageImageStore.Presentation) -> some View {
    if let store {
      ImageGalleryView(model: presented.model, store: store) { store.dismissGallery() }
    }
  }
}

extension View {
  /// Presents the pictures of the chat's messages full screen when one is tapped. A chat without a
  /// store (a lab, a preview) has nothing to present.
  func imageGalleryHost(_ store: MessageImageStore?) -> some View {
    modifier(ImageGalleryHost(store: store))
  }
}
