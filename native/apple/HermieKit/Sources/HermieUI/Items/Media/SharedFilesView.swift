import HermieCore
import HermieMarkdown
import HermieTranscript
import PDFKit
import SwiftUI

/// The files a bot shared with a reply, under its words (`contract/outbox/`): the pictures together as the
/// message's grid, then one card for each of the others, in the order they were shared.
///
/// - an image is a thumbnail that opens the gallery (the same one the message's other pictures use);
/// - a sound is a compact row with a scrubber, a video a poster that plays full screen, a PDF a card that
///   opens the app's own viewer;
/// - anything else is a chip with a Save button: it is saved deliberately and never opened here.
///
/// A row outside a chat screen (a lab, a preview) has no `OutboxMedia`: every file is a plain chip.
struct SharedFilesView: View {
  let attachments: [OutboxAttachment]
  let media: OutboxMedia?
  let images: MessageImageStore?

  private let pictures: [OutboxAttachment]
  private let others: [OutboxAttachment]

  init(attachments: [OutboxAttachment], media: OutboxMedia?, images: MessageImageStore?) {
    self.attachments = attachments
    self.media = media
    self.images = images
    let layout = OutboxPresentation.layout(attachments)
    // Without a store a picture cannot be drawn: it is a chip like the rest.
    self.pictures = images == nil ? [] : layout.pictures
    self.others = images == nil ? attachments : layout.others
    // A picture has to be known to the store before a frame asks for it.
    images?.register(outbox: self.pictures, files: media?.files)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let images, !pictures.isEmpty {
        MessageImageGrid(images: pictures.map(MessageImageStore.image(for:)), store: images)
      }
      ForEach(others) { attachment in
        OutboxCard(attachment: attachment, media: media)
      }
    }
    .accessibilityElement(children: .contain)
  }
}

/// One shared file as the card of its kind.
struct OutboxCard: View {
  let attachment: OutboxAttachment
  let media: OutboxMedia?

  var body: some View {
    switch (OutboxPresentation.card(for: attachment), media) {
    case (.audio, let media?):
      OutboxAudioRow(attachment: attachment, playback: media.playback.playback(for: attachment))
    case (.video, let media?):
      OutboxVideoCard(attachment: attachment, media: media)
    case (.document, let media?):
      OutboxPDFCard(attachment: attachment, media: media)
    default:
      OutboxFileChip(attachment: attachment, media: media)
    }
  }
}

// MARK: - Shared pieces

/// What a card says about the file under its name: its size, or how it is doing.
enum OutboxStatus {
  /// The line under a name, for `state`.
  static func line(_ state: OutboxFileState, size: Int, saveFailed: Bool = false) -> String {
    if saveFailed { return NativeStrings.Outbox.saveFailed }
    switch state {
    case .idle, .ready: return OutboxPresentation.sizeText(size)
    case .loading(let progress):
      if let progress { return NativeStrings.Outbox.downloading(percent: Int((progress * 100).rounded())) }
      return NativeStrings.Outbox.downloading
    case .gone: return NativeStrings.Outbox.gone
    case .tooLarge: return "\(NativeStrings.Outbox.tooLarge) · \(OutboxPresentation.sizeText(size))"
    case .failed: return NativeStrings.Outbox.failed
    }
  }

  /// The line under a sound or a video, for `phase`.
  static func line(_ phase: MediaPlayback.Phase, size: Int) -> String {
    switch phase {
    case .idle, .preparing, .ready: OutboxPresentation.sizeText(size)
    case .gone: NativeStrings.Outbox.gone
    case .tooLarge: "\(NativeStrings.Outbox.tooLarge) · \(OutboxPresentation.sizeText(size))"
    case .failed: NativeStrings.Outbox.failed
    }
  }
}

/// How far a file is on its way: a small ring, or a spinner while the total is not known.
private struct OutboxProgress: View {
  let progress: Double?

  var body: some View {
    Group {
      if let progress {
        ProgressView(value: progress)
          .progressViewStyle(.circular)
      } else {
        ProgressView()
      }
    }
    .controlSize(.small)
    .frame(width: 28, height: 28)
    .accessibilityLabel(
      progress.map { NativeStrings.Outbox.downloading(percent: Int(($0 * 100).rounded())) }
        ?? NativeStrings.Outbox.downloading)
  }
}

/// The name as the person reads it: verbatim, without control and format characters.
private func shownName(_ attachment: OutboxAttachment) -> String {
  OutboxText.displayName(attachment.name)
}

extension View {
  /// A control a finger can hit: at least 44 points tall on a phone or an iPad; a pointer needs less.
  fileprivate func fingerSized() -> some View {
    #if os(iOS)
      frame(minHeight: 44)
    #else
      self
    #endif
  }
}

