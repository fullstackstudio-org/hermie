import AVFoundation
import Foundation
import HermieGateway
import HermieTranscript
import Synchronization
import UniformTypeIdentifiers

/// One byte range a player asks for: `length` bytes from `offset`, or everything from it when `length` is nil.
public struct MediaRange: Sendable, Equatable {
  public var offset: Int
  public var length: Int?

  public init(offset: Int, length: Int?) {
    self.offset = offset
    self.length = length
  }
}

/// Reads one range of one file: `onHead` once, before any `onData`, then the bytes in order and never more than were
/// asked for. Throws `FileDownloadError`, or `CancellationError`.
public typealias MediaRangeReader = @Sendable (
  _ range: MediaRange,
  _ onHead: @escaping @Sendable (ByteRangeHead) -> Void,
  _ onData: @escaping @Sendable (Data) -> Void
) async throws -> Void

/// Serves one shared sound or video to AVFoundation itself, a byte range at a time, so the player never makes a
/// request of its own.
///
/// An `AVURLAsset` on an `http(s)` address with the credential in `AVURLAssetHTTPHeaderFieldsKey` copies those
/// headers onto a redirect, to whatever origin it points at. Here the asset's address is `hermie-outbox://…`, which
/// nothing but this delegate can load: every range goes through `read` (the gateway's own HTTP client, which sends
/// the credential to the gateway's origin only and follows no redirect), the whole file is held to `maxBytes`, and a
/// request the player gives up on is cancelled.
public final class OutboxMediaLoader: NSObject, AVAssetResourceLoaderDelegate, Sendable {
  /// The scheme of the address the asset is made with.
  public static let scheme = "hermie-outbox"
  /// The domain of the errors a load fails with (a `404` fails as the system's own "file does not exist").
  public static let errorDomain = "app.hermie.outbox-media"

  public let attachment: OutboxAttachment
  public let maxBytes: Int
  /// The queue AVFoundation calls this delegate on, and where every answer is given.
  let queue = DispatchQueue(label: "app.hermie.outbox-media")

  private let read: MediaRangeReader
  private let state = Mutex(State())

  private struct State {
    var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    var failure: FileDownloadError?
    var closed = false
  }

  /// A loading request handed between the delegate's queue and the task that answers it. AVFoundation's requests are
  /// not `Sendable`; each one is only touched on `queue`, or after the task that owns it was started.
  private struct Pending: @unchecked Sendable {
    let request: AVAssetResourceLoadingRequest
  }

  public init(attachment: OutboxAttachment, maxBytes: Int, read: @escaping MediaRangeReader) {
    self.attachment = attachment
    self.maxBytes = maxBytes
    self.read = read
  }

  /// The address the asset is made with: not one any network stack can dial. It ends in an extension of the media
  /// type this loader declares, never the bot's file name: AVFoundation picks the format from the extension, and a
  /// name ending in `.m3u8` would make it a stream whose segments the player fetches itself, from any host.
  public var url: URL {
    let ext = Self.mediaType(served: nil, attachment: attachment).preferredFilenameExtension ?? "mp4"
    var components = URLComponents()
    components.scheme = Self.scheme
    components.host = "file"
    components.percentEncodedPath = "/\(attachment.id)/media.\(ext)"
    return components.url ?? URL(string: "\(Self.scheme)://file/\(attachment.id)/media.mp4")!
  }

  /// A new asset this loader serves. The asset holds its delegate weakly: keep the loader as long as the asset.
  public func makeAsset() -> AVURLAsset {
    let asset = AVURLAsset(url: url)
    asset.resourceLoader.setDelegate(self, queue: queue)
    return asset
  }

  /// Why the last range failed, when the gateway said so: `.notFound`, `.tooLarge`, a refusal.
  public var failure: FileDownloadError? {
    state.withLock { $0.failure }
  }

  /// Cancel every range on its way, and answer none from now on (the player is let go).
  public func close() {
    let tasks = state.withLock { state -> [Task<Void, Never>] in
      state.closed = true
      defer { state.tasks = [:] }
      return Array(state.tasks.values)
    }
    for task in tasks { task.cancel() }
  }

  // MARK: AVAssetResourceLoaderDelegate

  public func resourceLoader(
    _ resourceLoader: AVAssetResourceLoader,
    shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
  ) -> Bool {
    guard loadingRequest.request.url?.scheme == Self.scheme else { return false }

    let key = ObjectIdentifier(loadingRequest)
    let pending = Pending(request: loadingRequest)
    let range = Self.range(of: loadingRequest)

    return state.withLock { state in
      guard !state.closed else { return false }
      state.tasks[key] = Task { [self] in await serve(pending, range: range, key: key) }
      return true
    }
  }

  public func resourceLoader(
    _ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest
  ) {
    let task = state.withLock { $0.tasks.removeValue(forKey: ObjectIdentifier(loadingRequest)) }
    task?.cancel()
  }

  // MARK: Serving

