import HermieCore
import ImageIO
import SwiftUI

/// The attachments staged for the next message, above the message field: a thumbnail for a
/// picture, a card for a file, each with a way to take it out again, the progress of its upload,
/// and, when it did not go, why and a button to try again.
///
/// A message waits for every chip to be ready (`ComposerModel.canSubmit`): what is shown here is
/// what goes.
struct AttachmentStrip: View {
  let tray: AttachmentTray

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 10) {
        ForEach(tray.items) { item in
          AttachmentChip(
            item: item,
            onRemove: { tray.remove(item.id) },
            onRetry: { tray.retry(item.id) }
          )
        }
      }
      // Room for the remove badges that overhang a thumbnail's corner.
      .padding(.top, 8)
      .padding(.trailing, 8)
    }
    .scrollClipDisabled()
    .accessibilityElement(children: .contain)
    .accessibilityLabel(NativeStrings.Composer.Attach.list)
    .accessibilityIdentifier("composer.attachments")
  }
}

/// One staged attachment.
struct AttachmentChip: View {
  let item: StagedAttachment
  let onRemove: () -> Void
  let onRetry: () -> Void

  @ScaledMetric(relativeTo: .body) private var side: CGFloat = 60
  @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 44

  /// A picture that is read or ready is a thumbnail on its own; a file, and anything that failed
  /// (it has something to say), is a card.
  private var isThumbnail: Bool { item.kind == .image && item.status != .failed && item.previewURL != nil }

