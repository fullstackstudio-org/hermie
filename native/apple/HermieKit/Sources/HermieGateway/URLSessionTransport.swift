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
  /// The largest inbound frame accepted. URLSession's default is 1 MiB, and a
  /// frame past it kills the socket: a long `session.resume` or a replay of a
  /// busy session is bigger than that, and the redial would ask for the same
  /// frame again, for ever.
  public static let maximumMessageSize = 64 * 1024 * 1024

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
    task.maximumMessageSize = Self.maximumMessageSize

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
///
/// It reads the socket into one stream of messages. `frames` (the JSON-RPC socket's, text) is a view
/// of it, started only when somebody asks, so a socket read through `messages` buffers nothing twice.
final class URLSessionWebSocketChannel: WebSocketChannel {
  let messages: AsyncThrowingStream<WebSocketMessage, any Error>

  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private let reader: Task<Void, Never>

  init(task: URLSessionWebSocketTask, session: URLSession, delegate: SocketDelegate) {
    self.task = task
    self.session = session

    let (messages, continuation) = AsyncThrowingStream<WebSocketMessage, any Error>.makeStream()
    self.messages = messages

    reader = Task {
      while true {
        do {
          switch try await task.receive() {
          case .string(let text):
            continuation.yield(.text(text))
          case .data(let data):
            continuation.yield(.binary(data))
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

  /// The text of every message: a binary one is read as text, as it was before there were messages.
  /// Read once; a reader that stops takes the socket down, as it always did.
  var frames: AsyncThrowingStream<String, any Error> {
    let messages = self.messages

    return AsyncThrowingStream { continuation in
      let forwarder = Task {
        do {
          for try await message in messages {
            switch message {
            case .text(let text): continuation.yield(text)
            case .binary(let data): continuation.yield(String(decoding: data, as: UTF8.self))
            }
          }

          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }

      continuation.onTermination = { _ in forwarder.cancel() }
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

    return Self.redirectError(
      asked: asked,
      landed: redirect.location?.absoluteString,
      status: redirect.status
    )
  }

  /// `redirectError` of `fetch-json.ts`, worded the same, naming only origins
  /// and hosts: a WebSocket URL can carry a session token in its query, and a
  /// redirect's path and query may carry anything.
  static func redirectError(asked: String, landed: String?, status: Int) -> GatewayError {
    let askedOrigin = origin(asked)
    let landedOrigin = landed.flatMap(origin)
    let askedHost = askedOrigin.map(host) ?? ""
    let landedHost = landedOrigin.map(host) ?? ""
    let advice = "Nothing was read from it. Change the gateway address to the one you meant."
    let message: String

    if let landedOrigin, let askedOrigin {
      if landedHost != askedHost {
        message = "\(askedHost) redirected to \(landedHost), which is a different host. \(advice)"
      } else if isSecure(askedOrigin) && !isSecure(landedOrigin) {
        message = "\(askedOrigin) redirected to \(landedOrigin), which is not https. \(advice)"
      } else if landedOrigin != askedOrigin {
        message = "\(askedOrigin) redirected to \(landedOrigin), which is a different address. \(advice)"
      } else {
        message = "\(askedOrigin) redirected to itself, which was not followed. \(advice)"
      }
    } else {
      message = "\(askedOrigin ?? "The gateway address") answered with a redirect that was not followed. \(advice)"
    }

    return GatewayError(
      .redirect,
      message,
      status: status,
      redirectedTo: landedHost.isEmpty ? nil : landedHost,
      redirectedOrigin: landedOrigin
    )
  }

  private static func isSecure(_ origin: String) -> Bool {
    origin.hasPrefix("https:") || origin.hasPrefix("wss:")
  }

  /// The hostname of an origin, IPv6 without its brackets.
  private static func host(_ origin: String) -> String {
    var host = WHATWGURL.parse(origin)?.host ?? ""

    if host.hasPrefix("[") && host.hasSuffix("]") {
      host = String(host.dropFirst().dropLast())
    }

    return host
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