  /// What `request` asks for: its data request's range, or, for a request that only wants to know what the file is,
  /// its first byte.
  static func range(of request: AVAssetResourceLoadingRequest) -> MediaRange {
    guard let data = request.dataRequest else { return MediaRange(offset: 0, length: 1) }
    let offset = Int(data.requestedOffset)
    return MediaRange(offset: offset, length: data.requestsAllDataToEndOfResource ? nil : max(1, data.requestedLength))
  }

  private func serve(_ pending: Pending, range: MediaRange, key: ObjectIdentifier) async {
    let attachment = attachment
    let maxBytes = maxBytes
    let queue = queue
    let refusedOverCap = Mutex(false)
    let handed = Mutex(0)

    let onHead: @Sendable (ByteRangeHead) -> Void = { [weak self] head in
      let total = head.totalLength ?? attachment.size

      // The whole file is held to the cap, whatever a range of it is.
      guard total <= maxBytes else {
        refusedOverCap.withLock { $0 = true }
        self?.cancelTask(key)
        return
      }

      let type = Self.contentType(served: head.contentType, attachment: attachment)
      queue.sync {
        guard let info = pending.request.contentInformationRequest, !pending.request.isCancelled else { return }
        info.contentType = type
        info.contentLength = Int64(total)
        info.isByteRangeAccessSupported = head.rangesSupported
      }
    }

    let onData: @Sendable (Data) -> Void = { data in
      // Never past the cap, whatever the reader handed over.
      let allowed = handed.withLock { count -> Bool in
        count += data.count
        return range.offset + count <= maxBytes
      }
      guard allowed, !refusedOverCap.withLock({ $0 }) else { return }
      queue.sync {
        guard !pending.request.isCancelled, let request = pending.request.dataRequest else { return }
        request.respond(with: data)
      }
    }

    var failure: (any Error)?
    do {
      try await read(range, onHead, onData)
    } catch {
      failure = error
    }

    if refusedOverCap.withLock({ $0 }) || range.offset + handed.withLock({ $0 }) > maxBytes {
      failure = FileDownloadError.tooLarge
    }

    let known = failure as? FileDownloadError
    let stillAsked = state.withLock { state -> Bool in
      if let known { state.failure = known }
      return state.tasks.removeValue(forKey: key) != nil
    }

    // A request the player cancelled (or a loader that was closed) is not answered.
    guard stillAsked || known != nil else { return }
    let error = failure.map(Self.loadError)

    queue.async {
      let request = pending.request
      guard !request.isFinished, !request.isCancelled else { return }
      if let error {
        request.finishLoading(with: error)
      } else {
        request.finishLoading()
      }
    }
  }

  private func cancelTask(_ key: ObjectIdentifier) {
    state.withLock { $0.tasks[key] }?.cancel()
  }

  /// The error a load fails with: a `404` as the system's own "file does not exist" (what the player reads as gone),
  /// anything else in this loader's domain.
  static func loadError(_ error: any Error) -> NSError {
    switch error as? FileDownloadError {
    case .notFound:
      return NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)
    case .tooLarge:
      return NSError(domain: errorDomain, code: 413, userInfo: [NSLocalizedDescriptionKey: "The file is too large."])
    case .refused(let status):
      return NSError(domain: errorDomain, code: status, userInfo: [NSLocalizedDescriptionKey: "The gateway refused it."])
    case .unauthorized:
      return NSError(domain: errorDomain, code: 401, userInfo: [NSLocalizedDescriptionKey: "Not signed in."])
    case .corrupt, .unreachable, nil:
      if error is CancellationError { return NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError) }
      return NSError(domain: errorDomain, code: 0, userInfo: [NSLocalizedDescriptionKey: "The gateway could not be read."])
    }
  }

  /// The type the player is told, as a UTI: see `mediaType`.
  static func contentType(served: String?, attachment: OutboxAttachment) -> String {
    mediaType(served: served, attachment: attachment).identifier
  }

  /// The media type of the file: the first of what the gateway served, what the attachment says and what the name's
  /// extension says that is a single sound or video, never a playlist (an HLS playlist makes the player fetch its
  /// segments itself), else a plain MPEG-4 movie or sound by the attachment's kind.
  static func mediaType(served: String?, attachment: OutboxAttachment) -> UTType {
    let ext = (attachment.name as NSString).pathExtension
    let candidates =
      [served, attachment.mime].compactMap { $0 }.compactMap { UTType(mimeType: $0) }
      + (ext.isEmpty ? [] : [UTType(filenameExtension: ext)].compactMap { $0 })
    if let media = candidates.first(where: isSingleMedia) { return media }
    return attachment.kind == .audio ? .mpeg4Audio : .mpeg4Movie
  }

  private static func isSingleMedia(_ type: UTType) -> Bool {
    guard type.conforms(to: .audiovisualContent), !type.conforms(to: .playlist), !type.conforms(to: .m3uPlaylist)
    else { return false }
    let id = type.identifier.lowercased()
    return !id.contains("m3u") && !id.contains("mpegurl") && !id.contains("playlist")
  }
}
