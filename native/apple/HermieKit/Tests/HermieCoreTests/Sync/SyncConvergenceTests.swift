import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The property the whole design rests on, in two halves.
///
/// Liveness: whatever three devices do, and in whatever order the keychain delivers it (including
/// whole items refused or overwritten, devices that lose their copy and come back, clocks that
/// are wrong or jump back, a print key that is lost, and crashes between applying a plan and
/// saving the state), once delivery completes and each has reconciled twice they hold the same
/// items and equivalent gateway lists, and a further reconcile has nothing to do.
///
/// Safety: along the way, a gateway leaves a device only after a removal on all devices or an
/// origin change at its key; a removal on all devices is not undone without an explicit add; a
/// credential is cleared only after someone cleared it on purpose; and no credential is ever
/// written for another origin than its gateway's.
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
    atLeast(coverage.wiped, 1_000, "device lost its items (wipe)")
    atLeast(coverage.clockJumpsBack, 500, "clock jumped back")
    atLeast(coverage.syncSwitchedBackOn, 550, "sync switched off and on again")
    atLeast(coverage.crashes, 2_700, "crash between the steps of applying a plan")
    atLeast(coverage.lostWrites, 350, "iCloud writes lost with the state saved")
    atLeast(coverage.traces[.readded, default: 0], 170, "explicit re-add over a tombstone")
    atLeast(coverage.traces[.existingKeptAbsent, default: 0], 35, "existing gateway kept absent by a removal")
    atLeast(coverage.traces[.absentPurged, default: 0], 55, "absent gateway purged by a tombstone")
    atLeast(coverage.traces[.earlierLifeDropped, default: 0], 15, "credential from an earlier life dropped")
    atLeast(coverage.traces[.tombstoneRewritten, default: 0], 350, "remembered tombstone merged back in")
    atLeast(coverage.traces[.tombstoneRewrittenOverMissing, default: 0], 120, "stop-syncing/removal race repaired")
    atLeast(coverage.traces[.stopSyncingDeleteRepeated, default: 0], 350, "lost stop-syncing delete made again")
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
    var wiped = 0
    var refused = 0
    var clockJumpsBack = 0
    var syncSwitchedBackOn = 0
    var crashes = 0
    var lostWrites = 0
    var traces: [SyncTrace: Int] = [:]

    mutating func add(_ other: Coverage) {
      adopted += other.adopted
      purged += other.purged
      pruned += other.pruned
      becameAbsent += other.becameAbsent
      wiped += other.wiped
      refused += other.refused
      clockJumpsBack += other.clockJumpsBack
      syncSwitchedBackOn += other.syncSwitchedBackOn
      crashes += other.crashes
      lostWrites += other.lostWrites
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
      for trace in plan.traces {
        traces[trace, default: 0] += 1
      }
    }
  }

  struct Failure: Error {
    var message: String
    var log: [String]
  }

  /// What the people did, as far as the safety invariants need to know.
  struct Ledger {
    /// Per key and device: purges a removal on all devices (or a move away) has authorised and that
    /// have not happened yet. One removal allows each device one purge, not every later one.
    var purgeAllowance: [String: [Int: Int]] = [:]
    /// Null credential registers published with an intent to clear: `key|field|t|d`.
    var authorisedClears: Set<String> = []
    /// Credential registers published by the device they were entered on: `key|field|t|d`. A
    /// register put back later at the same stamp (the store lost it) is the same write.
    var authorisedValues: Set<String> = []
    /// Keys at which someone removed a gateway on all devices, or moved one away (a tombstone).
    var removed: Set<String> = []
    /// Keys removed on all devices by a device that had the gateway in sync, in sequence order.
    var syncedRemovalStep: [String: Int] = [:]
    /// The last step at which someone added a gateway at a key (or moved one there).
    var addStep: [String: Int] = [:]
    /// The devices on which someone added a gateway at a key (or moved one there).
    var addedBy: [String: Set<Int>] = [:]

    mutating func added(at key: String, on device: Int, step: Int) {
      addStep[key] = step
      addedBy[key, default: []].insert(device)
    }
    /// Devices that were wiped, had sync switched off, or switched a gateway's sync, per device.
    var wiped: Set<Int> = []
    /// Steps at which more than 180 days passed: a removal before one may have aged out.
    var longGaps: [Int] = []
    var syncWasOff: Set<Int> = []
    var gatewaySyncToggled: [Int: Set<String>] = [:]

    mutating func grantRemoval(at key: String, devices: Int) {
      removed.insert(key)
      for device in 0..<devices {
        purgeAllowance[key, default: [:]][device, default: 0] += 1
      }
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

    /// The safety invariants that hold plan by plan.
    func check(_ plan: SyncPlan, device: Int, before: TestDevice, view: [SyncedGatewayRecord]) {
      guard violation == nil else { return }

      for op in plan.localOps {
        switch op {
        case let .purge(gatewayId):
          let key = before.gateway(gatewayId)?.key ?? ""
          if (ledger.purgeAllowance[key]?[device] ?? 0) > 0 {
            ledger.purgeAllowance[key]![device]! -= 1
          } else {
            violation = "d\(device) purged \(gatewayId) at \(key) without a removal left to cause it"
          }
        case let .update(gateway, fields):
          let old = before.gateway(gateway.id)
          let oldOrigin = old.map { GatewayAddress.origin(of: $0.address) }
          for field in fields.intersection([.frontDoor, .headers, .sessionToken]) {
            // Only a credential usable before (bound to the gateway's origin) can be cleared.
            let wasSet =
              switch field {
              case .frontDoor: old?.frontDoor.map { $0.origin == oldOrigin } ?? false
              case .headers: old?.headers.map { $0.origin == oldOrigin } ?? false
              default: old?.sessionToken.map { $0.origin == oldOrigin } ?? false
              }
            let isSet =
              switch field {
              case .frontDoor: gateway.frontDoor != nil
              case .headers: gateway.headers != nil
              default: gateway.sessionToken != nil
              }
            let key = gateway.key
            // The register the value came from: what this plan writes, else what the device saw.
            let merged = plan.remotePuts.first { $0.key == key } ?? view.first { $0.key == key }?.normalized()
            let register = merged?.registers[field]
            let authorised = register.map { register in
              register.value.isNull
                && ledger.authorisedClears.contains("\(key)|\(field.rawValue)|\(register.stamp.t)|\(register.stamp.d)")
            } ?? (merged?.deleted != nil)
            // A credential a move left behind here (see `SyncEntry.leftBehind`) goes too.
            let leftBehind: Bool = {
              let value: JSONValue? =
                switch field {
                case .frontDoor: old?.frontDoor?.json
                case .headers: old?.headers?.json
                default: old?.sessionToken?.json
                }
              guard let value else { return false }
              return before.state.entries[gateway.id]?.leftBehind.contains(printer(key: before.printKey).print(value)) == true
            }()
            if wasSet, !isSet, !authorised, !leftBehind {
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

      // A tombstone in this device's view is overridden only by a gateway added here (or one
      // whose stamps already outrank it).
      for record in plan.remotePuts where record.isLive {
        guard let seen = view.first(where: { $0.key == record.key }), seen.isTombstone, let deleted = seen.deleted else {
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

      for record in plan.remotePuts where record.isLive {
        let seen = view.first { $0.key == record.key }?.normalized()
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

          if register.value.isNull {
            // (c) A clear goes out under a new stamp only with an intent to clear.
            let intent = before.state.entries.values.contains { $0.key == record.key && $0.clearing.contains(field) }
            if !intent {
              violation = "d\(device) published a cleared \(field.rawValue) at \(record.key) nobody asked for"
            }
            ledger.authorisedClears.insert("\(record.key)|\(field.rawValue)|\(register.stamp.t)|\(register.stamp.d)")
          } else if let value = SyncedGatewayRecord.projection(field, register.value, key: record.key, origin: record.origin) {
            // (e) A credential goes out under a new stamp of this device only if it was entered here.
            if before.entered.contains("\(field.rawValue)|\(canonical(value))") {
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

    world.devices[1].clockOffset = [0, 0, year, -year, 3_000].randomElement(using: &rng)!
    world.devices[2].clockOffset = [0, -5_000, 7 * day].randomElement(using: &rng)!
    log.append("offsets \(world.devices.map(\.clockOffset))")

    func randomGateway(_ device: Int) -> LocalGateway? {
      world.devices[device].gateways.randomElement(using: &rng)
    }

    func attached(_ device: Int, _ gateway: LocalGateway) -> Bool {
      world.devices[device].state.entries[gateway.id]?.detached == nil && world.devices[device].state.enabled
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

    // Some sequences open with a short scripted setup for a path random steps rarely reach; the
    // random steps that follow, and the delivery order, stay random.
    switch seed % 8 {
    case 1:
      // A copy that went absent (its device lost the item) meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      let id = world.add(0, address: address, name: "Scripted", token: "tok-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      world.cloud.wipeLocal(1)
      ledger.wiped.insert(1)
      coverage.wiped += 1
      reconcile(1)
      world.advance(1_000)
      step += 1
      ledger.grantRemoval(at: GatewayKey.of(address), devices: 3)
      world.remove(0, id, scope: .allDevices)
      log.append("scripted: d1 absent, d0 remove-everywhere \(id)")
    case 3:
      // A gateway that was already on a device with sync off meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      world.setEnabled(2, false)
      ledger.syncWasOff.insert(2)
      world.existing(2, address: address, token: "tok-old")
      ledger.addedBy[GatewayKey.of(address), default: []].insert(2)
      let id = world.add(0, address: address, name: "Scripted")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      world.advance(1_000)
      step += 1
      ledger.grantRemoval(at: GatewayKey.of(address), devices: 3)
      if uncontested(GatewayKey.of(address), removing: id) {
        ledger.syncedRemovalStep[GatewayKey.of(address)] = step
      }
      world.remove(0, id, scope: .allDevices)
      reconcile(0)
      world.setEnabled(2, true)
      coverage.syncSwitchedBackOn += 1
      log.append("scripted: d2 had it with sync off, d0 remove-everywhere \(id)")
    case 4:
      // A device signed out here loses the credentials it still had.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s", frontDoorSecret: "door-s")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      if let copy = world.devices[1].gateways.first(where: { $0.key == GatewayKey.of(address) }) {
        world.signOut(1, copy.id)
        world.loseCredentials(1, copy.id)
        log.append("scripted: d1 signed out and lost \(copy.id)")
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
      if let mine = world.devices[1].gateways.first(where: { $0.key == GatewayKey.of(address) }),
        let theirs = world.devices[0].gateways.first(where: { $0.key == GatewayKey.of(address) }) {
        ledger.grantRemoval(at: mine.key, devices: 3)
        if uncontested(mine.key, removing: mine.id) { ledger.syncedRemovalStep[mine.key] = step }
        world.remove(1, mine.id, scope: .allDevices)
        reconcile(1)
        world.setGatewaySynced(0, theirs.id, false)
        ledger.gatewaySyncToggled[0, default: []].insert(theirs.key)
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
      if let copy = world.devices[1].gateways.first(where: { $0.key == GatewayKey.of(address) }) {
        world.signOutEverywhere(1, copy.id)
        log.append("scripted: d1 signs out on all devices \(copy.id)")
      }
    case 7:
      // "Stop syncing" whose delete the keychain loses while the state is saved.
      let address = addresses.randomElement(using: &rng)!
      let id = world.add(0, address: address, name: "Scripted")
      ledger.added(at: GatewayKey.of(address), on: 0, step: step)
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(0)
      world.setGatewaySynced(0, id, false)
      ledger.gatewaySyncToggled[0, default: []].insert(GatewayKey.of(address))
      reconcile(0, loseWrites: true)
      log.append("scripted: d0 stop-syncing delete lost")
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
            ledger.grantRemoval(at: gateway.key, devices: 3)
            if known != gateway.key { ledger.grantRemoval(at: known, devices: 3) }
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
          log.append("d\(device) token \(gateway.id) \(token ?? "cleared")")
        case 10:
          guard let gateway = randomGateway(device) else { continue }
          let door: String? = Bool.random(using: &rng) ? "door-\(counter)" : nil
          world.setFrontDoor(device, gateway.id, secret: door)
          log.append("d\(device) frontDoor \(gateway.id) \(door ?? "cleared")")
        case 11:
          guard let gateway = randomGateway(device) else { continue }
          let choice = Int.random(in: 0..<3, using: &rng)
          let headers: [String: String]? = choice == 0 ? nil : choice == 1 ? ["X-Team": "t\(counter)"] : bigHeaders
          world.setHeaders(device, gateway.id, headers)
          log.append("d\(device) headers \(gateway.id) \(headers.map { "\($0.count)" } ?? "cleared")")
        case 12:
          guard let gateway = randomGateway(device) else { continue }
          world.remove(device, gateway.id, scope: .thisDevice)
          log.append("d\(device) remove-here \(gateway.id)")
        case 13...15:
          guard let gateway = randomGateway(device) else { continue }
          // The tombstone goes to the key sync knows the gateway under, which an unreconciled move
          // may have left different from its address.
          let known = world.devices[device].state.entries[gateway.id]?.key ?? gateway.key
          ledger.grantRemoval(at: gateway.key, devices: 3)
          if known != gateway.key { ledger.grantRemoval(at: known, devices: 3) }
          // A newer build's record at the key is left alone, so no tombstone can be written there.
          let foreignHere = world.records(device).contains { $0.key == known && !$0.isSupported }
          if attached(device, gateway), known == gateway.key, !foreignHere,
            uncontested(gateway.key, removing: gateway.id) {
            ledger.syncedRemovalStep[gateway.key] = step
          }
          world.remove(device, gateway.id, scope: .allDevices)
          log.append("d\(device) remove-everywhere \(gateway.id)")
        case 16:
          guard let gateway = randomGateway(device) else { continue }
          world.signOut(device, gateway.id)
          log.append("d\(device) sign-out \(gateway.id)")
        case 17:
          guard let gateway = randomGateway(device) else { continue }
          world.signOutEverywhere(device, gateway.id)
          log.append("d\(device) sign-out-everywhere \(gateway.id)")
        case 18, 19:
          guard let gateway = randomGateway(device) else { continue }
          let synced = world.devices[device].state.entries[gateway.id]?.detached == .user
          ledger.gatewaySyncToggled[device, default: []].insert(gateway.key)
          world.setGatewaySynced(device, gateway.id, synced)
          log.append("d\(device) gateway-sync \(gateway.id) \(synced)")
        case 20:
          let enabled = !world.devices[device].state.enabled
          if enabled { coverage.syncSwitchedBackOn += 1 } else { ledger.syncWasOff.insert(device) }
          world.setEnabled(device, enabled)
          log.append("d\(device) sync \(enabled)")
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
        coverage.wiped += 1
        ledger.wiped.insert(device)
        world.cloud.wipeLocal(device)
        log.append("d\(device) wipeLocal")
      case 95:
        world.advance(200 * day)
        ledger.longGaps.append(step)
        log.append("-- 200 days later")
      default:
        world.cloud.rejoin(device)
        log.append("d\(device) rejoin")
      }

      if let violation {
        return .failure(Failure(message: violation, log: log))
      }
    }

    // Delivery completes: every device is back on iCloud with sync on.
    for device in world.devices.indices {
      world.cloud.rejoin(device)
      if !world.devices[device].state.enabled { coverage.syncSwitchedBackOn += 1 }
      world.setEnabled(device, true)
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

    // Items only vanish when something deletes them or a device loses its copy; otherwise no
    // gateway may end up cut off from sync.
    if coverage.pruned == 0, coverage.wiped == 0, ledger.gatewaySyncToggled.isEmpty,
      coverage.traces[.existingKeptAbsent] == nil {
      for device in world.devices {
        if let id = device.state.entries.first(where: { $0.value.detached == .absent })?.key {
          return .failure(Failure(message: "d\(device.index) \(id) is absent though no item ever vanished", log: log))
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
  /// unless that device was away (wiped, sync off, crashed), some device switched that gateway's
  /// sync (its delete can race the tombstone), or the removal aged past 180 days (the design's
  /// "offline for more than 180 days" row).
  static func removalViolation(_ world: SyncWorld, _ ledger: Ledger) -> String? {
    for (key, removedAt) in ledger.syncedRemovalStep where (ledger.addStep[key] ?? 0) < removedAt {
      // A key a newer build's record holds is left alone by design.
      guard world.cloudRecord(key: key)?.isSupported != false else {
        continue
      }

      // Back in iCloud: only by an address someone wrote on a device where they added it there
      // (possibly unseen by the remover, and stamped later by a clock ahead).
      if let record = world.cloudRecord(key: key), record.isLive, let writer = record.registers[.address]?.stamp.d,
        let index = Int(writer.suffix(2), radix: 16) {
        if ledger.addedBy[key]?.contains(index) != true {
          return "\(key) came back in iCloud after a removal on all devices, written by d\(index) that never added it"
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
          let away = ledger.wiped.contains(device.index) || ledger.syncWasOff.contains(device.index)
            || ledger.gatewaySyncToggled[device.index]?.contains(key) == true
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
        if entry.detached == .user, entry.seen, !foreign.contains(gateway.key), let known = entry.stamp(.address),
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
