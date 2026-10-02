import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The property the whole design rests on, in two halves.
///
/// Liveness: whatever three devices do, and in whatever order the keychain delivers it (including
/// whole items refused or overwritten, devices that lose their copy and come back, clocks that
/// are wrong or jump back, a print key that is lost, everything deleted from the store, and crashes
/// between applying a plan and saving the state), once delivery completes and each has reconciled
/// twice they hold the same items and equivalent gateway lists, and a further reconcile has
/// nothing to do.
///
/// Safety: along the way, a gateway leaves a device only through a removal on all devices or an
/// origin change that some person made and that is newer than what the device knew of it; a
/// removal on all devices is not undone without an explicit add; a credential is cleared only
/// after someone cleared it on purpose while sync was on; a credential goes out under a new stamp
/// only from the device it was last entered on; an explicit publish is not deleted by an earlier
/// "stop syncing"; and no credential is ever written for another origin than its gateway's.
///
/// `HERMIE_SYNC_SEED` (first seed, default 1) and `HERMIE_SYNC_SEQUENCES` (default 2000) rerun or
/// widen the search; a failure names its seed and conflict policy and prints the operations.
/// `HERMIE_SYNC_TRACE=1` adds each device's store and sync entries to the log after a reconcile.
@Suite struct SyncConvergenceTests {
  static let firstSeed = UInt64(ProcessInfo.processInfo.environment["HERMIE_SYNC_SEED"] ?? "") ?? 1
  static let sequences = UInt64(ProcessInfo.processInfo.environment["HERMIE_SYNC_SEQUENCES"] ?? "") ?? 2000
  static let trace = ProcessInfo.processInfo.environment["HERMIE_SYNC_TRACE"] != nil

  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func threeReplicasConverge(conflict: TestCloud.ConflictPolicy) async {
    var coverage = Coverage()

    for seed in Self.firstSeed..<(Self.firstSeed + Self.sequences) {
      // Long synchronous work holds a cooperative thread; give it back between sequences, so the
      // package's timing-sensitive tests running alongside are not starved.
      await Task.yield()
      switch Self.run(seed: seed, conflict: conflict) {
      case let .failure(failure):
        Issue.record(
          "seed \(seed), conflict \(conflict.rawValue): \(failure.message)\n\(failure.log.joined(separator: "\n"))")
        return
      case let .success(run):
        coverage.add(run)
      }
    }

    // The sequences must reach the hard paths often enough for passing to mean something. The
    // minimums are scaled to the number of sequences and sit well below what 2,000 reach.
    let scale = Double(Self.sequences) / 2_000
    if ProcessInfo.processInfo.environment["HERMIE_SYNC_COVERAGE"] != nil {
      print("coverage \(conflict.rawValue): \(coverage)")
    }
    func atLeast(_ count: Int, _ minimum: Double, _ name: String) {
      // A rerun of a handful of seeds checks the invariants only.
      guard Self.sequences >= 500 else { return }
      #expect(Double(count) >= minimum * scale, "\(name): \(count)")
    }

    atLeast(coverage.adopted, 2_700, "adopted")
    atLeast(coverage.purged, 600, "purged by a removal on all devices")
    atLeast(coverage.pruned, 500, "item deleted (pruned, switched off)")
    atLeast(coverage.becameAbsent, 450, "became absent")
    atLeast(coverage.absentChecked, 250, "absent gateway whose cause was checked at the end")
    atLeast(coverage.wiped, 1_000, "device lost its items (wipe)")
    atLeast(coverage.clockJumpsBack, 500, "clock jumped back")
    atLeast(coverage.syncSwitchedBackOn, 550, "sync switched off and on again")
    atLeast(coverage.intentsDropped, 280, "intent dropped as sync was off")
    atLeast(coverage.crashes, 1_700, "crash between the steps of applying a plan")
    atLeast(coverage.lostWrites, 350, "iCloud writes lost with the state saved")
    atLeast(coverage.offOnOffDeletes, 45, "switched off, on and off again: deleted again")
    atLeast(coverage.unseenKeptAbsent, 80, "gateway never read back kept absent by a delete of everything")
    atLeast(coverage.traces[.readded, default: 0], 170, "explicit re-add over a tombstone")
    atLeast(coverage.traces[.existingKeptAbsent, default: 0], 35, "existing gateway kept absent by a removal")
    atLeast(coverage.traces[.absentPurged, default: 0], 55, "absent gateway purged by a tombstone")
    atLeast(coverage.traces[.earlierLifeDropped, default: 0], 15, "credential from an earlier life dropped")
    atLeast(coverage.traces[.tombstoneRewritten, default: 0], 350, "remembered tombstone merged back in")
    atLeast(coverage.traces[.tombstoneRewrittenOverMissing, default: 0], 120, "stop-syncing/removal race repaired")
    atLeast(coverage.traces[.stopSyncingDeleteRepeated, default: 0], 350, "lost stop-syncing delete made again")
    atLeast(coverage.traces[.stopSyncingDeletedUnread, default: 0], 260, "stop-syncing delete of an item not read back")
    atLeast(coverage.traces[.stopSyncingLeftRepublished, default: 0], 280, "stop syncing left a republished item alone")
    atLeast(coverage.traces[.republishedWithFreshStamp, default: 0], 320, "switched on or resynced: fresh address stamp")
    atLeast(coverage.traces[.deletedEverything, default: 0], 500, "store emptied: kept device-only")
    atLeast(coverage.traces[.clearedWhileSignedOut, default: 0], 200, "sign out on all devices while signed out")
    atLeast(coverage.traces[.printRebuildYielded, default: 0], 70, "stale credential under a lost print key")
    atLeast(coverage.traces[.pendingWriteRedone, default: 0], 12, "local write redone after a crash")
    atLeast(coverage.traces[.credentialsLeftBehind, default: 0], 140, "credentials a move left behind deleted")
    atLeast(coverage.traces[.headersOverLimit, default: 0], 160, "headers over the size limit")
    atLeast(coverage.traces[.foreignRecord, default: 0], 6_000, "foreign record in the store")
    atLeast(coverage.traces[.credentialRestored, default: 0], 150, "credential lost here put back")
    atLeast(coverage.traces[.credentialLeftSignedOut, default: 0], 320, "credential lost while signed out left alone")
    atLeast(coverage.traces[.printsReset, default: 0], 360, "print key lost")
    if conflict == .cloudWins {
      atLeast(coverage.refused, 700, "upload refused by the cloud")
    }
  }

  /// What the sequences exercised, summed.
  struct Coverage {
    var adopted = 0
    var purged = 0
    var pruned = 0
    var becameAbsent = 0
    var absentChecked = 0
    var wiped = 0
    var refused = 0
    var clockJumpsBack = 0
    var syncSwitchedBackOn = 0
    var intentsDropped = 0
    var crashes = 0
    var lostWrites = 0
    var offOnOffDeletes = 0
    var unseenKeptAbsent = 0
    var traces: [SyncTrace: Int] = [:]

