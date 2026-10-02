import Foundation
import HermieGateway
import Network
import Synchronization

/// Why the loopback listener could not do its job. No case carries a URL, a code or a request.
public enum LoopbackListenerError: Error, Sendable, Equatable, CustomStringConvertible {
  /// Something else on this device already listens on the callback port (another Hermes client,
  /// typically). The sign-in cannot receive its redirect here; the in-app page can.
  case portInUse(port: UInt16)
  /// The system refused to listen for another reason.
  case unavailable
  /// The attempt was stopped before a callback arrived.
  case cancelled
  /// `callback()` was called while another call was already waiting.
  case alreadyWaiting

  public var description: String {
    switch self {
    case .portInUse(let port): "Another app on this device is already listening on 127.0.0.1:\(port)."
    case .unavailable: "Hermie could not listen for the sign-in redirect on this device."
    case .cancelled: "The sign-in listener was stopped."
    case .alreadyWaiting: "The sign-in listener is already waiting for a callback."
    }
  }
}

/// The page the browser shows after Hermie answered it. Plain text in, escaped HTML out.
public struct LoopbackPage: Sendable, Equatable {
  public var title: String
  public var message: String
  /// The `lang` of the page, e.g. `en`.
  public var language: String

  public init(title: String, message: String, language: String) {
    self.title = title
    self.message = message
    self.language = language
  }

  /// A self-contained document: no script, no external resource, nothing from the request.
  public var html: String {
    """
    <!doctype html>
    <html lang="\(Self.escape(language))">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>\(Self.escape(title))</title>
    <style>
    body { font: 17px -apple-system, system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; \
    padding: 0 1rem; text-align: center; color: #1c1c1e; background: #ffffff; }
    @media (prefers-color-scheme: dark) { body { color: #f2f2f7; background: #000000; } }
    h1 { font-size: 1.4rem; }
    </style>
    </head>
    <body>
    <h1>\(Self.escape(title))</h1>
    <p>\(Self.escape(message))</p>
    </body>
    </html>
    """
  }

  static func escape(_ text: String) -> String {
    var out = ""

    for character in text {
      switch character {
      case "&": out += "&amp;"
      case "<": out += "&lt;"
      case ">": out += "&gt;"
      case "\"": out += "&quot;"
      case "'": out += "&#39;"
      default: out.append(character)
      }
    }

    return out
  }
}

/// The two answers the listener gives: the callback it took, and everything else.
public struct LoopbackPages: Sendable, Equatable {
  public var success: LoopbackPage
  public var rejected: LoopbackPage

  public init(success: LoopbackPage, rejected: LoopbackPage) {
    self.success = success
    self.rejected = rejected
  }

  /// The English pages, for tests and for a caller with no string table.
  public static let english = LoopbackPages(
    success: LoopbackPage(
      title: "You can return to Hermie",
      message: "Hermie finishes the sign-in. This page can be closed.",
      language: "en"
    ),
    rejected: LoopbackPage(
      title: "Not a Hermie sign-in",
      message: "This request does not belong to the sign-in Hermie is waiting for.",
      language: "en"
    )
  )
}

/// A listener for the sign-in redirect, so tests can stand in for the socket.
public protocol LoopbackCallbackListening: Sendable {
  /// Listen, and answer the port once listening. `accepts` is asked about every request that is
  /// shaped like the callback, with the full URL it named; the first one it approves is answered with
  /// the success page and ends the listening. Throws `LoopbackListenerError`.
  func start(accepting accepts: @escaping @Sendable (String) -> Bool) async throws -> UInt16
  /// The URL of the approved callback, once there is one. Throws `cancelled` when stopped first,
  /// including by cancelling the calling task.
  func callback() async throws -> String
  /// Listen again if the system took the socket away while the app was suspended. No effect while
  /// listening, or after the callback arrived or the listener was stopped. When listening again
  /// fails, the wait in `callback()` ends with that failure.
  func resume() async
  /// Stop listening and close every connection. Idempotent.
  func stop() async
}

/**
 The RFC 8252 loopback redirect receiver: an HTTP listener on `127.0.0.1` and a port the system
 chooses for each attempt (RFC 8252 §7.3), for exactly as long as that attempt runs.

 The attempt asks the gateway to send the browser to `http://127.0.0.1:<port>/callback` with the code
 and the state. A port nobody can know in advance is a port nobody can be listening on first. This
 listener:

 - binds the IPv4 loopback address only (never a wildcard), refuses endpoint reuse, and accepts local
   connections only;
 - reads at most 8 KiB of request head per connection, with a deadline, and handles a bounded number of
   connections at once, so a client that never finishes its request cannot hold it;
 - answers anything that is not `GET /callback…` with `Host: 127.0.0.1:<port>`, and any callback the
   caller does not approve (a wrong `state`, no code), with `400` and the rejected page, and keeps
   listening;
 - answers the first approved callback with the success page, hands its URL over and stops listening
   at once: the callback is single-use.

 The pages carry no script and no external resource, and nothing from the request is echoed into them.
 Nothing is logged: a callback URL carries an authorization code.
 */
