import Foundation
import Synchronization

/// What the gateway said about a file before the first byte of a range: its type and how long it is whole.
public struct ByteRangeHead: Sendable, Equatable {
  /// The `Content-Type` without its parameters, lower-cased, when the gateway sent one.
  public var contentType: String?
  /// The whole file's length, from `Content-Range` (or `Content-Length` when the whole file came), when known.
  public var totalLength: Int?
  /// Whether the gateway answered the range itself (`206`). A `200` sent the whole file, and the bytes before the
  /// range were skipped.
  public var rangesSupported: Bool

  public init(contentType: String?, totalLength: Int?, rangesSupported: Bool) {
    self.contentType = contentType
    self.totalLength = totalLength
    self.rangesSupported = rangesSupported
  }
}

extension HTTPClient {
  /// `GET` `length` bytes of a file the gateway serves from `offset` (to its end when `length` is nil), for a media
  /// player that reads by byte ranges. Held to the rules of `downloadFile`:
  ///
  /// - the credential and the front-door headers go to the gateway's own origin and nowhere else: no redirect is
  ///   followed (one answers `.refused(status:)`), and an address that is not on the gateway's origin is refused;
  /// - a `401` refreshes the credential once and asks again;
  /// - `maxBytes` caps the whole file: an announced length over it is `.tooLarge` before a byte is handed over, and
  ///   a body that runs past it is cut off;
  /// - cancelling the task ends the request.
  ///
  /// `onHead` is called once, before any `onData`, with what the gateway said about the file. `onData` is handed the
  /// requested bytes as they arrive, in order, never more than were asked for. Both are called on the session's own
  /// serial queue. Throws `FileDownloadError`, or `CancellationError`.
  public func readRange(
    _ path: String,
    offset: Int,
    length: Int?,
    maxBytes: Int,
    onHead: @escaping @Sendable (ByteRangeHead) -> Void,
    onData: @escaping @Sendable (Data) -> Void
  ) async throws {
    guard offset >= 0, length.map({ $0 > 0 }) ?? true else { throw FileDownloadError.refused(status: 416) }
    guard offset < maxBytes else { throw FileDownloadError.tooLarge }

    let url: String
    do {
      url = try GatewayAddress.apiURL(baseURL, path: path)
    } catch {
      throw FileDownloadError.unreachable
    }

    // The credential is only ever for the gateway's own origin.
    guard let target = URL(string: url), let origin = URLOrigin(target), origin == URLOrigin(URL(string: baseURL)) else {
      throw FileDownloadError.unreachable
    }

    let plan = RangePlan(offset: offset, length: length, maxBytes: maxBytes, onHead: onHead, onData: onData)
    var result = try await fetchRange(target, plan: plan, auth: AuthHeaderOptions())

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

      result = try await fetchRange(target, plan: plan, auth: AuthHeaderOptions(forceRefresh: false))
    }

    let outcome = result.outcome
    if let failure = outcome.failure { throw failure }
    guard (200...299).contains(outcome.status) else { throw Self.error(forStatus: outcome.status) }
  }

  private struct FetchedRange {
    var outcome: RangeSink.Outcome
    var usedToken: String?
  }

  private func fetchRange(_ target: URL, plan: RangePlan, auth options: AuthHeaderOptions) async throws -> FetchedRange {
    let auth: [String: String]

    do {
      auth = try await credentials.httpAuthHeaders(options)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw FileDownloadError.unauthorized
    }

    var request = URLRequest(url: target)
    request.httpMethod = "GET"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    request.timeoutInterval = 120

    for (name, value) in extraHeaders.merging(auth, uniquingKeysWith: { _, auth in auth }) {
      request.setValue(value, forHTTPHeaderField: name)
    }

    // An open end for no length, and for one too large to add (the cap still holds on what arrives).
    let last = plan.length.flatMap { length -> String? in
      guard length > 0 else { return nil }
      let (end, overflow) = plan.offset.addingReportingOverflow(length - 1)
      return overflow ? nil : String(end)
    } ?? ""
    request.setValue("bytes=\(plan.offset)-\(last)", forHTTPHeaderField: "Range")

    let sink = RangeSink(plan: plan)
    let outcome = await transport.run(request, delegate: sink) { continuation in sink.begin(continuation) }

    if Task.isCancelled { throw CancellationError() }
    return FetchedRange(outcome: outcome, usedToken: GatewayCredentials.bearer(from: auth))
  }
}

extension HTTPTransport {
  /// Run one data task on this transport's own session (no cache, no cookies; a test's stub protocol) with
  /// `delegate` as the task's own delegate, so its bytes are handed over as they arrive and its redirects are its to
  /// refuse. `begin` hands the delegate the continuation it resumes when the task is over. Cancelling the calling
  /// task cancels the request.
  func run<Outcome: Sendable>(
    _ request: URLRequest,
    delegate: any URLSessionDataDelegate,
    begin: @escaping @Sendable (CheckedContinuation<Outcome, Never>) -> Void
  ) async -> Outcome {
    let task = session.dataTask(with: request)
    task.delegate = delegate

    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
        begin(continuation)
        task.resume()
      }
    } onCancel: {
      task.cancel()
    }
  }
}

