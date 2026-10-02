import Foundation
import Synchronization

/// One device's replica of a `FakeCloud`: a `SyncedItemStore` in memory, for
/// tests and previews. Get one with `FakeCloud.replica(_:)`, or `init()` for a
/// store that is alone in its own cloud.
///
/// It enforces the account rule of `ICloudKeychainStore` and, like it, is
/// empty and ignores writes while its device is unavailable.
public struct InMemorySyncedItemStore: SyncedItemStore {
  public let cloud: FakeCloud
  public let device: String

  /// A store alone in a cloud of its own, on device `local`.
  public init() {
    self = FakeCloud().replica("local")
  }

  init(cloud: FakeCloud, device: String) {
    self.cloud = cloud
    self.device = device
  }

  public func availability() -> SyncedStoreAvailability {
    cloud.availability(on: device)
  }

  public func all() throws -> [SyncedItem] {
    try cloud.all(on: device)
  }

  public func put(_ item: SyncedItem) throws {
    try cloud.put(item, on: device)
  }

  public func delete(account: String) throws {
    try cloud.delete(account: account, on: device)
  }
}

extension InMemorySyncedItemStore: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "InMemorySyncedItemStore(device: \(device))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["device": device]) }
}

/// iCloud Keychain for tests: several devices, each with its own replica of the
/// synced set, and delivery between them that the test controls.
///
/// ## The model
///
/// - Each device (`replica(_:)`) holds its own items. A `put` or `delete` on a
///   device changes that device at once, like a keychain write.
/// - Every change leaves its device at once (unless the device is held, see
///   below): the cloud keeps it, and a delivery of it waits in the inbox of every
///   other device. Nothing arrives anywhere until the test delivers it
///   (`.manual`, the default), or at once (`.immediate`).
/// - Conflicts are settled per account and per whole item, never by a merge,
///   under one of two policies (`Conflict`), because iCloud Keychain does not
///   promise either:
///   - `.newestWrite`: the latest write wins everywhere. "Latest" is a
///     cloud-wide counter, so a delivery older than what a device already has
///     is ignored when it arrives, and the order of delivery never changes the
///     outcome.
///   - `.cloudWins`: the cloud settles it. Every change records which cloud
///     version the device's copy was based on; an upload whose base is not the
///     cloud's current version (another device got there first) is refused,
///     is not passed on, and the cloud's copy is sent back to that device and
///     replaces its own. So an offline edit made from a stale copy can be lost,
///     and a stale delete can lose and the item come back. The outcome then
///     depends on the order in which devices reach the cloud.
/// - A delete is a change too: it travels, and keeps an older write from
///   bringing the item back. A delete of an item the device does not have
///   changes nothing and does not travel, as in the keychain.
/// - A device added later receives a delivery for every item the cloud holds.
///
/// ## What a test controls
///
/// - delivery: `deliverAll()`, `deliverNext(to:)` (oldest first),
///   `deliverNewest(to:)`, `deliver(at:to:)` (any order), and
///   `deliverAll(using:)` for a random interleaving across devices;
/// - "drop until asked": `hold(_:)` takes a device offline, so nothing is
///   delivered to it and what it writes stays on it, until `release(_:)`;
/// - items that vanish from one device without a delete travelling (iCloud
///   Keychain switched off with "delete from this device", signing out of the
///   Apple Account, a keychain reset): `wipeLocal(_:)`, and `rejoin(_:)` for
///   the download of everything when it is switched on again;
/// - faults: `setAvailability(_:on:)` (a device whose keychain refuses the
///   process: empty, writes ignored), `failNext(_:on:with:)` (one call throws);
/// - inspection: `pending(to:)`, `cloudItems()`, `writes()`, `refused()`.
///
/// ## What it does not model
///
/// Code under test must not rely on any of these, because real iCloud
/// Keychain does not give them:
///
/// - Delivery is guaranteed here once the test asks; in reality a change may
///   arrive after minutes or days, or never (iCloud Keychain off, no network,
///   an account problem), and the app is never told.
/// - A released device uploads everything it wrote while held at once and in
///   order; in reality uploads may be batched, reordered or partial.
/// - Delete tombstones are kept here forever (in the cloud and on every
///   replica), so a very old write can never bring an item back; real
///   tombstones expire.
/// - A change is delivered at most once per device here (apart from a refused
///   upload's copy and `rejoin(_:)`); duplicate delivery cannot be injected.
/// - Conflicts are settled by one of the two policies above, consistently;
///   the real service gives no documented rule.
///
/// Thread-safe. Its descriptions never show an account or a value.
public final class FakeCloud: Sendable {
  /// When a change reaches the other devices.
  public enum Delivery: Sendable, Equatable {
    /// Only when the test delivers it.
    case manual
    /// As soon as it leaves its device.
    case immediate
  }

