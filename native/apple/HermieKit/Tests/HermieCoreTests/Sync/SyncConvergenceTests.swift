import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// The property the whole design rests on: whatever three devices do, and in whatever order the
/// keychain delivers it, once delivery completes and each has reconciled twice they hold the same
/// items and equivalent gateway lists, and a further reconcile has nothing to do.
///
/// `HERMIE_SYNC_SEED` (first seed, default 1) and `HERMIE_SYNC_SEQUENCES` (default 2000) rerun or
/// widen the search; a failure names its seed and conflict policy and prints the operations.
@Suite struct SyncConvergenceTests {
  static let firstSeed = UInt64(ProcessInfo.processInfo.environment["HERMIE_SYNC_SEED"] ?? "") ?? 1
  static let sequences = UInt64(ProcessInfo.processInfo.environment["HERMIE_SYNC_SEQUENCES"] ?? "") ?? 2000
  /// `HERMIE_SYNC_TRACE=1` adds each device's store and sync entries to the log after a reconcile.
  static let trace = ProcessInfo.processInfo.environment["HERMIE_SYNC_TRACE"] != nil

  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func threeReplicasConverge(conflict: TestCloud.ConflictPolicy) {
    var coverage = Coverage()

    for seed in Self.firstSeed..<(Self.firstSeed + Self.sequences) {
      switch Self.run(seed: seed, conflict: conflict) {
      case let .failure(failure):
        Issue.record("seed \(seed), conflict \(conflict.rawValue): \(failure.message)\n\(failure.log.joined(separator: "\n"))")
        return
      case let .success(run):
        coverage.add(run)
      }
    }

    // The sequences must actually reach the hard paths, or passing says little.
    #expect(coverage.adopted > 0)
    #expect(coverage.purged > 0)
    #expect(coverage.tombstonesWritten > 0)
    #expect(coverage.itemsDeleted > 0)
    #expect(coverage.becameAbsent > 0)
    #expect(coverage.wiped > 0)
    #expect(coverage.mostSettleRounds > 1)
    if conflict == .cloudWins {
      #expect(coverage.refused > 0)
    }
  }

  /// What the sequences exercised, summed.
  struct Coverage {
    var adopted = 0
    var purged = 0
    var tombstonesWritten = 0
    var itemsDeleted = 0
    var becameAbsent = 0
    var wiped = 0
    var refused = 0
    var mostSettleRounds = 0

    mutating func add(_ other: Coverage) {
      adopted += other.adopted
      purged += other.purged
      tombstonesWritten += other.tombstonesWritten
      itemsDeleted += other.itemsDeleted
      becameAbsent += other.becameAbsent
      wiped += other.wiped
      refused += other.refused
      mostSettleRounds = max(mostSettleRounds, other.mostSettleRounds)
    }

    mutating func tally(_ plan: SyncPlan, before: SyncState) {
      for op in plan.localOps {
        if case .add = op { adopted += 1 }
        if case .purge = op { purged += 1 }
      }
      tombstonesWritten += plan.remotePuts.filter(\.isTombstone).count
      itemsDeleted += plan.remoteDeletes.count
      becameAbsent += plan.state.entries.filter { id, entry in
        entry.detached == .absent && before.entries[id]?.detached != .absent
      }.count
    }
  }

  struct Failure: Error {
    var message: String
    var log: [String]
  }

  static let addresses = [
    "https://gateway.test", "https://gateway.test/hermes", "https://alpha.gateway.test",
    "http://beta.gateway.test:8080", "https://gateway.test:8443"
  ]
  static let names = ["Home", "Work", "Lab", "Office"]

