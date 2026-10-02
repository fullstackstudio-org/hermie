import Foundation
import HermieGateway
import HermieProtocol

/**
 One gateway as this device holds it: the registry row, the per-gateway config, and the
 shareable credentials from the device-only keychain, each credential with the origin it was
 stored for. A credential whose origin is not this gateway's origin counts as absent (I13).
 */
public struct LocalGateway: Sendable, Equatable {
  public var id: String
  public var name: String
  public var address: String
  public var authKind: String
  public var provider: SyncProvider?
  public var user: String?
  /// Epoch milliseconds; merges to the smallest value across devices.
  public var addedAt: Double
  public var frontDoor: SyncFrontDoor?
  public var headers: SyncHeaders?
  public var sessionToken: SyncSessionToken?

  public init(
    id: String,
    name: String,
    address: String,
    authKind: String,
    provider: SyncProvider? = nil,
    user: String? = nil,
    addedAt: Double,
    frontDoor: SyncFrontDoor? = nil,
    headers: SyncHeaders? = nil,
    sessionToken: SyncSessionToken? = nil
  ) {
    self.id = id
    self.name = name
    self.address = address
    self.authKind = authKind
    self.provider = provider
    self.user = user
    self.addedAt = addedAt
    self.frontDoor = frontDoor
    self.headers = headers
    self.sessionToken = sessionToken
  }

  /// The gateway key of the address, `""` when the address names no gateway.
  public var key: String { GatewayKey.of(address) }
}

extension LocalGateway: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    let secrets = [
      frontDoor.map { _ in "frontDoor" }, headers.map { _ in "headers" }, sessionToken.map { _ in "sessionToken" }
    ].compactMap { $0 }
    return "LocalGateway(\(id), key: \(key), authKind: \(authKind), credentials: \(secrets))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(self, children: ["id": id, "key": key, "authKind": authKind], displayStyle: .struct)
  }
}

/// Turns a value into the opaque print stored in `SyncEntry.prints`. The engine passes a keyed
/// hash (HMAC-SHA-256 under a device-only key, truncated); tests pass anything deterministic.
public struct SyncPrinter: Sendable {
  private let body: @Sendable (String) -> String

  public init(_ body: @escaping @Sendable (String) -> String) {
    self.body = body
  }

  /// The print of a value's canonical text.
  func print(_ value: JSONValue) -> String {
    body(canonical(value))
  }
}

/// Everything local that one reconcile reads.
public struct LocalSyncSnapshot: Sendable {
  public var gateways: [LocalGateway]
  /// Fresh random gateway ids, used in order for gateways adopted from iCloud. Ids already in use
  /// are skipped; when they run out, the remaining records are adopted at the next reconcile.
  public var newIds: [String]
  public var printer: SyncPrinter

  public init(gateways: [LocalGateway], newIds: [String], printer: SyncPrinter) {
    self.gateways = gateways
    self.newIds = newIds
    self.printer = printer
  }
}

extension LocalSyncSnapshot: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "LocalSyncSnapshot(\(gateways.count) gateways)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["gateways": gateways.map(\.description)], displayStyle: .struct)
  }
}