public actor LoopbackCallbackListener: LoopbackCallbackListening {
  /// The path of `PKCE.redirectURI`, kept for every port.
  public static let callbackPath = "/callback"

  /// The redirect URI for a listener on `port`.
  public static func redirectURI(port: UInt16) -> String {
    "http://127.0.0.1:\(port)\(callbackPath)"
  }

  static let maxHeadBytes = 8 * 1024
  /// How long binding may take before the listener is reported unavailable.
  static let bindPatience: Duration = .seconds(10)
  /// How long stopping waits for the socket to be released.
  static let closePatience: Duration = .seconds(5)
  static let maxConnections = 16

  public nonisolated let requestedPort: UInt16
  private let pages: LoopbackPages
  private let readTimeout: Duration
  private let queue = DispatchQueue(label: "dev.hermie.signin.loopback")

  private var listener: NWListener?
  /// Bumped whenever a listener is replaced or shut down, so a late callback from an old one is ignored.
  private var generation = 0
  /// The generation whose listener reached `ready`: only that one's failure is a socket taken away.
  private var readyGeneration: Int?
  /// The port actually bound: `requestedPort`, or the system's choice for port 0.
  public private(set) var port: UInt16?
  private var accepts: (@Sendable (String) -> Bool)?
  private var connections: [Int: NWConnection] = [:]
  private var nextConnectionID = 0
  private var waiter: CheckedContinuation<String, any Error>?
  private var deliveredURL: String?
  private var stopped = false
  /// Why the listening ended early, for a `callback()` that starts waiting afterwards.
  private var failure: LoopbackListenerError?

  /// - Parameters:
  ///   - port: 0, the default, lets the system choose; a test may name one.
  ///   - readTimeout: how long one connection may take to send its request head.
  public init(port: UInt16 = 0, pages: LoopbackPages = .english, readTimeout: Duration = .seconds(15)) {
    self.requestedPort = port
    self.pages = pages
    self.readTimeout = readTimeout
  }

  @discardableResult
  public func start(accepting accepts: @escaping @Sendable (String) -> Bool) async throws -> UInt16 {
    guard !stopped else {
      throw LoopbackListenerError.cancelled
    }

    self.accepts = accepts

    if listener == nil {
      try await bind()
    }

    guard let port else {
      throw LoopbackListenerError.unavailable
    }

    return port
  }

  public func callback() async throws -> String {
    if let deliveredURL {
      return deliveredURL
    }

    guard waiter == nil else {
      throw LoopbackListenerError.alreadyWaiting
    }

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, any Error>) in
        park(continuation)
      }
    } onCancel: {
      Task { await self.stop() }
    }
  }

  public func resume() async {
    guard !stopped, deliveredURL == nil, accepts != nil, listener == nil else {
      return
    }

    await listenAgain()
  }

  /// Returns once the socket is closed, so the port can be bound again straight away.
  public func stop() async {
    stopped = true

    let closed = shutDown()

    await closed?.wait()
    waiter?.resume(throwing: LoopbackListenerError.cancelled)
    waiter = nil
  }

  // MARK: - Listening

  private func park(_ continuation: CheckedContinuation<String, any Error>) {
    if let deliveredURL {
      continuation.resume(returning: deliveredURL)
    } else if stopped {
      continuation.resume(throwing: failure ?? LoopbackListenerError.cancelled)
    } else {
      waiter = continuation
    }
  }

  private func bind() async throws {
    let wanted = port ?? requestedPort
    let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())

    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: wanted) ?? .any)
    parameters.acceptLocalOnly = true
    parameters.allowLocalEndpointReuse = false
    parameters.includePeerToPeer = false

    let created: NWListener

    do {
      created = try NWListener(using: parameters)
    } catch {
      throw Self.startFailure(error, port: wanted)
    }

    generation += 1

    let current = generation
    let ready = OneShot<UInt16>()

    created.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        ready.resolve(.success(created.port?.rawValue ?? wanted))
      case .waiting(let error), .failed(let error):
        // Before `ready` this is a failure to listen, which `bind()` reports (a listener waits rather
        // than fails on some errors, and a port in use never clears by itself). After `ready` it is
        // the socket taken away, which `listenerFailed` handles.
        ready.resolve(.failure(Self.startFailure(error, port: wanted)))
        Task { await self?.listenerFailed(generation: current) }
      case .cancelled:
        ready.resolve(.failure(LoopbackListenerError.cancelled))
      default:
        break
      }
    }

    created.newConnectionHandler = { [weak self] connection in
      guard let self else {
        connection.cancel()
        return
      }

      Task { await self.serve(connection, generation: current) }
    }

    listener = created
    created.start(queue: queue)

    // A listener that never says ready or failed is not one to wait on for ever.
    let patience = Task {
      try? await Task.sleep(for: Self.bindPatience)

      guard !Task.isCancelled else {
        return
      }

      ready.resolve(.failure(LoopbackListenerError.unavailable))
    }

    defer { patience.cancel() }

    do {
      port = try await ready.value
      readyGeneration = current
    } catch {
      if generation == current {
        listener = nil
      }

      created.stateUpdateHandler = nil
      created.newConnectionHandler = nil
      created.cancel()
      throw error
    }
  }

  /// The system took a ready listener away (on iOS, a suspended app's sockets can be reclaimed).
  /// Listen again on the same port, which the attempt's redirect URI names; when that fails, the
  /// attempt is over and `callback()` says why.
  private func listenerFailed(generation failed: Int) async {
    // A listener that failed to start is reported by `bind()` itself; listening again here would
    // race the caller that is already giving up.
    guard failed == generation, failed == readyGeneration, !stopped, deliveredURL == nil else {
      return
    }

    await shutDown()?.wait()
    await listenAgain()
  }

  /// Bind the attempt's port again, or end the attempt with the reason it could not be.
  private func listenAgain() async {
    guard !stopped, deliveredURL == nil else {
      return
    }

    do {
      try await bind()
    } catch {
      stopped = true
      await shutDown()?.wait()
      waiter?.resume(throwing: (error as? LoopbackListenerError) ?? .unavailable)
      waiter = nil
      failure = (error as? LoopbackListenerError) ?? .unavailable
    }
  }

  #if DEBUG
    /// Tests only: what happens when the system takes the socket away. `meanwhile` runs between the
    /// socket going and the listener trying to listen again.
    func simulateSocketTakenAway(meanwhile: @Sendable () async -> Void = {}) async {
      readyGeneration = generation
      await shutDown()?.wait()
      await meanwhile()
      await listenAgain()
    }
  #endif

  /// Stop accepting and close every connection. Answers what to await for the socket to be gone.
  @discardableResult
  private func shutDown() -> OneShot<Void>? {
    generation += 1

    var closed: OneShot<Void>?

    if let listener {
      let done = OneShot<Void>()

      // Bounded: a listener that never reports `cancelled` must not hold `stop()` for ever.
      Task {
        try? await Task.sleep(for: Self.closePatience)
        done.resolve(.success(()))
      }

      listener.newConnectionHandler = nil
      listener.stateUpdateHandler = { state in
        if case .cancelled = state {
          done.resolve(.success(()))
        }
      }
      listener.cancel()
      closed = done
    }

    listener = nil

    for connection in connections.values {
      connection.cancel()
    }

    connections = [:]
    return closed
  }

  // MARK: - One connection

  private func serve(_ connection: NWConnection, generation current: Int) async {
    guard current == generation, !stopped, deliveredURL == nil, connections.count < Self.maxConnections else {
      connection.cancel()
      return
    }

    let id = nextConnectionID

    nextConnectionID += 1
    connections[id] = connection
    connection.start(queue: queue)

    let head = await Self.readHead(connection, limit: Self.maxHeadBytes, timeout: readTimeout)

    guard connections.removeValue(forKey: id) != nil, !stopped, deliveredURL == nil, let port else {
      connection.cancel()
      return
    }

    guard let head, let request = LoopbackRequest(head: head), request.isCallback(port: port) else {
      await Self.respond(connection, status: 400, page: pages.rejected)
      return
    }

    let url = "http://127.0.0.1:\(port)\(request.target)"

    guard let accepts, accepts(url) else {
      await Self.respond(connection, status: 400, page: pages.rejected)
      return
    }

    // Single use: nothing after this point can deliver a second callback.
    deliveredURL = url

    let closed = shutDown()

    await Self.respond(connection, status: 200, page: pages.success)
    await closed?.wait()

    waiter?.resume(returning: url)
    waiter = nil
  }

  /// The request head, or nil when the client closed, sent too much, or took too long.
  static func readHead(_ connection: NWConnection, limit: Int, timeout: Duration) async -> Data? {
    let deadline = Task {
      try? await Task.sleep(for: timeout)

      if !Task.isCancelled {
        connection.cancel()
      }
    }

    defer { deadline.cancel() }

    var data = Data()
    let end = Data("\r\n\r\n".utf8)

    while data.count <= limit {
      guard let chunk = await receive(connection, maximumLength: limit + 1 - data.count) else {
        return nil
      }

      data.append(chunk)

      if data.range(of: end) != nil {
        return data.count <= limit ? data : nil
      }
    }

    return nil
  }

  private static func receive(_ connection: NWConnection, maximumLength: Int) async -> Data? {
    await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
      connection.receive(minimumIncompleteLength: 1, maximumLength: max(1, maximumLength)) { content, _, _, _ in
        continuation.resume(returning: content.flatMap { $0.isEmpty ? nil : $0 })
      }
    }
  }

  static func respond(_ connection: NWConnection, status: Int, page: LoopbackPage) async {
    let body = Data(page.html.utf8)
    let reason = status == 200 ? "OK" : "Bad Request"
    let head =
      "HTTP/1.1 \(status) \(reason)\r\n"
      + "Content-Type: text/html; charset=utf-8\r\n"
      + "Content-Length: \(body.count)\r\n"
      + "Cache-Control: no-store\r\n"
      + "Connection: close\r\n"
      + "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n"
      + "Referrer-Policy: no-referrer\r\n"
      + "X-Content-Type-Options: nosniff\r\n"
      + "X-Frame-Options: DENY\r\n"
      + "\r\n"

    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      connection.send(
        content: Data(head.utf8) + body,
        contentContext: .finalMessage,
        isComplete: true,
        completion: .contentProcessed { _ in continuation.resume() }
      )
    }

    connection.cancel()
  }

  static func startFailure(_ error: any Error, port: UInt16) -> LoopbackListenerError {
    if let error = error as? NWError, case .posix(let code) = error, code == .EADDRINUSE || code == .EACCES {
      return .portInUse(port: port)
    }

    return .unavailable
  }
}

