#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Synchronization

/// A `GatewayConnection` dialling a real fake gateway over a real socket, on
/// the real clock, with every status, event and server request it emits kept
/// in order so a test can wait for what it expects.
///
/// Nothing here sleeps to let time pass. A wait is for something the
/// connection or the gateway does, bounded by a deadline that only turns a
/// hang into a failure.
final class LiveConnection: Sendable {
  let connection: GatewayConnection
  let statuses: StreamLog<ConnectionStatus>
  let events: StreamLog<WireEvent>
  let requests: StreamLog<ServerRequestDelivery>
  let clock: FiringClock

  /// How long any one wait may take before the test fails.
  static let deadline: Duration = .seconds(20)

  init(gateway: FakeGateway, credentials: any CredentialProvider, configure: (inout GatewayConnection.Options) -> Void = { _ in }) throws {
    var options = GatewayConnection.Options()
    // A short ladder: a redial is part of several tests, and the default's
    // first rung is 150 to 300 ms of a run's time budget.
    options.backoff = { _ in .milliseconds(50) }
    options.heartbeatInterval = .zero
    configure(&options)

    clock = FiringClock()
    connection = try GatewayConnection(
      baseURL: gateway.baseURL,
      credentials: credentials,
      transport: URLSessionTransport(),
      clock: clock,
      options: options
    )
    // Subscribed before `start()`, as the contract asks.
    statuses = StreamLog(connection.statuses)
    events = StreamLog(connection.events)
    requests = StreamLog(connection.serverRequests)
  }

  /// Start, run `body`, and shut the connection down whatever happened.
  static func with<T>(
    _ gateway: FakeGateway,
    credentials: any CredentialProvider,
    configure: (inout GatewayConnection.Options) -> Void = { _ in },
    _ body: (LiveConnection) async throws -> T
  ) async throws -> T {
    let live = try LiveConnection(gateway: gateway, credentials: credentials, configure: configure)

    do {
      let result = try await body(live)
      await live.connection.shutdown()
      return result
    } catch {
      await live.connection.shutdown()
      throw error
    }
  }

  /// Until the connection has moved to `phase`.
  ///
  /// The first entry of the log is the status `statuses` replays to a new
  /// subscriber, taken before `start()`: `disconnected`. It never counts.
  /// Otherwise a wait for `disconnected` right after `start()` could return on
  /// that entry while the collector had not yet recorded `authenticating`, and
  /// read `lastError` in the middle of the dial.
  func waitFor(_ phase: ConnectionPhase) async throws {
    try await statuses.wait("the connection to be \(phase.rawValue)") { log in
      log.count > 1 && log.last?.phase == phase
    }
  }

  /// The first event after `index` (exclusive) matching `predicate`.
  @discardableResult
  func waitForEvent(
    _ label: String,
    after index: UInt64 = 0,
    where predicate: @escaping @Sendable (GatewayEvent) -> Bool
  ) async throws -> WireEvent {
    let found = try await events.wait(label) { events in
      events.contains { $0.index > index && predicate($0.event) }
    }
    return found.first { $0.index > index && predicate($0.event) }!
  }
}

/// Everything a stream yields, in order, and a way to wait until it holds
/// something. Each append wakes the waiters; nothing is polled.
final class StreamLog<Element: Sendable>: Sendable {
  private struct State {
    var values: [Element] = []
    var waiters: [UInt64: CheckedContinuation<Void, Never>] = [:]
    var nextWaiter: UInt64 = 0
  }

  private final class Storage: Sendable {
    let state = Mutex(State())
  }

  private let storage = Storage()
  private let task: Task<Void, Never>

  init(_ stream: AsyncStream<Element>) {
    let storage = self.storage
    task = Task {
      for await element in stream {
        let waiters = storage.state.withLock { state in
          state.values.append(element)
          defer { state.waiters = [:] }
          return state.waiters.values
        }

        for waiter in waiters {
          waiter.resume()
        }
      }
    }
  }

  deinit {
    task.cancel()
  }

  var values: [Element] { storage.state.withLock { $0.values } }

  /// Until `condition` holds for what has arrived; answers what had arrived.
  @discardableResult
  func wait(
    _ label: String,
    timeout: Duration = LiveConnection.deadline,
    until condition: @escaping @Sendable ([Element]) -> Bool
  ) async throws -> [Element] {
    try await within(timeout, label) { [storage] in
      while true {
        let values = storage.state.withLock { $0.values }

        if condition(values) {
          return values
        }

        try Task.checkCancellation()
        await Self.nextAppend(storage, after: values.count)
      }
    }
  }