/**
 The merge, as one pure function every device runs: its own gateways and sync state plus the
 records in the store in, a plan out. No clock (`now` is a parameter), no keychain, no SQLite.

 The rules, in the order they are applied (`.claude/plans/native-rewrite-icloud.md`, I3, I4, I9,
 I13, I16 and "Data model"):

 1. Nothing happens unless sync is on, the person has been told (`disclosed`), the state is one
    this build can write, and the device has a tag.
 2. Records are normalised; foreign ones (newer `v`, unreadable, address not hashing to the key)
    block their key: nothing is applied to or written over them.
 3. Tombstones this device remembers (`SyncState.tombstones`) are merged into their record; one the
    keychain lost to a concurrent whole-item write is written again.
 4. Tombstones older than 180 days are deleted.
 5. A gateway that left the local list: removed on all devices → tombstone; otherwise its key is
    hidden on this device, so it is not adopted again.
 6. A gateway whose origin changed: tombstone for the old key (when it was synced), and it starts
    over under the new key; no credential is carried to the new origin.
 7. Per key, one local gateway is the synced one (an already attached one, else the oldest); the
    others are `duplicateOrigin`. "Sync this gateway" switched off deletes the item once.
 8. The synced gateway meets the record for its key: missing (seen before → `absent`; never seen
    → publish), a tombstone (newer than what this device knows →
    purge, also when `absent`; a gateway new on this device → added again, outranking it), or
    live (first attach by the table, or a merge field by field). Local changes are found by
    comparing each value's print with the stored one and are stamped
    `max(now, highest t in the record + 1)`. A local value whose register was written before the
    record's tombstone belongs to an earlier life of the gateway and is removed.
 9. Live records with no local gateway and a key that is not hidden are adopted.

 A device's own write is never taken as published: `seen` is set by a later read of the store,
 not by the write, and every register and tombstone this device knows of is merged in again
 whenever the store has lost it. (A read can still show this device's own copy before iCloud has
 accepted it; if iCloud then refuses it, the entry ends `absent`, device-only, until a device
 publishes the gateway again.)
 */
public enum GatewaySync {
  public static func reconcile(
    local: LocalSyncSnapshot,
    remote: [SyncedGatewayRecord],
    state: SyncState,
    now: Double
  ) -> SyncPlan {
    guard state.unsupportedVersion == nil, state.enabled, state.disclosed, SyncState.isValidDevice(state.device),
      now.isFinite
    else {
      return SyncPlan(state: state)
    }

    var reconciler = Reconciler(local: local, state: state, now: now.rounded(.down))
    return reconciler.run(remote: remote)
  }

  /// The live records a new device could take, for "Found in iCloud Keychain". Foreign records
  /// and tombstones are left out.
  public static func adoptable(_ remote: [SyncedGatewayRecord]) -> [SyncedGatewayRecord] {
    remote.filter { $0.isSupported }.map { $0.normalized() }.filter(\.isLive)
      .sorted { ($0.addedAt ?? .infinity, $0.key) < ($1.addedAt ?? .infinity, $1.key) }
  }
}

// MARK: - The reconcile

private struct Reconciler {
  enum Mode {
    /// The entry has stamps: field by field, by stamp, with local edits stamped now.
    case merge
    /// The entry has never been attached and the record is live: the first-attach table.
    case firstAttach
    /// The record is a tombstone and the gateway is new here: every local value stamped above it.
    case readd
  }

  let gateways: [LocalGateway]
  let printer: SyncPrinter
  let input: SyncState
  let now: Double
  var state: SyncState

  var freshIds: [String]
  var usedIds: Set<String>

  /// The supported records, normalised and merged as far as this run has got.
  var records: [String: SyncedGatewayRecord] = [:]
  /// The text each key has in the store, to tell whether a merged record needs writing.
  var stored: [String: String] = [:]
  /// Keys whose record is foreign.
  var blocked: Set<String> = []
  /// Keys that have an item in the store (for the item limit).
  var itemKeys: Set<String> = []
  var puts: [String: SyncedGatewayRecord] = [:]
  var deletes: Set<String> = []
  var ops: [SyncLocalOp] = []
  var events: [SyncEvent] = []
  var stampCache: [String: SyncStamp] = [:]

  init(local: LocalSyncSnapshot, state: SyncState, now: Double) {
    self.gateways = local.gateways
    self.printer = local.printer
    self.input = state
    self.state = state
    self.now = now
    self.freshIds = local.newIds
    self.usedIds = Set(local.gateways.map(\.id)).union(state.entries.keys)
  }

