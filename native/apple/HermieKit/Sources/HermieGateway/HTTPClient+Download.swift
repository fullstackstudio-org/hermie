import CryptoKit
import Foundation
import Synchronization

/// A file fetched from the gateway and kept on this device.
public struct FileDownload: Sendable, Equatable {
  /// Where the bytes are (the file the caller named).
  public var url: URL
  /// How many bytes arrived.
  public var bytes: Int
  /// Their SHA-256, 64 lower-case hex characters, worked out as they arrived.
  public var sha256: String

  public init(url: URL, bytes: Int, sha256: String) {
    self.url = url
    self.bytes = bytes
    self.sha256 = sha256
  }
}

/// Why a file did not arrive.
public enum FileDownloadError: Error, Sendable, Equatable {
  /// `404`: the gateway does not have it (any more).
  case notFound
  /// The gateway answered something else than the file (a refusal, an error, a redirect it was not allowed to follow).
  case refused(status: Int)
  /// More bytes than the cap allowed, announced or counted as they arrived. Nothing is kept.
  case tooLarge
  /// What arrived is not what was announced: another size, or another SHA-256. Nothing is kept.
  case corrupt
  /// The credentials were refused and could not be renewed.
  case unauthorized
  /// The gateway could not be reached, or the connection broke.
  case unreachable
}

extension HTTPClient {
  /// `GET` a file the gateway serves into `destination`, with the same 401-then-retry as every other call and
  /// no redirect followed (the credential and the file stay with the gateway).
  ///
  /// - The bytes go to disk as they arrive (never held whole), the SHA-256 is worked out on the way, and the
  ///   cap is enforced on the stream: a body longer than `maxBytes` is cut off the moment it passes the cap,
  ///   whatever its `Content-Length` said, and what was written is removed.
  /// - `expectedSize` and `expectedSHA256` (what the attachment declared) are checked once the file is whole; a
  ///   file that differs is removed and answers `.corrupt`.
  /// - `onProgress` is called with 0 to 1 as bytes arrive, when the total is known.
  /// - Cancelling the task cancels the request and removes the partial file.
  ///
  /// Throws `FileDownloadError`, or `CancellationError`.
  public func downloadFile(
    _ path: String,
    to destination: URL,
    maxBytes: Int,
    expectedSize: Int? = nil,
    expectedSHA256: String? = nil,
    onProgress: (@Sendable (Double) -> Void)? = nil
  ) async throws -> FileDownload {
    let url: String
    do {
      url = try GatewayAddress.apiURL(baseURL, path: path)
    } catch {
      throw FileDownloadError.unreachable
    }

    let plan = DownloadPlan(
      destination: destination, maxBytes: maxBytes, expectedSize: expectedSize, onProgress: onProgress)
    var result = try await fetch(url, plan: plan, auth: AuthHeaderOptions())

    if result.outcome.status == 401 {
      do {
        if try await credentials.onRejected(rejectedToken: result.usedToken) == .reauth {
          throw FileDownloadError.unauthorized
        }
      } catch let error as FileDownloadError {
        throw error
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        throw FileDownloadError.unauthorized
      }

      result = try await fetch(url, plan: plan, auth: AuthHeaderOptions(forceRefresh: false))
    }

    let outcome = result.outcome

    if let failure = outcome.failure {
      try? FileManager.default.removeItem(at: destination)
      throw failure
    }

    guard (200...299).contains(outcome.status), let digest = outcome.digest else {
      try? FileManager.default.removeItem(at: destination)
      throw Self.error(forStatus: outcome.status)
    }

    if let expectedSize, expectedSize != outcome.bytes {
      try? FileManager.default.removeItem(at: destination)
      throw FileDownloadError.corrupt
    }

    if let expectedSHA256, expectedSHA256.lowercased() != digest {
      try? FileManager.default.removeItem(at: destination)
      throw FileDownloadError.corrupt
    }

    return FileDownload(url: destination, bytes: outcome.bytes, sha256: digest)
  }

  static func error(forStatus status: Int) -> FileDownloadError {
    switch status {
    case 404: .notFound
    case 401: .unauthorized
    case 0: .unreachable
    default: .refused(status: status)
    }
  }

  private struct Fetched {
    var outcome: DownloadSink.Outcome
    var usedToken: String?
  }

