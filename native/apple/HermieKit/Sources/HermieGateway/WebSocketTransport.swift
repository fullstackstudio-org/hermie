import Foundation

/// Opens WebSockets. The connection dials only through this, so a test can
/// hand it a scripted gateway and the app a `URLSessionTransport`.
public protocol WebSocketTransport: Sendable {
  /// Open one socket and return once the upgrade has completed (the socket is
  /// open). `subprotocols` go out as `Sec-WebSocket-Protocol`; the request's
  /// headers go out as they are.
  ///
  /// Throws when the socket never opens. A `GatewayError` is passed through as
  /// the dial's failure; anything else becomes the reference's
  /// "WebSocket connection failed" network error. Must honour cancellation.
  func connect(_ request: URLRequest, subprotocols: [String]) async throws -> any WebSocketChannel
}

/// One open socket.
public protocol WebSocketChannel: Sendable {
  /// Send one text frame.
  func send(text: String) async throws

  /// The inbound text frames, in order. Read it once: it is a single stream.
  /// It finishes by throwing `WebSocketClosed` with the close code and reason,
  /// whichever side closed, including after `close(code:reason:)`.
  var frames: AsyncThrowingStream<String, any Error> { get }

  /// Close the socket. `frames` finishes afterwards.
  func close(code: Int, reason: String?) async
}

/// How a socket ended: the close code and reason the `close` event carries.
public struct WebSocketClosed: Error, Sendable, Equatable {
  /// 1006 for a socket that went away without a close frame.
  public var code: Int
  public var reason: String

  public init(code: Int, reason: String = "") {
    self.code = code
    self.reason = reason
  }

  /// Normal closure, what the client sends when it closes a socket itself.
  public static let normalClosure = 1000
  /// No close frame was received.
  public static let abnormalClosure = 1006
  /// A close frame without a status code.
  public static let noStatus = 1005
}

/// Turning a `DialPlan` into what a transport dials, the job the reference's
/// `DialPlanSocketFactory` does for the vendored client.
///
/// The factory exists in TypeScript because the vendored client passes only a
/// URL to its socket factory, so the plan had to be armed beside it and
/// consumed by the next dial. Here the dial loop hands the plan to the
/// transport directly: one plan, one dial, by construction.
public enum WebSocketDial {
  /// The request for one dial: the plan's URL, and its headers when it has any.
  /// `nil` when the URL does not parse.
  public static func request(for plan: DialPlan) -> URLRequest? {
    guard let url = URL(string: plan.url) else {
      return nil
    }

    var request = URLRequest(url: url)

    for name in plan.headers.keys.sorted() {
      request.setValue(plan.headers[name], forHTTPHeaderField: name)
    }

    return request
  }

  /// `isGatewayWebSocketUrl`: a `ws://` or `wss://` URL is the only thing the
  /// connection will dial.
  public static func isWebSocketURL(_ value: String) -> Bool {
    guard let url = WHATWGURL.parse(value) else {
      return false
    }

    return url.scheme == "ws" || url.scheme == "wss"
  }
}