  mutating func run(remote: [SyncedGatewayRecord]) -> SyncPlan {
    index(remote)
    applyRememberedTombstones()
    prune()
    removeVanished()
    let groups = group()
    for key in groups.keys.sorted() {
      process(key: key, groups[key]!)
    }
    adopt(skipping: Set(groups.keys))
    rememberTombstones()

    return SyncPlan(
      localOps: ops,
      remotePuts: puts.keys.sorted().map { puts[$0]! },
      remoteDeletes: deletes.sorted().map(SyncedGatewayRecord.account(forKey:)),
      state: state,
      events: events,
      stateChanged: state != input
    )
  }

  // MARK: Store side

  mutating func index(_ remote: [SyncedGatewayRecord]) {
    for record in remote where GatewayKey.isValid(record.key) {
      itemKeys.insert(record.key)

      if record.foreign != nil {
        blocked.insert(record.key)
        continue
      }

      let normalized = record.normalized()

      if let existing = records[record.key] {
        // Two items for one key cannot come from one store; merge them and rewrite.
        records[record.key] = .join(existing, normalized)
        stored[record.key] = nil
      } else {
        records[record.key] = normalized
        stored[record.key] = record.storedText
      }
    }

    for key in blocked {
      records[key] = nil
    }
  }

  /// A tombstone this device knows of but the store has lost (a concurrent whole-item write won
  /// over it) is merged back in and written again, as a register would be.
  mutating func applyRememberedTombstones() {
    let cutoff = now - SyncedGatewayRecord.tombstoneLifetime

    for key in state.tombstones.keys.sorted() {
      let stamp = state.tombstones[key]!

      guard stamp.t >= cutoff else {
        state.tombstones[key] = nil
        continue
      }

      guard !blocked.contains(key), let record = records[key] else {
        continue
      }

      var tombstone = SyncedGatewayRecord(key: key)
      tombstone.deleted = stamp

      let joined = SyncedGatewayRecord.join(record, tombstone)
      if joined != record {
        schedule(joined)
      }
    }
  }

  /// Remember every tombstone in the store (and the ones written now); forget one once its
  /// gateway has been added again.
  mutating func rememberTombstones() {
    for key in records.keys.sorted() where !blocked.contains(key) {
      let record = records[key]!

      if record.isTombstone, let deleted = record.deleted {
        state.tombstones[key] = max(state.tombstones[key] ?? deleted, deleted)
      } else if record.isLive {
        state.tombstones[key] = nil
      }
    }
  }

  /// I16: tombstones older than 180 days go.
  mutating func prune() {
    let cutoff = now - SyncedGatewayRecord.tombstoneLifetime

    for key in records.keys.sorted() {
      guard let record = records[key], record.isTombstone, let deleted = record.deleted, deleted.t < cutoff else {
        continue
      }

      deleteItem(key)
    }
  }

  func canAddItem(_ key: String) -> Bool {
    itemKeys.contains(key) || itemKeys.count < SyncedGatewayRecord.maximumItems
  }

  mutating func schedule(_ record: SyncedGatewayRecord) {
    records[record.key] = record
    puts[record.key] = record
    deletes.remove(record.key)
    itemKeys.insert(record.key)
  }

  mutating func deleteItem(_ key: String) {
    records[key] = nil
    puts[key] = nil
    deletes.insert(key)
    itemKeys.remove(key)
  }

  /// `max(now, highest t in the record or in this device's stamps for it + 1)`, one per key per
  /// reconcile so the fields edited together share it.
  mutating func newStamp(_ key: String, _ entry: SyncEntry) -> SyncStamp {
    if let cached = stampCache[key] {
      return cached
    }

    let highest = ([records[key]?.highestT] + entry.stamps.values.map { Optional($0.t) }).compactMap { $0 }.max()
    let stamp = SyncStamp(t: highest.map { max(now, $0 + 1) } ?? now, d: state.device)

    stampCache[key] = stamp
    return stamp
  }