  private func fetch(_ url: String, plan: DownloadPlan, auth options: AuthHeaderOptions) async throws -> Fetched {
    let auth: [String: String]

    do {
      auth = try await credentials.httpAuthHeaders(options)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw FileDownloadError.unauthorized
    }

    guard let target = URL(string: url), URLOrigin(target) != nil else {
      throw FileDownloadError.unreachable
    }

    var request = URLRequest(url: target)
    request.httpMethod = "GET"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    // The idle window between bytes; a big file on a slow line is not a stalled one.
    request.timeoutInterval = 120

    for (name, value) in extraHeaders.merging(auth, uniquingKeysWith: { _, auth in auth }) {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let sink = DownloadSink(plan: plan)
    // The transport's own session (no cache, no cookies; a test's stub protocol), shared by every call, with this
    // download's own delegate: the bytes are handed over as they arrive, and a redirect is its to refuse.
    let outcome = await transport.run(request, delegate: sink) { continuation in sink.begin(continuation) }

    if Task.isCancelled {
      try? FileManager.default.removeItem(at: plan.destination)
      throw CancellationError()
    }

    return Fetched(outcome: outcome, usedToken: GatewayCredentials.bearer(from: auth))
  }
}

/// What one download is asked to do.
struct DownloadPlan: Sendable {
  var destination: URL
  var maxBytes: Int
  var expectedSize: Int?
  var onProgress: (@Sendable (Double) -> Void)?
}

/// Receives one download's bytes: writes them to the file, hashes them and enforces the cap as they come.
/// Its callbacks run one at a time on the session's own serial queue.
private final class DownloadSink: NSObject, URLSessionDataDelegate, Sendable {
  struct Outcome: Sendable {
    var status = 0
    var bytes = 0
    var digest: String?
    var failure: FileDownloadError?
  }

  private struct State {
    var status = 0
    var received = 0
    var announced: Int64 = -1
    var hasher = SHA256()
    var handle: FileHandle?
    var failure: FileDownloadError?
    var continuation: CheckedContinuation<Outcome, Never>?
    var lastProgress = -1.0
  }

  private let plan: DownloadPlan
  private let state = Mutex(State())

  init(plan: DownloadPlan) {
    self.plan = plan
  }

  func begin(_ continuation: CheckedContinuation<Outcome, Never>) {
    state.withLock { $0.continuation = continuation }
  }

  // A redirect is never followed: nothing authenticated goes where the gateway did not say.
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let announced = response.expectedContentLength
    var allow = false

    state.withLock { state in
      state.status = status
      state.announced = announced

      guard (200...299).contains(status) else { return }

      // Refused by its declared length before a byte is read.
      if announced > Int64(plan.maxBytes) {
        state.failure = .tooLarge
        return
      }

      do {
        try FileManager.default.createDirectory(
          at: plan.destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: plan.destination)
        guard FileManager.default.createFile(atPath: plan.destination.path, contents: nil),
          let handle = FileHandle(forWritingAtPath: plan.destination.path)
        else {
          state.failure = .unreachable
          return
        }
        state.handle = handle
        allow = true
      } catch {
        state.failure = .unreachable
      }
    }

    completionHandler(allow ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    var cancel = false
    var fraction: Double?

    state.withLock { state in
      guard state.failure == nil, let handle = state.handle else { return }

      state.received += data.count

      // Cut off the moment it runs past the cap, whatever the header said.
      if state.received > plan.maxBytes {
        state.failure = .tooLarge
        cancel = true
        return
      }

      do {
        try handle.write(contentsOf: data)
      } catch {
        state.failure = .unreachable
        cancel = true
        return
      }

      state.hasher.update(data: data)
      let total = state.announced > 0 ? Int(state.announced) : (plan.expectedSize ?? 0)

      if total > 0 {
        let now = min(1, Double(state.received) / Double(total))
        // At most a hundred updates, not one per chunk.
        if now - state.lastProgress >= 0.01 || now >= 1 {
          state.lastProgress = now
          fraction = now
        }
      }
    }

    if cancel { dataTask.cancel() }
    if let fraction { plan.onProgress?(fraction) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    let (continuation, outcome) = state.withLock { state -> (CheckedContinuation<Outcome, Never>?, Outcome) in
      try? state.handle?.close()
      state.handle = nil

      var outcome = Outcome(status: state.status, bytes: state.received, digest: nil, failure: state.failure)
      let answered = (200...299).contains(state.status)

      if outcome.failure == nil {
        if answered {
          // A body cut short by the connection (a cut of ours has its own failure above).
          if error != nil {
            outcome.failure = .unreachable
          } else {
            outcome.digest = state.hasher.finalize().map { String(format: "%02x", $0) }.joined()
          }
        } else if state.status == 0 {
          // Nothing answered.
          outcome.failure = .unreachable
        }
        // Any other status is the answer: the body was not wanted and was cancelled.
      }

      let continuation = state.continuation
      state.continuation = nil
      return (continuation, outcome)
    }

    continuation?.resume(returning: outcome)
  }
}
