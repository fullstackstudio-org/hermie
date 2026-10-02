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
/// - Conflicts are settled the way iCloud Keychain settles them: per account,
///   the whole item of the latest write wins (last writer wins, never a merge).
///   "Latest" is a cloud-wide counter, so a delivery older than what a device
///   already has is ignored when it arrives, and the order of delivery never
///   changes the outcome once everything is delivered.
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
/// - faults: `setAvailability(_:on:)` (a device whose keychain refuses the
///   process: empty, writes ignored), `failNext(_:on:with:)` (one call throws);
/// - inspection: `pending(to:)`, `cloudItems()`, `writes()`.
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
  /// counter at the moment it was made.
  struct Change: Sendable {
    let account: String
    let value: String?
    let stamp: Int
  }

  struct Replica: Sendable {
    /// Per account: the newest change applied here, deletes included.
    var entries: [String: Change] = [:]
    /// Deliveries waiting for this device, oldest first.
    var inbox: [Change] = []
    /// Changes made while held, waiting to leave this device.
    var outbox: [Change] = []
    var held = false
    var availability = SyncedStoreAvailability.available
    var failures: [Operation: SecretStoreError] = [:]

    /// Applies a change if it is newer than what this replica has for its
    /// account. Returns whether it did.
    @discardableResult
    mutating func apply(_ change: Change) -> Bool {
      if let current = entries[change.account], current.stamp >= change.stamp { return false }
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
    var clock = 0
    /// What iCloud holds: per account, the newest change that left a device.
    var cloud: [String: Change] = [:]
    var replicas: [String: Replica] = [:]
    /// Device names in the order they were added.
    var devices: [String] = []
    var writes: [Write] = []

    mutating func replica(_ device: String) {
      guard replicas[device] == nil else { return }
      var replica = Replica()
      replica.inbox = cloud.values.filter { $0.value != nil }.sorted { $0.stamp < $1.stamp }
      replicas[device] = replica
      devices.append(device)
      if delivery == .immediate { deliverAll(to: device) }
    }

    mutating func record(_ change: Change, from device: String) {
      if replicas[device]?.held == true {
        replicas[device]?.outbox.append(change)
      } else {
        upload(change, from: device)
      }
    }

    mutating func upload(_ change: Change, from device: String) {
      if let current = cloud[change.account], current.stamp >= change.stamp {
        // Older than what the cloud has: still delivered, and ignored on
        // arrival wherever something newer is already applied.
      } else {
        cloud[change.account] = change
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
      replicas[device]!.apply(change)
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

  public init(delivery: Delivery = .manual) {
    state = Mutex(State(delivery: delivery))
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

  // MARK: - Inspection

  /// What iCloud holds: per account, the newest write that left a device,
  /// deletes left out, ordered by account. Every device that is not held has
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
      state.clock += 1
      let change = Change(account: item.account, value: item.value, stamp: state.clock)
      state.replicas[device]?.apply(change)
      state.writes.append(Write(device: device, account: item.account, kind: .put))
      state.record(change, from: device)
    }
  }

  func delete(account: String, on device: String) throws {
    guard SyncedItem.isValidAccount(account) else { throw SecretStoreError.invalidKey }
    try state.withLock { state in
      try state.takeFailure(.delete, on: device)
      guard state.replicas[device]?.availability == .available,
        state.replicas[device]?.entries[account]?.value != nil
      else { return }
      state.clock += 1
      let change = Change(account: account, value: nil, stamp: state.clock)
      state.replicas[device]?.apply(change)
      state.writes.append(Write(device: device, account: account, kind: .delete))
      state.record(change, from: device)
    }
  }
}

extension FakeCloud: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "FakeCloud(\(devices.count) devices, \(pendingCount) pending)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["devices": devices.count, "pending": pendingCount]) }
}
