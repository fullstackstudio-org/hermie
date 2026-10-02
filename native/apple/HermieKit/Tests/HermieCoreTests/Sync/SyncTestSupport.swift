import Foundation
import HermieGateway
import HermieProtocol

@testable import HermieCore

// A small model of iCloud Keychain and of the sync engine around the pure merge, for the tests of
// this directory only. The names follow `FakeCloud` in `HermieStore` (conflict policies,
// `wipeLocal`, `rejoin`), so a later task can swap one for the other.

/// Deterministic, and not the identity, so a test can tell a print from a value.
let testPrinter = printer(key: "")

/// A printer under a key: a device that loses its print key gets a printer under another.
func printer(key: String) -> SyncPrinter {
  SyncPrinter { "p:" + GatewayKey.fnv1a64(key + "|" + $0) }
}

let startOfTime: Double = 1_790_000_000_000
let day: Double = 24 * 60 * 60 * 1000
let year: Double = 365 * day

// MARK: - Cloud

/**
 One iCloud Keychain: the cloud's copy of every item plus each device's local copy, with uploads
 and downloads as messages the test delivers in any order.

 Each copy remembers the cloud version it derives from. A device's write changes its local copy at
 once and sends an upload made from that copy. The cloud then applies the conflict policy:

 - `.newestWrite`: the upload that reaches the cloud last wins.
 - `.cloudWins`: an upload made from a copy that is not the cloud's current one is refused, and the
   cloud's copy is sent back to the device in its place (a stale delete loses the same way, and the
   item comes back).

 Every accepted change goes to every connected device. `wipeLocal` empties one device's copy
 without a delete travelling and disconnects it; its writes stay local until `rejoin`, which hands
 it every live item again (like a late joiner) and then sends what it wrote in between.
 */
struct TestCloud {
  enum ConflictPolicy: String, Sendable, CaseIterable {
    case newestWrite
    case cloudWins
  }

  struct Item: Equatable {
    /// `nil` once deleted.
    var value: String?
    var version: Int
  }

  enum Message {
    case upload(from: Int, account: String, value: String?, base: Int)
    case download(to: Int, account: String, item: Item)
  }

  struct Replica {
    var items: [String: Item] = [:]
    var connected = true
    var held: [Message] = []
  }

  let conflict: ConflictPolicy
  private(set) var cloud: [String: Item] = [:]
  private(set) var replicas: [Replica]
  private(set) var pending: [Message] = []
  /// Uploads the cloud refused (`.cloudWins` only).
  private(set) var refused = 0
  private var version = 0

  init(replicas: Int, conflict: ConflictPolicy) {
    self.conflict = conflict
    self.replicas = Array(repeating: Replica(), count: replicas)
  }

  /// The live items on one device.
  func items(_ replica: Int) -> [String: String] {
    replicas[replica].items.compactMapValues(\.value)
  }

  /// The live items in the cloud.
  var cloudItems: [String: String] {
    cloud.compactMapValues(\.value)
  }

  mutating func put(_ replica: Int, account: String, value: String) {
    write(replica, account: account, value: value)
  }

  mutating func delete(_ replica: Int, account: String) {
    write(replica, account: account, value: nil)
  }

  private mutating func write(_ replica: Int, account: String, value: String?) {
    let base = replicas[replica].items[account]?.version ?? 0
    replicas[replica].items[account] = Item(value: value, version: base)

    let upload = Message.upload(from: replica, account: account, value: value, base: base)
    if replicas[replica].connected {
      pending.append(upload)
    } else {
      replicas[replica].held.append(upload)
    }
  }