  /// Return once more than `count` values have arrived (at once if they have).
  private static func nextAppend(_ storage: Storage, after count: Int) async {
    let id = storage.state.withLock { state -> UInt64 in
      defer { state.nextWaiter += 1 }
      return state.nextWaiter
    }

    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let ready = storage.state.withLock { state -> Bool in
          if state.values.count > count {
            return true
          }

          state.waiters[id] = continuation
          return false
        }

        if ready {
          continuation.resume()
        }
      }
    } onCancel: {
      let waiter = storage.state.withLock { $0.waiters.removeValue(forKey: id) }
      waiter?.resume()
    }
  }
}

struct DeadlinePassed: Error, CustomStringConvertible {
  let label: String
  let timeout: Duration
  var description: String { "Timed out after \(timeout) waiting for \(label)" }
}

/// Run `operation`, failing with `DeadlinePassed` if it has not finished within
/// `timeout`. The deadline is a bound on a hang, never a wait for anything.
func within<T: Sendable>(
  _ timeout: Duration,
  _ label: String,
  _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
  try await withThrowingTaskGroup(of: T?.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await Task.sleep(for: timeout)
      return nil
    }

    defer { group.cancelAll() }

    guard let first = try await group.next(), let value = first else {
      throw DeadlinePassed(label: label, timeout: timeout)
    }

    return value
  }
}

/// The real clock, reporting each timer that fires, so a test can wait for
/// "five heartbeat intervals have passed" without sleeping for them.
final class FiringClock: ConnectionClock {
  private let base = SystemConnectionClock()
  let fired: StreamLog<Int>
  private let continuation: AsyncStream<Int>.Continuation
  private let count = Counter()

  private final class Counter: Sendable {
    let value = Mutex(0)

    func next() -> Int {
      value.withLock { value in
        value += 1
        return value
      }
    }
  }

  init() {
    let (stream, continuation) = AsyncStream<Int>.makeStream()
    self.continuation = continuation
    fired = StreamLog(stream)
  }

  var now: Duration { base.now }
  var date: Date { base.date }

  func schedule(after delay: Duration, _ action: @escaping @Sendable () async -> Void) -> ScheduledTimer {
    base.schedule(after: delay) { [count, continuation] in
      await action()
      continuation.yield(count.next())
    }
  }
}

/// `GET /__fake/state`, the gateway's own account of what happened.
struct FakeState: Sendable {
  let json: JSONValue

  var connections: Int { json["connections"]?.intValue ?? -1 }
  var openSockets: Int { json["openSockets"]?.intValue ?? -1 }
  var rejectedUpgrades: Int { json["rejectedUpgrades"]?.intValue ?? -1 }
  var ticketsMinted: Int { json["ticketsMinted"]?.intValue ?? -1 }
  var ticketsConsumed: Int { json["ticketsConsumed"]?.intValue ?? -1 }
  var refreshCalls: Int { json["refreshCalls"]?.intValue ?? -1 }
  var methodLog: [String] { json["methodLog"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
  var eventsSinceCalls: [JSONValue] { json["eventsSinceCalls"]?.arrayValue ?? [] }
  var serverRequestAnswers: [JSONValue] { json["serverRequestAnswers"]?.arrayValue ?? [] }
  /// Stored ids of the sessions with a turn still streaming.
  var runningSessions: [String] { json["runningSessions"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
}

extension FakeGateway {
  func state() async throws -> FakeState {
    FakeState(json: try await control("GET", "/__fake/state"))
  }

  /// `POST /__fake/drop-sockets`: abruptly without a code (the client sees 1006).
  func dropSockets(code: Int? = nil, reason: String = "") async throws {
    var body: JSONObject = [:]
    if let code {
      body["code"] = .number(Double(code))
      body["reason"] = .string(reason)
    }
    try await control("POST", "/__fake/drop-sockets", body: .object(body))
  }

  /// `POST /__fake/reject-upgrades`: the next `count` upgrades fail with `--close-code`.
  func rejectUpgrades(_ count: Int) async throws {
    try await control("POST", "/__fake/reject-upgrades", body: ["count": .number(Double(count))])
  }
}
#endif