  /// Write a tombstone for a key: "removed from all devices". `false` when it cannot be written.
  mutating func writeTombstone(_ key: String, _ entry: SyncEntry) -> Bool {
    guard !blocked.contains(key) else {
      return false
    }

    let current = records[key]

    if let current, current.isTombstone {
      return true
    }

    guard current != nil || canAddItem(key) else {
      return false
    }

    var tombstone = SyncedGatewayRecord(key: key)
    tombstone.deleted = newStamp(key, entry)
    // A gateway added again at this key in the same run must stamp above the tombstone.
    stampCache[key] = nil

    schedule(current.map { .join($0, tombstone) } ?? tombstone.normalized())
    return true
  }

  // MARK: Local side

  /// Gateways that are gone from the local list since the last reconcile.
  mutating func removeVanished() {
    let present = Set(gateways.map(\.id))

    for id in state.entries.keys.sorted() where !present.contains(id) {
      let entry = state.entries[id]!
      state.entries[id] = nil

      guard GatewayKey.isValid(entry.key), entry.detached != .duplicateOrigin else {
        continue
      }

      if entry.removal == .allDevices, entry.detached == nil, writeTombstone(entry.key, entry) {
        continue
      }

      // Removed from this device (or by something that did not say): do not adopt it again.
      state.hidden.insert(entry.key)
    }
  }

  /// The local gateways by key, oldest first, after origin changes are dealt with.
  mutating func group() -> [String: [LocalGateway]] {
    var groups: [String: [LocalGateway]] = [:]
    var ids = Set<String>()

    for gateway in gateways.sorted(by: Self.oldestFirst) where ids.insert(gateway.id).inserted {
      let key = gateway.key

      guard !key.isEmpty else {
        continue
      }

      if let entry = state.entries[gateway.id] {
        if entry.key != key {
          // I13: a new origin is a new record; the old one is removed everywhere if it was ours.
          if entry.detached == nil, entry.seen || !entry.stamps.isEmpty, GatewayKey.isValid(entry.key),
            records[entry.key]?.isLive == true {
            _ = writeTombstone(entry.key, entry)
          }

          state.entries[gateway.id] = SyncEntry(key: key, detached: entry.detached == .user ? .user : nil)
        }
      } else {
        // Added (again) on this device.
        state.hidden.remove(key)
      }

      groups[key, default: []].append(gateway)
    }

    return groups
  }

  static func oldestFirst(_ left: LocalGateway, _ right: LocalGateway) -> Bool {
    left.addedAt != right.addedAt ? left.addedAt < right.addedAt : left.id < right.id
  }

  mutating func process(key: String, _ group: [LocalGateway]) {
    func entry(_ gateway: LocalGateway) -> SyncEntry {
      state.entries[gateway.id] ?? SyncEntry(key: key)
    }

    let eligible = group.filter { entry($0).detached == nil || entry($0).detached == .absent }
    let attachedBefore = eligible.filter { entry($0).seen || !entry($0).stamps.isEmpty }
    let chosen = (attachedBefore.isEmpty ? eligible : attachedBefore).first

    for gateway in group {
      var current = entry(gateway)

      if gateway.id == chosen?.id || current.detached == .user {
        sync(gateway, current, key: key)
        continue
      }

      if current.detached == nil || current.detached == .absent {
        current.detached = .duplicateOrigin
      }

      state.entries[gateway.id] = current
    }
  }