  mutating func deliver(at index: Int) {
    let message = pending.remove(at: index)

    switch message {
    case let .upload(from, account, value, base):
      let current = cloud[account]
      let accepted =
        switch conflict {
        case .newestWrite: true
        case .cloudWins: (current?.version ?? 0) == base
        }

      if accepted {
        version += 1
        let item = Item(value: value, version: version)
        cloud[account] = item
        for index in replicas.indices where replicas[index].connected {
          pending.append(.download(to: index, account: account, item: item))
        }
      } else {
        refused += 1
        pending.append(.download(to: from, account: account, item: current ?? Item(value: nil, version: 0)))
      }
    case let .download(to, account, item):
      guard replicas[to].connected else { return }
      if (replicas[to].items[account]?.version ?? -1) < item.version {
        replicas[to].items[account] = item
      }
    }
  }

  mutating func deliverAll() {
    while !pending.isEmpty {
      deliver(at: 0)
    }
  }

  /// Deliver everything except what goes to or comes from one device, which stays as it was: an
  /// offline device that keeps its stale copies.
  mutating func deliverAll(except replica: Int) {
    func involves(_ message: Message) -> Bool {
      switch message {
      case let .upload(from, _, _, _): from == replica
      case let .download(to, _, _): to == replica
      }
    }

    while let index = pending.firstIndex(where: { !involves($0) }) {
      deliver(at: index)
    }
  }

  /// The device loses every item without a delete travelling (iCloud Keychain switched off with
  /// "delete from this device", Apple Account signed out, keychain reset), and stops syncing.
  mutating func wipeLocal(_ replica: Int) {
    replicas[replica].items = [:]
    replicas[replica].connected = false
    replicas[replica].held = []
    pending.removeAll { message in
      switch message {
      case let .upload(from, _, _, _): from == replica
      case let .download(to, _, _): to == replica
      }
    }
  }

  /// Sync is back: every live item arrives again, then the writes made in between go up.
  mutating func rejoin(_ replica: Int) {
    guard !replicas[replica].connected else { return }

    let heldAccounts = Set(
      replicas[replica].held.compactMap { message -> String? in
        if case let .upload(_, account, _, _) = message { return account }
        return nil
      })

    replicas[replica].connected = true
    for (account, item) in cloud where item.value != nil && !heldAccounts.contains(account) {
      replicas[replica].items[account] = item
    }
    pending.append(contentsOf: replicas[replica].held)
    replicas[replica].held = []
  }
}

// MARK: - Devices

/// One device: its gateways (registry, config and device-only credentials in one value), its sync
/// state, and a clock that may be wrong.
struct TestDevice {
  var gateways: [LocalGateway] = []
  var state: SyncState
  var clockOffset: Double = 0
  var events: [SyncEvent] = []
  var nextId = 0
  /// The key prints are made under; a new one models a print key lost while SQLite stayed.
  var printKey = ""
  let index: Int

  init(index: Int) {
    self.index = index
    self.state = SyncState(device: String(format: "%08x", 0xA1B2_C300 + index), enabled: true, disclosed: true)
  }

  mutating func mintId() -> String {
    nextId += 1
    return String(format: "g%02x%014x", index, nextId)
  }

  func gateway(_ id: String) -> LocalGateway? {
    gateways.first { $0.id == id }
  }

  func gateways(at key: String) -> [LocalGateway] {
    gateways.filter { $0.key == key }
  }
}

/// Devices sharing one `TestCloud`, and the engine's side of a reconcile: read the device's items,
/// run `GatewaySync.reconcile`, apply the plan.
struct SyncWorld {
  var cloud: TestCloud
  var devices: [TestDevice]
  var now: Double = startOfTime

  init(devices count: Int, conflict: TestCloud.ConflictPolicy = .newestWrite) {
    cloud = TestCloud(replicas: count, conflict: conflict)
    devices = (0..<count).map(TestDevice.init(index:))
  }

  func records(_ device: Int) -> [SyncedGatewayRecord] {
    cloud.items(device).sorted { $0.key < $1.key }.compactMap { SyncedGatewayRecord.decode(account: $0.key, value: $0.value) }
  }

  func record(_ device: Int, key: String) -> SyncedGatewayRecord? {
    records(device).first { $0.key == key }
  }

