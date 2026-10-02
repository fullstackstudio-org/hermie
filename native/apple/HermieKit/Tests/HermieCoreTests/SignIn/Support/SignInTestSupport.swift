import Foundation
import HermieGateway
import HermieStore
import Network
import Synchronization
import Testing

@testable import HermieCore

// MARK: - A stubbed transport

/// One request as the stub saw it.
struct StubRequest: Sendable {
  var method: String
  var url: String
  /// Header names lowercased.
  var headers: [String: String]
  var body: Data

  var path: String { URL(string: url)?.path() ?? "" }
  var scheme: String { URL(string: url)?.scheme ?? "" }
  var bodyText: String { String(decoding: body, as: UTF8.self) }

  func header(_ name: String) -> String? { headers[name.lowercased()] }
}

enum StubReply: Sendable {
  case respond(status: Int, body: Data)
  case fail(URLError.Code)

  static func json(_ text: String, status: Int = 200) -> StubReply {
    .respond(status: status, body: Data(text.utf8))
  }
}

/// A fake server behind a stubbed `URLProtocol`, routed by a header so parallel tests stay apart.
final class StubServer: Sendable {
  typealias Handler = @Sendable (StubRequest) -> StubReply

  static let routingHeader = "X-Stub-Server"

  let id = UUID().uuidString
  private let state: Mutex<(handler: Handler, requests: [StubRequest])>

  init(_ handler: @escaping Handler) {
    state = Mutex((handler, []))
    StubRegistry.register(self)
  }

  var requests: [StubRequest] { state.withLock { $0.requests } }

  fileprivate func answer(_ request: StubRequest) -> StubReply {
    state.withLock { state in
      state.requests.append(request)
      return state.handler
    }(request)
  }

  func transport() -> HTTPTransport {
    let configuration = URLSessionConfiguration.ephemeral

    configuration.protocolClasses = [StubURLProtocol.self]
    configuration.httpAdditionalHeaders = [Self.routingHeader: id]

    return HTTPTransport(session: HTTPTransport.makeSession(configuration: configuration))
  }
}

private enum StubRegistry {
  private static let servers = Mutex<[String: StubServer]>([:])

  static func register(_ server: StubServer) {
    servers.withLock { $0[server.id] = server }
  }

  static func server(_ id: String) -> StubServer? {
    servers.withLock { $0[id] }
  }
}

final class StubURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let id = request.value(forHTTPHeaderField: StubServer.routingHeader),
      let server = StubRegistry.server(id)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }

    var headers: [String: String] = [:]

    for (name, value) in request.allHTTPHeaderFields ?? [:]
    where name.caseInsensitiveCompare(StubServer.routingHeader) != .orderedSame {
      headers[name.lowercased()] = value
    }

    let seen = StubRequest(
      method: request.httpMethod ?? "GET",
      url: url.absoluteString,
      headers: headers,
      body: request.httpBody ?? Self.read(request.httpBodyStream)
    )

    switch server.answer(seen) {
    case .respond(let status, let body):
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    case .fail(let code):
      client?.urlProtocol(self, didFailWithError: URLError(code))
    }
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream?) -> Data {
    guard let stream else {
      return Data()
    }

    stream.open()
    defer { stream.close() }

    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)

    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)

      guard count > 0 else {
        break
      }

      data.append(buffer, count: count)
    }

    return data
  }
}

/// A gateway's answers, the way the fake gateway gives them.
enum GatewayStub {
  static let ungatedStatus = #"{"auth_required":false,"auth_flows":[],"version":"1.2.3"}"#
  static let gatedStatus = #"{"auth_required":true,"auth_flows":["cookie","native_pkce","native_revoke"],"version":"1.2.3"}"#
  static let providers = #"{"providers":[{"name":"self-hosted","display_name":"Self-Hosted","supports_password":true}]}"#
  static let tokens = #"{"access_token":"at-1","refresh_token":"rt-1","expires_at":4102444800,"provider":"self-hosted","user_id":"tester@example.invalid"}"#
  static let me = #"{"user_id":"tester@example.invalid","email":"tester@example.invalid","display_name":"Tester","provider":"self-hosted"}"#

  /// A gated gateway that signs in, answers who you are and takes a revoke.
  static func gated() -> StubServer {
    StubServer { request in
      switch request.path {
      case "/api/status": .json(gatedStatus)
      case "/api/auth/providers": .json(providers)
      case "/auth/native/token": .json(tokens)
      case "/auth/native/refresh": .json(tokens)
      case "/api/auth/me": request.header("authorization") == "Bearer at-1" ? .json(me) : .json("{}", status: 401)
      case "/auth/native/revoke": .json("{}")
      default: .json("{}", status: 404)
      }
    }
  }

