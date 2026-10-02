import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

// Fakes for the engine tests: an in-memory SQLite, a device-only secret store that lists its
// keys and fails on demand, `FakeCloud` replicas, a hand-moved clock, captured logs. Never the
// real keychain: on a Mac that is the owner's live iCloud Keychain.

// MARK: - Device-only keychain

/// `SyncDeviceSecretStore` in memory, with the key list the tests assert on and one-shot faults.
final class TestSecretStore: SyncDeviceSecretStore {
  enum Operation: Sendable, Hashable {
    case get
    case set
    case delete
  }

  private struct State {
    var items: [String: String] = [:]
    /// Per operation: the error the next matching call throws, and which keys it matches.
    var faults: [Operation: (match: @Sendable (String) -> Bool, error: SecretStoreError, sticky: Bool)] = [:]
  }

  private let state = Mutex(State())

  init(_ items: [String: String] = [:]) {
    state.withLock { $0.items = items }
  }

  var keys: Set<String> { state.withLock { Set($0.items.keys) } }
  var items: [String: String] { state.withLock { $0.items } }

  /// The next call of that kind on a matching key throws (every such call, when `sticky`).
  func fail(
    _ operation: Operation, with error: SecretStoreError = .interactionNotAllowed, sticky: Bool = false,
    where match: @escaping @Sendable (String) -> Bool = { _ in true }
  ) {
    state.withLock { $0.faults[operation] = (match, error, sticky) }
  }

  func heal() {
    state.withLock { $0.faults = [:] }
  }

  private func check(_ operation: Operation, _ key: String) throws {
    try state.withLock { state in
      guard let fault = state.faults[operation], fault.match(key) else { return }
      if !fault.sticky { state.faults[operation] = nil }
      throw fault.error
    }
  }

  func get(_ key: String) throws -> String? {
    guard SecretKeys.isValidKey(key) else { throw SecretStoreError.invalidKey }
    try check(.get, key)
    return state.withLock { $0.items[key] }
  }

  func set(_ key: String, _ value: String) throws {
    guard SecretKeys.isValidKey(key) else { throw SecretStoreError.invalidKey }
    try check(.set, key)
    state.withLock { $0.items[key] = value }
  }

  func delete(_ key: String) throws {
    guard SecretKeys.isValidKey(key) else { throw SecretStoreError.invalidKey }
    try check(.delete, key)
    _ = state.withLock { $0.items.removeValue(forKey: key) }
  }

  func removeAll(prefix: String) throws -> Int {
    guard prefix.hasPrefix("hermie."), prefix.hasSuffix("."), prefix.count > "hermie.".count + 1 else {
      throw SecretStoreError.invalidPrefix
    }
    return state.withLock { state in
      let matching = state.items.keys.filter { $0.hasPrefix(prefix) }
      for key in matching { state.items.removeValue(forKey: key) }
      return matching.count
    }
  }
}

// MARK: - Clock, logs, lifecycle

/// Wall clock and debounce sleeps, moved by the test only.
final class EngineClock: Sendable {
  private struct State {
    var now: Double
    var sleepers: [(deadline: Double, continuation: CheckedContinuation<Void, any Error>)] = []
  }

  private let state: Mutex<State>

  init(now: Double = startOfTime) {
    state = Mutex(State(now: now))
  }

  var now: Double { state.withLock { $0.now } }

  var sleeping: Int { state.withLock { $0.sleepers.count } }

  /// Move time on and wake every sleep that is due.
  func advance(_ milliseconds: Double) {
    let due = state.withLock { state -> [CheckedContinuation<Void, any Error>] in
      state.now += milliseconds
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }.map(\.continuation)
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for continuation in due { continuation.resume() }
  }

  var syncClock: SyncClock {
    SyncClock(
      now: { [self] in now },
      sleep: { [self] duration in
        if duration <= .zero { return }
        let milliseconds = Double(duration.components.seconds) * 1000
          + Double(duration.components.attoseconds) / 1e15
        try await withCheckedThrowingContinuation { continuation in
          state.withLock { $0.sleepers.append(($0.now + milliseconds, continuation)) }
        }
      }
    )
  }
}

final class LogCapture: Sendable {
  private let lines = Mutex<[String]>([])

  var all: [String] { lines.withLock { $0 } }

  var logger: SyncLogger {
    SyncLogger { [self] line in lines.withLock { $0.append(line) } }
  }
}

final class RecordingLifecycle: GatewayLifecycle {
  private let ids = Mutex<[String]>([])