  var body: some View {
    Group {
      if isThumbnail {
        thumbnail
      } else {
        card
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.name)
    .accessibilityValue(Self.spokenStatus(item))
    .accessibilityAction(named: Text(NativeStrings.Composer.Attach.remove(name: item.name)), onRemove)
    .accessibilityActions {
      if item.status == .failed, item.problem?.isRetryable ?? true {
        Button(NativeStrings.Composer.Attach.retry(name: item.name), action: onRetry)
      }
    }
    .accessibilityIdentifier("composer.attachment.\(item.id)")
  }

  // MARK: A picture

  private var thumbnail: some View {
    ZStack {
      if let url = item.previewURL {
        AttachmentThumbnail(url: url, side: side, corner: 14)
      }

      if item.status == .working {
        Color.black.opacity(0.35).clipShape(.rect(cornerRadius: 14))
        ProgressView().controlSize(.small).tint(.white)
      }
    }
    .frame(width: side, height: side)
    .overlay(alignment: .topTrailing) {
      removeBadge
    }
  }

  private var removeBadge: some View {
    Button(action: onRemove) {
      Image(systemName: "xmark.circle.fill")
        .symbolRenderingMode(.palette)
        .foregroundStyle(.white, Color.black.opacity(0.65))
        .font(.system(size: 22))
        // The visible glyph is small; the target around it is a finger's.
        .padding(11)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .offset(x: 16, y: -16)
    .accessibilityHidden(true)
  }

  // MARK: A file, or anything that did not go

  private var card: some View {
    HStack(spacing: 10) {
      leading

      VStack(alignment: .leading, spacing: 2) {
        Text(item.name)
          .font(.footnote.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)
        Text(Self.statusText(item))
          .font(.caption2)
          .foregroundStyle(item.status == .failed ? AnyShapeStyle(Self.failureColour) : AnyShapeStyle(.secondary))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if item.status == .failed, item.problem?.isRetryable ?? true {
        Button(action: onRetry) {
          Image(systemName: "arrow.clockwise")
            .font(.body.weight(.semibold))
            .frame(width: 36, height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHidden(true)
      }

      Button(action: onRemove) {
        Image(systemName: "xmark")
          .font(.footnote.weight(.bold))
          .foregroundStyle(.secondary)
          .frame(width: 32, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHidden(true)
    }
    .padding(.leading, 8)
    .padding(.trailing, 2)
    .frame(width: cardWidth, alignment: .leading)
    .glassEffect(.regular.tint(ComposerView.fieldTint), in: .rect(cornerRadius: 16))
  }

  /// A card is as wide as its words need, up to this much.
  private var cardWidth: CGFloat { min(280, max(200, side * 4)) }

  @ViewBuilder private var leading: some View {
    ZStack {
      if item.kind == .image, let url = item.previewURL {
        AttachmentThumbnail(url: url, side: tile, corner: 10)
      } else {
        RoundedRectangle(cornerRadius: 10)
          .fill(.fill.tertiary)
          .frame(width: tile, height: tile)
        Image(systemName: item.kind == .image ? "photo" : "doc.fill")
          .font(.title3)
          .foregroundStyle(.secondary)
      }

      switch item.status {
      case .working:
        Color.black.opacity(0.3).clipShape(.rect(cornerRadius: 10))
        progress
      case .failed:
        Color.black.opacity(0.3).clipShape(.rect(cornerRadius: 10))
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.title3)
          .foregroundStyle(.white)
      case .ready:
        EmptyView()
      }
    }
    .frame(width: tile, height: tile)
    .padding(.vertical, 8)
  }

  @ViewBuilder private var progress: some View {
    if let fraction = item.progress {
      ProgressView(value: fraction).progressViewStyle(.circular).controlSize(.small).tint(.white)
    } else {
      ProgressView().controlSize(.small).tint(.white)
    }
  }

  // MARK: Words

  /// A red that holds 4.5:1 on the glass over the page's background in both appearances.
  static let failureColour = Color.dynamic(light: (0xC0, 0x1B, 0x1B), dark: (0xFF, 0x8A, 0x80))

  static func statusText(_ item: StagedAttachment) -> String {
    switch item.status {
    case .ready:
      return AttachmentFormat.size(item.size)
    case .working:
      if item.kind == .image {
        return NativeStrings.Composer.Attach.reading
      }

      guard let fraction = item.progress, fraction > 0 else {
        return NativeStrings.Composer.Attach.uploadingStart
      }

      return NativeStrings.Composer.Attach.uploading(percent: Int((fraction * 100).rounded(.down)))
    case .failed:
      return item.problem?.message ?? ""
    }
  }

  /// What VoiceOver reads after the file's name.
  static func spokenStatus(_ item: StagedAttachment) -> String {
    item.status == .ready
      ? "\(NativeStrings.Composer.Attach.ready), \(AttachmentFormat.size(item.size))" : statusText(item)
  }
}

/// A picture's thumbnail, decoded at the size it is drawn and off the main actor: a 12-megapixel
/// photograph is never decoded whole to fill sixty points.
struct AttachmentThumbnail: View {
  let url: URL
  let side: CGFloat
  let corner: CGFloat

  @Environment(\.displayScale) private var displayScale
  @State private var image: Image?

  var body: some View {
    ZStack {
      Color.secondary.opacity(0.15)

      if let image {
        image
          .resizable()
          .scaledToFill()
      }
    }
    .frame(width: side, height: side)
    .clipShape(.rect(cornerRadius: corner))
    .task(id: url) {
      image = await Self.decode(url, pixels: side * displayScale)
    }
    .accessibilityHidden(true)
  }

  static func decode(_ url: URL, pixels: CGFloat) async -> Image? {
    await Task.detached(priority: .userInitiated) {
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        return nil
      }

      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: max(1, Int(pixels.rounded(.up)))
      ]

      guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        return nil
      }

      return Image(decorative: cgImage, scale: 1)
    }.value
  }
}

extension AttachmentProblem {
  /// Whether trying again could end differently.
  var isRetryable: Bool {
    if case .tooLarge = self { false } else { true }
  }

  /// What the chip says, in the reader's language.
  var message: String {
    switch self {
    case .tooLarge(let limit): NativeStrings.Composer.Attach.tooLarge(limit: AttachmentFormat.limit(limit))
    case .noWorkspace: NativeStrings.Composer.Attach.noWorkspace
    case .refused(let detail): NativeStrings.Composer.Attach.refused(detail)
    case .failed(let message): NativeStrings.Composer.Attach.failed(message)
    case .unreadable: NativeStrings.Composer.Attach.unreadable
    }
  }
}

/// Byte counts as a reader says them, in the reader's language.
enum AttachmentFormat {
  /// "1.2 MB", for a file's size.
  static func size(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }

  /// "25 MB", "100 MB", for a limit (counted in binary units, as the gateway counts them).
  static func limit(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)
  }
}

extension NativeStrings.Composer {
  enum Attach {
    /// Add attachment
    static var add: String {
      String(localized: "native.composer.attach.add", table: "Native", bundle: .module)
    }
    /// Photo Library
    static var photoLibrary: String {
      String(localized: "native.composer.attach.photoLibrary", table: "Native", bundle: .module)
    }
    /// Take Photo
    static var camera: String {
      String(localized: "native.composer.attach.camera", table: "Native", bundle: .module)
    }
    /// Files
    static var files: String {
      String(localized: "native.composer.attach.files", table: "Native", bundle: .module)
    }
    /// Choose File…
    static var chooseFile: String {
      String(localized: "native.composer.attach.chooseFile", table: "Native", bundle: .module)
    }
    /// Remove {name}
    static func remove(name: String) -> String {
      String(
        localized: "native.composer.attach.remove",
        defaultValue: "Remove \(name)",
        table: "Native",
        bundle: .module
      )
    }
    /// Retry {name}
    static func retry(name: String) -> String {
      String(
        localized: "native.composer.attach.retry",
        defaultValue: "Retry \(name)",
        table: "Native",
        bundle: .module
      )
    }
    /// Preparing…
    static var reading: String {
      String(localized: "native.composer.attach.reading", table: "Native", bundle: .module)
    }
    /// Uploading {percent}%
    static func uploading(percent: Int) -> String {
      String(
        localized: "native.composer.attach.uploading",
        defaultValue: "Uploading \(percent)%",
        table: "Native",
        bundle: .module
      )
    }
    /// Uploading…
    static var uploadingStart: String {
      String(localized: "native.composer.attach.uploadingStart", table: "Native", bundle: .module)
    }
    /// Ready
    static var ready: String {
      String(localized: "native.composer.attach.ready", table: "Native", bundle: .module)
    }
    /// Too large, the limit is {limit}
    static func tooLarge(limit: String) -> String {
      String(
        localized: "native.composer.attach.problem.tooLarge",
        defaultValue: "Too large, the limit is \(limit)",
        table: "Native",
        bundle: .module
      )
    }
    /// This chat has no working folder yet, so a file cannot be attached
    static var noWorkspace: String {
      String(localized: "native.composer.attach.problem.noWorkspace", table: "Native", bundle: .module)
    }
    /// The gateway refused it: {detail}
    static func refused(_ detail: String) -> String {
      String(
        localized: "native.composer.attach.problem.refused",
        defaultValue: "The gateway refused it: \(detail)",
        table: "Native",
        bundle: .module
      )
    }
    /// Upload failed: {message}
    static func failed(_ message: String) -> String {
      String(
        localized: "native.composer.attach.problem.failed",
        defaultValue: "Upload failed: \(message)",
        table: "Native",
        bundle: .module
      )
    }
    /// The file could not be read
    static var unreadable: String {
      String(localized: "native.composer.attach.problem.unreadable", table: "Native", bundle: .module)
    }
    /// Waiting for the attachments to finish
    static var waitingHint: String {
      String(localized: "native.composer.attach.waitingHint", table: "Native", bundle: .module)
    }
    /// Drop to attach
    static var drop: String {
      String(localized: "native.composer.attach.drop", table: "Native", bundle: .module)
    }
    /// Attachments
    static var list: String {
      String(localized: "native.composer.attach.list", table: "Native", bundle: .module)
    }
    /// The file could not be attached: {reason}
    static func stagingFailed(_ reason: String) -> String {
      String(
        localized: "native.composer.attach.stagingFailed",
        defaultValue: "The file could not be attached: \(reason)",
        table: "Native",
        bundle: .module
      )
    }
  }
}