  /// An ungated gateway whose session token is `good-token`.
  static func ungated() -> StubServer {
    StubServer { request in
      switch request.path {
      case "/api/status": .json(ungatedStatus)
      case "/api/profiles":
        request.header("x-hermes-session-token") == "good-token" ? .json(#"{"profiles":[]}"#) : .json("{}", status: 401)
      default: .json("{}", status: 404)
      }
    }
  }
}

// MARK: - Fakes for the browser and the listener

/// A listener that never touches a socket: the test hands it requests.
actor FakeListener: LoopbackCallbackListening {
  enum StartOutcome: Sendable {
    case ok
    case fail(LoopbackListenerError)
  }

  private let outcome: StartOutcome
  /// The port it pretends the system chose.
  let port: UInt16
  private var accepts: (@Sendable (String) -> Bool)?
  private var waiter: CheckedContinuation<String, any Error>?
  private var delivered: String?
  private(set) var stopped = false
  private(set) var started = false
  private(set) var resumes = 0
  private var startWaiters: [CheckedContinuation<Void, Never>] = []

  init(_ outcome: StartOutcome = .ok, port: UInt16 = 51_234) {
    self.outcome = outcome
    self.port = port
  }

  @discardableResult
  func start(accepting accepts: @escaping @Sendable (String) -> Bool) async throws -> UInt16 {
    if case .fail(let error) = outcome {
      throw error
    }

    self.accepts = accepts
    started = true

    for waiter in startWaiters {
      waiter.resume()
    }

    startWaiters = []
    return port
  }

  /// The listening ended early, as when listening again after a suspension failed.
  func fail(_ error: LoopbackListenerError) {
    stopped = true
    waiter?.resume(throwing: error)
    waiter = nil
  }

  /// Wait until `start` was called.
  func waitUntilStarted() async {
    if started {
      return
    }

    await withCheckedContinuation { startWaiters.append($0) }
  }

  /// A request arrives: answers whether it was taken (the real one answers 200 or 400).
  func deliver(_ url: String) -> Bool {
    guard !stopped, delivered == nil, let accepts, accepts(url) else {
      return false
    }

    delivered = url
    waiter?.resume(returning: url)
    waiter = nil
    return true
  }

  func callback() async throws -> String {
    if let delivered {
      return delivered
    }

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, any Error>) in
        if stopped {
          continuation.resume(throwing: LoopbackListenerError.cancelled)
        } else {
          waiter = continuation
        }
      }
    } onCancel: {
      Task { await self.stop() }
    }
  }

  func resume() async {
    resumes += 1
  }

  func stop() async {
    stopped = true
    waiter?.resume(throwing: LoopbackListenerError.cancelled)
    waiter = nil
  }
}

/// A listener whose `stop()` waits for `gate`: holds an attempt's cleanup back for as long as a test wants.
actor SlowStopListener: LoopbackCallbackListening {
  private let gate: ManualTimer
  private var waiter: CheckedContinuation<String, any Error>?
  private var stopped = false

  init(gate: ManualTimer) {
    self.gate = gate
  }

  @discardableResult
  func start(accepting accepts: @escaping @Sendable (String) -> Bool) async throws -> UInt16 {
    51_235
  }

  func callback() async throws -> String {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, any Error>) in
      if stopped {
        continuation.resume(throwing: LoopbackListenerError.cancelled)
      } else {
        waiter = continuation
      }
    }
  }

  func resume() async {}

  func stop() async {
    try? await gate.sleep(.zero)
    stopped = true
    waiter?.resume(throwing: LoopbackListenerError.cancelled)
    waiter = nil
  }
}

/// Hands out the listeners it was given, one per attempt.
final class ListenerQueue: Sendable {
  private let listeners: Mutex<[FakeListener]>

  init(_ listeners: [FakeListener]) {
    self.listeners = Mutex(listeners)
  }

  func next() -> any LoopbackCallbackListening {
    listeners.withLock { $0.isEmpty ? FakeListener() : $0.removeFirst() }
  }
}

/// A browser sheet that records what it was asked to show, and can be closed "by the person".
@MainActor
final class FakePresenter: BrowserSessionPresenting {
  var opened: [URL] = []
  var closes = 0
  var canOpen = true
  private var onEnd: (@MainActor (BrowserSessionEnd) -> Void)?

  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool {
    guard canOpen else {
      return false
    }

    opened.append(url)
    self.onEnd = onEnd
    return true
  }

  func close() {
    closes += 1
    onEnd = nil
  }

  func personClosesIt() {
    let end = onEnd

    onEnd = nil
    end?(.closedByPerson)
  }

  /// The `state` of the last authorize URL opened.
  var state: String {
    opened.last.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value } ?? ""
  }

  /// The `redirect_uri` of the last authorize URL opened.
  var redirectURI: String {
    opened.last.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "redirect_uri" }?.value }
      ?? ""
  }

  /// What the gateway would redirect the browser to for this attempt.
  func callbackURL(code: String = "code-1", state: String? = nil) -> String {
    "\(redirectURI)?code=\(code)&state=\(state ?? self.state)"
  }
}