  /// The synced gateway of a key meets the record for that key.
  mutating func sync(_ gateway: LocalGateway, _ entryIn: SyncEntry, key: String) {
    var entry = entryIn

    guard !blocked.contains(key) else {
      state.entries[gateway.id] = entry
      return
    }

    let record = records[key]

    switch entry.detached {
    case .user?:
      // "Stop syncing this gateway": the item goes once, and the stamps with it.
      if entry.seen || !entry.stamps.isEmpty {
        if record?.isLive == true {
          deleteItem(key)
        }

        entry.seen = false
        entry.stamps = [:]
        entry.prints = [:]
      }

      state.entries[gateway.id] = entry
      return
    case .duplicateOrigin?, .other?:
      state.entries[gateway.id] = entry
      return
    case .absent?:
      guard let record, record.isLive else {
        // An item that comes back as a tombstone newer than anything this device knew of the
        // gateway was removed everywhere, and that reaches a device-only copy too.
        if let deleted = record?.deleted, !entry.stamps.isEmpty,
          !(entry.stamp(.address).map { $0.t > deleted.t } ?? false) {
          purge(gateway)
        } else {
          state.entries[gateway.id] = entry
        }
        return
      }

      entry.detached = nil
    case nil:
      break
    }

    guard let record else {
      if entry.seen {
        // I4: absence is never deletion. Keep it here, device-only, and do not republish it.
        entry.detached = .absent
        state.entries[gateway.id] = entry
      } else {
        attach(gateway, entry, key: key, base: nil, mode: .merge)
      }
      return
    }

    entry.seen = true

    if let deleted = record.deleted, !record.isLive {
      let knownLive = entry.stamp(.address).map { $0.t > deleted.t } ?? false

      if knownLive {
        // The store holds an older tombstone than this device knows about.
        attach(gateway, entry, key: key, base: record, mode: .merge)
      } else if entry.stamps.isEmpty {
        attach(gateway, entry, key: key, base: record, mode: .readd)
      } else {
        purge(gateway)
      }
      return
    }

    attach(gateway, entry, key: key, base: record, mode: entry.stamps.isEmpty ? .firstAttach : .merge)
  }

  mutating func purge(_ gateway: LocalGateway) {
    ops.append(.purge(gatewayId: gateway.id))
    events.append(.removedElsewhere(gatewayId: gateway.id, name: gateway.name))
    state.entries[gateway.id] = nil
  }

  /// Fields that take part for an entry: everything but the sign-in fields while signed out
  /// here, and never `signIn` (phase 2) or `addedAt` (not a register).
  static func participating(_ entry: SyncEntry) -> [SyncField] {
    [.address, .name, .authKind, .provider, .frontDoor, .headers] + (entry.signedOut ? [] : [.user, .sessionToken])
  }