  var purged: [String] { ids.withLock { $0 } }

  func willPurge(gatewayId: String) async {
    ids.withLock { $0.append(gatewayId) }
  }
}

/// Lets a test hold a reconcile at one step and act while it waits.
final class StepGate<Step: Sendable & Equatable>: Sendable {
  private struct State {
    var step: Step?
    var arrived: CheckedContinuation<Void, Never>?
    var release: CheckedContinuation<Void, Never>?
    var reached = false
  }

  private let state = Mutex(State())

  init(at step: Step) {
    state.withLock { $0.step = step }
  }

  var probe: @Sendable (Step) async throws -> Void {
    { [self] step in
      guard state.withLock({ $0.step == step }) else { return }
      await withCheckedContinuation { continuation in
        let arrived = state.withLock { state -> CheckedContinuation<Void, Never>? in
          state.step = nil
          state.reached = true
          state.release = continuation
          defer { state.arrived = nil }
          return state.arrived
        }
        arrived?.resume()
      }
    }
  }

  /// Wait until the reconcile is held at the step.
  func reached() async {
    await withCheckedContinuation { continuation in
      let already = state.withLock { state -> Bool in
        if state.reached { return true }
        state.arrived = continuation
        return false
      }
      if already { continuation.resume() }
    }
  }

  func open() {
    let release = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.release = nil }
      return state.release
    }
    release?.resume()
  }
}

/// A crash right after one step: the probe throws there, once.
struct Crash: Error {}

func crash<Step: Sendable & Equatable>(after target: Step) -> @Sendable (Step) async throws -> Void {
  let fired = Mutex(false)
  return { step in
    guard step == target else { return }
    let fire = fired.withLock { fired -> Bool in
      defer { fired = true }
      return !fired
    }
    if fire { throw Crash() }
  }
}

// MARK: - A device

/// One device: its own SQLite, device-only keychain and engine, on a replica of a shared cloud.
struct EngineDevice: Sendable {
  let name: String
  let database: SQLiteStore
  let secrets: TestSecretStore
  let store: InMemorySyncedItemStore
  let clock: EngineClock
  let logs: LogCapture
  let lifecycle: RecordingLifecycle
  let status: SyncStatus
  let timing: SyncTiming
  var engine: GatewaySyncEngine

  /// Without a debounce by default, so a test never waits for a clock nobody moves; the debounce
  /// tests pass their own timing.
  init(
    name: String, cloud: FakeCloud, clock: EngineClock = EngineClock(),
    timing: SyncTiming = SyncTiming(localChangeDelay: .zero)
  ) throws {
    self.name = name
    database = try SQLiteStore(.inMemory)
    secrets = TestSecretStore()
    store = cloud.replica(name)
    self.clock = clock
    self.timing = timing
    logs = LogCapture()
    lifecycle = RecordingLifecycle()
    status = SyncStatus()
    engine = GatewaySyncEngine(
      database: database, secrets: secrets, synced: store, lifecycle: lifecycle, clock: clock.syncClock,
      timing: timing, logger: logs.logger, status: status)
  }

  /// The process dies and starts again: a new engine on the same stores.
  mutating func restart() {
    engine = GatewaySyncEngine(
      database: database, secrets: secrets, synced: store, lifecycle: lifecycle, clock: clock.syncClock,
      timing: timing, logger: logs.logger, status: status)
  }

  func registry() async throws -> GatewayRegistry {
    try await GatewayRegistryStore(store: database).load()
  }

  func gateways() async throws -> [GatewayRecord] {
    try await registry().inOrder
  }

  func only() async throws -> GatewayRecord {
    let all = try await gateways()
    try #require(all.count == 1, "expected one gateway on \(name), found \(all.count)")
    return all[0]
  }

  func state() async throws -> SyncState? {
    SyncState.decode(try await database.read { try $0.kvValue(forKey: SyncState.storageKey) })
  }

  func kv(_ key: String) async throws -> String? {
    try await database.read { try $0.kvValue(forKey: key) }
  }

  func token(_ id: String) -> String? { secrets.items[SecretKeys.Gateway(id: id).sessionToken] }
  func frontDoor(_ id: String) -> String? { secrets.items[SecretKeys.Gateway(id: id).frontDoor] }
  func headers(_ id: String) -> String? { secrets.items[SecretKeys.Gateway(id: id).extraHeaders] }

  /// The device-only keys that belong to gateways (not the print key or the device tag).
  var gatewayKeys: Set<String> { secrets.keys.filter { !$0.hasPrefix("hermie.sync.") } }