    mutating func add(_ other: Coverage) {
      adopted += other.adopted
      purged += other.purged
      pruned += other.pruned
      becameAbsent += other.becameAbsent
      absentChecked += other.absentChecked
      wiped += other.wiped
      refused += other.refused
      clockJumpsBack += other.clockJumpsBack
      syncSwitchedBackOn += other.syncSwitchedBackOn
      intentsDropped += other.intentsDropped
      crashes += other.crashes
      lostWrites += other.lostWrites
      offOnOffDeletes += other.offOnOffDeletes
      unseenKeptAbsent += other.unseenKeptAbsent
      traces.merge(other.traces, uniquingKeysWith: +)
    }

    mutating func tally(_ plan: SyncPlan, before: SyncState) {
      for op in plan.localOps {
        if case .add = op { adopted += 1 }
        if case .purge = op { purged += 1 }
      }
      pruned += plan.remoteDeletes.count
      becameAbsent += plan.state.entries.filter { id, entry in
        entry.detached == .absent && before.entries[id]?.detached != .absent
      }.count
      if plan.traces.contains(.deletedEverything) {
        unseenKeptAbsent += plan.state.entries.filter { id, entry in
          entry.detached == .absent && before.entries[id].map { $0.detached == nil && !$0.seen } == true
        }.count
      }
      for trace in plan.traces {
        traces[trace, default: 0] += 1
      }
    }
  }

  struct Failure: Error {
    var message: String
    var log: [String]
  }

  /// What the people did, as far as the safety invariants need to know. Intents live here as the
  /// person recorded them, not as the state under test keeps them.
  struct Ledger {
    /// Tombstone stamps written for a removal on all devices or a move away, per key. Only these
    /// may purge a gateway anywhere, and only one whose knowledge they are not older than.
    var tombstones: [String: Set<SyncStamp>] = [:]
    /// Null credential registers published with an intent to clear: `key|field|t|d`.
    var authorisedClears: Set<String> = []
    /// Credential registers published by the device they were entered on: `key|field|t|d`. A
    /// register put back later at the same stamp (the store lost it) is the same write.
    var authorisedValues: Set<String> = []
    /// Clears the person asked for with sync on, not yet published: `device|gatewayId|field`.
    /// Switching sync off drops them.
    var clearIntents: Set<String> = []
    /// Removals on all devices the person asked for with sync on: `device|gatewayId`. Switching
    /// sync off drops them.
    var removalIntents: Set<String> = []
    /// Keys at which someone removed a gateway on all devices, or moved one away (a tombstone).
    var removed: Set<String> = []
    /// Keys removed on all devices by a device that had the gateway in sync, in sequence order,
    /// and who removed it (`device|gatewayId`), so a removal dropped before it went out is forgotten.
    var syncedRemovalStep: [String: Int] = [:]
    var syncedRemovalBy: [String: String] = [:]
    /// The last step at which someone added a gateway at a key (or moved one there).
    var addStep: [String: Int] = [:]
    /// The devices on which someone added a gateway at a key (or moved one there), and devices that
    /// carried such a gateway's address forward under a fresh stamp (switching it on, `resync`).
    var addedBy: [String: Set<Int>] = [:]
    /// Per device, the steps at which it was wiped and rejoined, had sync switched off and on.
    var wipes: [Int: [Int]] = [:]
    var rejoins: [Int: [Int]] = [:]
    var syncOff: [Int: [Int]] = [:]
    var syncOn: [Int: [Int]] = [:]
    /// Per device and key, the steps at which a gateway's sync was switched.
    var gatewaySyncToggled: [Int: [String: [Int]]] = [:]
    /// Steps at which more than 180 days passed: a removal before one may have aged out.
    var longGaps: [Int] = []
    /// Steps at which a device deleted everything from the store.
    var deletedEverything: [Int] = []
    /// Keys whose item some plan deleted.
    var deletedKeys: Set<String> = []
    /// Devices that read an empty store while holding an attached gateway whose item they had read:
    /// to them everything was deleted (I9), whatever emptied it.
    var readEmpty: Set<Int> = []
    /// Gateways that were on a device before sync knew of them (`device|gatewayId`): a removal on
    /// all devices keeps them there, device-only, by design.
    var preexisting: Set<String> = []
    /// The step at which a gateway was last switched off (`device|gatewayId`), and gateways switched
    /// on again since a switch-off.
    var switchedOffAt: [String: Int] = [:]
    var switchedOn: Set<String> = []
    /// Gateways switched on or resynced whose explicit publish has not gone out yet: `device|id`.
    var republishing: Set<String> = []
    /// Per key, the address stamps explicit publishes went out under, with their step.
    var explicitPublishes: [String: [SyncStamp: Int]] = [:]
    /// Per key, an explicit publish's address stamp and the stamp of the address it carried forward.
    var carriedFrom: [String: [SyncStamp: SyncStamp]] = [:]

    mutating func added(at key: String, on device: Int, step: Int) {
      addStep[key] = step
      addedBy[key, default: []].insert(device)
    }

    /// Whether a device was away at or after a step: it went away then, or had gone before and
    /// had not come back by then.
    static func away(_ device: Int, since step: Int, left: [Int: [Int]], back: [Int: [Int]]) -> Bool {
      for start in left[device] ?? [] {
        if start >= step { return true }
        let returned = (back[device] ?? []).filter { $0 > start }.min()
        if returned.map({ $0 >= step }) ?? true { return true }
      }
      return false
    }
  }

  static let addresses = [
    "https://gateway.test", "https://gateway.test/hermes", "https://alpha.gateway.test",
    "http://beta.gateway.test:8080", "https://gateway.test:8443"
  ]
  static let names = ["Home", "Work", "Lab", "Office"]
  static let bigHeaders = Dictionary(uniqueKeysWithValues: (0..<200).map { ("X-Big-\($0)", String(repeating: "v", count: 40)) })