  /// How two writes to one account are settled. See the type's documentation.
  public enum Conflict: Sendable, Equatable {
    /// The latest write wins on every device.
    case newestWrite
    /// The first change to reach the cloud wins; an upload made from a stale
    /// copy is refused and the device gets the cloud's copy back.
    case cloudWins
  }

  /// A store call, for `failNext(_:on:with:)`.
  public enum Operation: Sendable, Hashable {
    case all
    case put
    case delete
  }

  /// A change a device made to its own replica, in order. Never the value.
  public struct Write: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
      case put
      case delete
    }

    public let device: String
    public let account: String
    public let kind: Kind

    public init(device: String, account: String, kind: Kind) {
      self.device = device
      self.account = account
      self.kind = kind
    }
  }

  /// One change: a value, or nil for a delete, stamped with the cloud-wide
  /// counter at the moment it was made, and based on the version (stamp) of
  /// the copy the device had then, 0 for none.
  struct Change: Sendable {
    let account: String
    let value: String?
    let stamp: Int
    let base: Int
  }

  struct Replica: Sendable {
    /// Per account: the current copy here, deletes included.
    var entries: [String: Change] = [:]
    /// Per account: the newest cloud version this replica has applied or had
    /// accepted (`.cloudWins` only).
    var seen: [String: Int] = [:]
    /// Deliveries waiting for this device, oldest first.
    var inbox: [Change] = []
    /// Changes made while held, waiting to leave this device.
    var outbox: [Change] = []
    var held = false
    var availability = SyncedStoreAvailability.available
    var failures: [Operation: SecretStoreError] = [:]

    /// Applies a delivered cloud version if it is newer than what this
    /// replica has: than its copy under `.newestWrite`, than the newest cloud
    /// version it has seen under `.cloudWins` (so the cloud's copy replaces a
    /// local write the cloud refused). Returns whether it did.
    @discardableResult
    mutating func apply(_ change: Change, _ conflict: Conflict) -> Bool {
      switch conflict {
      case .newestWrite:
        if let current = entries[change.account], current.stamp >= change.stamp { return false }
      case .cloudWins:
        if let seen = seen[change.account], seen >= change.stamp { return false }
        seen[change.account] = change.stamp
      }
      entries[change.account] = change
      return true
    }

    var items: [SyncedItem] {
      entries.values
        .compactMap { change in change.value.map { SyncedItem(account: change.account, value: $0) } }
        .sorted { $0.account < $1.account }
    }
  }

  struct State: Sendable {
    let delivery: Delivery
    let conflict: Conflict
    var clock = 0
    /// What iCloud holds: per account, the version that won.
    var cloud: [String: Change] = [:]
    var replicas: [String: Replica] = [:]
    /// Device names in the order they were added.
    var devices: [String] = []
    var writes: [Write] = []
    var refused: [Write] = []

    /// The cloud's live items, oldest first: what a joining device downloads.
    var liveCloudChanges: [Change] {
      cloud.values.filter { $0.value != nil }.sorted { $0.stamp < $1.stamp }
    }

    mutating func replica(_ device: String) {
      guard replicas[device] == nil else { return }
      var replica = Replica()
      replica.inbox = liveCloudChanges
      replicas[device] = replica
      devices.append(device)
      if delivery == .immediate { deliverAll(to: device) }
    }

    /// A local write: applied to the device's copy at once, then sent.
    mutating func write(_ account: String, _ value: String?, on device: String) {
      clock += 1
      let base = replicas[device]?.entries[account]?.stamp ?? 0
      let change = Change(account: account, value: value, stamp: clock, base: base)
      replicas[device]?.entries[account] = change
      writes.append(Write(device: device, account: account, kind: value == nil ? .delete : .put))
      if replicas[device]?.held == true {
        replicas[device]?.outbox.append(change)
      } else {
        upload(change, from: device)
      }
    }

    mutating func upload(_ change: Change, from device: String) {
      switch conflict {
      case .newestWrite:
        if (cloud[change.account]?.stamp ?? 0) < change.stamp { cloud[change.account] = change }
        // An older change is still delivered, and ignored on arrival wherever
        // something newer is already applied.
      case .cloudWins:
        if let current = cloud[change.account], current.stamp != change.base {
          // Another device reached the cloud first: refused, not passed on,
          // and the cloud's copy goes back to this device.
          let kind: Write.Kind = change.value == nil ? .delete : .put
          refused.append(Write(device: device, account: change.account, kind: kind))
          replicas[device]?.inbox.append(current)
          if delivery == .immediate { deliverAll(to: device) }
          return
        }
        cloud[change.account] = change
        replicas[device]?.seen[change.account] = change.stamp
      }
      for other in devices where other != device {
        replicas[other]?.inbox.append(change)
        if delivery == .immediate { deliverAll(to: other) }
      }
    }

    @discardableResult
    mutating func deliver(at index: Int, to device: String) -> Bool {
      guard let replica = replicas[device], !replica.held, replica.inbox.indices.contains(index) else {
        return false
      }
      let change = replicas[device]!.inbox.remove(at: index)
      replicas[device]!.apply(change, conflict)
      return true
    }

    mutating func deliverAll(to device: String) {
      while deliver(at: 0, to: device) {}
    }

    mutating func takeFailure(_ operation: Operation, on device: String) throws {
      if let error = replicas[device]?.failures.removeValue(forKey: operation) { throw error }
    }
  }

  let state: Mutex<State>

  public init(delivery: Delivery = .manual, conflict: Conflict = .newestWrite) {
    state = Mutex(State(delivery: delivery, conflict: conflict))
  }

  // MARK: - Devices

  /// The store of a device, created on first use. Asking again for the same
  /// name gives a store on the same replica.
  public func replica(_ device: String) -> InMemorySyncedItemStore {
    precondition(!device.isEmpty, "a device needs a name")
    state.withLock { $0.replica(device) }
    return InMemorySyncedItemStore(cloud: self, device: device)
  }

  /// Every device, in the order it was added.
  public var devices: [String] { state.withLock { $0.devices } }

  // MARK: - Delivery

  /// The accounts of the deliveries waiting for a device, oldest first.
  public func pending(to device: String) -> [String] {
    state.withLock { $0.replicas[device]?.inbox.map(\.account) ?? [] }
  }

  /// How many deliveries are waiting, on every device, held ones included.
  public var pendingCount: Int {
    state.withLock { state in state.replicas.values.reduce(0) { $0 + $1.inbox.count + $1.outbox.count } }
  }

  /// Delivers the oldest waiting change to a device. False when there is none
  /// or the device is held.
  @discardableResult
  public func deliverNext(to device: String) -> Bool {
    state.withLock { $0.deliver(at: 0, to: device) }
  }

  /// Delivers the newest waiting change to a device, out of order.
  @discardableResult
  public func deliverNewest(to device: String) -> Bool {
    state.withLock { state in
      guard let count = state.replicas[device]?.inbox.count, count > 0 else { return false }
      return state.deliver(at: count - 1, to: device)
    }
  }

  /// Delivers the waiting change at `index` (in `pending(to:)` order).
  @discardableResult
  public func deliver(at index: Int, to device: String) -> Bool {
    state.withLock { $0.deliver(at: index, to: device) }
  }

  /// Delivers everything waiting for every device that is not held, oldest
  /// first.
  public func deliverAll() {
    state.withLock { state in
      for device in state.devices { state.deliverAll(to: device) }
    }
  }

  /// Delivers everything waiting for every device that is not held, one
  /// change at a time, picking the device and the change at random.
  public func deliverAll(using generator: inout some RandomNumberGenerator) {
    state.withLock { state in
      while true {
        let candidates = state.devices.flatMap { device -> [(String, Int)] in
          guard let replica = state.replicas[device], !replica.held else { return [] }
          return replica.inbox.indices.map { (device, $0) }
        }
        guard let (device, index) = candidates.randomElement(using: &generator) else { return }
        state.deliver(at: index, to: device)
      }
    }
  }

  /// Takes a device offline: nothing is delivered to it, and what it writes
  /// stays on it, until `release(_:)`.
  public func hold(_ device: String) {
    state.withLock { $0.replicas[device]?.held = true }
  }

  /// Brings a held device back: what it wrote meanwhile leaves it, in order.
  /// With `.immediate` delivery, everything waiting for it is delivered too.
  public func release(_ device: String) {
    state.withLock { state in
      guard state.replicas[device]?.held == true else { return }
      state.replicas[device]?.held = false
      let outbox = state.replicas[device]?.outbox ?? []
      state.replicas[device]?.outbox = []
      for change in outbox { state.upload(change, from: device) }
      if state.delivery == .immediate { state.deliverAll(to: device) }
    }
  }

  /// Empties a device's replica without a delete travelling: its items, what
  /// waits for it and what it wrote while held are gone, and nothing is sent.
  /// Models iCloud Keychain switched off with "delete from this device",
  /// signing out of the Apple Account, or a keychain reset. Later changes from
  /// other devices still reach it; `rejoin(_:)` downloads the rest.
  public func wipeLocal(_ device: String) {
    state.withLock { state in
      state.replicas[device]?.entries = [:]
      state.replicas[device]?.seen = [:]
      state.replicas[device]?.inbox = []
      state.replicas[device]?.outbox = []
    }
  }

  /// Queues every live item the cloud holds for a device, as for a device
  /// that joins late: iCloud Keychain switched on again downloads everything.
  /// What already waits for it stays queued. With `.immediate` delivery it is
  /// delivered at once.
  public func rejoin(_ device: String) {
    state.withLock { state in
      guard state.replicas[device] != nil else { return }
      let live = state.liveCloudChanges
      state.replicas[device]?.inbox += live
      if state.delivery == .immediate { state.deliverAll(to: device) }
    }
  }

  // MARK: - Inspection

  /// What iCloud holds: per account, the version that won, deletes left out,
  /// ordered by account. Every device that is not held has
  /// exactly this once everything is delivered.
  public func cloudItems() -> [SyncedItem] {
    state.withLock { state in
      state.cloud.values
        .compactMap { change in change.value.map { SyncedItem(account: change.account, value: $0) } }
        .sorted { $0.account < $1.account }
    }
  }

  /// Every write a device made to its own replica, in order. Writes ignored
  /// because the device was unavailable, and deletes of nothing, are not
  /// here.
  public func writes() -> [Write] {
    state.withLock { $0.writes }
  }

  /// Every upload the cloud refused under `.cloudWins`, in order: the device
  /// that made it, the account, and whether it was a put or a delete.
  public func refused() -> [Write] {
    state.withLock { $0.refused }
  }

  // MARK: - Faults

  /// A device whose keychain refuses the process: while `unavailable` its
  /// store reports so, lists nothing and ignores writes. Deliveries still
  /// reach its replica, as iCloud Keychain would still fill the device's
  /// keychain.
  public func setAvailability(_ availability: SyncedStoreAvailability, on device: String) {
    state.withLock { $0.replicas[device]?.availability = availability }
  }

  /// The next call of that kind on that device throws `error` and changes
  /// nothing. Accounts are still validated first.
  public func failNext(_ operation: Operation, on device: String, with error: SecretStoreError) {
    state.withLock { $0.replicas[device]?.failures[operation] = error }
  }

  // MARK: - The store calls

  func availability(on device: String) -> SyncedStoreAvailability {
    state.withLock { $0.replicas[device]?.availability ?? .unavailable }
  }

  func all(on device: String) throws -> [SyncedItem] {
    try state.withLock { state in
      try state.takeFailure(.all, on: device)
      guard let replica = state.replicas[device], replica.availability == .available else { return [] }
      return replica.items
    }
  }

  func put(_ item: SyncedItem, on device: String) throws {
    guard SyncedItem.isValidAccount(item.account) else { throw SecretStoreError.invalidKey }
    try state.withLock { state in
      try state.takeFailure(.put, on: device)
      guard state.replicas[device]?.availability == .available else { return }
      state.write(item.account, item.value, on: device)
    }
  }

  func delete(account: String, on device: String) throws {
    guard SyncedItem.isValidAccount(account) else { throw SecretStoreError.invalidKey }
    try state.withLock { state in
      try state.takeFailure(.delete, on: device)
      guard state.replicas[device]?.availability == .available,
        state.replicas[device]?.entries[account]?.value != nil
      else { return }
      state.write(account, nil, on: device)
    }
  }
}

extension FakeCloud: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "FakeCloud(\(devices.count) devices, \(pendingCount) pending)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["devices": devices.count, "pending": pendingCount]) }
}
