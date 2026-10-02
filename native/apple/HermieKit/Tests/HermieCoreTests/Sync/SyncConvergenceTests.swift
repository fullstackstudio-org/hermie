import Foundation
import HermieGateway
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

    atLeast(coverage.adopted, 2_200, "adopted")
    atLeast(coverage.purged, 450, "purged by a removal on all devices")
    atLeast(coverage.pruned, 240, "item deleted (pruned, switched off)")
    atLeast(coverage.becameAbsent, 500, "became absent")
    atLeast(coverage.wiped, 1_100, "device lost its items (wipe)")
    atLeast(coverage.clockJumpsBack, 500, "clock jumped back")
    atLeast(coverage.syncSwitchedBackOn, 600, "sync switched off and on again")
    atLeast(coverage.crashes, 2_900, "crash before the state was saved")
    atLeast(coverage.traces[.readded, default: 0], 150, "explicit re-add over a tombstone")
    atLeast(coverage.traces[.existingKeptAbsent, default: 0], 120, "existing gateway kept absent by a removal")
    atLeast(coverage.traces[.absentPurged, default: 0], 50, "absent gateway purged by a tombstone")
    atLeast(coverage.traces[.earlierLifeDropped, default: 0], 10, "credential from an earlier life dropped")
    atLeast(coverage.traces[.tombstoneRewritten, default: 0], 180, "remembered tombstone written again")
    atLeast(coverage.traces[.headersOverLimit, default: 0], 120, "headers over the size limit")
    atLeast(coverage.traces[.foreignRecord, default: 0], 5_000, "foreign record in the store")
    atLeast(coverage.traces[.credentialRestored, default: 0], 80, "credential lost here put back")
    atLeast(coverage.traces[.credentialLeftSignedOut, default: 0], 300, "credential lost while signed out left alone")
    atLeast(coverage.traces[.printsReset, default: 0], 200, "print key lost")
    atLeast(coverage.traces[.crashedPurgeRecovered, default: 0], 40, "purge whose state was lost")
    if conflict == .cloudWins {
      atLeast(coverage.refused, 600, "upload refused by the cloud")
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
    /// Keys at which someone removed a gateway on all devices, or moved one away (a tombstone).
    var removed: Set<String> = []
    /// Keys removed on all devices by a device that had the gateway in sync, in sequence order.
    var syncedRemovalStep: [String: Int] = [:]
    /// The last step at which someone added a gateway at a key (or moved one there).
    var addStep: [String: Int] = [:]
    /// Credentials someone cleared on purpose, per key.
    var cleared: [String: Set<SyncField>] = [:]
    /// Devices that were wiped, had sync switched off, or switched a gateway's sync, per device.
    var wiped: Set<Int> = []
    /// Devices that crashed between applying a plan and saving the state: a gateway adopted just
    /// before looks like one that was already there, and stays device-only on a later removal.
    var crashed: Set<Int> = []
    /// Steps at which more than 180 days passed: a removal before one may have aged out.
    var longGaps: [Int] = []
    var syncWasOff: Set<Int> = []
    var gatewaySyncToggled: [Int: Set<String>] = [:]
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
          if !ledger.removed.contains(key) {
            violation = "d\(device) purged \(gatewayId) at \(key), where nobody removed a gateway"
          }
        case let .update(gateway, fields):
          let old = before.gateway(gateway.id)
          for field in fields.intersection([.frontDoor, .headers, .sessionToken]) {
            let wasSet =
              switch field {
              case .frontDoor: old?.frontDoor != nil
              case .headers: old?.headers != nil
              default: old?.sessionToken != nil
              }
            let isSet =
              switch field {
              case .frontDoor: gateway.frontDoor != nil
              case .headers: gateway.headers != nil
              default: gateway.sessionToken != nil
              }
            let key = gateway.key
            if wasSet, !isSet, ledger.cleared[key]?.contains(field) != true, !ledger.removed.contains(key) {
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
            && (before.state.entries[gateway.id].map { $0.addedHere || $0.key != record.key } ?? true
              || (before.state.entries[gateway.id]?.stamp(.address)?.t ?? -1) > deleted.t)
        }
        if wroteAddress, !explicit {
          violation = "d\(device) brought \(record.key) back over a tombstone without an explicit add"
        }
      }
    }

    @discardableResult
    func reconcile(_ device: Int, crash: Bool = false) -> SyncPlan {
      let before = world.devices[device]
      let view = world.records(device)
      let plan = world.plan(device)

      if crash {
        // The engine applied the local changes (and maybe the remote writes) and then died: the
        // state was never saved.
        var applied = plan
        applied.state = before.state
        if Bool.random(using: &rng) { applied.remotePuts = []; applied.remoteDeletes = [] }
        world.apply(applied, to: device)
        coverage.crashes += 1
        ledger.crashed.insert(device)
      } else {
        world.apply(plan, to: device)
      }

      coverage.tally(plan, before: before.state)
      check(plan, device: device, before: before, view: view)
      log.append("d\(device) reconcile\(crash ? " (crash)" : "") \(plan)")
      if trace {
        log.append("    traces: \(plan.traces.map(\.rawValue).sorted()) hidden: \(plan.state.hidden.sorted())")
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

    // Some sequences open with a short scripted setup for a path random steps rarely reach; the
    // random steps that follow, and the delivery order, stay random.
    switch seed % 5 {
    case 1:
      // A copy that went absent (its device lost the item) meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      let id = world.add(0, address: address, name: "Scripted", token: "tok-s")
      ledger.addStep[GatewayKey.of(address)] = step
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      world.cloud.wipeLocal(1)
      ledger.wiped.insert(1)
      coverage.wiped += 1
      reconcile(1)
      world.advance(1_000)
      step += 1
      ledger.removed.insert(GatewayKey.of(address))
      world.remove(0, id, scope: .allDevices)
      log.append("scripted: d1 absent, d0 remove-everywhere \(id)")
    case 3:
      // A gateway that was already on a device with sync off meets a removal on all devices.
      let address = addresses.randomElement(using: &rng)!
      world.setEnabled(2, false)
      ledger.syncWasOff.insert(2)
      world.existing(2, address: address, token: "tok-old")
      let id = world.add(0, address: address, name: "Scripted")
      ledger.addStep[GatewayKey.of(address)] = step
      reconcile(0)
      world.cloud.deliverAll()
      world.advance(1_000)
      step += 1
      ledger.removed.insert(GatewayKey.of(address))
      ledger.syncedRemovalStep[GatewayKey.of(address)] = step
      world.remove(0, id, scope: .allDevices)
      reconcile(0)
      world.setEnabled(2, true)
      coverage.syncSwitchedBackOn += 1
      log.append("scripted: d2 had it with sync off, d0 remove-everywhere \(id)")
    case 4:
      // A device signed out here loses the credentials it still had.
      let address = addresses.randomElement(using: &rng)!
      world.add(0, address: address, name: "Scripted", token: "tok-s", frontDoorSecret: "door-s")
      ledger.addStep[GatewayKey.of(address)] = step
      reconcile(0)
      world.cloud.deliverAll()
      reconcile(1)
      if let copy = world.devices[1].gateways.first(where: { $0.key == GatewayKey.of(address) }) {
        world.signOut(1, copy.id)
        world.loseCredentials(1, copy.id)
        log.append("scripted: d1 signed out and lost \(copy.id)")
      }
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
          ledger.addStep[GatewayKey.of(address)] = step
          log.append("d\(device) add \(id) \(address) \(name) \(kind) token:\(token ?? "-") door:\(door ?? "-")")
        case 3..<6:
          guard let gateway = randomGateway(device) else { continue }
          let name = names.randomElement(using: &rng)! + "\(counter)"
          world.rename(device, gateway.id, to: name)
          log.append("d\(device) rename \(gateway.id) \(name)")
        case 6..<8:
          guard let gateway = randomGateway(device) else { continue }
          let address = addresses.randomElement(using: &rng)!
          if GatewayKey.of(address) != gateway.key {
            ledger.removed.insert(gateway.key)
            ledger.addStep[GatewayKey.of(address)] = step
          }
          world.setAddress(device, gateway.id, to: address)
          log.append("d\(device) address \(gateway.id) \(address)")
        case 8..<10:
          guard let gateway = randomGateway(device) else { continue }
          let token: String? = Int.random(in: 0..<3, using: &rng) == 0 ? nil : "tok-\(counter)"
          if token == nil { ledger.cleared[gateway.key, default: []].insert(.sessionToken) }
          world.setToken(device, gateway.id, to: token)
          log.append("d\(device) token \(gateway.id) \(token ?? "cleared")")
        case 10:
          guard let gateway = randomGateway(device) else { continue }
          let door: String? = Bool.random(using: &rng) ? "door-\(counter)" : nil
          if door == nil { ledger.cleared[gateway.key, default: []].insert(.frontDoor) }
          world.setFrontDoor(device, gateway.id, secret: door)
          log.append("d\(device) frontDoor \(gateway.id) \(door ?? "cleared")")
        case 11:
          guard let gateway = randomGateway(device) else { continue }
          let choice = Int.random(in: 0..<3, using: &rng)
          let headers: [String: String]? = choice == 0 ? nil : choice == 1 ? ["X-Team": "t\(counter)"] : bigHeaders
          if headers == nil { ledger.cleared[gateway.key, default: []].insert(.headers) }
          world.setHeaders(device, gateway.id, headers)
          log.append("d\(device) headers \(gateway.id) \(headers.map { "\($0.count)" } ?? "cleared")")
        case 12:
          guard let gateway = randomGateway(device) else { continue }
          world.remove(device, gateway.id, scope: .thisDevice)
          log.append("d\(device) remove-here \(gateway.id)")
        case 13...15:
          guard let gateway = randomGateway(device) else { continue }
          ledger.removed.insert(gateway.key)
          // An add at this key that sync has not acted on yet, on any device, is concurrent with
          // this removal and may win over it; then the removal is not checked.
          let pendingAdd = world.devices.contains { other in
            other.gateways.contains { candidate in
              candidate.id != gateway.id && candidate.key == gateway.key
                && (other.state.entries[candidate.id].map { $0.addedHere || $0.key != candidate.key } ?? true)
            }
          }
          if attached(device, gateway), !pendingAdd { ledger.syncedRemovalStep[gateway.key] = step }
          world.remove(device, gateway.id, scope: .allDevices)
          log.append("d\(device) remove-everywhere \(gateway.id)")
        case 16:
          guard let gateway = randomGateway(device) else { continue }
          world.signOut(device, gateway.id)
          log.append("d\(device) sign-out \(gateway.id)")
        case 17:
          guard let gateway = randomGateway(device) else { continue }
          ledger.cleared[gateway.key, default: []].insert(.sessionToken)
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
        reconcile(device, crash: Int.random(in: 0..<6, using: &rng) == 0)
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
    if coverage.pruned == 0, coverage.wiped == 0, ledger.gatewaySyncToggled.isEmpty, ledger.crashed.isEmpty,
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

  /// Safety (d): a credential written to a device names the gateway's own origin.
  static func foreignOrigin(_ gateway: LocalGateway, fields: Set<SyncField>) -> String? {
    let origin = GatewayAddress.origin(of: gateway.address)
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
      // A key a newer build's record holds is left alone by design; so is a re-added gateway.
      guard world.cloudRecord(key: key)?.isLive != true, world.cloudRecord(key: key)?.isSupported != false else {
        continue
      }

      for device in world.devices {
        for gateway in device.gateways(at: key) {
          let entry = device.state.entries[gateway.id]
          if entry?.detached == nil {
            return "d\(device.index) still syncs \(gateway.id) at \(key), removed on all devices"
          }
          let away = ledger.wiped.contains(device.index) || ledger.syncWasOff.contains(device.index)
            || ledger.crashed.contains(device.index)
            // "Stop syncing" anywhere deletes the item, and with it a tombstone it races with.
            || ledger.gatewaySyncToggled.values.contains { $0.contains(key) }
            || ledger.longGaps.contains { $0 > removedAt }
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
        if entry.detached == .user, entry.seen || !entry.stamps.isEmpty {
          return "d\(device.index) \(gateway.id) is switched off but still holds sync stamps"
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