/// What one range read is asked to do.
struct RangePlan: Sendable {
  var offset: Int
  var length: Int?
  var maxBytes: Int
  var onHead: @Sendable (ByteRangeHead) -> Void
  var onData: @Sendable (Data) -> Void
}

/// Receives one range: reads what the gateway said about the file, skips what came before the range when the
/// whole file came, hands over no more than was asked for, and enforces the cap as the bytes come. Its callbacks
/// run one at a time on the session's own serial queue.
final class RangeSink: NSObject, URLSessionDataDelegate, Sendable {
  struct Outcome: Sendable {
    var status = 0
    var failure: FileDownloadError?
  }

  private struct State {
    var status = 0
    var accepted = false
    /// Bytes of the body still to drop before the range starts (a `200` sends the file from its first byte).
    var skip = 0
    /// Bytes still to hand over.
    var remaining = 0
    /// Everything that was asked for has been handed over, and the rest of the body was not wanted.
    var done = false
    var failure: FileDownloadError?
    var continuation: CheckedContinuation<Outcome, Never>?
  }

  private let plan: RangePlan
  private let state = Mutex(State())

  init(plan: RangePlan) {
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

  /// `bytes <first>-<last>/<total>`: the first byte and the whole length (nil for `*`).
  static func contentRange(_ value: String?) -> (first: Int, last: Int, total: Int?)? {
    guard let value else { return nil }
    let parts = value.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1)
    guard parts.count == 2, parts[0].lowercased() == "bytes" else { return nil }
    let halves = parts[1].split(separator: "/", maxSplits: 1)
    let bounds = halves.first?.split(separator: "-", maxSplits: 1) ?? []
    guard halves.count == 2, bounds.count == 2, let first = Int(bounds[0]), let last = Int(bounds[1]), first <= last
    else { return nil }
    if halves[1] == "*" { return (first, last, nil) }
    guard let total = Int(halves[1]), total > last else { return nil }
    return (first, last, total)
  }

  /// `audio/mpeg; charset=…` → `audio/mpeg`.
  static func mediaType(_ value: String?) -> String? {
    guard let value else { return nil }
    let bare = value.split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
    let trimmed = bare.trimmingCharacters(in: .whitespaces).lowercased()
    return trimmed.isEmpty ? nil : trimmed
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 0
    var head: ByteRangeHead?

    state.withLock { state in
      state.status = status
      let type = Self.mediaType(http?.value(forHTTPHeaderField: "Content-Type"))

      switch status {
      case 206:
        guard let range = Self.contentRange(http?.value(forHTTPHeaderField: "Content-Range")), range.first == plan.offset
        else {
          state.failure = .refused(status: 206)
          return
        }
        if let total = range.total, total > plan.maxBytes {
          state.failure = .tooLarge
          return
        }
        let available = (range.total ?? plan.maxBytes) - plan.offset
        state.remaining = min(plan.length ?? available, available, plan.maxBytes - plan.offset)
        head = ByteRangeHead(contentType: type, totalLength: range.total, rangesSupported: true)

      case 200:
        let announced = response.expectedContentLength
        if announced > Int64(plan.maxBytes) {
          state.failure = .tooLarge
          return
        }
        let total = announced >= 0 ? Int(announced) : nil
        if let total, plan.offset >= total {
          state.failure = .refused(status: 416)
          return
        }
        let available = (total ?? plan.maxBytes) - plan.offset
        state.skip = plan.offset
        state.remaining = min(plan.length ?? available, available)
        head = ByteRangeHead(contentType: type, totalLength: total, rangesSupported: false)

      default:
        // Anything else is the answer; its body is not wanted.
        return
      }

      state.accepted = true
    }

    if let head { plan.onHead(head) }
    completionHandler(head != nil ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    var cancel = false
    var handed: Data?

    state.withLock { state in
      guard state.accepted, state.failure == nil, !state.done else { return }
      var chunk = data[...]

      if state.skip > 0 {
        let dropped = min(state.skip, chunk.count)
        state.skip -= dropped
        chunk = chunk.dropFirst(dropped)
      }

      guard !chunk.isEmpty else { return }

      if chunk.count >= state.remaining {
        chunk = chunk.prefix(state.remaining)
        state.done = true
        cancel = true
      }

      state.remaining -= chunk.count
      if !chunk.isEmpty { handed = Data(chunk) }
    }

    if let handed { plan.onData(handed) }
    if cancel { dataTask.cancel() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    let (continuation, outcome) = state.withLock { state -> (CheckedContinuation<Outcome, Never>?, Outcome) in
      var outcome = Outcome(status: state.status, failure: state.failure)

      if outcome.failure == nil {
        if state.accepted {
          // A body cut short by the connection; a cut of ours, once everything asked for was handed over, is not.
          if error != nil, !state.done { outcome.failure = .unreachable }
        } else if state.status == 0 {
          outcome.failure = .unreachable
        }
      }

      let continuation = state.continuation
      state.continuation = nil
      return (continuation, outcome)
    }

    continuation?.resume(returning: outcome)
  }
}