  mutating func attach(
    _ gateway: LocalGateway,
    _ entryIn: SyncEntry,
    key: String,
    base: SyncedGatewayRecord?,
    mode: Mode
  ) {
    var entry = entryIn
    let origin = GatewayAddress.origin(of: gateway.address)
    let fields = Self.participating(entry)
    var merged = base ?? SyncedGatewayRecord(key: key)
    var locals: [SyncField: JSONValue] = [:]

    for field in fields {
      let local = Self.localValue(gateway, field, key: key, origin: origin)
      let remote = merged.registers[field]
      let remoteValue = remote.flatMap { SyncedGatewayRecord.projection(field, $0.value, key: key, origin: origin) }
      var candidate: SyncRegister?

      locals[field] = local

      switch mode {
      case .readd:
        if !local.isNull {
          candidate = Self.register(local, newStamp(key, entry), field: field, previous: nil)
        }
      case .firstAttach:
        if field == .address {
          break
        } else if field.isSecret {
          // Local wins; a null in the record never deletes an unstamped local secret.
          if !local.isNull, remoteValue != local {
            candidate = Self.register(local, newStamp(key, entry), field: field, previous: remote)
          }
        } else if remoteValue == nil || remoteValue == .null, !local.isNull {
          // Record wins when it has a value; otherwise the value that exists is kept and stamped.
          candidate = Self.register(local, newStamp(key, entry), field: field, previous: remote)
        }
      case .merge:
        let stamp = entry.stamp(field)
        var edited = entry.prints[field.rawValue].map { $0 != printer.print(local) } ?? !local.isNull

        if !edited, stamp == nil, remote == nil, !local.isNull {
          edited = true
        }

        if edited {
          if let remoteValue, remoteValue == local {
            // The same value is already there: keep its register.
          } else if remote == nil, stamp == nil, local.isNull {
            // Nothing to clear.
          } else {
            candidate = Self.register(local, newStamp(key, entry), field: field, previous: remote)
          }
        } else if let stamp, remote?.stamp != stamp {
          // The store lost (or never got) the register this value came from: put it back.
          candidate = SyncRegister(value: local, stamp: stamp)
        }
      }

      if let candidate {
        merged.registers[field] = SyncRegister.winner(remote, candidate)
      }
    }

    if gateway.addedAt.isFinite {
      merged.addedAt = min(merged.addedAt ?? gateway.addedAt, gateway.addedAt)
    }

    merged = merged.normalized()

    guard merged.isLive else {
      state.entries[gateway.id] = entryIn
      return
    }

    // I16: a record over the size limit keeps its headers on this device.
    var form = merged
    if form.encodedSize > SyncedGatewayRecord.maximumBytes {
      form.registers[.headers] = base?.registers[.headers]
      if form.encodedSize > SyncedGatewayRecord.maximumBytes {
        form.registers[.headers] = nil
      }
    }

    if base == nil, !canAddItem(key) {
      // I16: no room for another item; try again at a later reconcile.
      state.entries[gateway.id] = entryIn
      return
    }

    if form.encodedSize <= SyncedGatewayRecord.maximumBytes, (try? form.encoded()) != stored[key] {
      schedule(form)
    } else {
      records[key] = form
    }

    var updated = gateway
    var changed = Set<SyncField>()

    for field in fields {
      let local = locals[field]!

      guard let register = merged.registers[field],
        let value = SyncedGatewayRecord.projection(field, register.value, key: key, origin: origin)
      else {
        // A value whose register was written before the gateway was removed everywhere belongs to
        // its earlier life: it goes here too, exactly as if the tombstone had been seen first.
        let earlierLife = entry.stamp(field).flatMap { stamp in merged.deleted.map { stamp.t <= $0.t } } ?? false

        if earlierLife, !local.isNull, ![SyncField.address, .name, .authKind].contains(field) {
          Self.apply(.null, field, to: &updated)
          changed.insert(field)
          entry.prints[field.rawValue] = printer.print(.null)
        } else {
          entry.prints[field.rawValue] = printer.print(local)
        }

        entry.stamps[field.rawValue] = nil
        continue
      }

      if value != local {
        Self.apply(value, field, to: &updated)
        changed.insert(field)
      }

      entry.stamps[field.rawValue] = register.stamp
      entry.prints[field.rawValue] = printer.print(value)
    }

    if let addedAt = merged.addedAt, !(gateway.addedAt <= addedAt) {
      updated.addedAt = addedAt
      changed.insert(.addedAt)
    }

    if !changed.isEmpty {
      ops.append(.update(updated, fields: changed))

      let lostToken = changed.contains(.sessionToken) && updated.sessionToken == nil
      if lostToken, updated.authKind == GatewayAuthMode.sessionToken.rawValue {
        events.append(.needsSignIn(gatewayId: gateway.id))
      }
    }

    state.entries[gateway.id] = entry
  }

  /// Live records nobody here has, and whose key is not hidden, become local gateways.
  mutating func adopt(skipping localKeys: Set<String>) {
    let candidates = records.values
      .filter { $0.isLive && !localKeys.contains($0.key) && !state.hidden.contains($0.key) }
      .sorted { ($0.addedAt ?? .infinity, $0.key) < ($1.addedAt ?? .infinity, $1.key) }

    for record in candidates {
      guard let id = nextId(), let address = record.address, let origin = record.origin else {
        break
      }

      let gateway = LocalGateway(
        id: id,
        name: record.name ?? Self.defaultName(for: address),
        address: address,
        authKind: record.authKind ?? GatewayAuthMode.nativePKCE.rawValue,
        provider: record.provider,
        user: record.user,
        addedAt: record.addedAt ?? now,
        frontDoor: record.frontDoor,
        headers: record.headers,
        sessionToken: record.sessionToken
      )

      var entry = SyncEntry(key: record.key, seen: true)

      for field in Self.participating(entry) {
        let local = Self.localValue(gateway, field, key: record.key, origin: origin)

        if let register = record.registers[field],
          SyncedGatewayRecord.projection(field, register.value, key: record.key, origin: origin) == local {
          entry.stamps[field.rawValue] = register.stamp
        }

        entry.prints[field.rawValue] = printer.print(local)
      }

      state.entries[id] = entry
      ops.append(.add(gateway))
      events.append(.adopted(gatewayId: id))

      if gateway.authKind != GatewayAuthMode.sessionToken.rawValue || gateway.sessionToken == nil {
        events.append(.needsSignIn(gatewayId: id))
      }
    }
  }

