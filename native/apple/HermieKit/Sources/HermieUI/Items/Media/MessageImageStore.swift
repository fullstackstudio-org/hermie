import Foundation
import HermieCore
import HermieMarkdown
import HermieTranscript
import ImageIO
import Observation

/// A decoded picture, at the size it was asked for.
struct MediaImageData: @unchecked Sendable {
  let image: CGImage

  var pixelSize: CGSize { CGSize(width: image.width, height: image.height) }
  var aspect: CGFloat { image.height > 0 ? CGFloat(image.width) / CGFloat(image.height) : 1 }
  /// What the picture costs in memory, for the cache.
  var cost: Int { image.width * image.height * 4 }
}

/// Reading a picture off disk as a thumbnail, without decoding more than the thumbnail needs.
enum MediaImageDecoder {
  /// A picture with more pixels than this is refused: a file of a few kilobytes can claim a size
  /// that takes gigabytes to draw.
  static let maximumPixels = 120_000_000

  /// The picture in `url`, its longer side at most `maxPixel` pixels, turned the way its metadata says.
  /// `nil` when it is not a picture the system can read.
  static func decode(url: URL, maxPixel: Int) -> MediaImageData? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions), CGImageSourceGetCount(source) > 0 else {
      return nil
    }

    if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width * height > maximumPixels
    {
      return nil
    }

    let options =
      [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel
      ] as CFDictionary
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
    return MediaImageData(image: image)
  }
}

/// What one open chat knows about the pictures its messages show.
///
/// The thumbnails of a transcript come through here and nowhere else: a picture is fetched through
/// the session's own attachment path (`GatewaySession.prepareAttachment`: the gateway's credentials,
/// no redirect, the size cap, a local file only for a gateway on this device), turned into a
/// thumbnail off the main actor, and kept in a memory cache bounded in bytes, so a row the list
/// let go of and builds again draws its pictures at once, with no placeholder in between.
///
/// - Fetches are shared (two rows, or a row and the gallery, asking for one file make one request),
///   limited to a few at a time, and survive the row that asked going away: a picture the reader
///   scrolled past is still there when they scroll back.
/// - A fetch that failed is not tried again for a short while, so a row that keeps appearing does
///   not keep asking.
/// - The gallery's state is here as well (`presentation`), because the row that was tapped may be
///   recycled by the list while the gallery is up; the screen presents it (`imageGalleryHost`).
@MainActor
@Observable
final class MessageImageStore {
  /// Makes a reference something on this device: the file to read, or `nil` when it cannot be had.
  typealias Resolver = @MainActor @Sendable (_ reference: String) async -> URL?

  /// The gallery being shown.
  struct Presentation: Identifiable, Equatable {
    let id = UUID()
    var model: ImageGalleryModel
  }

  /// The pictures the reader opened, or `nil` when no gallery is up.
  var presentation: Presentation?

  /// How many files are fetched at once.
  static let maximumFetches = 3
  /// How long a failed fetch is remembered, in seconds.
  static let failureMemory: TimeInterval = 30

  @ObservationIgnored private let resolver: Resolver
  @ObservationIgnored private var resolutions: [String: Task<URL?, Never>] = [:]
  @ObservationIgnored private var failures: [String: Date] = [:]
  /// The pictures messages hold themselves, by their handle (`MessageImage.inlineReference`).
  @ObservationIgnored private var inlinePictures: [String: String] = [:]
  /// The pictures a bot shared, by their handle (`reference(for:)`): fetched through their model.
  @ObservationIgnored private var outboxModels: [String: OutboxFileModel] = [:]
  @ObservationIgnored private let cache: NSCache<NSString, Box> = {
    let cache = NSCache<NSString, Box>()
    // About 40 MB of decoded pictures, which is some three dozen thumbnails and a few full-size ones.
    cache.totalCostLimit = 40_000_000
    return cache
  }()
  @ObservationIgnored private var running = 0
  @ObservationIgnored private var waiting: [CheckedContinuation<Void, Never>] = []

  private final class Box {
    let data: MediaImageData
    init(_ data: MediaImageData) { self.data = data }
  }

  init(resolve: @escaping Resolver) {
    self.resolver = resolve
  }

  // MARK: Pictures a bot shared

  /// What a shared picture is called to the store: `outbox:<token>`. A token is 32 characters of a fixed alphabet,
  /// so the handle cannot be mistaken for a path, an `@image:` reference or a picture a message holds itself.
  nonisolated static func reference(for attachment: OutboxAttachment) -> String {
    "outbox:\(attachment.id)"
  }

  /// The picture a shared image is, for the grid and the gallery: named as the card shows it.
  nonisolated static func image(for attachment: OutboxAttachment) -> MessageImage {
    MessageImage(reference: reference(for: attachment), name: OutboxText.displayName(attachment.name))
  }

  nonisolated static func isOutbox(_ reference: String) -> Bool {
    reference.hasPrefix("outbox:")
  }

  /// Makes the pictures a bot shared something `file` can answer for: fetched through `files`, under the
  /// chat's own session, with the cap a picture has.
  func register(outbox attachments: [OutboxAttachment], files: OutboxFiles?) {
    guard let files else { return }
    for attachment in attachments {
      outboxModels[Self.reference(for: attachment)] = files.model(for: attachment)
    }
  }

