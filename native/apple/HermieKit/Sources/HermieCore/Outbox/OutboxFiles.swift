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
  /// The address and the credentials a media player reads one attachment with.
  public typealias MediaSource = @Sendable (_ attachment: OutboxAttachment) async throws -> MediaRequest

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

  /// The address and the headers a player reads `attachment` with. Throws `FileDownloadError.tooLarge` for a
  /// file over what this device takes, and what the link throws when it has no address for it.
  public func mediaRequest(for attachment: OutboxAttachment) async throws -> MediaRequest {
    guard OutboxLimits.allows(attachment) else { throw FileDownloadError.tooLarge }
    return try await source(attachment)
  }

  /// Stop every load that is running (the chat is closing). What is on disk stays until the gateway signs out.
  public func cancelAll() {
    for model in models.values { model.cancel() }
  }
}

// MARK: - The session's side

/// How a session fetches a shared file: into a folder of its own gateway, under a name the person could read.
public enum OutboxDownloads {
  /// Fetch `attachment` through `link` into a fresh folder of `gatewayID`'s opened files (the one
  /// `AttachmentOpening.discardOpened` removes on sign-out), named as a copy of it is saved
  /// (`OutboxText.savedName`). One folder per fetch, so two files of one name never meet.
  public static func download(
    _ attachment: OutboxAttachment,
    profile: String?,
    link: any GatewayLink,
    gatewayID: String,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL {
    let cap = OutboxLimits.maxBytes(for: attachment.kind)
    guard attachment.size <= cap else { throw FileDownloadError.tooLarge }

    let folder = AttachmentOpening.directory(gateway: gatewayID).appendingPathComponent(UUID().uuidString, isDirectory: true)
    let destination = folder.appendingPathComponent(OutboxText.savedName(attachment.name))

    do {
      let result = try await link.downloadFile(
        OutboxRoute.path(for: attachment, profile: profile),
        to: destination,
        maxBytes: cap,
        expectedSize: attachment.size,
        expectedSHA256: attachment.sha256,
        onProgress: onProgress)
      return result.url
    } catch {
      try? FileManager.default.removeItem(at: folder)
      if error is CancellationError || error is FileDownloadError { throw error }
      throw FileDownloadError.unreachable
    }
  }
}

extension GatewaySession {
  /// The files the bots of this gateway shared with `profile`'s chat, fetched with this session's own credentials.
  public func outboxFiles(profile: String?) -> OutboxFiles {
    let link = self.link
    let gatewayID = self.gatewayID

    return OutboxFiles(
      download: { attachment, onProgress in
        try await OutboxDownloads.download(
          attachment, profile: profile, link: link, gatewayID: gatewayID, onProgress: onProgress)
      },
      mediaSource: { attachment in
        try await link.mediaRequest(OutboxRoute.path(for: attachment, profile: profile))
      })
  }
}