/// The request line and the `Host` header of one request head; nothing else is read.
struct LoopbackRequest: Equatable {
  var method: String
  var target: String
  var host: String?

  init?(head: Data) {
    guard let text = String(data: head, encoding: .utf8) else {
      return nil
    }

    let lines = text.components(separatedBy: "\r\n")
    let requestLine = lines.first?.split(separator: " ", omittingEmptySubsequences: false) ?? []

    guard requestLine.count == 3, requestLine[2].hasPrefix("HTTP/1.") else {
      return nil
    }

    method = String(requestLine[0])
    target = String(requestLine[1])
    host = nil

    for line in lines.dropFirst() where !line.isEmpty {
      guard let colon = line.firstIndex(of: ":") else {
        return nil
      }

      let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()

      if name == "host" {
        // Two Host headers is a request nobody honest sends.
        guard host == nil else {
          return nil
        }

        host = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
    }
  }

  /// `GET /callback` or `GET /callback?…`, addressed to this listener by its loopback literal. The
  /// Host check keeps a page on another origin that resolves to 127.0.0.1 (DNS rebinding) out.
  func isCallback(port: UInt16) -> Bool {
    let path = LoopbackCallbackListener.callbackPath
    let shaped = target == path || target.hasPrefix(path + "?")

    return method == "GET" && shaped && host?.lowercased() == "127.0.0.1:\(port)"
  }
}

/// A value that arrives once and is awaited once, from a callback on any queue.
final class OneShot<Value: Sendable>: Sendable {
  private struct State {
    var continuation: CheckedContinuation<Value, any Error>?
    var result: Result<Value, any Error>?
  }

  private let state = Mutex(State())

  func resolve(_ result: Result<Value, any Error>) {
    let waiting: CheckedContinuation<Value, any Error>? = state.withLock { state in
      guard state.result == nil else {
        return nil
      }

      state.result = result

      defer { state.continuation = nil }

      return state.continuation
    }

    waiting?.resume(with: result)
  }

  /// Wait for the value, ignoring what it was.
  func wait() async {
    _ = try? await value
  }

  var value: Value {
    get async throws {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Value, any Error>) in
        let ready: Result<Value, any Error>? = state.withLock { state in
          if let result = state.result {
            return result
          }

          state.continuation = continuation
          return nil
        }

        if let ready {
          continuation.resume(with: ready)
        }
      }
    }
  }
}