  func cloudRecord(key: String) -> SyncedGatewayRecord? {
    cloud.cloudItems[SyncedGatewayRecord.account(forKey: key)].flatMap {
      SyncedGatewayRecord.decode(account: SyncedGatewayRecord.account(forKey: key), value: $0)
    }
  }

  func snapshot(_ device: Int) -> LocalSyncSnapshot {
    var copy = devices[device]
    let ids = (0..<4).map { _ in copy.mintId() }
    return LocalSyncSnapshot(gateways: devices[device].gateways, newIds: ids, printer: printer(key: devices[device].printKey))
  }

  /// The plan for one device, without applying it.
  func plan(_ device: Int) -> SyncPlan {
    GatewaySync.reconcile(
      local: snapshot(device), remote: records(device), state: devices[device].state,
      now: now + devices[device].clockOffset)
  }

  @discardableResult
  mutating func reconcile(_ device: Int) -> SyncPlan {
    let plan = plan(device)
    apply(plan, to: device)
    return plan
  }

  mutating func apply(_ plan: SyncPlan, to device: Int) {
    var target = devices[device]

    for op in plan.localOps {
      switch op {
      case let .add(gateway):
        target.gateways.append(gateway)
      case let .update(gateway, _):
        if let index = target.gateways.firstIndex(where: { $0.id == gateway.id }) {
          target.gateways[index] = gateway
        }
      case let .purge(gatewayId):
        target.gateways.removeAll { $0.id == gatewayId }
      }
    }

    // Ids handed out in the snapshot are spent whether or not they were used.
    target.nextId += 4
    target.state = plan.state
    target.events += plan.events
    devices[device] = target

    for record in plan.remotePuts {
      cloud.put(device, account: record.account, value: try! record.encoded())
    }
    for account in plan.remoteDeletes {
      cloud.delete(device, account: account)
    }
  }

  /// Reconcile each device in turn, delivering everything after each, until nothing is written.
  mutating func settle(maxRounds: Int = 20) {
    for _ in 0..<maxRounds {
      cloud.deliverAll()
      var wrote = false
      for device in devices.indices {
        let plan = reconcile(device)
        wrote = wrote || plan.hasRemoteWrites || !plan.localOps.isEmpty
        cloud.deliverAll()
      }
      if !wrote { return }
    }
  }

  mutating func advance(_ milliseconds: Double) {
    now += milliseconds
  }

  // MARK: What the app and the engine do on a person's action

  @discardableResult
  mutating func add(
    _ device: Int,
    address: String,
    name: String = "Home",
    authKind: String = "session_token",
    token: String? = nil,
    frontDoorSecret: String? = nil,
    addedAt: Double? = nil
  ) -> String {
    let id = devices[device].mintId()
    let origin = GatewayAddress.origin(of: address)
    let gateway = LocalGateway(
      id: id, name: name, address: address, authKind: authKind,
      addedAt: addedAt ?? (now + devices[device].clockOffset),
      frontDoor: frontDoorSecret.map { SyncFrontDoor(origin: origin, clientId: "client.access", clientSecret: $0) },
      sessionToken: token.map { SyncSessionToken(origin: origin, token: $0) })
    devices[device].gateways.append(gateway)
    devices[device].state.markAddedHere(gatewayId: id, key: gateway.key)
    return id
  }

  /// A gateway that was already on the device before sync knew of it (set up by hand earlier, or
  /// by a build without sync): no "added here" intent.
  @discardableResult
  mutating func existing(_ device: Int, address: String, name: String = "Home", token: String? = nil) -> String {
    let id = devices[device].mintId()
    let origin = GatewayAddress.origin(of: address)
    devices[device].gateways.append(
      LocalGateway(
        id: id, name: name, address: address, authKind: "session_token", addedAt: now + devices[device].clockOffset,
        sessionToken: token.map { SyncSessionToken(origin: origin, token: $0) }))
    return id
  }

  mutating func edit(_ device: Int, _ id: String, _ change: (inout LocalGateway) -> Void) {
    guard let index = devices[device].gateways.firstIndex(where: { $0.id == id }) else { return }
    change(&devices[device].gateways[index])
  }

