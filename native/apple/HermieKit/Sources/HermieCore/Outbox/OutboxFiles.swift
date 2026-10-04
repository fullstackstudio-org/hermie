import CryptoKit
import Foundation
import HermieGateway
import HermieTranscript
import Observation

/// Where one shared file is, as the card that shows it needs to know.
public enum OutboxFileState: Equatable, Sendable {
  /// Nothing asked for yet.
  case idle
  /// On its way; `progress` is 0 to 1 once the total is known.
  case loading(progress: Double?)
  /// On this device, in a temporary file: to show, to share, to save.
  case ready(URL)
  /// `404`: the gateway no longer has it (retention, or its conversation went). Final: asking again is the same.
  case gone
  /// Larger than this device takes for its kind (`OutboxLimits`). Final.
  case tooLarge
  /// Anything else (unreachable, refused, broken in transit, not what was announced): worth another try.
  case failed

  /// A state that asking again can change.
  public var canRetry: Bool { self == .failed }
}

/// One file a bot shared, fetched on demand and kept in a temporary file for as long as the chat is open.
///
/// The model is what a card reads: its `state`, and the three things a card does with it. A load survives
/// the row that asked for it going away (the list recycles rows), so a file the reader scrolled past is
/// there when they scroll back, and two cards that ask for one file make one request.
@MainActor
@Observable
public final class OutboxFileModel: Identifiable {
  public let attachment: OutboxAttachment
  public private(set) var state: OutboxFileState = .idle

  public nonisolated var id: String { attachment.id }

  @ObservationIgnored private let files: OutboxFiles
  @ObservationIgnored private var task: Task<Void, Never>?

  init(attachment: OutboxAttachment, files: OutboxFiles) {
    self.attachment = attachment
    self.files = files
  }

  /// The file on this device, when it is there.
  public var fileURL: URL? {
    if case .ready(let url) = state { return url }
    return nil
  }

  /// Fetch the file unless it is here or on its way. A final answer (`gone`, `tooLarge`) and a failure stay as they are
  /// until the reader asks again (`retry()`): a row that comes back into view does not ask a gateway that just failed.
  public func load() {
    switch state {
    case .loading, .gone, .tooLarge, .failed:
      return
    case .ready(let url) where FileManager.default.fileExists(atPath: url.path):
      return
    default:
      start()
    }
  }

  /// Ask again, whatever the last answer was.
  public func retry() {
    if case .loading = state { return }
    start()
  }

  /// Fetch the file if it is not here, and wait for the answer.
  @discardableResult
  public func ensure() async -> OutboxFileState {
    load()
    await task?.value
    return state
  }

  /// Stop a load that is running; the file is asked for again when the card needs it.
  public func cancel() {
    task?.cancel()
    task = nil
    if case .loading = state { state = .idle }
  }

  /// The state a failed or refused fetch left: a 404 is final, a cap is final, the rest can be tried again.
  nonisolated static func state(after error: any Error) -> OutboxFileState {
    switch error as? FileDownloadError {
    case .notFound: .gone
    case .tooLarge: .tooLarge
    default: .failed
    }
  }

  private func start() {
    guard OutboxLimits.allows(attachment) else {
      state = .tooLarge
      return
    }

    state = .loading(progress: nil)
    let attachment = self.attachment
    let download = files.download
    task?.cancel()
    task = Task {
      do {
        let url = try await download(attachment) { [model = self] fraction in
          Task { @MainActor in model.progressed(fraction) }
        }
        finish(.ready(url))
      } catch is CancellationError {
        finish(.idle)
      } catch {
        finish(Self.state(after: error))
      }
    }
  }

  private func progressed(_ fraction: Double) {
    if case .loading = state { state = .loading(progress: fraction) }
  }

  private func finish(_ outcome: OutboxFileState) {
    // A load that was cancelled and replaced must not take the newer one's place.
    if Task.isCancelled, outcome == .idle { return }
    state = outcome
  }
}

