import AVKit
import HermieCore
import HermieMarkdown
import HermieTranscript
import PDFKit
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

// What goes up over the chat for a file a bot shared: a video full screen, a PDF in the app's own viewer, and
// on a phone the share sheet (where Save to Files is). They are presented by the chat screen (`outboxHost`),
// from `OutboxMedia`, and not by the row that was tapped: the list may recycle that row while a viewer is up.

// MARK: - Video

/// A video full screen, played by the system's player from the gateway as it is read.
struct OutboxVideoScreen: View {
  let playback: MediaPlayback
  let close: () -> Void

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      switch playback.phase {
      case .gone, .tooLarge, .failed:
        VStack(spacing: 10) {
          Image(systemName: "film")
            .font(.largeTitle)
          Text(verbatim: OutboxStatus.line(playback.phase, size: playback.attachment.size))
            .font(.callout)
          if playback.phase == .failed {
            Button(NativeStrings.Outbox.retry) {
              playback.retry()
              Task { await playback.play() }
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .foregroundStyle(.white)
        .padding()
      case .idle, .preparing, .ready:
        if let player = playback.player {
          VideoPlayer(player: player)
            .ignoresSafeArea()
            .accessibilityLabel(NativeStrings.Outbox.video(name: OutboxText.displayName(playback.attachment.name)))
        } else {
          ProgressView().tint(.white)
        }
      }
    }
    .overlay(alignment: .topLeading) {
      Button(action: close) {
        Label(NativeStrings.Outbox.close, systemImage: "xmark")
          .labelStyle(.iconOnly)
          .font(.body.weight(.semibold))
          .frame(width: 36, height: 36)
          .background(.ultraThinMaterial, in: Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.white)
      .keyboardShortcut(.cancelAction)
      .padding(.horizontal, 16)
      .padding(.top, 8)
    }
    .preferredColorScheme(.dark)
    .task { await playback.play() }
    #if os(macOS)
      .frame(minWidth: 520, idealWidth: 880, minHeight: 340, idealHeight: 520)
      .onExitCommand(perform: close)
    #endif
  }
}

// MARK: - PDF

/// A PDF in PDFKit's own viewer, with Share (and, on a Mac, Save). The file is the one already fetched; nothing here
/// loads a web page, and the document is never given the app's credentials.
struct OutboxPDFViewer: View {
  let model: OutboxFileModel
  let media: OutboxMedia
  let close: () -> Void

  var body: some View {
    let name = OutboxText.displayName(model.attachment.name)

    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button(action: close) {
          Label(NativeStrings.Outbox.close, systemImage: "xmark")
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .frame(width: 36, height: 36)
            .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.cancelAction)

        Text(verbatim: name)
          .font(.headline)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: .infinity, alignment: .leading)

        if let url = model.fileURL {
          #if os(macOS)
            Button {
              media.save(url, token: model.attachment.id, name: model.attachment.name)
            } label: {
              Label(NativeStrings.Outbox.save, systemImage: "arrow.down.to.line")
                .labelStyle(.iconOnly)
                .font(.body.weight(.semibold))
                .frame(width: 36, height: 36)
                .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(NativeStrings.Outbox.saveHint)
          #endif

          ShareLink(item: url) {
            Label(NativeStrings.Outbox.share, systemImage: "square.and.arrow.up")
              .labelStyle(.iconOnly)
              .font(.body.weight(.semibold))
              .frame(width: 36, height: 36)
              .background(.ultraThinMaterial, in: Circle())
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)

      Divider()

      if let url = model.fileURL {
        PDFKitView(url: url)
          .accessibilityLabel(NativeStrings.Outbox.pdf(name: name))
      } else {
        Spacer()
        Text(verbatim: OutboxStatus.line(model.state, size: model.attachment.size))
          .foregroundStyle(.secondary)
        Spacer()
      }
    }
    #if os(macOS)
      .frame(minWidth: 560, idealWidth: 820, minHeight: 480, idealHeight: 720)
    #endif
  }
}

/// Where a link in a bot's PDF may go: the schemes a link in a message may leave the app through
/// (`MarkdownInline.openableSchemes`: web, mail, phone), and nothing else. A PDF is the bot's document; a link in it
/// to `file:`, another app's scheme or anything else is not followed. A link to a page of the document itself is
/// PDFKit's own, and never comes here.
@MainActor
final class OutboxPDFLinks: NSObject, PDFViewDelegate {
  /// Opens an address that passed (the environment's `openURL`, as a link in a message is opened).
  var open: (URL) -> Void

  init(open: @escaping (URL) -> Void) {
    self.open = open
  }

  /// Whether a link to `url` in a shared PDF is followed.
  nonisolated static func allows(_ url: URL) -> Bool {
    MarkdownInline.isOpenable(url)
  }

  /// PDFKit asks before it follows a link out of the document; implementing this replaces its own opening.
  nonisolated func pdfViewWillClick(onLink sender: PDFView, with url: URL) {
    guard Self.allows(url) else { return }
    MainActor.assumeIsolated { open(url) }
  }
}

/// PDFKit's view of one document: continuous scrolling, scaled to the width, links held to `OutboxPDFLinks`.
#if os(iOS)
  struct PDFKitView: UIViewRepresentable {
    let url: URL
    @Environment(\.openURL) private var openURL

    func makeCoordinator() -> OutboxPDFLinks {
      OutboxPDFLinks { _ in }
    }

    func makeUIView(context: Context) -> PDFView {
      let view = PDFView()
      view.autoScales = true
      view.displayMode = .singlePageContinuous
      view.displayDirection = .vertical
      context.coordinator.open = { openURL($0) }
      view.delegate = context.coordinator
      view.document = PDFDocument(url: url)
      return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
      context.coordinator.open = { openURL($0) }
      if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
  }
#else
  struct PDFKitView: NSViewRepresentable {
    let url: URL
    @Environment(\.openURL) private var openURL

    func makeCoordinator() -> OutboxPDFLinks {
      OutboxPDFLinks { _ in }
    }

    func makeNSView(context: Context) -> PDFView {
      let view = PDFView()
      view.autoScales = true
      view.displayMode = .singlePageContinuous
      view.displayDirection = .vertical
      context.coordinator.open = { openURL($0) }
      view.delegate = context.coordinator
      view.document = PDFDocument(url: url)
      return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
      context.coordinator.open = { openURL($0) }
      if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
  }
#endif

// MARK: - The share sheet

#if os(iOS)
  /// The system's share sheet for one file: where Save to Files is. The file is handed over, never opened.
  struct ActivitySheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
      UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
  }
#endif

// MARK: - Presenting

/// Shows what the chat's shared files bring up: a video full screen on a phone (a sheet on a Mac), a PDF in a
/// sheet, and on a phone the share sheet.
struct OutboxHost: ViewModifier {
  let media: OutboxMedia?

  private var video: Binding<MediaPlayback?> {
    Binding(
      get: { media?.playback.video },
      set: { if $0 == nil { media?.playback.dismissVideo() } })
  }

  private var pdf: Binding<OutboxFileModel?> {
    Binding(get: { media?.pdf }, set: { media?.pdf = $0 })
  }

  func body(content: Content) -> some View {
    content
      .modifier(VideoPresentation(media: media, video: video))
      .sheet(item: pdf) { model in
        if let media {
          OutboxPDFViewer(model: model, media: media) { media.pdf = nil }
        }
      }
      #if os(iOS)
        .sheet(
          item: Binding(get: { media?.shared }, set: { media?.shared = $0 })
        ) { shared in
          ActivitySheet(url: shared.url)
            .presentationDetents([.medium, .large])
        }
      #endif
  }
}

private struct VideoPresentation: ViewModifier {
  let media: OutboxMedia?
  let video: Binding<MediaPlayback?>

  func body(content: Content) -> some View {
    #if os(iOS)
      content.fullScreenCover(item: video) { playback in screen(playback) }
    #else
      content.sheet(item: video) { playback in screen(playback) }
    #endif
  }

  @ViewBuilder private func screen(_ playback: MediaPlayback) -> some View {
    OutboxVideoScreen(playback: playback) { media?.playback.dismissVideo() }
  }
}

extension View {
  /// Presents the files the chat's bot shared when one asks: a video full screen, a PDF, the share sheet. A chat
  /// without them (a lab, a preview) has nothing to present.
  func outboxHost(_ media: OutboxMedia?) -> some View {
    modifier(OutboxHost(media: media))
  }
}