  /// One random sequence, and what it exercised.
  static func run(seed: UInt64, conflict: TestCloud.ConflictPolicy) -> Result<Coverage, Failure> {
    var rng = SeededGenerator(seed: seed)
    var world = SyncWorld(devices: 3, conflict: conflict)
    var log: [String] = []
    var counter = 0
    var step = 0
    var coverage = Coverage()
    var ledger = Ledger()
    var violation: String?
    let trace = Self.trace
    // Every other sequence crowds every gateway onto two origins, so removals, wipes, re-adds
    // and lost credentials meet each other far more often.
    let addresses = seed % 2 == 0 ? ["https://gateway.test", "https://alpha.gateway.test"] : Self.addresses
    let credentials: Set<SyncField> = [.frontDoor, .headers, .sessionToken]

    /// The safety invariants that hold plan by plan.
    func check(_ plan: SyncPlan, device: Int, before: TestDevice, view: [SyncedGatewayRecord]) {
      guard violation == nil else { return }

      let print = printer(key: before.printKey)
      func seen(_ key: String) -> SyncedGatewayRecord? {
        view.first { $0.key == key && $0.isSupported }?.normalized()
      }
      func put(_ key: String) -> SyncedGatewayRecord? {
        plan.remotePuts.first { $0.key == key }
      }
      /// The newest removal this plan's merge knew of at a key: in the store, remembered, or written.
      func deletedKnown(_ key: String) -> SyncStamp? {
        [seen(key)?.deleted, before.state.tombstones[key]?.stamp, put(key)?.deleted].compactMap { $0 }.max()
      }

      // At most one local op per gateway.
      let ids = plan.localOps.map(\.gatewayId)
      if Set(ids).count != ids.count {
        violation = "d\(device) has more than one local op for a gateway: \(plan.localOps)"
        return
      }

      // (a) A tombstone under a new stamp of this device needs a removal on all devices the person
      // asked for with sync on, or a move away from that key.
      for record in plan.remotePuts {
        guard let deleted = record.deleted, deleted.d == before.state.device, seen(record.key)?.deleted != deleted,
          before.state.tombstones[record.key]?.stamp != deleted, ledger.tombstones[record.key]?.contains(deleted) != true
        else {
          continue
        }
        let reason = before.state.entries.contains { id, entry in
          guard entry.key == record.key else { return false }
          if let gateway = before.gateway(id) {
            return gateway.key != entry.key
          }
          return entry.removal == .allDevices && ledger.removalIntents.contains("\(device)|\(id)")
        }
        if !reason {
          violation = "d\(device) wrote a tombstone at \(record.key) nobody asked for"
        }
        ledger.tombstones[record.key, default: []].insert(deleted)
      }

      for op in plan.localOps {
        switch op {
        case let .purge(gatewayId):
          // (a) Purged only by a tombstone someone's removal or move wrote, not older than what this
          // device knew of the gateway.
          let key = before.gateway(gatewayId)?.key ?? ""
          let entry = before.state.entries[gatewayId]
          guard let cause = deletedKnown(key), ledger.tombstones[key]?.contains(cause) == true,
            let entry, !entry.stamps.isEmpty, !((entry.stamp(.address)?.t ?? -.infinity) > cause.t)
          else {
            violation = "d\(device) purged \(gatewayId) at \(key) without a removal newer than what it knew"
            continue
          }
        case let .update(gateway, fields):
          let old = before.gateway(gateway.id)
          let oldOrigin = old.map { GatewayAddress.origin(of: $0.address) }
          let origin = GatewayAddress.origin(of: gateway.address)
          let entry = before.state.entries[gateway.id]
          for field in fields.intersection(credentials) {
            // Only a credential usable before (bound to the gateway's origin) can be cleared.
            let oldValue: JSONValue? =
              switch field {
              case .frontDoor: old?.frontDoor.flatMap { $0.origin == oldOrigin ? $0 : nil }?.json
              case .headers: old?.headers.flatMap { $0.origin == oldOrigin ? $0 : nil }?.json
              default: old?.sessionToken.flatMap { $0.origin == oldOrigin ? $0 : nil }?.json
              }
            let isSet =
              switch field {
              case .frontDoor: gateway.frontDoor != nil
              case .headers: gateway.headers != nil
              default: gateway.sessionToken != nil
              }
            guard let oldValue, !isSet else { continue }

            let key = gateway.key
            // The register the value came from: what this plan writes, else what the device saw.
            let merged = put(key) ?? seen(key)
            let authorised: Bool
            if let register = merged?.registers[field],
              SyncedGatewayRecord.projection(field, register.value, key: key, origin: origin) != nil {
              // (c) A usable register clears only when it is a null someone published on purpose.
              authorised = register.value.isNull
                && ledger.authorisedClears.contains("\(key)|\(field.rawValue)|\(register.stamp.t)|\(register.stamp.d)")
            } else {
              // No usable register: only a value from before a removal everywhere (its stamp not
              // newer), or such a drop a crash left pending, goes.
              let deleted = deletedKnown(key)
              let earlierLife = deleted.map { removal in entry?.stamp(field).map { $0.t <= removal.t } ?? false } ?? false
              let pendingDrop = deleted != nil
                && (SyncEntry.pending(entry?.prints[field.rawValue]).map { $0.new == print.print(.null) } ?? false)
              authorised = earlierLife || pendingDrop
            }
            // A credential a move left behind here (see `SyncEntry.leftBehind`) goes too.
            let leftBehind = entry?.leftBehind.contains(print.print(oldValue)) == true
            if !authorised, !leftBehind {
              violation = "d\(device) cleared \(field.rawValue) of \(gateway.id) at \(key) though nobody cleared it"
            }
          }
          if let problem = foreignOrigin(gateway, fields: fields) { violation = "d\(device) \(problem)" }
        case let .add(gateway):
          if let problem = foreignOrigin(gateway, fields: [.frontDoor, .headers, .sessionToken]) {
            violation = "d\(device) \(problem)"
          }
        }
      }

      // (b) A tombstone in this device's view is overridden only by a gateway added here (or one
      // whose stamps already outrank it).
      for record in plan.remotePuts where record.isLive {
        guard let seen = seen(record.key), seen.isTombstone, let deleted = seen.deleted else {
          continue
        }
        let wroteAddress = record.registers[.address]?.stamp.d == before.state.device
          && record.registers[.address]?.stamp.t ?? 0 > deleted.t
        let explicit = before.gateways.contains { gateway in
          gateway.key == record.key
            && (before.state.entries[gateway.id].map { $0.addedHere || $0.key != record.key } ?? false
              || (before.state.entries[gateway.id]?.stamp(.address)?.t ?? -1) > deleted.t)
        }
        if wroteAddress, !explicit {
          violation = "d\(device) brought \(record.key) back over a tombstone without an explicit add"
        }
      }

      // An explicit publish (switching a gateway on, `resync`): the first live put of its key after
      // the person asked whose address stamp differs from the one shown, whoever wrote it (so a
      // publish at old stamps counts too). Over a live record it carries that address forward (the
      // end check follows it back); over nothing, it is the person publishing the gateway again, an
      // add.
      for record in plan.remotePuts where record.isLive {
        guard let address = record.registers[.address],
          seen(record.key).flatMap({ $0.isLive ? $0.registers[.address]?.stamp : nil }) != address.stamp
        else {
          continue
        }
        let republished = before.gateways.filter { $0.key == record.key && ledger.republishing.contains("\(device)|\($0.id)") }
        guard !republished.isEmpty else { continue }
        ledger.explicitPublishes[record.key, default: [:]][address.stamp] = step
        for gateway in republished { ledger.republishing.remove("\(device)|\(gateway.id)") }
        if let shown = seen(record.key).flatMap({ $0.isLive ? $0.registers[.address]?.stamp : nil }) {
          // The address carried is the newer of the one shown and the one the gateway knew here.
          let known = republished.compactMap { before.state.entries[$0.id]?.stamp(.address) }
          let carried = ([shown] + known).max()!
          if carried != address.stamp {
            ledger.carriedFrom[record.key, default: [:]][address.stamp] = carried
          }
        } else {
          ledger.added(at: record.key, on: device, step: step)
        }
      }

      for account in plan.remoteDeletes {
        guard let key = account.split(separator: ".").last.map(String.init) else { continue }
        ledger.deletedKeys.insert(key)

        // "Stop syncing" never deletes an explicit publish made after it was switched off. (An item
        // this device's remembered removal cuts is pruned, not deleted for "stop syncing".)
        let liveHere = seen(key).map { record in
          record.isLive && !(before.state.tombstones[key].map { $0.stamp.t >= (record.registers[.address]?.stamp.t ?? 0) } ?? false)
        } ?? false
        // The switched-off gateway the item still shows (by the address register it knew) deletes it.
        let shown = seen(key)?.registers[.address]?.stamp
        for gateway in before.gateways where liveHere && gateway.key == key {
          guard let entry = before.state.entries[gateway.id], entry.detached == .user, let shown,
            entry.stamp(.address) == shown
          else {
            continue
          }
          let switchedOff = ledger.switchedOffAt["\(device)|\(gateway.id)"] ?? -1
          if let published = ledger.explicitPublishes[key]?[shown], published > switchedOff {
            violation = "d\(device) deleted \(key), published again on purpose after it stopped syncing"
          }
          if ledger.switchedOn.contains("\(device)|\(gateway.id)") {
            coverage.offOnOffDeletes += 1
          }
        }
      }

      for record in plan.remotePuts where record.isLive {
        let seen = seen(record.key)
        for field in [SyncField.frontDoor, .headers, .sessionToken] {
          guard let register = record.registers[field], register.stamp.d == before.state.device,
            seen?.registers[field]?.stamp != register.stamp
          else {
            continue
          }

          let id = "\(record.key)|\(field.rawValue)|\(register.stamp.t)|\(register.stamp.d)"
          if ledger.authorisedClears.contains(id) || ledger.authorisedValues.contains(id) {
            continue
          }

          let here = before.gateways.filter { $0.key == record.key }
          if register.value.isNull {
            // (c) A clear goes out under a new stamp only with an intent recorded while sync was on.
            let intents = here.map { "\(device)|\($0.id)|\(field.rawValue)" }.filter(ledger.clearIntents.contains)
            if intents.isEmpty {
              violation = "d\(device) published a cleared \(field.rawValue) at \(record.key) nobody asked for"
            }
            ledger.clearIntents.subtract(intents)
            ledger.authorisedClears.insert(id)
          } else if let value = SyncedGatewayRecord.projection(field, register.value, key: record.key, origin: record.origin) {
            // (e) A credential goes out under a new stamp of this device only if it is the value the
            // person last entered here, not one received since.
            if here.contains(where: { before.ownValue(field, gateway: $0.id) == canonical(value) }) {
              ledger.authorisedValues.insert(id)
            } else {
              violation = "d\(device) published a \(field.rawValue) at \(record.key) under a new stamp it was never given"
            }
          }
        }

        // (d) Never a front door for a cleartext gateway.
        if record.origin?.hasPrefix("http://") == true, record.frontDoor != nil {
          violation = "d\(device) published a front door for a cleartext gateway"
        }
      }

      // I9: a store found emptied publishes no record.
      if plan.traces.contains(.deletedEverything), plan.remotePuts.contains(where: \.isLive) {
        violation = "d\(device) published a record after everything was deleted"
      }
    }

    @discardableResult
    func reconcile(_ device: Int, crash: Bool = false, loseWrites: Bool = false) -> SyncPlan {
      let before = world.devices[device]
      let view = world.records(device)
      let plan = world.plan(device)

      if crash {
        // The engine died between two steps of applying the plan: the final state was never saved.
        let point = SyncWorld.CrashPoint.allCases.randomElement(using: &rng)!
        world.applyCrash(plan, to: device, at: point)
        coverage.crashes += 1
      } else if loseWrites {
        // The keychain lost the writes, but the engine saved its state as if they had been made.
        var applied = plan
        applied.remotePuts = []
        applied.remoteDeletes = []
        world.apply(applied, to: device)
        if plan.hasRemoteWrites { coverage.lostWrites += 1 }
      } else {
        world.apply(plan, to: device)
      }

      coverage.tally(plan, before: before.state)
      if view.isEmpty, before.state.enabled, before.state.entries.values.contains(where: { $0.detached == nil && $0.seen }) {
        ledger.readEmpty.insert(device)
      }
      check(plan, device: device, before: before, view: view)
      log.append("d\(device) reconcile\(crash ? " (crash)" : loseWrites ? " (writes lost)" : "") \(plan)")
      if trace {
        log.append("    traces: \(plan.traces.map(\.rawValue).sorted()) hidden: \(plan.state.hidden.sorted())")
        log.append("    saw: \(view.map(\.description))")
        log.append("    store: \(world.records(device).map(\.description))")
        log.append(contentsOf: plan.state.entries.keys.sorted().map { "    \($0): \(plan.state.entries[$0]!)" })
      }
      return plan
    }

    // MARK: The person's actions, with what the ledger needs to know

    func enabled(_ device: Int) -> Bool {
      world.devices[device].state.enabled
    }

    /// A clear the person asked for: an intent only while sync is on.
    func clearIntent(_ device: Int, _ id: String, _ field: SyncField) {
      if enabled(device) {
        ledger.clearIntents.insert("\(device)|\(id)|\(field.rawValue)")
      } else {
        coverage.intentsDropped += 1
      }
    }

    func setEnabled(_ device: Int, _ on: Bool) {
      guard enabled(device) != on else { return }
      if on {
        coverage.syncSwitchedBackOn += 1
        ledger.syncOn[device, default: []].append(step)
      } else {
        ledger.syncOff[device, default: []].append(step)
        let mine = ledger.clearIntents.filter { $0.hasPrefix("\(device)|") }
          .union(ledger.removalIntents.filter { $0.hasPrefix("\(device)|") })
        if !mine.isEmpty { coverage.intentsDropped += 1 }
        // A removal that had not gone out yet never will.
        for (key, remover) in ledger.syncedRemovalBy where remover.hasPrefix("\(device)|") {
          let id = String(remover.dropFirst("\(device)|".count))
          if world.devices[device].state.entries[id]?.removal == .allDevices {
            ledger.syncedRemovalStep[key] = nil
            ledger.syncedRemovalBy[key] = nil
          }
        }
        ledger.clearIntents = ledger.clearIntents.filter { !$0.hasPrefix("\(device)|") }
        ledger.removalIntents = ledger.removalIntents.filter { !$0.hasPrefix("\(device)|") }
      }
      world.setEnabled(device, on)
    }

    func setGatewaySynced(_ device: Int, _ id: String, _ synced: Bool) {
      guard let gateway = world.devices[device].gateway(id) else { return }
      let wasOff = world.devices[device].state.entries[id]?.detached == .user
      ledger.gatewaySyncToggled[device, default: [:]][gateway.key, default: []].append(step)
      if synced, wasOff {
        ledger.switchedOn.insert("\(device)|\(id)")
        ledger.republishing.insert("\(device)|\(id)")
      } else if !synced {
        ledger.switchedOffAt["\(device)|\(id)"] = step
        ledger.republishing.remove("\(device)|\(id)")
      }
      world.setGatewaySynced(device, id, synced)
    }

    func resync(_ device: Int, _ id: String) {
      guard let entry = world.devices[device].state.entries[id] else { return }
      if entry.detached == nil || entry.detached == .absent {
        ledger.republishing.insert("\(device)|\(id)")
      }
      world.resync(device, id)
    }

    /// A removal on all devices; recorded as an intent only while sync is on.
    func removeEverywhere(_ device: Int, _ gateway: LocalGateway) {
      // The tombstone goes to the key sync knows the gateway under, which an unreconciled move
      // may have left different from its address.
      let known = world.devices[device].state.entries[gateway.id]?.key ?? gateway.key
      ledger.removed.insert(gateway.key)
      ledger.removed.insert(known)
      if enabled(device) {
        ledger.removalIntents.insert("\(device)|\(gateway.id)")
      } else {
        coverage.intentsDropped += 1
      }
      // A newer build's record at the key is left alone, so no tombstone can be written there.
      let foreignHere = world.records(device).contains { $0.key == known && !$0.isSupported }
      let attached = world.devices[device].state.entries[gateway.id]?.detached == nil && enabled(device)
      if attached, known == gateway.key, !foreignHere, uncontested(gateway.key, removing: gateway.id) {
        ledger.syncedRemovalStep[gateway.key] = step
        ledger.syncedRemovalBy[gateway.key] = "\(device)|\(gateway.id)"
      }
      world.remove(device, gateway.id, scope: .allDevices)
    }

    func wipe(_ device: Int) {
      coverage.wiped += 1
      ledger.wipes[device, default: []].append(step)
      world.cloud.wipeLocal(device)
    }

    func rejoin(_ device: Int) {
      if !world.cloud.replicas[device].connected {
        ledger.rejoins[device, default: []].append(step)
      }
      world.cloud.rejoin(device)
    }

    world.devices[1].clockOffset = [0, 0, year, -year, 3_000].randomElement(using: &rng)!
    world.devices[2].clockOffset = [0, -5_000, 7 * day].randomElement(using: &rng)!
    log.append("offsets \(world.devices.map(\.clockOffset))")

    func randomGateway(_ device: Int) -> LocalGateway? {
      world.devices[device].gateways.randomElement(using: &rng)
    }

    /// A removal is checked at the end only when nothing could race it: no other copy at the key
    /// that sync has not yet carried (an add not acted on, a move there, or a gateway that was on
    /// a device before sync knew of it). Such a copy published before the removal reaches it is a
    /// concurrent add, which may win by its stamp.
    func uncontested(_ key: String, removing id: String) -> Bool {
      !world.devices.contains { other in
        other.gateways.contains { candidate in
          guard candidate.id != id, candidate.key == key else { return false }
          guard let entry = other.state.entries[candidate.id] else { return true }
          return entry.addedHere || entry.key != candidate.key || (entry.stamps.isEmpty && !entry.seen)
        }
      }
    }

    func copy(_ device: Int, at address: String) -> LocalGateway? {
      world.devices[device].gateways.first { $0.key == GatewayKey.of(address) }
    }

    // Some sequences open with a short scripted setup for a path random steps rarely reach; the
    // random steps that follow, and the delivery order, stay random.
    switch seed % 8 {
    case 0:
      let address = addresses.randomElement(using: &rng)!
      switch (seed / 8) % 3 {
      case 0:
        // Headers cleared on a device whose sync is (or is then switched) off; another device sets
        // new ones; sync comes back a month later. The clear must not go out.
        let id = world.add(0, address: address, name: "Scripted", token: "tok-s")
        ledger.added(at: GatewayKey.of(address), on: 0, step: step)
        world.setHeaders(0, id, ["X-Team": "s1"])
        reconcile(0)
        world.cloud.deliverAll()
        reconcile(1)
        if let mine = copy(1, at: address) {
          if Bool.random(using: &rng) {
            world.setHeaders(1, mine.id, nil)
            clearIntent(1, mine.id, .headers)
            setEnabled(1, false)
          } else {
            setEnabled(1, false)
            world.setHeaders(1, mine.id, nil)
            clearIntent(1, mine.id, .headers)
          }
        }
        world.advance(1_000)
        world.setHeaders(0, id, ["X-Team": "s2"])
        reconcile(0)
        world.cloud.deliverAll()
        world.advance(30 * day)
        step += 1
        setEnabled(1, true)
        log.append("scripted: d1 cleared headers with sync off; d0 set new ones")
      case 1:
        // A device holding a gateway it has not read back yet meets a store emptied by "Delete
        // everything from iCloud Keychain" on another device: nothing of it may go out.
        let other = addresses.first { GatewayKey.of($0) != GatewayKey.of(address) } ?? address
        world.add(0, address: address, name: "Scripted", token: "tok-s")
        ledger.added(at: GatewayKey.of(address), on: 0, step: step)
        reconcile(0)
        world.cloud.deliverAll()
        reconcile(1)
        world.add(1, address: other, name: "Unread", token: "tok-u")
        ledger.added(at: GatewayKey.of(other), on: 1, step: step)
        world.deleteEverything(0)
        ledger.deletedEverything.append(step)
        world.cloud.deliverAll()
        reconcile(1)
        log.append("scripted: d0 deleted everything while d1 held a gateway it never read back")
      default:
        // "Stop syncing" on a phone; a tablet sees the item go, resyncs it; the phone, back later,
        // must leave that explicit publish alone.
        let id = world.add(0, address: address, name: "Scripted", token: "tok-s")
        ledger.added(at: GatewayKey.of(address), on: 0, step: step)
        reconcile(0)
        world.cloud.deliverAll()
        reconcile(1)
        reconcile(0)
        step += 1
        setGatewaySynced(0, id, false)
        reconcile(0)
        world.cloud.deliverAll()
        reconcile(1)
        if let mine = copy(1, at: address) {
          step += 1
          resync(1, mine.id)
          reconcile(1)
          world.cloud.deliverAll()
        }
        log.append("scripted: d0 stops syncing, d1 resyncs")
      }
    case 1:
      // A copy that went absent (its device lost the item) meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      wipe(1)
      reconcile(1)
      world.advance(1_000)
      step += 1
      if let gateway = copy(0, at: address) {
        removeEverywhere(0, gateway)
      }
      log.append("scripted: d1 absent, d0 remove-everywhere")
    case 3:
      // A gateway that was already on a device with sync off meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      setEnabled(2, false)
      let old = world.existing(2, address: address, token: "tok-old")
      ledger.addedBy[GatewayKey.of(address), default: []].insert(2)
      ledger.preexisting.insert("2|\(old)")
      world.add(0, address: address, name: "Scripted")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      world.advance(1_000)
      step += 1
      if let gateway = copy(0, at: address) {
        removeEverywhere(0, gateway)
      }
      reconcile(0)
      setEnabled(2, true)
      log.append("scripted: d2 had it with sync off, d0 remove-everywhere")
    case 4:
      // A device signed out here loses the credentials it still had.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s", frontDoorSecret: "door-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      if let mine = copy(1, at: address) {
        world.signOut(1, mine.id)
        world.loseCredentials(1, mine.id)
        log.append("scripted: d1 signed out and lost \(mine.id)")
      }
    case 2:
      // "Stop syncing" on one device races "remove from all devices" on another.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      reconcile(2)
      world.advance(1_000)
      step += 1
      if let mine = copy(1, at: address), let theirs = copy(0, at: address) {
        removeEverywhere(1, mine)
        reconcile(1)
        setGatewaySynced(0, theirs.id, false)
        reconcile(0)
        log.append("scripted: d1 remove-everywhere races d0 stop-syncing")
      }
    case 5:
      // A device that received a newer token loses its print key before acting on it.
      let address = addresses.randomElement(using: &rng)!
      let id = world.add(0, address: address, name: "Scripted", token: "tok-s1")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      world.advance(1_000)
      world.setToken(0, id, to: "tok-s2")
      reconcile(0)
      world.cloud.deliverAll()
      world.losePrintKey(1)
      log.append("scripted: d1 loses its print key holding a stale token")
    case 6:
      // "Sign Out on All Devices", done as the design says: signed out here and cleared everywhere.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      if let mine = copy(1, at: address) {
        world.signOutEverywhere(1, mine.id)
        clearIntent(1, mine.id, .sessionToken)
        log.append("scripted: d1 signs out on all devices \(mine.id)")
      }
    case 7:
      // "Stop syncing" whose delete the keychain loses while the state is saved; switched on and
      // off again before the store shows the item gone.
      let address = addresses.randomElement(using: &rng)!
      let id = world.add(0, address: address, name: "Scripted")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      if Bool.random(using: &rng) {
        // Not even read back before it is switched off.
        world.cloud.deliverAll()
        reconcile(0)
      }
      setGatewaySynced(0, id, false)
      reconcile(0, loseWrites: Bool.random(using: &rng))
      if Bool.random(using: &rng) {
        setGatewaySynced(0, id, true)
        reconcile(0)
        setGatewaySynced(0, id, false)
      }
      log.append("scripted: d0 stop-syncing, delete maybe lost")
    default:
      break
    }

    for _ in 0..<Int.random(in: 10...50, using: &rng) {
      step += 1
      world.advance(Double(Int.random(in: 0...20_000, using: &rng)))
      let device = Int.random(in: 0..<3, using: &rng)
      let roll = Int.random(in: 0..<100, using: &rng)

      switch roll {
      case 0..<48:
        counter += 1
        switch Int.random(in: 0..<30, using: &rng) {
        case 0..<3:
          let address = addresses.randomElement(using: &rng)!
          let token: String? = Bool.random(using: &rng) ? "tok-\(counter)" : nil
          let door: String? = Int.random(in: 0..<3, using: &rng) == 0 ? "door-\(counter)" : nil
          let kind = Bool.random(using: &rng) ? "session_token" : "native_pkce"
          let name = names.randomElement(using: &rng)!
          let id = world.add(device, address: address, name: name, authKind: kind, token: token, frontDoorSecret: door)
          ledger.added(at: GatewayKey.of(address), on: device, step: step)
          log.append("d\(device) add \(id) \(address) \(name) \(kind) token:\(token ?? "-") door:\(door ?? "-")")
        case 3..<6:
          guard let gateway = randomGateway(device) else { continue }
          let name = names.randomElement(using: &rng)! + "\(counter)"
          world.rename(device, gateway.id, to: name)
          log.append("d\(device) rename \(gateway.id) \(name)")
        case 6..<8:
          guard let gateway = randomGateway(device) else { continue }
          let address = addresses.randomElement(using: &rng)!
          // The key sync knows the gateway under (an earlier move may not have been reconciled).
          let known = world.devices[device].state.entries[gateway.id]?.key ?? gateway.key
          if GatewayKey.of(address) != gateway.key {
            ledger.removed.insert(gateway.key)
            ledger.removed.insert(known)
            ledger.added(at: GatewayKey.of(address), on: device, step: step)
          } else {
            // A same-origin address edit writes the address register, which by the design's
            // liveness rule (address newer than the tombstone) outranks a removal it raced.
            ledger.addedBy[gateway.key, default: []].insert(device)
          }
          world.setAddress(device, gateway.id, to: address)
          log.append("d\(device) address \(gateway.id) \(address)")
        case 8..<10:
          guard let gateway = randomGateway(device) else { continue }
          let token: String? = Int.random(in: 0..<3, using: &rng) == 0 ? nil : "tok-\(counter)"
          world.setToken(device, gateway.id, to: token)
          if token == nil { clearIntent(device, gateway.id, .sessionToken) }
          log.append("d\(device) token \(gateway.id) \(token ?? "cleared")")
        case 10:
          guard let gateway = randomGateway(device) else { continue }
          let door: String? = Bool.random(using: &rng) ? "door-\(counter)" : nil
          world.setFrontDoor(device, gateway.id, secret: door)
          if door == nil { clearIntent(device, gateway.id, .frontDoor) }
          log.append("d\(device) frontDoor \(gateway.id) \(door ?? "cleared")")
        case 11:
          guard let gateway = randomGateway(device) else { continue }
          let choice = Int.random(in: 0..<3, using: &rng)
          let headers: [String: String]? = choice == 0 ? nil : choice == 1 ? ["X-Team": "t\(counter)"] : bigHeaders
          world.setHeaders(device, gateway.id, headers)
          if headers == nil { clearIntent(device, gateway.id, .headers) }
          log.append("d\(device) headers \(gateway.id) \(headers.map { "\($0.count)" } ?? "cleared")")
        case 12:
          guard let gateway = randomGateway(device) else { continue }
          world.remove(device, gateway.id, scope: .thisDevice)
          log.append("d\(device) remove-here \(gateway.id)")
        case 13...15:
          guard let gateway = randomGateway(device) else { continue }
          removeEverywhere(device, gateway)
          log.append("d\(device) remove-everywhere \(gateway.id)")
        case 16:
          guard let gateway = randomGateway(device) else { continue }
          world.signOut(device, gateway.id)
          log.append("d\(device) sign-out \(gateway.id)")
        case 17:
          guard let gateway = randomGateway(device) else { continue }
          world.signOutEverywhere(device, gateway.id)
          clearIntent(device, gateway.id, .sessionToken)
          log.append("d\(device) sign-out-everywhere \(gateway.id)")
        case 18, 19:
          guard let gateway = randomGateway(device) else { continue }
          let synced = world.devices[device].state.entries[gateway.id]?.detached == .user
          setGatewaySynced(device, gateway.id, synced)
          log.append("d\(device) gateway-sync \(gateway.id) \(synced)")
        case 20:
          let on = !enabled(device)
          setEnabled(device, on)
          log.append("d\(device) sync \(on)")
        case 21...23:
          guard let gateway = randomGateway(device) else { continue }
          world.loseCredentials(device, gateway.id)
          log.append("d\(device) lose-credentials \(gateway.id)")
        case 24:
          world.losePrintKey(device)
          log.append("d\(device) lose-print-key")
        case 25:
          let back = Double(Int.random(in: 60_000...(30 * Int(day)), using: &rng))
          world.devices[device].clockOffset -= back
          coverage.clockJumpsBack += 1
          log.append("d\(device) clock-back \(back)")
        case 26:
          // A newer build writes a record this build must leave alone.
          let address = Int.random(in: 0..<8, using: &rng) == 0
            ? addresses.randomElement(using: &rng)! : "https://newer.gateway.test"
          let key = GatewayKey.of(address)
          world.cloud.put(device, account: SyncedGatewayRecord.account(forKey: key), value: #"{"key":"\#(key)","v":2}"#)
          log.append("d\(device) newer-build-record \(key)")
        case 27:
          // "Publish this gateway again", mostly on one that went device-only.
          let absent = world.devices[device].gateways.filter {
            world.devices[device].state.entries[$0.id]?.detached == .absent
          }
          guard let gateway = absent.randomElement(using: &rng) ?? randomGateway(device) else { continue }
          resync(device, gateway.id)
          log.append("d\(device) resync \(gateway.id)")
        case 28:
          guard Int.random(in: 0..<3, using: &rng) == 0 else { continue }
          world.deleteEverything(device)
          ledger.deletedEverything.append(step)
          log.append("d\(device) delete-everything")
        default:
          reconcile(device, crash: true)
        }
      case 48..<70:
        for _ in 0..<Int.random(in: 1...4, using: &rng) where !world.cloud.pending.isEmpty {
          world.cloud.deliver(at: Int.random(in: 0..<world.cloud.pending.count, using: &rng))
        }
      case 70..<92:
        // Now and then the engine dies after applying a plan and before saving the state.
        let fate = Int.random(in: 0..<8, using: &rng)
        reconcile(device, crash: fate == 0, loseWrites: fate == 1)
      case 92..<95:
        wipe(device)
        log.append("d\(device) wipeLocal")
      case 95:
        world.advance(200 * day)
        ledger.longGaps.append(step)
        log.append("-- 200 days later")
      default:
        rejoin(device)
        log.append("d\(device) rejoin")
      }

      if let violation {
        return .failure(Failure(message: violation, log: log))
      }
    }

    // Delivery completes: every device is back on iCloud with sync on.
    step += 1
    for device in world.devices.indices {
      rejoin(device)
      setEnabled(device, true)
    }
    log.append("-- settle")

    var rounds = 0
    var settled = false

    while rounds < 60, !settled {
      rounds += 1
      while !world.cloud.pending.isEmpty {
        world.cloud.deliver(at: Int.random(in: 0..<world.cloud.pending.count, using: &rng))
        if Int.random(in: 0..<5, using: &rng) == 0 {
          // Early on, the engine may still die between a plan and its state.
          reconcile(Int.random(in: 0..<3, using: &rng), crash: rounds <= 2 && Int.random(in: 0..<4, using: &rng) == 0)
        }
      }

      var wrote = false
      for device in [0, 1, 2].shuffled(using: &rng) {
        world.advance(1_000)
        let plan = reconcile(device)
        wrote = wrote || plan.hasRemoteWrites || !plan.localOps.isEmpty
      }
      settled = !wrote && world.cloud.pending.isEmpty

      if let violation {
        return .failure(Failure(message: violation, log: log))
      }
    }

    guard settled else {
      return .failure(Failure(message: "did not settle in \(rounds) rounds", log: log))
    }

    // Each device reconciles twice more: nothing left to do.
    for pass in 1...2 {
      for device in world.devices.indices {
        world.advance(1_000)
        let before = (try? world.devices[device].state.encoded()) ?? ""
        let plan = reconcile(device)
        if !plan.isEmpty {
          let after = (try? plan.state.encoded()) ?? ""
          return .failure(
            Failure(
              message: "reconcile \(pass) on d\(device) is not empty: \(plan)\n\(before)\n\(after)\n"
                + "\(world.devices[device].gateways)",
              log: log))
        }
      }
    }

    if let problem = invariantViolation(world) ?? removalViolation(world, ledger) {
      return .failure(Failure(message: problem, log: log))
    }

    // A gateway goes device-only (`absent`) only when its item vanished from that device's view:
    // something deleted it (a prune, "stop syncing", everything deleted), the device lost its
    // copies, the cloud refused the write it held, or a removal on all devices met it.
    for device in world.devices {
      for gateway in device.gateways {
        guard let entry = device.state.entries[gateway.id], entry.detached == .absent else { continue }
        coverage.absentChecked += 1
        let key = entry.key
        let explained = ledger.deletedKeys.contains(key) || ledger.wipes[device.index] != nil
          || world.cloud.refusedAccounts.contains(SyncedGatewayRecord.account(forKey: key))
          || ledger.removed.contains(key) || !ledger.deletedEverything.isEmpty || ledger.readEmpty.contains(device.index)
        if !explained {
          return .failure(Failure(message: "d\(device.index) \(gateway.id) is absent though its item never vanished", log: log))
        }
      }
    }

    coverage.refused = world.cloud.refused
    return .success(coverage)
  }

  /// Safety (d): a credential written to a device names the gateway's own origin, and a front door
  /// is never written for a cleartext gateway.
  static func foreignOrigin(_ gateway: LocalGateway, fields: Set<SyncField>) -> String? {
    let origin = GatewayAddress.origin(of: gateway.address)
    if fields.contains(.frontDoor), gateway.frontDoor != nil, !origin.hasPrefix("https://") {
      return "wrote a front door for a cleartext gateway to \(gateway.id)"
    }
    let origins = [
      fields.contains(.frontDoor) ? gateway.frontDoor?.origin : nil,
      fields.contains(.headers) ? gateway.headers?.origin : nil,
      fields.contains(.sessionToken) ? gateway.sessionToken?.origin : nil
    ].compactMap { $0 }
    return origins.allSatisfy { $0 == origin } ? nil : "wrote a credential for another origin to \(gateway.id)"
  }

  /// Safety (b): a removal on all devices by a device that had the gateway in sync, with no add at
  /// that key afterwards, leaves no device holding it in sync, and none holding it device-only
  /// unless it was there before sync knew of it, or that device was away at or after the removal
  /// (wiped and not back, sync off), switched
  /// that gateway's sync since (its delete can race the tombstone), everything was deleted from
  /// the store since, or the removal aged past 180 days (the design's "offline for more than 180
  /// days" row).
  static func removalViolation(_ world: SyncWorld, _ ledger: Ledger) -> String? {
    for (key, removedAt) in ledger.syncedRemovalStep where (ledger.addStep[key] ?? 0) < removedAt {
      // A key a newer build's record holds is left alone by design.
      guard world.cloudRecord(key: key)?.isSupported != false else {
        continue
      }

      // Back in iCloud: only by an address someone wrote on a device where they added it there
      // (possibly unseen by the remover, and stamped later by a clock ahead). An address carried
      // forward by switching a gateway on or resyncing it is followed back to the one it carried,
      // which must itself outrank the removal.
      if let record = world.cloudRecord(key: key), record.isLive, var stamp = record.registers[.address]?.stamp {
        while let carried = ledger.carriedFrom[key]?[stamp] { stamp = carried }
        guard let index = Int(stamp.d.suffix(2), radix: 16), ledger.addedBy[key]?.contains(index) == true else {
          return "\(key) came back in iCloud after a removal on all devices, written by \(stamp.d) that never added it"
        }
        if let deleted = record.deleted, !(stamp.t > deleted.t) {
          return "\(key) came back in iCloud after a removal on all devices by an address carried over it"
        }
        // Added again (concurrently with the removal): it is meant to be there.
        continue
      }

      for device in world.devices {
        for gateway in device.gateways(at: key) {
          let entry = device.state.entries[gateway.id]
          if entry?.detached == nil {
            return "d\(device.index) still syncs \(gateway.id) at \(key), removed on all devices"
          }
          let index = device.index
          // On the device before sync knew of it: kept there, device-only, by design.
          if ledger.preexisting.contains("\(index)|\(gateway.id)") { continue }
          let away = Ledger.away(index, since: removedAt, left: ledger.wipes, back: ledger.rejoins)
            || Ledger.away(index, since: removedAt, left: ledger.syncOff, back: ledger.syncOn)
            || ledger.gatewaySyncToggled[index]?[key]?.contains { $0 >= removedAt } == true
            || ledger.deletedEverything.contains { $0 >= removedAt }
            || ledger.longGaps.contains { $0 > removedAt }
            // Its own knowledge is newer than the removal (re-added there, by a clock ahead).
            || (entry?.stamp(.address)?.t ?? -1) > (world.cloudRecord(key: key)?.deleted?.t ?? .infinity)
          if entry?.detached == .absent, !away {
            return "d\(device.index) keeps \(gateway.id) at \(key), removed on all devices"
          }
        }
      }
    }

    return nil
  }

  /// What "converged" means.
  static func invariantViolation(_ world: SyncWorld) -> String? {
    let items = world.cloud.cloudItems

    for device in world.devices.indices where world.cloud.items(device) != items {
      return "d\(device) holds other items than the cloud"
    }

    var records: [String: SyncedGatewayRecord] = [:]
    var foreign: Set<String> = []

    for (account, text) in items {
      guard let record = SyncedGatewayRecord.decode(account: account, value: text) else {
        return "\(account) is not one of ours"
      }
      guard record.isSupported else {
        foreign.insert(record.key)
        continue
      }
      guard (try? record.encoded()) == text else {
        return "\(account) is not in canonical form"
      }
      records[record.key] = record
    }

    for device in world.devices {
      for gateway in device.gateways {
        guard let entry = device.state.entries[gateway.id] else {
          return "d\(device.index) \(gateway.id) has no sync entry"
        }
        // Switched off: the item it last knew is gone, whether or not it ever read it back.
        if entry.detached == .user, !foreign.contains(gateway.key), let known = entry.stamp(.address),
          records[gateway.key]?.isLive == true, records[gateway.key]?.registers[.address]?.stamp == known,
          !device.gateways.contains(where: { $0.key == gateway.key && device.state.entries[$0.id]?.detached == nil }) {
          return "d\(device.index) \(gateway.id) is switched off but the item it knew is still in iCloud"
        }
        guard entry.detached == nil, !foreign.contains(gateway.key) else { continue }
        guard let record = records[gateway.key], record.isLive else {
          return "d\(device.index) \(gateway.id) is attached to \(gateway.key) but there is no live record"
        }
        if let difference = difference(gateway, entry, record) {
          return "d\(device.index) \(gateway.id) differs from its record in \(difference)"
        }
      }

      for (key, record) in records where record.isLive {
        if !device.state.hidden.contains(key), device.gateways(at: key).isEmpty {
          return "d\(device.index) has no gateway for live record \(key) and has not hidden it"
        }
      }
    }

    return nil
  }

  /// The first field in which an attached gateway does not show its record.
  static func difference(_ gateway: LocalGateway, _ entry: SyncEntry, _ record: SyncedGatewayRecord) -> String? {
    let origin = GatewayAddress.origin(of: gateway.address)
    let door = gateway.frontDoor.flatMap { $0.origin == origin && origin.hasPrefix("https://") ? $0 : nil }
    let token = gateway.sessionToken.flatMap { $0.origin == origin ? $0 : nil }
    let headers = gateway.headers.flatMap { $0.origin == origin ? $0 : nil }

    if gateway.address != record.address { return "address" }
    if gateway.name != record.name { return "name" }
    if gateway.authKind != record.authKind { return "authKind" }
    if gateway.provider != record.provider { return "provider" }
    if gateway.addedAt != record.addedAt { return "addedAt" }
    // Signed out here, a missing front door or headers are left missing.
    if door != record.frontDoor, !(entry.signedOut && door == nil) { return "frontDoor" }
    if (headers?.headers.count ?? 0) <= 50, headers != record.headers, !(entry.signedOut && headers == nil) {
      return "headers"
    }
    if !entry.signedOut, token != record.sessionToken { return "sessionToken" }
    if !entry.signedOut, gateway.user != record.user { return "user" }
    return nil
  }
}
