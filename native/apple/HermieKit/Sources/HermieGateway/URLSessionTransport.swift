import Foundation
import Synchronization

/// The production `WebSocketTransport`: one `URLSessionWebSocketTask` per dial.
///
/// - The subprotocols go out as `Sec-WebSocket-Protocol` on the request,
///   because `webSocketTask(with:protocols:)` takes no headers and a dial plan
///   may carry both (a gated gateway's ticket, a front door's header pair).
/// - Redirects are never followed. An upgrade answered with a 3xx fails the
///   dial with a `redirect` error naming only the origin it pointed at, the
///   way the HTTP client refuses one, so an address that moved is reported
///   rather than silently dialled somewhere else. (A browser or React Native
///   socket reports this as the generic connect error below; the native app
///   says what happened.)
/// - Any other dial that does not end in an open socket (refused, a non-101
///   answer, a TLS failure) throws the reference's one connect error, a
///   `network` "WebSocket connection failed": a browser or React Native socket
///   reports nothing finer, and the dial loop's decisions are written against
///   that.
/// - The close code and reason the socket ended with finish `frames` as a
///   `WebSocketClosed`; 1006 when there was no close frame.
public struct URLSessionTransport: WebSocketTransport {
  private let configuration: URLSessionConfiguration

  public init(configuration: URLSessionConfiguration = .default) {
    self.configuration = configuration
  }

  public func connect(_ request: URLRequest, subprotocols: [String]) async throws -> any WebSocketChannel {
    var request = request

    if !subprotocols.isEmpty {
      request.setValue(subprotocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
    }

    let delegate = SocketDelegate(asked: request.url?.absoluteString ?? "")
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    let task = session.webSocketTask(with: request)

    do {
      try await withTaskCancellationHandler {
        try await delegate.waitUntilOpen {
          task.resume()
        }
      } onCancel: {
        task.cancel(with: .goingAway, reason: nil)
      }
    } catch {
      // A session keeps its delegate until it is invalidated.
      session.invalidateAndCancel()
      throw error
    }

    return URLSessionWebSocketChannel(task: task, session: session, delegate: delegate)
  }
}

/// One open `URLSessionWebSocketTask`.
final class URLSessionWebSocketChannel: WebSocketChannel {
  let frames: AsyncThrowingStream<String, any Error>

  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private let reader: Task<Void, Never>

  init(task: URLSessionWebSocketTask, session: URLSession, delegate: SocketDelegate) {
    self.task = task
    self.session = session

    let (frames, continuation) = AsyncThrowingStream<String, any Error>.makeStream()
    self.frames = frames

    reader = Task {
      while true {
        do {
          switch try await task.receive() {
          case .string(let text):
            continuation.yield(text)
          case .data(let data):
            continuation.yield(String(decoding: data, as: UTF8.self))
          @unknown default:
            continue
          }
        } catch {
          // The receive fails as the socket goes; the close code arrives
          // through the delegate, which may report it a moment later.
          let closed = await delegate.waitUntilClosed()
          continuation.finish(throwing: closed)
          session.finishTasksAndInvalidate()
          return
        }
      }
    }

    continuation.onTermination = { [reader] termination in
      if case .cancelled = termination {
        reader.cancel()
        task.cancel(with: .goingAway, reason: nil)
      }
    }
  }

  func send(text: String) async throws {
    try await task.send(.string(text))
  }