/// What one open chat knows about the files its bot shared.
///
/// The models are kept by attachment token for the chat's lifetime, so a row the list let go of and builds
/// again finds its file (or its failure) where it was. Fetching and the player's address are the
/// session's (`GatewaySession.outboxFiles(profile:)`): this holds no connection of its own.
@MainActor
public final class OutboxFiles {
  /// Fetches one attachment into a temporary file, reporting 0 to 1 as it arrives. Throws `FileDownloadError`.
  public typealias Downloader = @Sendable (
    _ attachment: OutboxAttachment, _ onProgress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL
  /// Reads one byte range of one attachment for a media player (`OutboxMediaLoader`): `onHead` once, then the bytes.
  /// Throws `FileDownloadError`.
  public typealias MediaSource = @Sendable (
    _ attachment: OutboxAttachment,
    _ range: MediaRange,
    _ onHead: @escaping @Sendable (ByteRangeHead) -> Void,
    _ onData: @escaping @Sendable (Data) -> Void
  ) async throws -> Void

  let download: Downloader
  private let source: MediaSource
  private var models: [String: OutboxFileModel] = [:]

  public init(download: @escaping Downloader, mediaSource: @escaping MediaSource) {
    self.download = download
    self.source = mediaSource
  }

  /// The model for `attachment`: the one already made for its token, or a new one.
  public func model(for attachment: OutboxAttachment) -> OutboxFileModel {
    if let known = models[attachment.id] { return known }
    let model = OutboxFileModel(attachment: attachment, files: self)
    models[attachment.id] = model
    return model
  }

  /// What a player reads `attachment` through: a loader that serves the asset it makes a byte range at a time, through
  /// this chat's session, held to the attachment's cap. Throws `FileDownloadError.tooLarge` for a file over what this
  /// device takes.
  public func mediaLoader(for attachment: OutboxAttachment) throws -> OutboxMediaLoader {
    guard OutboxLimits.allows(attachment) else { throw FileDownloadError.tooLarge }
    let source = self.source
    return OutboxMediaLoader(attachment: attachment, maxBytes: OutboxLimits.maxBytes(for: attachment.kind)) {
      range, onHead, onData in
      try await source(attachment, range, onHead, onData)
    }
  }

  /// Stop every load that is running (the chat is closing). What is on disk stays for the next time the chat is
  /// opened (`OutboxDownloads`), until it is old, the folder is over its size, or the gateway signs out.
  public func cancelAll() {
    for model in models.values { model.cancel() }
  }
}

// MARK: - The session's side

/// How a session fetches a shared file: into a folder of its own gateway, under a name the person could read, kept
/// for the next time the chat is opened.
///
/// A file is kept at `<gateway's opened files>/outbox/<profile>/<token>/<saved name>` (`AttachmentOpening.directory`,
/// which signing out of the gateway removes). A token names one file for good, so a copy whose size and SHA-256 are
/// still the attachment's is used again instead of asking the gateway; the profile is part of the place, so a chat of
/// another profile still asks the gateway, which answers only the profile the file was shared with. What is older
/// than `maximumAge`, and the oldest beyond `maximumBytes` in all, is removed (`purge`), as `AttachmentTray.purge`
/// does for staged uploads.
public enum OutboxDownloads {
  /// A kept file not used for this long is removed.
  public static let maximumAge: TimeInterval = 7 * 24 * 60 * 60
  /// The most one gateway's kept files take; the least recently used go first.
  public static let maximumBytes = 500 * 1024 * 1024

  /// Where `gatewayID`'s shared files are kept.
  public static func directory(gateway gatewayID: String) -> URL {
    AttachmentOpening.directory(gateway: gatewayID).appendingPathComponent("outbox", isDirectory: true)
  }