  /// Whether the gateway no longer has the picture `reference` names (a `404`): it is not asked for again, and the
  /// frame says so rather than offering a retry.
  func isGone(_ reference: String) -> Bool {
    outboxModels[reference]?.state == .gone
  }

  // MARK: Opening the gallery

  func present(_ images: [MessageImage], at index: Int) {
    guard !images.isEmpty else { return }
    register(images)
    presentation = Presentation(model: ImageGalleryModel(images: images, start: index))
  }

  /// Makes the pictures a message holds itself something `file` can answer for: their bytes are kept
  /// (the message's own string, not a copy) until a file is asked for.
  func register(_ images: [MessageImage]) {
    for image in images {
      if let base64 = image.inlineBase64, inlinePictures[image.reference] == nil { inlinePictures[image.reference] = base64 }
    }
  }

  /// A file already fetched for `reference` (an attachment chip that turned out to be a picture): the
  /// gallery uses it instead of asking again.
  func prime(_ reference: String, url: URL) {
    failures[reference] = nil
    resolutions[reference] = Task { url }
  }

  func dismissGallery() {
    presentation = nil
  }

  // MARK: Pictures

  private func key(_ reference: String, _ maxPixel: Int) -> NSString {
    "\(maxPixel)|\(reference)" as NSString
  }

  /// The picture if it is already decoded at this size: what a row asks for first, so it can draw
  /// without a placeholder.
  func cached(_ reference: String, maxPixel: Int) -> MediaImageData? {
    cache.object(forKey: key(reference, maxPixel))?.data
  }

  /// The picture `reference` names, decoded with its longer side at most `maxPixel`, or `nil` when it
  /// cannot be had here (not on this device, the gateway refused it, it is not a picture).
  func image(_ reference: String, maxPixel: Int) async -> MediaImageData? {
    if let hit = cached(reference, maxPixel: maxPixel) { return hit }
    guard let url = await file(reference) else { return nil }
    let decoded = await Task.detached(priority: .utility) {
      MediaImageDecoder.decode(url: url, maxPixel: maxPixel)
    }.value
    guard let decoded else { return nil }
    cache.setObject(Box(decoded), forKey: key(reference, maxPixel), cost: decoded.cost)
    return decoded
  }

  /// The file behind `reference`: the one to share or to save from the gallery.
  func file(_ reference: String) async -> URL? {
    if let task = resolutions[reference] {
      return await task.value
    }
    if let failed = failures[reference], Date.now.timeIntervalSince(failed) < Self.failureMemory {
      return nil
    }

    let resolver = self.resolver
    let inline = inlinePictures[reference]
    let outbox = outboxModels[reference]
    let task = Task { [weak self] () -> URL? in
      guard let self else { return nil }
      await self.acquire()
      let url: URL?
      if Self.isOutbox(reference) {
        // A picture a bot shared: fetched once through its model (the session's credentials, the cap a picture has,
        // the SHA-256 checked), and the gallery shares what the thumbnail fetched.
        if let model = outbox, case .ready(let file) = await model.ensure() {
          url = file
        } else {
          url = nil
        }
      } else if reference.hasPrefix("inline:") {
        // A picture the message holds: its bytes go to a file once, off the main actor.
        url = await Task.detached(priority: .utility) { Self.writeInline(inline, reference: reference) }.value
      } else {
        url = await resolver(reference)
      }
      self.release()
      return url
    }
    resolutions[reference] = task

    let url = await task.value
    if url == nil {
      // Nothing is remembered but the failure, so the next try starts over once the memory is out.
      resolutions[reference] = nil
      failures[reference] = .now
    } else {
      failures[reference] = nil
    }
    return url
  }

  /// Forgets that `reference` failed, so the next ask tries again at once.
  func retry(_ reference: String) {
    failures[reference] = nil
    // A picture a bot shared asks its model again (unless the gateway said it is gone for good).
    if let model = outboxModels[reference], model.state != .gone { model.retry() }
  }

  // MARK: Inline pictures

  /// Where the pictures of messages are kept as files (never backed up; the system clears it).
  nonisolated static var inlineDirectory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("hermie-inline", isDirectory: true)
  }

  /// The bytes of `base64` in a file named for `reference`, with the extension its first bytes call for,
  /// or `nil` when it does not decode. A file that is already there is reused.
  nonisolated static func writeInline(_ base64: String?, reference: String) -> URL? {
    guard let base64 else { return nil }
    let stem = AttachmentRules.sanitisedName(reference)
    let folder = inlineDirectory
    if let existing = (try? FileManager.default.contentsOfDirectory(atPath: folder.path))?.first(where: { $0.hasPrefix(stem + ".") }) {
      return folder.appendingPathComponent(existing)
    }
    guard let data = Data(base64Encoded: base64), !data.isEmpty else { return nil }
    let ext = AttachmentOpening.sniffedExtension(data) ?? "img"
    let url = folder.appendingPathComponent("\(stem).\(ext)")
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
      return url
    } catch {
      return nil
    }
  }

  // MARK: Limiting fetches

  private func acquire() async {
    if running < Self.maximumFetches {
      running += 1
      return
    }
    await withCheckedContinuation { waiting.append($0) }
  }

  private func release() {
    if waiting.isEmpty {
      running -= 1
    } else {
      waiting.removeFirst().resume()
    }
  }
}
