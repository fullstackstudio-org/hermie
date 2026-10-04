import HermieMarkdown
import SwiftUI

/// The pictures of one message, in the frames `MediaImageLayout` gives them.
///
/// The frames are decided by the number of pictures and the room alone, so the block has the same
/// size while pictures load, when they have, and when one fails: nothing in the row moves. A tap on
/// a picture opens the gallery over the whole message's pictures, on that one.
struct MessageImageGrid: View {
  let images: [MessageImage]
  let store: MessageImageStore

  var body: some View {
    let visible = MediaImageLayout.visibleCount(images.count)
    let nominal = MediaImageLayout.plan(count: images.count, width: nil)

    MediaGridLayout(count: images.count) {
      ForEach(0..<visible, id: \.self) { index in
        MessageImageCell(
          image: images[index], store: store, frame: nominal.cells[index].rect.size,
          fills: nominal.columns > 1, overflow: nominal.cells[index].overflow
        ) {
          store.present(images, at: index)
        }
      }
    }
    .accessibilityElement(children: .contain)
  }
}

/// Places a message's frames: sizes and positions from `MediaImageLayout.plan`, whatever the pictures
/// are.
struct MediaGridLayout: Layout {
  var count: Int

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    MediaImageLayout.plan(count: count, width: proposal.width).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let plan = MediaImageLayout.plan(count: count, width: bounds.width)
    for (cell, subview) in zip(plan.cells, subviews) {
      subview.place(
        at: CGPoint(x: bounds.minX + cell.rect.minX, y: bounds.minY + cell.rect.minY), anchor: .topLeading,
        proposal: ProposedViewSize(cell.rect.size))
    }
  }
}

/// One frame: a tinted surface from the first moment, the thumbnail when it is decoded, a name and an
/// icon when the picture cannot be had.
struct MessageImageCell: View {
  let image: MessageImage
  let store: MessageImageStore
  /// The frame's nominal size, which decides how large a thumbnail to decode.
  let frame: CGSize
  /// Filled and cropped (a grid) rather than fitted (a lone picture).
  let fills: Bool
  /// On the last frame of a message with more pictures than frames: how many it stands for.
  let overflow: Int?
  let open: () -> Void

  enum Phase {
    case loading
    case loaded(MediaImageData)
    case failed
  }

  @Environment(\.transcriptItemActions) private var actions
  @State private var phase: Phase
  @State private var attempt = 0

  /// A thumbnail is decoded for a 3x screen at the nominal frame: a little more than a 2x screen
  /// needs, and one cache entry whatever the device.
  private var pixels: Int { MediaImageLayout.thumbnailPixels(for: frame, scale: 3) }

  init(
    image: MessageImage, store: MessageImageStore, frame: CGSize, fills: Bool, overflow: Int?, open: @escaping () -> Void
  ) {
    self.image = image
    self.store = store
    self.frame = frame
    self.fills = fills
    self.overflow = overflow
    self.open = open
    // A picture already decoded draws on the first frame: a row that comes back into view has no
    // placeholder to flash.
    let pixels = MediaImageLayout.thumbnailPixels(for: frame, scale: 3)
    if let hit = store.cached(image.reference, maxPixel: pixels) {
      _phase = State(initialValue: .loaded(hit))
    } else {
      _phase = State(initialValue: .loading)
    }
  }

  var body: some View {
    Button(action: tap) {
      surface
        .overlay {
          if let overflow {
            Text(verbatim: "+\(overflow)")
              .font(.title3.weight(.semibold))
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .background(.black.opacity(0.45))
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous)
            .strokeBorder(.foreground.opacity(0.12), lineWidth: 0.5)
        }
        .contentShape(RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(overflow.map { NativeStrings.Media.more(count: $0) } ?? image.label)
    .accessibilityAddTraits(.isImage)
    .accessibilityHint(Strings.Chat.Viewer.openHint)
    .task(id: "\(image.reference)#\(attempt)") {
      if case .loaded = phase { return }
      phase = .loading
      if let data = await store.image(image.reference, maxPixel: pixels) {
        phase = .loaded(data)
      } else {
        phase = .failed
      }
    }
  }

  private func tap() {
    if case .failed = phase {
      // The same line over the chat as before pictures had frames (why it cannot be opened), and
      // another try at the thumbnail.
      actions.openAttachment(image.reference)
      store.retry(image.reference)
      attempt += 1
    } else {
      open()
    }
  }

  private var surface: some View {
    Color.clear
      .background(.foreground.opacity(0.12))
      .overlay {
        switch phase {
        case .loading:
          EmptyView()
        case .loaded(let data):
          Color.clear.overlay {
            Image(decorative: data.image, scale: 1)
              .resizable()
              .aspectRatio(contentMode: fills ? .fill : .fit)
          }
          .clipped()
        case .failed:
          VStack(spacing: 4) {
            Image(systemName: "photo")
              .font(.title3)
            Text(image.name)
              .font(.caption2)
              .lineLimit(2)
              .truncationMode(.middle)
            if !fills {
              Text(NativeStrings.Media.unavailable)
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
          .multilineTextAlignment(.center)
          .padding(6)
        }
      }
  }
}