  /// The folder of one profile's files: a digest of its handle, so no handle is a path and no two are one folder.
  static func profileFolder(_ profile: String?) -> String {
    guard let profile, !profile.isEmpty else { return "default" }
    let digest = SHA256.hash(data: Data(profile.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    return "p-\(digest)"
  }

  /// Where `attachment` is kept for `profile`.
  public static func location(of attachment: OutboxAttachment, profile: String?, gateway gatewayID: String) -> URL {
    directory(gateway: gatewayID)
      .appendingPathComponent(profileFolder(profile), isDirectory: true)
      .appendingPathComponent(attachment.id, isDirectory: true)
      .appendingPathComponent(OutboxText.savedName(attachment.name))
  }

  /// Fetch `attachment` through `link` into its place (`location(of:profile:gateway:)`), or use the copy already there
  /// when its size and SHA-256 are still the attachment's. The bytes arrive in a file of their own next to it and take
  /// its place only once they are whole and checked, so a copy being shown is never half-written.
  public static func download(
    _ attachment: OutboxAttachment,
    profile: String?,
    link: any GatewayLink,
    gatewayID: String,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL {
    let cap = OutboxLimits.maxBytes(for: attachment.kind)
    guard attachment.size <= cap else { throw FileDownloadError.tooLarge }

    let destination = location(of: attachment, profile: profile, gateway: gatewayID)
    let folder = destination.deletingLastPathComponent()

    if isIntact(destination, as: attachment) {
      // Used again: it is the newest of what is kept.
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: destination.path)
      onProgress(1)
      return destination
    }

    let partial = folder.appendingPathComponent(".partial-\(UUID().uuidString)")

    do {
      _ = try await link.downloadFile(
        OutboxRoute.path(for: attachment, profile: profile),
        to: partial,
        maxBytes: cap,
        expectedSize: attachment.size,
        expectedSHA256: attachment.sha256,
        onProgress: onProgress)
      try place(partial, at: destination)
      return destination
    } catch {
      try? FileManager.default.removeItem(at: partial)
      // A token folder with nothing kept in it goes too.
      if ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).isEmpty {
        try? FileManager.default.removeItem(at: folder)
      }
      if error is CancellationError || error is FileDownloadError { throw error }
      throw FileDownloadError.unreachable
    }
  }

  /// Put the whole, checked file where the kept copy goes, in one step.
  private static func place(_ file: URL, at destination: URL) throws {
    let manager = FileManager.default
    if manager.fileExists(atPath: destination.path) {
      _ = try manager.replaceItemAt(destination, withItemAt: file)
    } else {
      try manager.moveItem(at: file, to: destination)
    }
  }

  /// Whether the file at `url` is `attachment`: its size, then its SHA-256, read a piece at a time.
  static func isIntact(_ url: URL, as attachment: OutboxAttachment) -> Bool {
    guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])),
      size.isRegularFile == true, size.fileSize == attachment.size,
      let handle = try? FileHandle(forReadingFrom: url)
    else {
      return false
    }
    defer { try? handle.close() }

    var hasher = SHA256()
    do {
      // `nil` or nothing is the end of the file.
      while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
        hasher.update(data: chunk)
      }
    } catch {
      return false
    }

    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return digest == attachment.sha256.lowercased()
  }

  /// Remove what is kept under `root` (one gateway's `directory(gateway:)`) and was not used for `age`, then, oldest
  /// first, what goes beyond `limit` bytes in all. A file is as old as its last use (`download` touches a copy it uses
  /// again). Whole token folders go, and the profile folders they leave empty.
  public static func purge(
    in root: URL, olderThan age: TimeInterval = maximumAge, keepingAtMost limit: Int = maximumBytes, now: Date = Date()
  ) {
    let manager = FileManager.default
    let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]

    struct Kept {
      var folder: URL
      var used: Date
      var bytes: Int
    }

    var kept: [Kept] = []
    let profiles = (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []

    for profile in profiles {
      let tokens = (try? manager.contentsOfDirectory(at: profile, includingPropertiesForKeys: nil)) ?? []

      for token in tokens {
        let files = (try? manager.contentsOfDirectory(at: token, includingPropertiesForKeys: Array(keys))) ?? []
        var used = Date.distantPast
        var bytes = 0

        for file in files {
          guard let values = try? file.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
          used = max(used, values.contentModificationDate ?? .distantPast)
          bytes += values.fileSize ?? 0
        }

        kept.append(Kept(folder: token, used: used, bytes: bytes))
      }
    }

    // Newest first: what fits under the limit stays, and from the first that does not, everything older goes.
    var total = 0
    var full = false
    for entry in kept.sorted(by: { $0.used > $1.used }) {
      full = full || total + entry.bytes > limit
      if full || now.timeIntervalSince(entry.used) > age {
        try? manager.removeItem(at: entry.folder)
      } else {
        total += entry.bytes
      }
    }

    for profile in profiles where ((try? manager.contentsOfDirectory(atPath: profile.path)) ?? []).isEmpty {
      try? manager.removeItem(at: profile)
    }
  }
}

extension GatewaySession {
  /// The files the bots of this gateway shared with `profile`'s chat, fetched with this session's own credentials.
  public func outboxFiles(profile: String?) -> OutboxFiles {
    let link = self.link
    let gatewayID = self.gatewayID

    // What earlier chats kept and no longer need goes, away from the screen being opened.
    let kept = OutboxDownloads.directory(gateway: gatewayID)
    Task.detached(priority: .utility) { OutboxDownloads.purge(in: kept) }

    return OutboxFiles(
      download: { attachment, onProgress in
        try await OutboxDownloads.download(
          attachment, profile: profile, link: link, gatewayID: gatewayID, onProgress: onProgress)
      },
      mediaSource: { attachment, range, onHead, onData in
        try await link.readRange(
          OutboxRoute.path(for: attachment, profile: profile), offset: range.offset, length: range.length,
          maxBytes: OutboxLimits.maxBytes(for: attachment.kind), onHead: onHead, onData: onData)
      })
  }
}