// MARK: - A file to save

/// Any file that is not a picture, a sound, a video or a PDF (HTML, SVG, scripts, archives, documents): its
/// name verbatim, its size and a Save button. The bytes are fetched when the person asks, kept in a temporary
/// file and handed to a save panel or the share sheet; the app never opens, previews or runs them.
struct OutboxFileChip: View {
  let attachment: OutboxAttachment
  let media: OutboxMedia?

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let model = media?.files.model(for: attachment)
    let state = model?.state ?? .idle
    let saveFailed = media?.didFailToSave(attachment.id) ?? false
    let status = OutboxStatus.line(state, size: attachment.size, saveFailed: saveFailed)

    HStack(spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: OutboxPresentation.symbol(forName: attachment.name))
          .font(.title3)
          .frame(width: 28)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: shownName(attachment))
            .font(.callout)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .truncationMode(.middle)
          Text(verbatim: status)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(NativeStrings.Outbox.file(name: shownName(attachment)))
      .accessibilityValue(status)

      Spacer(minLength: 8)

      if let model {
        action(for: model, state: state)
      }
    }
    .cardSurface()
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private func action(for model: OutboxFileModel, state: OutboxFileState) -> some View {
    switch state {
    case .loading(let progress):
      OutboxProgress(progress: progress)
    case .gone, .tooLarge:
      EmptyView()
    case .failed:
      Button(NativeStrings.Outbox.retry) { model.retry() }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .fingerSized()
    case .idle, .ready:
      Button(NativeStrings.Outbox.save) { save(model) }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .fingerSized()
        .accessibilityHint(NativeStrings.Outbox.saveHint)
    }
  }

  private func save(_ model: OutboxFileModel) {
    let media = self.media
    let attachment = self.attachment

    Task {
      guard case .ready(let url) = await model.ensure() else { return }
      media?.save(url, token: attachment.id, name: attachment.name)
    }
  }
}

// MARK: - A sound

/// A sound: a play button, the name, a scrubber and the time. The player is made when the row appears (the length
/// is read), and plays only when asked; starting it pauses whatever else played in the chat.
struct OutboxAudioRow: View {
  let attachment: OutboxAttachment
  let playback: MediaPlayback

  @State private var scrubbing: Double?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let ready = playback.phase == .ready
    let total = max(playback.duration ?? 0, 0)
    let shown = scrubbing ?? playback.position

    HStack(spacing: 10) {
      Button(action: playback.toggle) {
        Image(systemName: playback.isPlaying ? "pause.circle.fill" : "play.circle.fill")
          .font(.system(size: 32))
          .frame(width: 44, height: 44)
          .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .disabled(playback.phase == .gone || playback.phase == .tooLarge)
      .accessibilityLabel(playback.isPlaying ? NativeStrings.Outbox.pause : NativeStrings.Outbox.play)

      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: shownName(attachment))
          .font(.callout)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
          .truncationMode(.middle)

        if ready {
          HStack(spacing: 8) {
            Slider(
              value: Binding(get: { shown }, set: { scrubbing = $0 }),
              in: 0...max(total, 0.1)
            ) { editing in
              if !editing, let target = scrubbing {
                playback.seek(to: target)
                scrubbing = nil
              }
            }
            .controlSize(.small)
            .accessibilityLabel(NativeStrings.Outbox.position)
            .accessibilityValue("\(OutboxPresentation.clock(shown)) / \(OutboxPresentation.clock(total))")

            Text(verbatim: "\(OutboxPresentation.clock(shown)) / \(OutboxPresentation.clock(total))")
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
              .fixedSize()
              .accessibilityHidden(true)
          }
        } else {
          Text(verbatim: OutboxStatus.line(playback.phase, size: attachment.size))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if playback.phase == .failed {
        Button(NativeStrings.Outbox.retry) { playback.retry() }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .fingerSized()
      }
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quaternary, in: .rect(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(NativeStrings.Outbox.audio(name: shownName(attachment)))
    .task { await playback.prepare() }
  }
}

// MARK: - A video

/// A video: its first frame with a play button, the name and the size. Tapping it plays the video full screen
/// (`outboxHost`); nothing plays inline, so a transcript of videos does not hold a player for each.
struct OutboxVideoCard: View {
  let attachment: OutboxAttachment
  let media: OutboxMedia

  var body: some View {
    let playback = media.playback.playback(for: attachment)

    Button(action: { open(playback) }) {
      ZStack {
        Rectangle().fill(.black.opacity(0.78))

        if let poster = playback.poster {
          Image(decorative: poster, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fill)
        }

        centre(playback)
      }
      .aspectRatio(16.0 / 9.0, contentMode: .fit)
      .frame(maxWidth: .infinity)
      .overlay(alignment: .bottomLeading) { caption(playback) }
      .clipShape(RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous)
          .strokeBorder(.foreground.opacity(0.12), lineWidth: 0.5)
      }
      .contentShape(RoundedRectangle(cornerRadius: MediaImageLayout.cornerRadius, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(playback.phase == .gone || playback.phase == .tooLarge)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(NativeStrings.Outbox.video(name: shownName(attachment)))
    .accessibilityValue(OutboxStatus.line(playback.phase, size: attachment.size))
    .accessibilityHint(NativeStrings.Outbox.openVideoHint)
    .accessibilityAddTraits(.isButton)
    .task { await playback.loadPoster() }
  }

  private func open(_ playback: MediaPlayback) {
    if playback.phase == .failed { playback.retry() }
    media.playback.present(video: playback)
  }

  @ViewBuilder private func centre(_ playback: MediaPlayback) -> some View {
    switch playback.phase {
    case .gone, .tooLarge, .failed:
      VStack(spacing: 4) {
        Image(systemName: "film")
          .font(.title2)
        Text(verbatim: OutboxStatus.line(playback.phase, size: attachment.size))
          .font(.caption)
          .multilineTextAlignment(.center)
        if playback.phase == .failed {
          Text(NativeStrings.Outbox.retryHint)
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.7))
        }
      }
      .foregroundStyle(.white)
      .padding(8)
    case .idle, .preparing:
      if playback.poster == nil {
        ProgressView().tint(.white)
      } else {
        playGlyph
      }
    case .ready:
      playGlyph
    }
  }

  private var playGlyph: some View {
    Image(systemName: "play.fill")
      .font(.title2)
      .foregroundStyle(.white)
      .frame(width: 52, height: 52)
      .background(.ultraThinMaterial, in: Circle())
  }

  private func caption(_ playback: MediaPlayback) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(verbatim: shownName(attachment))
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .truncationMode(.middle)
      Text(verbatim: playback.duration.map(OutboxPresentation.clock) ?? OutboxPresentation.sizeText(attachment.size))
        .font(.caption2.monospacedDigit())
    }
    .foregroundStyle(.white)
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom))
  }
}

