import Foundation
import HermieProtocol
import Synchronization
import Testing

@testable import HermieGateway

/// The base URL every connection test dials. Never a real host.
let testBaseURL = "http://gateway.test"

/// The `harness()` of `connection.test.ts`: a fake gateway, credentials for it,
/// a connection with the test's short timings, and a record of every status.
///
/// The timings are the TypeScript harness's: a 10 ms reconnect ladder, a 2 s
/// ready and connect timeout, the heartbeat off unless asked for (5 s deadline
/// when on), and a 10 ms offline grace. None of them pass unless the test
/// advances the clock.
struct Harness {
  let gateway: FakeGateway
  let credentials: FakeCredentials
  let clock: TestClock
  let connection: GatewayConnection
  let statuses: Recorder<ConnectionStatus>
  let timeline: AuthTimeline

  var phases: [ConnectionPhase] { statuses.values.map(\.phase) }

  /// `waitFor(status)`: until the connection is in `phase` and every status it
  /// published on the way has been recorded. No time passes.
  func waitFor(_ phase: ConnectionPhase, _ comment: Comment? = nil) async throws {
    try await eventually("the connection to be \(phase.rawValue)") {
      guard statuses.values.last?.phase == phase else {
        return false
      }

      // A call into the actor runs after the turn that published the status,
      // so whatever that turn did after publishing (a timer, a teardown) is done.
      return await connection.phase == phase
    }
  }

  /// `waitUntil`, with time moving: advance the clock in small steps while the
  /// connection waits on a timer, until `condition` holds. Time never moves
  /// while a dial is in flight (authenticating or connecting), so a fake dial
  /// that takes a while to be scheduled can never be overtaken by its own ready
  /// or connect timeout.
  func advanceUntil(
    _ label: String,
    step: Duration = .milliseconds(5),
    _ condition: @escaping @Sendable () async -> Bool
  ) async throws {
    try await eventually(label) {
      if await condition() {
        return true
      }

      let phase = await connection.phase

      if phase != .authenticating && phase != .connecting {
        await clock.advance(by: step)
      }

      return await condition()
    }
  }

  /// `advanceUntil` the connection is in `phase`, then `waitFor` it, so the
  /// recorded statuses have caught up too.
  func advanceUntil(phase: ConnectionPhase) async throws {
    try await advanceUntil("the connection to be \(phase.rawValue)") { (await connection.phase) == phase }
    try await waitFor(phase)
  }

  /// Let every task the connection has in flight run to its next wait.
  func settle() async {
    for _ in 0..<20 {
      await Task.yield()
      _ = await connection.phase
    }

    try? await Task.sleep(for: .milliseconds(2))
    _ = await connection.phase
  }
}

struct HarnessOptions {
  var auth: FakeGateway.Auth = .none
  var heartbeatInterval: Duration?
  var offlineGrace: Duration = .milliseconds(10)
  var backoff: (@Sendable (Int) -> Duration)?
  var extraHeaders: [String: String]?
  /// The two-step `client.capabilities` for `confirm`.
  var confirm: ConfirmCapabilitySource?
  /// The interactive methods this device can show (`requests` of the second call).
  var requests: [String]?
}

/// Build a harness, run `body`, and always stop the connection afterwards (the
/// TypeScript `afterEach`).
func withHarness(
  _ options: HarnessOptions = HarnessOptions(),
  _ body: (Harness) async throws -> Void
) async throws {
  let gateway = FakeGateway(auth: options.auth)
  let credentials = FakeCredentials(options.auth == .native ? .native : .sessionToken, gateway: gateway)
  let clock = TestClock()
  let timeline = AuthTimeline(now: { TestClock.epoch.timeIntervalSince1970 * 1000 })

  var connectionOptions = GatewayConnection.Options()
  connectionOptions.backoff = options.backoff ?? { _ in .milliseconds(10) }
  connectionOptions.readyTimeout = .milliseconds(2000)
  connectionOptions.connectTimeout = .milliseconds(2000)
  connectionOptions.heartbeatInterval = options.heartbeatInterval ?? .zero
  connectionOptions.heartbeatDeadline = options.heartbeatInterval == nil ? .zero : .milliseconds(5000)
  connectionOptions.offlineGrace = options.offlineGrace
  connectionOptions.confirm = options.confirm
  connectionOptions.requests = options.requests

  let connection = try GatewayConnection(
    baseURL: testBaseURL,
    extraHeaders: options.extraHeaders,
    credentials: credentials,
    transport: gateway,
    clock: clock,
    timeline: timeline,
    options: connectionOptions
  )

  let statuses = Recorder(connection.statuses)
  let harness = Harness(
    gateway: gateway,
    credentials: credentials,
    clock: clock,
    connection: connection,
    statuses: statuses,
    timeline: timeline
  )

  do {
    try await body(harness)
  } catch {
    await connection.stop()
    statuses.cancel()
    throw error
  }

  await connection.stop()
  statuses.cancel()
}

/// Collects everything a stream yields, as the TypeScript tests push into arrays.
final class Recorder<Element: Sendable>: Sendable {
  private final class Storage: Sendable {
    let values = Mutex([Element]())
  }

  private let storage = Storage()
  private let task: Task<Void, Never>

  init(_ stream: AsyncStream<Element>) {
    let storage = self.storage
    task = Task {
      for await element in stream {
        storage.values.withLock { $0.append(element) }
      }
    }
  }

  var values: [Element] { storage.values.withLock { $0 } }

  func cancel() {
    task.cancel()
  }
}

enum HarnessError: Error, CustomStringConvertible {
  case timedOut(String)

  var description: String {
    switch self {
    case .timedOut(let label): "Timed out waiting for \(label)"
    }
  }
}

/// Poll `condition` until it holds, for at most `timeout` of real time. A
/// condition, never a fixed wait: it returns the moment the work has happened.
///
/// The bound is only there to turn a hang into a failure. It is generous on
/// purpose: on a machine running many builds at once a task can wait seconds
/// for a thread, and a test must not fail for that. No test may depend on the
/// bound being short, and none may advance the test clock while work it is
/// waiting for is still queued (see `anyInboundLiveness`).
func eventually(
  _ label: String,
  timeout: Duration = .seconds(60),
  _ condition: () async -> Bool
) async throws {
  let deadline = ContinuousClock.now + timeout

  while ContinuousClock.now < deadline {
    if await condition() {
      return
    }

    await Task.yield()
    try await Task.sleep(for: .microseconds(500))
  }

  throw HarnessError.timedOut(label)
}

/// The first event of `type` on a subscription made now.
func firstEvent(of type: String, on connection: GatewayConnection) -> Task<GatewayEvent?, Never> {
  let events = connection.events

  return Task {
    for await wire in events where wire.event.type == type {
      return wire.event
    }

    return nil
  }
}