  @discardableResult
  func reconcile() async -> SyncOutcome {
    await engine.reconcileNow()
  }
}

extension SecretKeys.Gateway {
  init(id: String) {
    self = try! SecretKeys.gateway(id)
  }
}

// MARK: - Several devices

/// Devices sharing one `FakeCloud`, each with its own clock offset.
struct EngineWorld {
  let cloud: FakeCloud
  var devices: [EngineDevice]
  let clock: EngineClock

  init(_ count: Int, conflict: FakeCloud.Conflict = .newestWrite) throws {
    let cloud = FakeCloud(delivery: .manual, conflict: conflict)
    let clock = EngineClock()
    self.cloud = cloud
    self.clock = clock
    devices = try (0..<count).map { try EngineDevice(name: "device\($0)", cloud: cloud, clock: clock) }
  }

  subscript(_ index: Int) -> EngineDevice {
    get { devices[index] }
    set { devices[index] = newValue }
  }

  /// Every device has seen the disclosure.
  func discloseAll() async throws {
    for device in devices { try await device.engine.disclose() }
    for device in devices { await device.engine.waitUntilIdle() }
  }

  /// Deliver everything and reconcile every device until nothing is written anywhere.
  @discardableResult
  func settle(rounds: Int = 12) async -> [SyncOutcome] {
    var last: [SyncOutcome] = []
    for _ in 0..<rounds {
      cloud.deliverAll()
      last = []
      for device in devices {
        await device.engine.waitUntilIdle()
        last.append(await device.reconcile())
        cloud.deliverAll()
      }
      if last.allSatisfy({ if case .applied = $0 { false } else { true } }) {
        return last
      }
    }
    return last
  }

  /// Advance the shared clock.
  func advance(_ milliseconds: Double) {
    clock.advance(milliseconds)
  }

  func cloudRecord(_ address: String) -> SyncedGatewayRecord? {
    let account = SyncedGatewayRecord.account(forKey: GatewayKey.of(address))
    return cloud.cloudItems().first { $0.account == account }.flatMap {
      SyncedGatewayRecord.decode(account: $0.account, value: $0.value)
    }
  }
}

/// A gateway the add wizard completed on a device.
@discardableResult
func addGateway(
  _ device: EngineDevice,
  address: String,
  name: String = "Home",
  token: String? = "tok-1",
  frontDoorSecret: String? = nil,
  headers: [String: String] = [:]
) async throws -> String {
  let origin = GatewayAddress.origin(of: address)
  return try await device.engine.addGateway(
    NewGateway(
      name: name, address: address, authKind: token == nil ? .nativePKCE : .sessionToken,
      frontDoor: frontDoorSecret.map {
        .cloudflareAccess(.init(clientID: "client.access", clientSecret: $0, origin: origin))
      } ?? .none,
      customHeaders: headers, sessionToken: token))
}

let conflictPolicies: [FakeCloud.Conflict] = [.newestWrite, .cloudWins]

/// A replica whose store becomes unavailable while it is being listed, and then (as the real one
/// does) answers with nothing.
struct VanishingStore: SyncedItemStore {
  let replica: InMemorySyncedItemStore

  func availability() -> SyncedStoreAvailability { replica.availability() }

  func all() throws -> [SyncedItem] {
    replica.cloud.setAvailability(.unavailable, on: replica.device)
    return try replica.all()
  }

  func put(_ item: SyncedItem) throws { try replica.put(item) }
  func delete(account: String) throws { try replica.delete(account: account) }
}

extension EngineDevice {
  /// The same device with its engine on another synced store.
  func engine(on store: any SyncedItemStore) -> GatewaySyncEngine {
    GatewaySyncEngine(
      database: database, secrets: secrets, synced: store, lifecycle: lifecycle, clock: clock.syncClock,
      timing: timing, logger: logs.logger, status: status)
  }
}

/// What the share-delivery hook was called with.
final class HookRecorder: Sendable {
  private let ids = Mutex<[String]>([])

  var calls: [String] { ids.withLock { $0 } }

  var handler: @Sendable (String) async -> Void {
    { [self] id in ids.withLock { $0.append(id) } }
  }
}

/// Polls until a condition holds, yielding in between; no time limit of its own (the suite's
/// time limit applies).
func eventually(_ condition: () async -> Bool) async -> Bool {
  for _ in 0..<100_000 {
    if await condition() { return true }
    await Task.yield()
  }
  return await condition()
}
