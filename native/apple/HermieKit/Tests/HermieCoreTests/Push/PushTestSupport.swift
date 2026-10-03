import Foundation
import HermieProtocol
import HermieStore
import Network
import Synchronization
import Testing

@testable import HermieCore

// MARK: - Values

/// A token, a handle and secrets in the relay's own shapes. Made up; nothing real.
enum PushFixtures {
  static let tokenA = APNsDeviceToken(hex: String(repeating: "ab", count: 32))!
  static let tokenB = APNsDeviceToken(hex: String(repeating: "cd", count: 32))!
  static let topic = "dev.hermie.app"
  static let relay = "https://relay.example.test"

  static func handle(_ n: Int) -> String {
    "h_" + String(String(repeating: "\(n % 10)", count: 22))
  }

  static func secret(_ tag: String, _ n: Int) -> String {
    String((tag + "_\(n)_" + String(repeating: "x", count: 43)).prefix(43))
  }

  static func registration(
    _ gatewayId: String,
    handle: String = handle(1),
    relay: String = relay,
    topic: String = topic,
    environment: APNsEnvironment = .sandbox,
    token: APNsDeviceToken = tokenA,
    refreshedAt: Double = 1_000_000
  ) -> PushRegistration {
    PushRegistration(
      gatewayId: gatewayId,
      handle: handle,
      relay: relay,
      topic: topic,
      environment: environment,
      tokenFingerprint: token.fingerprint,
      refreshedAt: refreshedAt
    )
  }
}

// MARK: - A scripted relay

/// A relay client that records every call and answers from a script, per call kind.
final class ScriptedRelay: PushRelayClient {
  enum Call: Hashable {
    case register(token: String, environment: APNsEnvironment, topic: String)
    case update(handle: String, manageSecret: String, token: String, environment: APNsEnvironment)
    case delete(handle: String, manageSecret: String)
  }

  let origin: String
  private let state = Mutex<State>(State())

  private struct State {
    var calls: [Call] = []
    var issued = 0
    var registerErrors: [PushRelayError] = []
    var updateErrors: [PushRelayError] = []
    var deleteErrors: [PushRelayError] = []
  }

  init(origin: String = PushFixtures.relay) {
    self.origin = origin
  }

  var calls: [Call] { state.withLock { $0.calls } }

  /// The next calls of each kind fail with these, in order; after that they succeed.
  func failRegister(_ errors: PushRelayError...) { state.withLock { $0.registerErrors += errors } }
  func failUpdate(_ errors: PushRelayError...) { state.withLock { $0.updateErrors += errors } }
  func failDelete(_ errors: PushRelayError...) { state.withLock { $0.deleteErrors += errors } }

  func register(token: APNsDeviceToken, environment: APNsEnvironment, topic: String) async throws(PushRelayError)
    -> PushCapability
  {
    let result: Result<PushCapability, PushRelayError> = state.withLock { state in
      state.calls.append(.register(token: token.hex, environment: environment, topic: topic))

      if !state.registerErrors.isEmpty {
        return .failure(state.registerErrors.removeFirst())
      }

      state.issued += 1
      let n = state.issued

      return .success(
        PushCapability(
          handle: PushFixtures.handle(n),
          sendSecret: PushFixtures.secret("send", n),
          manageSecret: PushFixtures.secret("manage", n)
        )
      )
    }

    return try result.get()
  }

  func update(handle: String, manageSecret: String, token: APNsDeviceToken, environment: APNsEnvironment)
    async throws(PushRelayError)
  {
    let error: PushRelayError? = state.withLock { state in
      state.calls.append(.update(handle: handle, manageSecret: manageSecret, token: token.hex, environment: environment))
      return state.updateErrors.isEmpty ? nil : state.updateErrors.removeFirst()
    }

    if let error {
      throw error
    }
  }

  func delete(handle: String, manageSecret: String) async throws(PushRelayError) {
    let error: PushRelayError? = state.withLock { state in
      state.calls.append(.delete(handle: handle, manageSecret: manageSecret))
      return state.deleteErrors.isEmpty ? nil : state.deleteErrors.removeFirst()
    }

    if let error {
      throw error
    }
  }
}

/// A clock a test moves by hand, in Unix seconds.
final class PushClock: Sendable {
  private let value: Mutex<Double>

  init(_ start: Double = 1_000_000) {
    value = Mutex(start)
  }

  var now: Double { value.withLock { $0 } }

  func set(_ seconds: Double) {
    value.withLock { $0 = seconds }
  }

  func advance(_ seconds: Double) {
    value.withLock { $0 += seconds }
  }

  var read: @Sendable () -> Double {
    { [self] in now }
  }
}

/// A secret store that can be made to fail reads, as a keychain does before the first unlock.
final class LockableSecretStore: ListableSecretStore {
  let inner = InMemorySecretStore()
  private let locked = Mutex(false)

  func keys(prefix: String) throws -> [String] {
    if locked.withLock({ $0 }) {
      throw SecretStoreError.interactionNotAllowed
    }

    return try inner.keys(prefix: prefix)
  }

  func lock(_ value: Bool) {
    locked.withLock { $0 = value }
  }

  func get(_ key: String) throws -> String? {
    if locked.withLock({ $0 }) {
      throw SecretStoreError.interactionNotAllowed
    }

    return try inner.get(key)
  }

  func set(_ key: String, _ value: String) throws {
    if locked.withLock({ $0 }) {
      throw SecretStoreError.interactionNotAllowed
    }

    try inner.set(key, value)
  }

