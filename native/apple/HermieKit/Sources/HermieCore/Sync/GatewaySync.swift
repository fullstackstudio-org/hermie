// Amendments after review (they change rules of the first version of this merge):
//
// - A credential (front door, headers, session token) that goes missing on one device is never
//   published as cleared. Only a clear the person asked for (`SyncEntry.clearing`) goes out; any
//   other missing credential is put back from iCloud (`SyncEvent.credentialRestored`), or left
//   missing while signed out here. A clear intent not acted on in an attach is dropped.
// - "Sign Out on All Devices" goes out while signed out here: the cleared token (or user) is
//   published, nothing is written locally, and a clear the store lost is put back at its stamp.
// - When the print key changes (`SyncState.printCheck`), every stored print is void and each field
//   is rebuilt from its stamp: if the record still holds the register last synced here, the usual
//   merge runs; otherwise a local value is offered only at its old stamp, so a newer one elsewhere
//   wins. No value nobody touched ever gets a new stamp; fields without a stamp follow the
//   first-attach table.
// - A tombstone is pruned only when its stamp is older than 180 days by this device's clock AND
//   this device first saw it at least 180 days ago, by its own clock.
// - A remembered tombstone is kept for three years of this device's own time (at most 512), so a
//   stale copy of a removed gateway that turns up later is cut again instead of coming back. While
//   young (seen here under 30 days ago, stamp under 150 days), one whose item vanished is written
//   back (at most three times), so a "stop syncing" delete that raced it cannot swallow the removal.
// - Only a gateway the person added here (`SyncEntry.addedHere`) is published over a removal on all
//   devices; one that merely existed here becomes `absent`, device-only. The same holds once the
//   tombstone itself is pruned and only this device's memory of it is left.
// - A removal on all devices always writes a fresh tombstone, even over an existing one, so its
//   age starts when the person removed the gateway.
// - A gateway the sync purged before its state was saved is not hidden by the next run.
// - "Stop syncing" deletes the item again while every read still shows the one this device knew;
//   switched off, a gateway keeps its stamps, so switching it on merges rather than republishing
//   values it only received. A synced sibling at the same origin keeps its item.
// - A move to another origin (or to an address that names none) writes the old key's tombstone
//   unless one already covers what this device knew, and hides the old key when it cannot. The
//   credentials the move leaves behind are deleted here, and remembered by keyed print
//   (`SyncEntry.leftBehind`) until they are, so moving back cannot revive one.
// - `SyncPlan.provisionalState` is saved with the registry changes, before the keychain, iCloud and
//   the final state; fields being written are marked pending, so after a crash a received value
//   never passes for one entered here.
// - A record is applied only when its address names the same origin as the local gateway (the
//   key is FNV-1a, which is not collision resistant).
// - Stamps outside `[0, 2^53 − 2^20]` are invalid; new stamps are clamped into that range.
// - Removing the last duplicate at a key, or moving an `absent` or switched-off gateway to another
//   origin, hides the old key.
// - Headers kept on the device by the size limit are announced (`SyncEvent.headersNotSynced`).
// - Header names and values, and front-door kinds and ids, are validated as the wizard does.

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

  /// The print of `SyncState.printCheckText`: equal to the stored one exactly when the key is.
  var check: String {
    body(SyncState.printCheckText)
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

 The rules, in the order they are applied:

 1. Nothing happens unless sync is on, the person has been told (`disclosed`), the state is one
    this build can write, and the device has a tag.
 2. When the print key changed, every print is void; each field is then rebuilt from its stamp.
 3. Records are normalised; foreign ones (newer `v`, unreadable, address not hashing to the key)
    block their key: nothing is applied to or written over them.
 4. Every tombstone in the store is remembered with the time this device first saw it, and every
    remembered one (kept three years of this device's time) is merged into its record; one the
    keychain lost to a concurrent whole-item write is written again.
 5. A tombstone goes once its stamp is 180 days old by this clock and this device saw it 180 days
    ago.
 6. A gateway that left the local list: removed on all devices → tombstone; purged by an earlier
    sync whose state was never saved → forgotten; otherwise its key is hidden on this device, so
    it is not adopted again.
 7. A gateway whose origin changed: tombstone for the old key (when it was synced; the old key is
    hidden when it was device-only), and it starts over under the new key as one added here; no
    credential is carried to the new origin.
 8. Per key, one local gateway is the synced one (an already attached one, else the oldest); the
    others are `duplicateOrigin`. "Sync this gateway" switched off deletes the item once.
 9. The synced gateway meets the record for its key, when that names the same origin: missing
    (seen before → `absent`; a removal remembered here and not added here → kept `absent`, or
    purged if it was synced; otherwise → publish), a tombstone (newer than what this device
    knows → purge, also when `absent`; added here → added again above it; otherwise kept here as
    `absent`), or live (first attach by the table, or a merge field by field). Local changes are
    found by comparing each value's print with the stored one and are stamped
    `max(now, highest t in the record + 1)`. A credential missing here is cleared everywhere only
    when the person cleared it; otherwise it is put back from iCloud. A local value whose register
    was written before the record's tombstone belongs to an earlier life of the gateway and goes.
 10. Live records with no local gateway and a key that is not hidden are adopted.

 A device's own write is never taken as published: `seen` is set by a later read of the store,
 not by the write, and every register and tombstone this device knows of is merged in again
 whenever the store has lost it. (A read can still show this device's own copy before iCloud has
 accepted it; if iCloud then refuses it, the entry ends `absent`, device-only, until a device
 publishes the gateway again; `SyncState.resync(gatewayId:)` is the way back.)
 */
public enum GatewaySync {
  /// How long a device remembers a removal on all devices, by its own clock.
  public static let tombstoneMemory: Double = 3 * 365 * 24 * 60 * 60 * 1000

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

    return reconcile(local: local, remote: remote, state: state, now: now, keyOf: GatewayKey.of)
  }

  /// The same, with the key of a local address computed by `keyOf`: only tests pass anything but
  /// `GatewayKey.of`, to stand in for a hash collision no test can find.
  static func reconcile(
    local: LocalSyncSnapshot,
    remote: [SyncedGatewayRecord],
    state: SyncState,
    now: Double,
    keyOf: @escaping (String) -> String
  ) -> SyncPlan {
    guard state.unsupportedVersion == nil, state.enabled, state.disclosed, SyncState.isValidDevice(state.device),
      now.isFinite
    else {
      return SyncPlan(state: state)
    }

    var reconciler = Reconciler(local: local, state: state, now: now.rounded(.down), keyOf: keyOf)
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
    /// The entry has stamps: field by field, by stamp, with local edits stamped now. A field
    /// without a stored print follows the first-attach table.
    case merge
    /// The entry has never been attached and the record is live: the first-attach table.
    case firstAttach
    /// The record is a tombstone and the gateway was added here: every local value stamped above it.
    case readd
  }

  /// A remembered tombstone whose item vanished is written again only while this device saw it
  /// less than 30 days ago and its stamp is younger than 150 days: well inside the 180 days after
  /// which another device may prune it, so the two never take turns.
  static let rewriteWindow: Double = 30 * 24 * 60 * 60 * 1000
  static let rewriteStampAge: Double = 150 * 24 * 60 * 60 * 1000
  /// At most this many times per remembered tombstone.
  static let maximumRewrites = 3
  /// At most this many remembered tombstones; the oldest by first sight go first.
  static let maximumRemembered = 512

  /// The credentials only an explicit clear may clear everywhere.
  static let credentials: Set<SyncField> = [.frontDoor, .headers, .sessionToken]

  let gateways: [LocalGateway]
  let printer: SyncPrinter
  let keyOf: (String) -> String
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
  var traces: Set<SyncTrace> = []
  var stampCache: [String: SyncStamp] = [:]
  /// Per gateway, the fields this run writes locally: the print of the value before and after.
  var pendingWrites: [String: [SyncField: (old: String, new: String)]] = [:]

  init(local: LocalSyncSnapshot, state: SyncState, now: Double, keyOf: @escaping (String) -> String) {
    self.keyOf = keyOf
    self.gateways = local.gateways
    self.printer = local.printer
    self.input = state
    self.state = state
    self.now = now
    self.freshIds = local.newIds
    self.usedIds = Set(local.gateways.map(\.id)).union(state.entries.keys)
  }

  mutating func run(remote: [SyncedGatewayRecord]) -> SyncPlan {
    checkPrints()
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

    // What the engine saves with the registry changes, before the keychain is touched: the final
    // state, with every field this plan writes here marked pending (its print before and after),
    // so a crash before the rest leaves nothing that looks entered on this device.
    var provisionalState = state
    for (id, fields) in pendingWrites {
      for (field, prints) in fields {
        provisionalState.entries[id]?.prints[field.rawValue] = SyncEntry.pendingPrint(from: prints.old, to: prints.new)
      }
    }

    var plan = SyncPlan(
      localOps: ops,
      remotePuts: puts.keys.sorted().map { puts[$0]! },
      remoteDeletes: deletes.sorted().map(SyncedGatewayRecord.account(forKey:)),
      state: state,
      events: events,
      stateChanged: state != input
    )
    plan.traces = traces
    plan.provisionalState = provisionalState
    return plan
  }

  // MARK: Prints

  /// A print key that changed voids every stored print: without them, each gateway is attached
  /// as on first sight, where local credentials win and nothing is cleared.
  mutating func checkPrints() {
    let check = printer.check

    guard state.printCheck != check else {
      return
    }

    if state.entries.values.contains(where: { !$0.prints.isEmpty }) {
      for id in state.entries.keys {
        // A write still pending stays pending, its prints unknown now: the record will win there.
        state.entries[id]!.prints = state.entries[id]!.prints.compactMapValues { print in
          SyncEntry.pending(print) != nil ? SyncEntry.pendingPrint(from: "", to: "") : nil
        }
      }
      traces.insert(.printsReset)
    }

    state.printCheck = check
  }

  // MARK: Store side

  mutating func index(_ remote: [SyncedGatewayRecord]) {
    for record in remote where GatewayKey.isValid(record.key) {
      itemKeys.insert(record.key)

      if record.foreign != nil {
        blocked.insert(record.key)
        traces.insert(.foreignRecord)
        continue
      }

      let normalized = record.normalized()

      if let existing = records[record.key] {
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

    // Two items for one key cannot come from one store; write the merged one back as one.
    for key in records.keys.sorted() where stored[key] == nil {
      schedule(records[key]!)
    }

    for key in records.keys.sorted() {
      if let record = records[key], record.isTombstone, let deleted = record.deleted {
        note(deleted, key: key)
      }
    }
  }

  /// Remember a tombstone, with the time this device first saw it (a newer one starts over).
  mutating func note(_ deleted: SyncStamp, key: String) {
    if let memory = state.tombstones[key], memory.stamp >= deleted {
      return
    }

    state.tombstones[key] = SyncTombstoneMemory(stamp: deleted, firstSeen: now)
  }

  /// A tombstone this device knows of but the store has lost (a concurrent whole-item write won
  /// over it, or a stale copy came back) is merged back in and written again, as a register is.
  mutating func applyRememberedTombstones() {
    for key in state.tombstones.keys.sorted() {
      let memory = state.tombstones[key]!

      guard now - memory.firstSeen < GatewaySync.tombstoneMemory else {
        state.tombstones[key] = nil
        continue
      }

      guard !blocked.contains(key) else {
        continue
      }

      var tombstone = SyncedGatewayRecord(key: key)
      tombstone.deleted = memory.stamp

      guard let record = records[key] else {
        // The item vanished while the removal is young here (a "stop syncing" delete elsewhere that
        // landed after it): write it again, or the devices that have not seen it keep the gateway.
        let young = now - memory.firstSeen < Self.rewriteWindow && now - memory.stamp.t < Self.rewriteStampAge
        if young, memory.rewrites < Self.maximumRewrites, canAddItem(key) {
          schedule(tombstone.normalized())
          state.tombstones[key]!.rewrites += 1
          traces.insert(.tombstoneRewrittenOverMissing)
        }
        continue
      }

      let joined = SyncedGatewayRecord.join(record, tombstone)
      if joined != record {
        schedule(joined)
        traces.insert(.tombstoneRewritten)
      }
    }
  }

  /// Remember the tombstones written in this run; forget one once its gateway has been added again.
  mutating func rememberTombstones() {
    for key in records.keys.sorted() where !blocked.contains(key) {
      let record = records[key]!

      if record.isTombstone, let deleted = record.deleted {
        note(deleted, key: key)
      } else if record.isLive {
        state.tombstones[key] = nil
      }
    }

    if state.tombstones.count > Self.maximumRemembered {
      let oldest = state.tombstones.sorted { left, right in
        left.value.firstSeen != right.value.firstSeen ? left.value.firstSeen < right.value.firstSeen : left.key < right.key
      }
      for (key, _) in oldest.prefix(state.tombstones.count - Self.maximumRemembered) {
        state.tombstones[key] = nil
      }
    }
  }

  /// I16: tombstones older than 180 days go, measured twice by this device's own clock: by the
  /// stamp, and since this device first saw it. A wrong clock elsewhere cannot shorten either.
  mutating func prune() {
    let lifetime = SyncedGatewayRecord.tombstoneLifetime

    for key in records.keys.sorted() {
      guard let record = records[key], record.isTombstone, let deleted = record.deleted,
        deleted.t < now - lifetime, let memory = state.tombstones[key], now - memory.firstSeen >= lifetime
      else {
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

  /// `max(now, highest t in the record or in this device's stamps for it + 1)`, clamped into the
  /// valid range, one per key per reconcile so the fields edited together share it.
  mutating func newStamp(_ key: String, _ entry: SyncEntry) -> SyncStamp {
    if let cached = stampCache[key] {
      return cached
    }

    let highest = ([records[key]?.highestT] + entry.stamps.values.map { Optional($0.t) }).compactMap { $0 }.max()
    let stamp = SyncStamp(t: SyncStamp.clamped(highest.map { max(now, $0 + 1) } ?? now), d: state.device)

    stampCache[key] = stamp
    return stamp
  }

  /// Write a tombstone for a key: "removed from all devices". `false` when it cannot be written.
  mutating func writeTombstone(_ key: String, _ entry: SyncEntry) -> Bool {
    guard !blocked.contains(key) else {
      return false
    }

    // Written even over an existing tombstone: the person removed it now, so its age starts now,
    // and an old one about to be pruned cannot carry this removal away with it.
    let current = records[key]

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
    let presentKeys = Set(gateways.map { keyOf($0.address) })

    for id in state.entries.keys.sorted() where !present.contains(id) {
      let entry = state.entries[id]!
      state.entries[id] = nil

      guard GatewayKey.isValid(entry.key) else {
        continue
      }

      if entry.detached == .duplicateOrigin {
        // The last copy at this key is gone: do not adopt it back.
        if !presentKeys.contains(entry.key) {
          state.hidden.insert(entry.key)
        }
        continue
      }

      if entry.removal == .allDevices, entry.detached == nil, writeTombstone(entry.key, entry) {
        continue
      }

      // Purged by a sync whose state was not saved: the tombstone is newer than what this entry
      // knew, so it was the removal everywhere, not the person removing it here.
      if entry.removal == nil, let address = entry.stamp(.address),
        let deleted = records[entry.key]?.deleted ?? state.tombstones[entry.key]?.stamp,
        records[entry.key]?.isLive != true, deleted.t >= address.t {
        traces.insert(.crashedPurgeRecovered)
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
    let presentKeys = Set(gateways.map { keyOf($0.address) })

    for original in gateways.sorted(by: Self.oldestFirst) where ids.insert(original.id).inserted {
      let remembered = state.entries[original.id]?.leftBehind ?? []
      let (gateway, dropped) = leaveBehind(original, remembered: remembered)
      // `""` for an address that names no gateway: a move away from the old key all the same.
      let key = keyOf(gateway.address)
      // What stays remembered as left behind: only prints a local credential still has (a drop
      // that has not landed yet), so it is forgotten once the credential is really gone.
      let stillHere = Set(Self.credentialPrints(original, printer: printer))
      let leftBehind = remembered.union(dropped).intersection(stillHere)

      if let entry = state.entries[gateway.id] {
        if entry.key != key {
          moveAway(from: entry, presentKeys: presentKeys)
          state.entries[gateway.id] = SyncEntry(
            key: key, detached: entry.detached == .user ? .user : nil, addedHere: true)
          if !key.isEmpty { state.hidden.remove(key) }
        } else if entry.addedHere, !key.isEmpty {
          state.hidden.remove(key)
        }
      } else if !key.isEmpty {
        // Added (again) on this device.
        state.hidden.remove(key)
      }

      if state.entries[original.id] != nil {
        state.entries[original.id]!.leftBehind = leftBehind
      } else if !leftBehind.isEmpty {
        state.entries[original.id] = SyncEntry(key: key, leftBehind: leftBehind)
      }

      guard !key.isEmpty else {
        continue
      }

      groups[key, default: []].append(gateway)
    }

    return groups
  }

  /// I13: a gateway moved to another origin (or to an address that names none). Its old record is
  /// removed everywhere if it was synced from here, unless a tombstone already covers what this
  /// device knew; when that cannot be written, or the gateway was device-only, the old key is
  /// hidden here, so its record is not adopted back as a copy.
  mutating func moveAway(from entry: SyncEntry, presentKeys: Set<String>) {
    guard GatewayKey.isValid(entry.key) else {
      return
    }

    let synced = entry.detached == nil && (entry.seen || !entry.stamps.isEmpty)
    let hideable = !presentKeys.contains(entry.key)

    if synced {
      let known = entry.stamps.values.map(\.t).max() ?? -Double.infinity
      let covered = records[entry.key].map { $0.isTombstone && ($0.deleted?.t ?? -Double.infinity) >= known } ?? false

      if !covered, !writeTombstone(entry.key, entry), hideable {
        state.hidden.insert(entry.key)
      }
    } else if hideable {
      state.hidden.insert(entry.key)
    }
  }

  /// I13 on this device: a credential bound to another origin than its gateway's (left behind by a
  /// move) can never be used here, so it goes. Done at every reconcile, so a crash cannot keep it,
  /// and a move back to that origin cannot bring a credential from an earlier time back to life
  /// and send it out as if entered here.
  mutating func leaveBehind(_ gateway: LocalGateway, remembered: Set<String>) -> (LocalGateway, Set<String>) {
    let origin = GatewayAddress.origin(of: gateway.address)
    var kept = gateway
    var fields = Set<SyncField>()
    var dropped = Set<String>()

    // Bound to another origin, or left behind by an earlier move (the drop may not have landed
    // before the gateway moved back to that origin).
    func goes(_ value: JSONValue, _ boundTo: String) -> Bool {
      let print = printer.print(value)
      guard boundTo != origin || remembered.contains(print) else { return false }
      dropped.insert(print)
      return true
    }

    if let door = gateway.frontDoor, goes(door.json, door.origin) {
      kept.frontDoor = nil
      fields.insert(.frontDoor)
    }
    if let headers = gateway.headers, goes(headers.json, headers.origin) {
      kept.headers = nil
      fields.insert(.headers)
    }
    if let token = gateway.sessionToken, goes(token.json, token.origin) {
      kept.sessionToken = nil
      fields.insert(.sessionToken)
    }

    if !fields.isEmpty {
      ops.append(.update(kept, fields: fields))
      traces.insert(.credentialsLeftBehind)
    }

    return (kept, dropped)
  }

  /// Keyed prints of a gateway's credentials as stored (with their origin).
  static func credentialPrints(_ gateway: LocalGateway, printer: SyncPrinter) -> [String] {
    [gateway.frontDoor?.json, gateway.headers?.json, gateway.sessionToken?.json].compactMap { $0 }.map(printer.print)
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
        sync(gateway, current, key: key, keySyncedHere: chosen != nil)
        continue
      }

      if current.detached == nil || current.detached == .absent {
        current.detached = .duplicateOrigin
      }

      store(gateway.id, current)
    }
  }

  /// The synced gateway of a key meets the record for that key.
  /// `keySyncedHere`: another local gateway at this key is (or becomes) the synced one, so the item
  /// is its, and a switched-off sibling must not delete it.
  mutating func sync(_ gateway: LocalGateway, _ entryIn: SyncEntry, key: String, keySyncedHere: Bool = false) {
    var entry = entryIn

    guard !blocked.contains(key) else {
      // A foreign item is never touched.
      if entry.detached == .user {
        entry.seen = false
      }
      store(gateway.id, entry)
      return
    }

    let record = records[key]

    // The key is a 64-bit FNV-1a hash: a record for another origin can share it. Never apply one.
    if let origin = record?.origin, origin != GatewayAddress.origin(of: gateway.address) {
      traces.insert(.originCollision)
      store(gateway.id, entry)
      return
    }

    switch entry.detached {
    case .user?:
      // "Stop syncing this gateway": the item goes, and goes again while every read since still
      // shows the one this device knew (seen, address register unchanged): a delete the keychain lost
      // is made again. Once a read shows it gone, `seen` drops, and a gateway another device
      // publishes again is left alone. The stamps and prints stay: switched on again, the gateway
      // merges as usual and nothing it merely received goes out under a new stamp of its own.
      let known = entry.stamp(.address)
      let stillOurs = entry.seen && record?.isLive == true && known != nil
        && record?.registers[.address]?.stamp == known

      if stillOurs, !keySyncedHere {
        if input.entries[gateway.id]?.detached == .user {
          traces.insert(.stopSyncingDeleteRepeated)
        }
        deleteItem(key)
        entry.seen = true
      } else {
        entry.seen = false
      }

      store(gateway.id, entry)
      return
    case .duplicateOrigin?, .other?:
      store(gateway.id, entry)
      return
    case .absent?:
      guard let record, record.isLive else {
        // An item that comes back as a tombstone newer than anything this device knew of the
        // gateway was removed everywhere, and that reaches a device-only copy too.
        if let deleted = record?.deleted, !entry.stamps.isEmpty,
          !(entry.stamp(.address).map { $0.t > deleted.t } ?? false) {
          traces.insert(.absentPurged)
          purge(gateway)
        } else {
          store(gateway.id, entry)
        }
        return
      }

      entry.detached = nil
    case nil:
      break
    }

    guard let record else {
      let remembered = state.tombstones[key].map { memory in
        !(entry.stamp(.address).map { $0.t > memory.stamp.t } ?? false)
      } ?? false

      if entry.seen {
        // I4: absence is never deletion. Keep it here, device-only, and do not republish it.
        entry.detached = .absent
        store(gateway.id, entry)
      } else if remembered, !entry.addedHere {
        // The item is gone (pruned), but this device remembers the removal on all devices: what
        // it knew is older, and the gateway was not added here. Do not publish it again.
        if entry.stamps.isEmpty {
          traces.insert(.existingKeptAbsent)
          entry.detached = .absent
          store(gateway.id, entry)
        } else {
          purge(gateway)
        }
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
      } else if !entry.stamps.isEmpty {
        purge(gateway)
      } else if entry.addedHere {
        traces.insert(.readded)
        attach(gateway, entry, key: key, base: record, mode: .readd)
      } else {
        // It existed here before; the removal on all devices is newer news. Keep it, device-only.
        traces.insert(.existingKeptAbsent)
        entry.detached = .absent
        store(gateway.id, entry)
      }
      return
    }

    attach(gateway, entry, key: key, base: record, mode: entry.stamps.isEmpty ? .firstAttach : .merge)
  }

  /// Keep an entry that was not attached in this run. An intent to clear a credential everywhere
  /// does not outlive the moment it could have gone out: it is dropped, never sent months later.
  mutating func store(_ gatewayId: String, _ entry: SyncEntry) {
    var kept = entry
    kept.clearing = []
    state.entries[gatewayId] = kept
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

  /// The first-attach table for one field: the record wins where it has a value, except for a
  /// credential, where a local value wins; the value only one side has is kept; a null in the
  /// record never clears a local value.
  mutating func firstAttachCandidate(
    _ field: SyncField,
    local: JSONValue,
    remote: SyncRegister?,
    remoteValue: JSONValue?,
    key: String,
    entry: SyncEntry
  ) -> SyncRegister? {
    guard !local.isNull else {
      return nil
    }

    if field.isSecret {
      return remoteValue != local ? Self.register(local, newStamp(key, entry), field: field, previous: remote) : nil
    }

    return remoteValue == nil || remoteValue == .null
      ? Self.register(local, newStamp(key, entry), field: field, previous: remote) : nil
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
    // Signed out here and cleared on all devices: the clear goes out, nothing is written here.
    let clearOnly = entry.signedOut ? [SyncField.user, .sessionToken].filter { entry.clearing.contains($0) } : []
    var merged = base ?? SyncedGatewayRecord(key: key)
    var locals: [SyncField: JSONValue] = [:]
    /// Credentials missing here while signed out: left as they are, and as they were in the state.
    var frozen: Set<SyncField> = []
    /// Credentials missing here without a clear: put back from the record.
    var restoring: Set<SyncField> = []
    /// Fields an earlier plan was writing here when it stopped: the record's value is written again.
    var pending: Set<SyncField> = []
    /// Their marks as stored, kept while the record has no value for them.
    var pendingMarks: [SyncField: String] = [:]

    for field in clearOnly where merged.registers[field]?.value.isNull != true {
      merged.registers[field] = Self.register(.null, newStamp(key, entry), field: field, previous: merged.registers[field])
    }

    // A clear sent while signed out here is put back at its own stamp when the store lost it.
    if entry.signedOut {
      for field in [SyncField.user, .sessionToken] where !clearOnly.contains(field) {
        guard let stamp = entry.stamp(field), entry.prints[field.rawValue] == printer.print(.null),
          (merged.registers[field]?.stamp).map({ $0 < stamp }) ?? true
        else {
          continue
        }
        merged.registers[field] = SyncRegister.winner(merged.registers[field], SyncRegister(value: .null, stamp: stamp))
      }
    }

    for field in fields {
      let local = Self.localValue(gateway, field, key: key, origin: origin)
      let remote = merged.registers[field]
      let remoteValue = remote.flatMap { SyncedGatewayRecord.projection(field, $0.value, key: key, origin: origin) }
      var candidate: SyncRegister?

      locals[field] = local

      // Written here by a plan whose state was never saved (see `SyncPlan.provisionalState`).
      if let mark = SyncEntry.pending(entry.prints[field.rawValue]) {
        let now = printer.print(local)
        let unknown = mark.old.isEmpty && mark.new.isEmpty
        if unknown || (now == mark.old && now != mark.new) {
          pendingMarks[field] = entry.prints[field.rawValue]
          // The write never landed: the record wins and its value is written again.
          pending.insert(field)
          traces.insert(.pendingWriteRedone)
          entry.prints[field.rawValue] = mark.old
          continue
        }
        // It landed (or the person changed the value since, which is then an edit like any other).
        entry.prints[field.rawValue] = mark.new
      }

      switch mode {
      case .readd:
        if !local.isNull {
          candidate = Self.register(local, newStamp(key, entry), field: field, previous: nil)
        }
      case .firstAttach:
        candidate = firstAttachCandidate(
          field, local: local, remote: remote, remoteValue: remoteValue, key: key, entry: entry)
      case .merge:
        let stamp = entry.stamp(field)
        var storedPrint = entry.prints[field.rawValue]

        // No print (the print key was lost, or the field is new): rebuild from the stamps, never by
        // minting a stamp for a value nobody may have touched.
        if storedPrint == nil {
          if let stamp, let remote, remote.stamp == stamp {
            // The record still holds exactly what was last synced here: merge as usual from it.
            storedPrint = printer.print(remoteValue ?? .null)
          } else if let stamp {
            if Self.credentials.contains(field), local.isNull, entry.clearing.contains(field) {
              candidate = Self.register(local, newStamp(key, entry), field: field, previous: remote)
            } else if !local.isNull {
              // At the stamp it had: a newer register elsewhere still wins and is applied here.
              candidate = SyncRegister(value: local, stamp: stamp)
              if Self.credentials.contains(field), let remote, remote.stamp > stamp, remoteValue != local {
                traces.insert(.printRebuildYielded)
              }
            } else if Self.credentials.contains(field) {
              if entry.signedOut { frozen.insert(field) } else { restoring.insert(field) }
            }
            break
          } else {
            candidate = firstAttachCandidate(
              field, local: local, remote: remote, remoteValue: remoteValue, key: key, entry: entry)
            break
          }
        }

        guard let print = storedPrint else { break }
        var edited = print != printer.print(local)

        if !edited, stamp == nil, remote == nil, !local.isNull {
          edited = true
        }

        if edited, local.isNull, Self.credentials.contains(field), !entry.clearing.contains(field) {
          // Missing here, and nobody asked for it to go: never publish the gap.
          if entry.signedOut {
            frozen.insert(field)
          } else {
            restoring.insert(field)
          }
        } else if edited {
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
    var headersKept = false
    if form.encodedSize > SyncedGatewayRecord.maximumBytes {
      form.registers[.headers] = base?.registers[.headers]
      if form.encodedSize > SyncedGatewayRecord.maximumBytes {
        form.registers[.headers] = nil
      }
      headersKept = form.registers[.headers] != merged.registers[.headers]
      traces.insert(.headersOverLimit)
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

    // Said once per headers value that cannot travel, not at every reconcile.
    if headersKept, entry.stamp(.headers) != merged.registers[.headers]?.stamp {
      events.append(.headersNotSynced(gatewayId: gateway.id))
    }

    var updated = gateway
    var changed = Set<SyncField>()
    var restored = Set<SyncField>()

    for field in fields where !frozen.contains(field) {
      let local = locals[field]!

      guard let register = merged.registers[field],
        let value = SyncedGatewayRecord.projection(field, register.value, key: key, origin: origin)
      else {
        // A value whose register was written before the gateway was removed everywhere belongs to
        // its earlier life: it goes here too, exactly as if the tombstone had been seen first.
        let earlierLife = entry.stamp(field).flatMap { stamp in merged.deleted.map { stamp.t <= $0.t } } ?? false
          || (pending.contains(field) && merged.deleted != nil)
        if pending.contains(field), !earlierLife {
          // Still pending: nothing in the record to write here, and the local value is not known to
          // be one this device was given. It stays as it is, unpublished, until the record has one.
          entry.prints[field.rawValue] = pendingMarks[field]
          continue
        }

        if earlierLife, !local.isNull, ![SyncField.address, .name, .authKind].contains(field) {
          Self.apply(.null, field, to: &updated)
          changed.insert(field)
          pendingWrites[gateway.id, default: [:]][field] = (printer.print(local), printer.print(.null))
          entry.prints[field.rawValue] = printer.print(.null)
          traces.insert(.earlierLifeDropped)
        } else {
          entry.prints[field.rawValue] = printer.print(local)
        }

        entry.stamps[field.rawValue] = nil
        continue
      }

      if value != local {
        Self.apply(value, field, to: &updated)
        changed.insert(field)
        pendingWrites[gateway.id, default: [:]][field] = (printer.print(local), printer.print(value))
        if restoring.contains(field), !value.isNull {
          restored.insert(field)
        }
      }

      entry.stamps[field.rawValue] = register.stamp
      entry.prints[field.rawValue] = printer.print(value)
    }

    // A clear that went out while signed out here: remembered as synced, nothing written here.
    for field in clearOnly {
      entry.stamps[field.rawValue] = merged.registers[field]?.stamp
      entry.prints[field.rawValue] = printer.print(.null)
      traces.insert(.clearedWhileSignedOut)
    }

    if !frozen.isEmpty {
      traces.insert(.credentialLeftSignedOut)
    }

    if !restored.isEmpty {
      traces.insert(.credentialRestored)
      events.append(.credentialRestored(gatewayId: gateway.id, fields: restored))
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

    entry.clearing.subtract(Set(fields + clearOnly).subtracting(frozen))
    entry.addedHere = false
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