/// A timer the test fires by hand: `sleep` never returns until `fire()` (or cancellation).
final class ManualTimer: Sendable {
  private let waiters = Mutex<[CheckedContinuation<Void, Never>]>([])
  private let fired = Mutex(false)

  var sleep: @Sendable (Duration) async throws -> Void {
    { _ in
      try await self.wait()
    }
  }

  private func wait() async throws {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let now = fired.withLock { $0 }

        if now {
          continuation.resume()
        } else {
          waiters.withLock { $0.append(continuation) }
        }
      }
    } onCancel: {
      let all = waiters.withLock { list in
        defer { list = [] }
        return list
      }

      for waiter in all {
        waiter.resume()
      }
    }

    try Task.checkCancellation()
  }

  func fire() {
    fired.withLock { $0 = true }

    let all = waiters.withLock { list in
      defer { list = [] }
      return list
    }

    for waiter in all {
      waiter.resume()
    }
  }
}

// MARK: - Building a model

@MainActor
struct OnboardingHarness {
  let store: SQLiteStore
  let secrets: InMemorySecretStorage
  let directory: GatewayDirectory
  let accounts: GatewayAccounts

  init(
    transport: HTTPTransport,
    resolve: (@Sendable (String, [String: String], FrontDoor) async throws -> OnboardingProbe)? = nil,
    listener: (@Sendable () -> any LoopbackCallbackListening)? = nil,
    sleep: (@Sendable (Duration) async throws -> Void)? = nil,
    secrets: InMemorySecretStorage = InMemorySecretStorage()
  ) throws {
    let store = try SQLiteStore(.inMemory)
    let directory = GatewayDirectory(store: GatewayRegistryStore(store: store), changes: KeyValueStore(store: store))
    let services = GatewayServices(
      store: store,
      secrets: secrets,
      transport: transport,
      resolve: resolve,
      makeListener: listener ?? { FakeListener() },
      nowMilliseconds: { 1_700_000_000_000 },
      nowSeconds: { 1_700_000_000 },
      sleep: sleep ?? Self.instantDebounce
    )

    self.store = store
    self.secrets = secrets
    self.directory = directory
    self.accounts = GatewayAccounts(directory: directory, services: services)
  }

  /// The probe's pause passes at once; the sign-in timeout never does (only cancellation ends it).
  static let instantDebounce: @Sendable (Duration) async throws -> Void = { duration in
    if duration < .seconds(60) {
      try Task.checkCancellation()
    } else {
      try await Task.sleep(for: .seconds(86_400))
    }
  }

  func model(_ mode: OnboardingModel.Mode = .newGateway) -> OnboardingModel {
    OnboardingModel(mode: mode, accounts: accounts)
  }

  func registry() async throws -> GatewayRegistry {
    try await GatewayRegistryStore(store: store).load()
  }

  func config(_ id: String) async -> StoredGatewayConfig? {
    await accounts.config(for: id)
  }
}

/// Wait, by yielding, until `condition` holds. Generous, so a loaded machine does not fail it.
@MainActor
func eventually(_ condition: @MainActor () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async {
  for _ in 0..<4_000 {
    if condition() {
      return
    }

    try? await Task.sleep(for: .milliseconds(5))
  }

  Issue.record("the condition never held", sourceLocation: sourceLocation)
}

// MARK: - Raw loopback HTTP

/// Send raw bytes to `127.0.0.1:port` and read everything back until the server closes.
func rawHTTP(port: UInt16, _ request: String) async throws -> String {
  let connection = NWConnection(
    host: .ipv4(.loopback),
    port: NWEndpoint.Port(rawValue: port)!,
    using: .tcp
  )
  let queue = DispatchQueue(label: "test.raw-http")
  let ready = OneShot<Void>()

  connection.stateUpdateHandler = { state in
    switch state {
    case .ready: ready.resolve(.success(()))
    case .failed(let error), .waiting(let error): ready.resolve(.failure(error))
    default: break
    }
  }

  connection.start(queue: queue)
  defer { connection.cancel() }

  try await ready.value

  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in continuation.resume() })
  }

  var data = Data()

  while true {
    let chunk: Data? = await withCheckedContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { content, _, complete, error in
        if let content, !content.isEmpty {
          continuation.resume(returning: content)
        } else {
          continuation.resume(returning: complete || error != nil ? nil : Data())
        }
      }
    }

    guard let chunk else {
      break
    }

    data.append(chunk)
  }

  return String(decoding: data, as: UTF8.self)
}

/// A GET as a browser sends it.
func browserGET(_ target: String, port: UInt16, host: String? = nil) -> String {
  "GET \(target) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\nUser-Agent: test\r\nAccept: text/html\r\n\r\n"
}