  func delete(_ key: String) throws {
    try inner.delete(key)
  }
}

/// A registration store over an in-memory database.
func makePushStore(secrets: any SecretStore = InMemorySecretStore()) throws -> PushRegistrationStore {
  PushRegistrationStore(keyValues: KeyValueStore(store: try SQLiteStore(.inMemory)), secrets: secrets)
}

// MARK: - Contract files

enum ContractFiles {
  /// `contract/<relative>`, found by walking up from this source file.
  static func url(_ relative: String, from filePath: String = #filePath) -> URL {
    var directory = URL(fileURLWithPath: filePath).deletingLastPathComponent()

    while directory.path != "/" {
      let candidate = directory.appendingPathComponent("contract").appendingPathComponent(relative)

      if FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }

      directory.deleteLastPathComponent()
    }

    Issue.record("contract/\(relative) not found above \(filePath)")
    return URL(fileURLWithPath: "/nonexistent")
  }

  static func json(_ relative: String) throws -> JSONValue {
    try JSONValue(parsing: try Data(contentsOf: url(relative)))
  }
}

// MARK: - A loopback relay

/// One request the loopback relay received.
struct RelayRequest: Sendable {
  var method: String
  var path: String
  var headers: [String: String]
  var body: String
}

/// What the loopback relay answers.
struct RelayAnswer: Sendable {
  var status: Int
  var headers: [String: String] = [:]
  var body: String = ""

  static func json(_ status: Int, _ body: String, headers: [String: String] = [:]) -> RelayAnswer {
    RelayAnswer(status: status, headers: headers.merging(["content-type": "application/json"]) { a, _ in a }, body: body)
  }
}

/**
 An HTTP/1.1 server on 127.0.0.1 that reads a whole request, body included (by `content-length`),
 records it, and answers once per connection. Enough to see what the relay client really sends.
 */
final class LoopbackRelay: Sendable {
  typealias Responder = @Sendable (RelayRequest) -> RelayAnswer

  private let listener: NWListener
  private let queue = DispatchQueue(label: "LoopbackRelay")
  private final class Log: Sendable {
    let items = Mutex<[RelayRequest]>([])
  }

  private let log = Log()

  var requests: [RelayRequest] { log.items.withLock { $0 } }

  init(_ respond: @escaping Responder) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)

    let queue = queue
    let log = log
    let record: @Sendable (RelayRequest) -> Void = { request in log.items.withLock { $0.append(request) } }

    listener.newConnectionHandler = { connection in
      connection.start(queue: queue)
      Self.receive(connection, buffer: Data(), record: record, respond: respond)
    }
  }

  /// Start listening and return `http://127.0.0.1:<port>`.
  func start() async throws -> String {
    let listener = listener
    let queue = queue
    let done = Mutex(false)

    let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { update in
        switch update {
        case .ready:
          if done.withLock({ let was = $0; $0 = true; return !was }) {
            continuation.resume(returning: listener.port?.rawValue ?? 0)
          }
        case .failed(let error):
          if done.withLock({ let was = $0; $0 = true; return !was }) {
            continuation.resume(throwing: error)
          }
        default:
          break
        }
      }

      listener.start(queue: queue)
    }

    return "http://127.0.0.1:\(port)"
  }

  func stop() {
    listener.cancel()
  }

  private static func receive(
    _ connection: NWConnection,
    buffer: Data,
    record: @escaping @Sendable (RelayRequest) -> Void,
    respond: @escaping Responder
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      var buffer = buffer

      if let data {
        buffer.append(data)
      }

      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        var headers: [String: String] = [:]

        for line in lines {
          if let colon = line.firstIndex(of: ":") {
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
          }
        }

        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = buffer[end.upperBound...]

        if body.count >= length {
          let request = RelayRequest(
            method: requestLine.first.map(String.init) ?? "",
            path: requestLine.count > 1 ? String(requestLine[1]) : "",
            headers: headers,
            body: String(decoding: body.prefix(length), as: UTF8.self)
          )

          record(request)

          let answer = respond(request)
          var text = "HTTP/1.1 \(answer.status) X\r\ncontent-length: \(answer.body.utf8.count)\r\nconnection: close\r\n"

          for (name, value) in answer.headers {
            text += "\(name): \(value)\r\n"
          }

          text += "\r\n" + answer.body

          connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in connection.cancel() })
          return
        }
      }

      if isComplete || error != nil {
        connection.cancel()
        return
      }

      receive(connection, buffer: buffer, record: record, respond: respond)
    }
  }
}

// MARK: - Delivered notifications

/// The system's delivered notifications, as a test sets them up: what is shown, and what was removed.
final class FakeDeliveredNotifications: PushDeliveredNotifications {
  private let state: Mutex<State>

  private struct State {
    var shown: [PushDeliveredNotification]
    var removed: [String] = []
  }

  init(_ shown: [PushDeliveredNotification] = []) {
    state = Mutex(State(shown: shown))
  }

  var shown: [PushDeliveredNotification] { state.withLock { $0.shown } }
  var removed: [String] { state.withLock { $0.removed } }

  func delivered() async -> [PushDeliveredNotification] { shown }

  func remove(identifiers: [String]) async {
    state.withLock { state in
      state.removed.append(contentsOf: identifiers)
      state.shown.removeAll { identifiers.contains($0.identifier) }
    }
  }
}