  mutating func rename(_ device: Int, _ id: String, to name: String) {
    edit(device, id) { $0.name = name }
  }

  mutating func setAddress(_ device: Int, _ id: String, to address: String) {
    edit(device, id) { $0.address = address }
  }

  /// Signing in with a token (or entering a new one) also ends a sign-out on this device; the
  /// person removing the token clears it on every device.
  mutating func setToken(_ device: Int, _ id: String, to token: String?) {
    guard let gateway = devices[device].gateway(id) else { return }
    edit(device, id) { gateway in
      gateway.sessionToken = token.map { SyncSessionToken(origin: GatewayAddress.origin(of: gateway.address), token: $0) }
    }
    if token != nil {
      devices[device].state.setSignedOut(false, gatewayId: id, key: gateway.key)
    } else {
      devices[device].state.markClearing(.sessionToken, gatewayId: id, key: gateway.key)
    }
  }

  mutating func setFrontDoor(_ device: Int, _ id: String, secret: String?) {
    guard let current = devices[device].gateway(id) else { return }
    edit(device, id) { gateway in
      gateway.frontDoor = secret.map {
        SyncFrontDoor(origin: GatewayAddress.origin(of: gateway.address), clientId: "client.access", clientSecret: $0)
      }
    }
    if secret == nil {
      devices[device].state.markClearing(.frontDoor, gatewayId: id, key: current.key)
    }
  }

  mutating func setHeaders(_ device: Int, _ id: String, _ headers: [String: String]?) {
    guard let current = devices[device].gateway(id) else { return }
    edit(device, id) { gateway in
      gateway.headers = headers.map { SyncHeaders(origin: GatewayAddress.origin(of: gateway.address), headers: $0) }
    }
    if headers == nil {
      devices[device].state.markClearing(.headers, gatewayId: id, key: current.key)
    }
  }

  /// Credentials gone from this device with nobody asking: a keychain read before the first
  /// unlock, a code path that dropped one. No intent is recorded.
  mutating func loseCredentials(_ device: Int, _ id: String) {
    edit(device, id) { gateway in
      gateway.sessionToken = nil
      gateway.frontDoor = nil
      gateway.headers = nil
    }
  }

  /// The device-only print key is gone and minted again, while SQLite kept the old prints.
  mutating func losePrintKey(_ device: Int) {
    devices[device].printKey += "x"
  }

  mutating func remove(_ device: Int, _ id: String, scope: RemovalScope) {
    guard let gateway = devices[device].gateway(id) else { return }
    devices[device].state.markRemoved(gatewayId: id, key: gateway.key, scope: scope)
    devices[device].gateways.removeAll { $0.id == id }
  }

  /// Sign out here: credentials deleted, and the engine told not to put the shared token back.
  mutating func signOut(_ device: Int, _ id: String) {
    guard let gateway = devices[device].gateway(id) else { return }
    edit(device, id) { $0.sessionToken = nil }
    devices[device].state.setSignedOut(true, gatewayId: id, key: gateway.key)
  }

  /// Sign out on all devices (session token): the local token goes and the cleared value syncs.
  mutating func signOutEverywhere(_ device: Int, _ id: String) {
    guard let gateway = devices[device].gateway(id) else { return }
    edit(device, id) { $0.sessionToken = nil }
    devices[device].state.markClearing(.sessionToken, gatewayId: id, key: gateway.key)
  }

  mutating func setGatewaySynced(_ device: Int, _ id: String, _ synced: Bool) {
    guard let gateway = devices[device].gateway(id) else { return }
    devices[device].state.setGatewaySynced(synced, gatewayId: id, key: gateway.key)
  }

  mutating func setEnabled(_ device: Int, _ enabled: Bool) {
    devices[device].state.enabled = enabled
  }
}

// MARK: - Deterministic randomness

/// SplitMix64: small, fast, and the same sequence on every platform for a seed.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}