  /// One random sequence, and what it exercised.
  static func run(seed: UInt64, conflict: TestCloud.ConflictPolicy) -> Result<Coverage, Failure> {
    var rng = SeededGenerator(seed: seed)
    var world = SyncWorld(devices: 3, conflict: conflict)
    var log: [String] = []
    var counter = 0
    var coverage = Coverage()
    let trace = Self.trace

    @discardableResult
    func reconcile(_ device: Int) -> SyncPlan {
      let before = world.devices[device].state
      let plan = world.reconcile(device)
      coverage.tally(plan, before: before)
      log.append("d\(device) reconcile \(plan)")
      if trace {
        let entries = plan.state.entries.keys.sorted().map { "    \($0): \(plan.state.entries[$0]!)" }
        log.append("    store: \(world.records(device).map(\.description))")
        log.append(contentsOf: entries)
      }
      return plan
    }

    world.devices[1].clockOffset = [0, 0, year, -year, 3_000].randomElement(using: &rng)!
    world.devices[2].clockOffset = [0, -5_000, 7 * day].randomElement(using: &rng)!
    log.append("offsets \(world.devices.map(\.clockOffset))")

    func randomGateway(_ device: Int) -> LocalGateway? {
      world.devices[device].gateways.randomElement(using: &rng)
    }

    for _ in 0..<Int.random(in: 5...40, using: &rng) {
      world.advance(Double(Int.random(in: 0...20_000, using: &rng)))
      let device = Int.random(in: 0..<3, using: &rng)
      let roll = Int.random(in: 0..<100, using: &rng)

      switch roll {
      case 0..<45:
        counter += 1
        let op = Int.random(in: 0..<18, using: &rng)
        switch op {
        case 0..<3:
          let address = addresses.randomElement(using: &rng)!
          let token: String? = Bool.random(using: &rng) ? "tok-\(counter)" : nil
          let door: String? = Int.random(in: 0..<4, using: &rng) == 0 ? "door-\(counter)" : nil
          let kind = Bool.random(using: &rng) ? "session_token" : "native_pkce"
          let name = names.randomElement(using: &rng)!
          let id = world.add(device, address: address, name: name, authKind: kind, token: token, frontDoorSecret: door)
          log.append("d\(device) add \(id) \(address) \(name) \(kind) token:\(token ?? "-") door:\(door ?? "-")")
        case 3..<6:
          guard let gateway = randomGateway(device) else { continue }
          let name = names.randomElement(using: &rng)! + "\(counter)"
          world.rename(device, gateway.id, to: name)
          log.append("d\(device) rename \(gateway.id) \(name)")
        case 6..<8:
          guard let gateway = randomGateway(device) else { continue }
          let address = addresses.randomElement(using: &rng)!
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
          world.remove(device, gateway.id, scope: .thisDevice)
          log.append("d\(device) remove-here \(gateway.id)")
        case 12:
          guard let gateway = randomGateway(device) else { continue }
          world.remove(device, gateway.id, scope: .allDevices)
          log.append("d\(device) remove-everywhere \(gateway.id)")
        case 13:
          guard let gateway = randomGateway(device) else { continue }
          world.signOut(device, gateway.id)
          log.append("d\(device) sign-out \(gateway.id)")
        case 14:
          guard let gateway = randomGateway(device) else { continue }
          world.signOutEverywhere(device, gateway.id)
          log.append("d\(device) sign-out-everywhere \(gateway.id)")
        case 15, 16:
          guard let gateway = randomGateway(device) else { continue }
          let synced = world.devices[device].state.entries[gateway.id]?.detached == .user
          world.setGatewaySynced(device, gateway.id, synced)
          log.append("d\(device) gateway-sync \(gateway.id) \(synced)")
        default:
          let enabled = !world.devices[device].state.enabled
          world.setEnabled(device, enabled)
          log.append("d\(device) sync \(enabled)")
        }
      case 45..<70:
        for _ in 0..<Int.random(in: 1...4, using: &rng) where !world.cloud.pending.isEmpty {
          world.cloud.deliver(at: Int.random(in: 0..<world.cloud.pending.count, using: &rng))
        }
      case 70..<93:
        reconcile(device)
      case 93..<96:
        coverage.wiped += 1
        world.cloud.wipeLocal(device)
        log.append("d\(device) wipeLocal")
      default:
        world.cloud.rejoin(device)
        log.append("d\(device) rejoin")
      }
    }

    // Delivery completes: every device is back on iCloud with sync on.
    for device in world.devices.indices {
      world.cloud.rejoin(device)
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
          let device = Int.random(in: 0..<3, using: &rng)
          reconcile(device)
        }
      }

      var wrote = false
      for device in [0, 1, 2].shuffled(using: &rng) {
        world.advance(1_000)
        let plan = reconcile(device)
        wrote = wrote || plan.hasRemoteWrites || !plan.localOps.isEmpty
      }
      settled = !wrote && world.cloud.pending.isEmpty
    }

    guard settled else {
      return .failure(Failure(message: "did not settle in \(rounds) rounds", log: log))
    }

    // Each device reconciles twice more: nothing left to do.
    for pass in 1...2 {
      for device in world.devices.indices {
        world.advance(1_000)
        let plan = reconcile(device)
        if !plan.isEmpty {
          return .failure(Failure(message: "reconcile \(pass) on d\(device) is not empty: \(plan)", log: log))
        }
      }
    }

    if let problem = invariantViolation(world) {
      return .failure(Failure(message: problem, log: log))
    }

    // Items only vanish when something deletes them or a device loses its copy; otherwise no
    // gateway may end up cut off from sync.
    if coverage.itemsDeleted == 0, coverage.wiped == 0 {
      for device in world.devices {
        if let id = device.state.entries.first(where: { $0.value.detached == .absent })?.key {
          return .failure(Failure(message: "d\(device.index) \(id) is absent though no item ever vanished", log: log))
        }
      }
    }

    coverage.refused = world.cloud.refused
    coverage.mostSettleRounds = rounds
    return .success(coverage)
  }

  /// What "converged" means.
  static func invariantViolation(_ world: SyncWorld) -> String? {
    let items = world.cloud.cloudItems

    for device in world.devices.indices where world.cloud.items(device) != items {
      return "d\(device) holds other items than the cloud"
    }

    var records: [String: SyncedGatewayRecord] = [:]

    for (account, text) in items {
      guard let record = SyncedGatewayRecord.decode(account: account, value: text), record.isSupported else {
        return "\(account) is not a record this build reads"
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
        guard entry.detached == nil else { continue }
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

    if gateway.address != record.address { return "address" }
    if gateway.name != record.name { return "name" }
    if gateway.authKind != record.authKind { return "authKind" }
    if gateway.provider != record.provider { return "provider" }
    if gateway.addedAt != record.addedAt { return "addedAt" }
    if door != record.frontDoor { return "frontDoor" }
    if !entry.signedOut, token != record.sessionToken { return "sessionToken" }
    if !entry.signedOut, gateway.user != record.user { return "user" }
    return nil
  }
}