  mutating func nextId() -> String? {
    while !freshIds.isEmpty {
      let id = freshIds.removeFirst()

      if Self.isGatewayId(id), usedIds.insert(id).inserted {
        return id
      }
    }

    return nil
  }

  // MARK: Values

  /// The local value of a field as sync sees it: the projection of what is stored, `.null` for
  /// nothing (and for a credential bound to another origin).
  static func localValue(_ gateway: LocalGateway, _ field: SyncField, key: String, origin: String) -> JSONValue {
    let raw: JSONValue? =
      switch field {
      case .address: .string(gateway.address)
      case .name: .string(gateway.name)
      case .authKind: .string(gateway.authKind)
      case .provider: gateway.provider?.json
      case .user: gateway.user.map(JSONValue.string)
      case .frontDoor: gateway.frontDoor?.json
      case .headers: gateway.headers?.json
      case .sessionToken: gateway.sessionToken?.json
      case .signIn, .addedAt: nil
      }

    guard let raw else {
      return .null
    }

    return SyncedGatewayRecord.projection(field, raw, key: key, origin: origin) ?? .null
  }

  static func apply(_ value: JSONValue, _ field: SyncField, to gateway: inout LocalGateway) {
    switch field {
    case .address: gateway.address = value.stringValue ?? gateway.address
    case .name: gateway.name = value.stringValue ?? gateway.name
    case .authKind: gateway.authKind = value.stringValue ?? gateway.authKind
    case .provider: gateway.provider = SyncProvider(json: value)
    case .user: gateway.user = value.stringValue
    case .frontDoor: gateway.frontDoor = SyncFrontDoor(json: value)
    case .headers: gateway.headers = SyncHeaders(json: value)
    case .sessionToken: gateway.sessionToken = SyncSessionToken(json: value)
    case .signIn, .addedAt: break
    }
  }

  /// The fields of a value object this build writes; any other field of the previous value is
  /// carried into the new one.
  static func knownValueKeys(_ field: SyncField) -> Set<String> {
    switch field {
    case .provider: ["name", "label"]
    case .frontDoor: ["origin", "kind", "clientId", "clientSecret"]
    case .headers: ["origin", "headers"]
    case .sessionToken: ["origin", "token"]
    default: []
    }
  }

  /// A new register for a local value, keeping unknown fields of the register it replaces.
  static func register(
    _ value: JSONValue,
    _ stamp: SyncStamp,
    field: SyncField,
    previous: SyncRegister?
  ) -> SyncRegister {
    var newValue = value

    if case var .object(object) = value, let old = previous?.value.objectValue {
      let known = knownValueKeys(field)
      for (name, member) in old where !known.contains(name) && object[name] == nil {
        object[name] = member
      }
      newValue = .object(object)
    }

    var register = SyncRegister(value: newValue, stamp: stamp)
    register.extra = previous?.extra ?? [:]
    return register
  }

  /// The host of an address, as the registry names a gateway without a name.
  static func defaultName(for address: String) -> String {
    let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)

    guard let host = URLComponents(string: trimmed)?.host, !host.isEmpty else {
      return trimmed
    }

    return host
  }

  /// `^g[0-9a-f]{2,64}$`, the registry's id rule.
  static func isGatewayId(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    guard scalars.first == "g", (3...65).contains(scalars.count) else {
      return false
    }

    return scalars.dropFirst().allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }
}