  func close(code: Int, reason: String?) async {
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
    task.cancel(with: closeCode, reason: reason.map { Data($0.utf8) })
  }
}

/// The delegate of one dial's session: reports the open, the close and the
/// completion of its single task, and refuses redirects.
final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, Sendable {
  private struct State {
    var opened = false
    var openFailed = false
    var openWaiter: CheckedContinuation<Void, any Error>?
    var closed: WebSocketClosed?
    var closeWaiters: [CheckedContinuation<WebSocketClosed, Never>] = []
    /// A redirect that was refused: its status and where it pointed.
    var refusedRedirect: (status: Int, location: URL?)?
  }

  private let state = Mutex(State())
  /// The URL dialled, for the redirect error's wording (only its origin is used).
  private let asked: String

  init(asked: String) {
    self.asked = asked
  }

  /// Start the dial and wait for the socket to open or fail.
  func waitUntilOpen(start: () -> Void) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      let settled = state.withLock { state -> Result<Void, any Error>? in
        if state.opened {
          return .success(())
        }

        if state.openFailed {
          return .failure(self.openFailure(state))
        }

        state.openWaiter = continuation
        return nil
      }

      if let settled {
        continuation.resume(with: settled)
      } else {
        start()
      }
    }
  }

  /// How the socket ended, once the session has said so.
  func waitUntilClosed() async -> WebSocketClosed {
    await withCheckedContinuation { continuation in
      let closed = state.withLock { state -> WebSocketClosed? in
        if let closed = state.closed {
          return closed
        }

        state.closeWaiters.append(continuation)
        return nil
      }

      if let closed {
        continuation.resume(returning: closed)
      }
    }
  }

  /// Why the socket did not open: a refused redirect, else the one connect error.
  private func openFailure(_ state: State) -> GatewayError {
    guard let redirect = state.refusedRedirect else {
      return GatewayError(.network, GatewayConnection.connectErrorMessage)
    }

    let asked = Self.origin(asked) ?? "The gateway address"
    // Only ever an origin: a redirect's path and query may carry anything.
    let landed = redirect.location.flatMap { Self.origin($0.absoluteString) }
    return GatewayError(
      .redirect,
      "\(asked) redirected to \(landed ?? "an address without a web origin"). Nothing was read from it. "
        + "Change the gateway address to the one you meant.",
      status: redirect.status,
      redirectedTo: landed
    )
  }

  private static func origin(_ url: String) -> String? {
    let origin = GatewayAddress.origin(of: url)
    return origin.isEmpty || origin == "null" ? nil : origin
  }

  /// The task ended before it opened.
  private func settleOpenFailure(task: URLSessionTask) {
    let failure = state.withLock { state -> GatewayError? in
      guard !state.opened else {
        return nil
      }

      // URLSession may answer a 3xx on the upgrade without asking the
      // redirection delegate first; the response says so either way.
      if state.refusedRedirect == nil, let response = task.response as? HTTPURLResponse,
        (300..<400).contains(response.statusCode)
      {
        let location = response.value(forHTTPHeaderField: "Location").flatMap {
          URL(string: $0, relativeTo: task.originalRequest?.url)?.absoluteURL
        }
        state.refusedRedirect = (response.statusCode, location)
      }

      return openFailure(state)
    }

    if let failure {
      settleOpen(.failure(failure))
    }
  }

  private func settleOpen(_ result: Result<Void, any Error>) {
    let waiter = state.withLock { state -> CheckedContinuation<Void, any Error>? in
      switch result {
      case .success: state.opened = true
      case .failure: state.openFailed = true
      }

      defer { state.openWaiter = nil }
      return state.openWaiter
    }

    waiter?.resume(with: result)
  }

  private func settleClose(_ closed: WebSocketClosed) {
    let waiters = state.withLock { state -> [CheckedContinuation<WebSocketClosed, Never>] in
      guard state.closed == nil else {
        return []
      }

      state.closed = closed
      defer { state.closeWaiters = [] }
      return state.closeWaiters
    }

    for waiter in waiters {
      waiter.resume(returning: closed)
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    settleOpen(.success(()))
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    settleClose(
      WebSocketClosed(
        code: closeCode == .invalid ? WebSocketClosed.abnormalClosure : closeCode.rawValue,
        reason: reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
      )
    )
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    settleOpenFailure(task: task)

    let socket = task as? URLSessionWebSocketTask
    let code = socket?.closeCode ?? .invalid
    settleClose(
      WebSocketClosed(
        code: code == .invalid ? WebSocketClosed.abnormalClosure : code.rawValue,
        reason: socket?.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
      )
    )
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    state.withLock { $0.refusedRedirect = (response.statusCode, request.url) }
    return nil
  }
}