// MARK: - A PDF

/// A PDF: an icon, its name, its size and (once it is loaded) its page count. Tapping it fetches it if need be and
/// opens the app's own viewer (`outboxHost`); a small one is fetched when the card appears.
struct OutboxPDFCard: View {
  let attachment: OutboxAttachment
  let media: OutboxMedia

  @State private var pages: Int?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let model = media.files.model(for: attachment)
    let state = model.state
    let status = OutboxStatus.line(state, size: attachment.size)
    let detail = state == .idle || isReady(state) ? subtitle : status

    Button(action: { open(model) }) {
      HStack(spacing: 10) {
        Image(systemName: "doc.richtext.fill")
          .font(.title2)
          .foregroundStyle(.red)
          .frame(width: 28)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: shownName(attachment))
            .font(.callout)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .truncationMode(.middle)
          Text(verbatim: detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
        Spacer(minLength: 8)
        trailing(state)
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .cardSurface()
    .disabled(state == .gone || state == .tooLarge)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(NativeStrings.Outbox.pdf(name: shownName(attachment)))
    .accessibilityValue(detail)
    .accessibilityHint(NativeStrings.Outbox.openPdfHint)
    .accessibilityAddTraits(.isButton)
    .task {
      if OutboxPresentation.fetchesOnAppear(attachment) { model.load() }
    }
    .task(id: model.fileURL) {
      guard let url = model.fileURL else { return }
      pages = await PDFPages.count(at: url)
    }
  }

  private func isReady(_ state: OutboxFileState) -> Bool {
    if case .ready = state { return true }
    return false
  }

  /// "48 KB · 12 pages": the page count once the file is loaded.
  private var subtitle: String {
    var parts = [OutboxPresentation.sizeText(attachment.size)]
    if let pages { parts.append(NativeStrings.Outbox.pages(pages)) }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder private func trailing(_ state: OutboxFileState) -> some View {
    switch state {
    case .loading(let progress):
      OutboxProgress(progress: progress)
    case .failed:
      Text(NativeStrings.Outbox.retry)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.tint)
    case .gone, .tooLarge:
      EmptyView()
    case .idle, .ready:
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
  }

  private func open(_ model: OutboxFileModel) {
    let media = self.media

    Task {
      if model.state == .failed { model.retry() }
      guard case .ready = await model.ensure() else { return }
      media.present(pdf: model)
    }
  }
}

/// The page count of a PDF on disk, read off the main actor.
enum PDFPages {
  static func count(at url: URL) async -> Int? {
    await Task.detached(priority: .utility) {
      PDFDocument(url: url).map(\.pageCount)
    }.value
  }
}
