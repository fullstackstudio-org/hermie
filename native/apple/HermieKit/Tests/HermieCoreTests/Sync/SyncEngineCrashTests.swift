import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// A crash after each step of applying a plan, and a store that fails in each step: the next run
/// converges, and no gateway or credential is lost or comes back.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineCrashTests {
  struct Case: Sendable, CustomTestStringConvertible {
    let step: SyncApplyStep
    let conflict: FakeCloud.Conflict
    var testDescription: String { "\(step), \(conflict)" }
  }

  static let cases: [Case] = SyncApplyStep.allCases.flatMap { step in conflictPolicies.map { Case(step: step, conflict: $0) } }

  static let addresses = (
    a: homeAddress, b: otherAddress, c: "https://c.test", e: "https://e.test", f: "https://f.test"
  )

  /// Device 1's next plan purges A, renames B and changes its token, adopts C, and publishes the
  /// rename of its own E. It also stopped syncing F, and that delete failed with the state saved
  /// (review A4).
  static func scenario(_ conflict: FakeCloud.Conflict) async throws -> (EngineWorld, [String: String]) {
    let world = try EngineWorld(2, conflict: conflict)
    let a = addresses
    try await world.discloseAll()
    try await addGateway(world[0], address: a.a, name: "A", token: "tok-a", frontDoorSecret: "door-a")
    try await addGateway(world[0], address: a.b, name: "B", token: "tok-b", headers: ["X-B": "1"])
    try await addGateway(world[0], address: a.f, name: "F", token: "tok-f")
    try await addGateway(world[1], address: a.e, name: "E", token: "tok-e")
    await world.settle()

    var ids: [String: String] = [:]
    for (device, prefix) in [(0, "0"), (1, "1")] {
      for gateway in try await world[device].gateways() {
        ids[prefix + gateway.name] = gateway.id
      }
    }

    world.cloud.failNext(.delete, on: "device1", with: .keychain(operation: .delete, status: -25_293))
    try await world[1].engine.setGatewaySynced(false, id: ids["1F"]!)
    await world[1].engine.waitUntilIdle()

    world.advance(1_000)
    try await world[0].engine.removeGateway(id: ids["0A"]!, scope: .allDevices)
    try await GatewayRegistryStore(store: world[0].database).rename(id: ids["0B"]!, to: "B2")
    try world[0].secrets.set(SecretKeys.Gateway(id: ids["0B"]!).sessionToken, "tok-b2")
    try await addGateway(world[0], address: a.c, name: "C", token: "tok-c")
    await world[0].engine.waitUntilIdle()
    await world[0].reconcile()
    world.cloud.deliverAll()

    try await GatewayRegistryStore(store: world[1].database).rename(id: ids["1E"]!, to: "E2")
    return (world, ids)
  }

  static func expectConverged(_ world: EngineWorld, _ ids: [String: String]) async throws {
    let a = addresses
    let one = try await world[1].gateways()
    let zero = try await world[0].gateways()

    #expect(one.map(\.address).sorted() == [a.b, a.c, a.e, a.f].sorted())
    #expect(zero.map(\.address).sorted() == [a.b, a.c, a.e, a.f].sorted())
    #expect(Set(one.map(\.id)).count == one.count)

    func on(_ device: EngineDevice, _ list: [GatewayRecord], _ address: String) -> (GatewayRecord?, String?) {
      let record = list.first { $0.address == address }
      return (record, record.flatMap { device.token($0.id) })
    }

    #expect(on(world[1], one, a.b).0?.name == "B2")
    #expect(on(world[1], one, a.b).1 == "tok-b2")
    #expect(on(world[1], one, a.c).1 == "tok-c")
    #expect(on(world[1], one, a.e).0?.name == "E2")
    #expect(on(world[1], one, a.e).1 == "tok-e")
    #expect(on(world[1], one, a.f).1 == "tok-f")
    #expect(on(world[0], zero, a.e).0?.name == "E2")
    #expect(on(world[0], zero, a.b).1 == "tok-b2")

    // A is gone from device 1 with every device-only item, and stays gone.
    #expect(world[1].gatewayKeys.allSatisfy { !$0.hasSuffix(ids["1A"]!) })
    #expect(world.cloudRecord(a.a)?.isTombstone == true)
    #expect(try await world[1].kv(SyncJournal.storageKey) == nil)

    // Review A4: "Stop syncing" still reaches iCloud after its delete failed with the state saved.
    #expect(world.cloudRecord(a.f) == nil)

    // A credential device 1 received is never published under a new stamp of device 1.
    let zeroTag = try #require(world[0].secrets.items[SyncPrintKey.deviceKey])
    for address in [a.b, a.c] {
      let record = try #require(world.cloudRecord(address))
      #expect(record.registers[.sessionToken]?.stamp.d == zeroTag)
    }
    #expect(world.cloudRecord(a.b)?.registers[.headers]?.stamp.d == zeroTag)
    #expect(world.cloudRecord(a.e)?.registers[.sessionToken]?.stamp.d == world[1].secrets.items[SyncPrintKey.deviceKey])
  }

  @Test(arguments: cases)
  func aCrashAfterEachStepConvergesOnTheNextRun(_ test: Case) async throws {
    var (world, ids) = try await Self.scenario(test.conflict)

    await world[1].engine.setProbe(crash(after: test.step))
    let crashed = await world[1].reconcile()
    #expect(crashed == .failed(.other("interrupted after \(test.step)")))

    world[1].restart()
    await world.settle()
    try await Self.expectConverged(world, ids)
  }

  enum Fault: String, Sendable, CaseIterable {
    case credentialWrite
    case credentialDelete
    case remotePut
    case remoteDelete
  }

  @Test(arguments: Fault.allCases)
  func aStoreFailingInAStepConvergesOnTheNextRun(_ fault: Fault) async throws {
    let (world, ids) = try await Self.scenario(.newestWrite)

    switch fault {
    case .credentialWrite: world[1].secrets.fail(.set) { $0.contains("session_token") }
    case .credentialDelete: world[1].secrets.fail(.delete) { $0.contains("hermie.auth.") }
    case .remotePut: world.cloud.failNext(.put, on: "device1", with: .keychain(operation: .update, status: -34_018))
    case .remoteDelete: world.cloud.failNext(.delete, on: "device1", with: .keychain(operation: .delete, status: -34_018))
    }

    let first = await world[1].reconcile()
    switch fault {
    case .credentialWrite, .credentialDelete:
      #expect(first == .failed(.secretStore(.interactionNotAllowed)))
    case .remotePut, .remoteDelete:
      guard case .applied = first else {
        Issue.record("a remote failure stopped the plan: \(first)")
        return
      }
    }

    world[1].secrets.heal()
    await world.settle()
    try await Self.expectConverged(world, ids)
  }
}

/// The review's probe scenarios A–E, at engine level.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineProbeTests {
  /// A: a device loses its token and front door without signing out; the others keep theirs and
  /// it gets them back.
  @Test(arguments: conflictPolicies)
  func probeA(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)
    let keys = SecretKeys.Gateway(id: ids[1])
    try world[1].secrets.delete(keys.sessionToken)
    try world[1].secrets.delete(keys.frontDoor)
    world.advance(1_000)
    let writes = world.cloud.writes().count

    await world.settle()

    #expect(world.cloud.writes().count == writes)
    #expect(world[0].token(ids[0]) == "tok-1")
    #expect(world[0].frontDoor(ids[0]) != nil)
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(world[1].frontDoor(ids[1]) == world[0].frontDoor(ids[0]))
  }

  /// B: clocks 200 days off either way do not prune a fresh tombstone; 180 days of a correct
  /// clock later, it goes.
  @Test func probeB() async throws {
    let cloud = FakeCloud()
    let behind = try EngineDevice(name: "behind", cloud: cloud, clock: EngineClock(now: startOfTime - 200 * day))
    let ahead = try EngineDevice(name: "ahead", cloud: cloud, clock: EngineClock(now: startOfTime + 200 * day))
    let right = try EngineDevice(name: "right", cloud: cloud, clock: EngineClock(now: startOfTime))
    let devices = [behind, ahead, right]
    for device in devices { try await device.engine.disclose() }

    func settle() async {
      for _ in 0..<8 {
        cloud.deliverAll()
        for device in devices {
          await device.engine.waitUntilIdle()
          await device.reconcile()
          cloud.deliverAll()
        }
      }
    }

    let id = try await addGateway(behind, address: homeAddress)
    await settle()
    try await behind.engine.removeGateway(id: id, scope: .allDevices)
    await settle()

    let account = SyncedGatewayRecord.account(forKey: homeKey)
    let tombstone = cloud.cloudItems().first { $0.account == account }.flatMap {
      SyncedGatewayRecord.decode(account: $0.account, value: $0.value)
    }
    #expect(tombstone?.isTombstone == true)
    for device in devices { #expect(try await device.gateways().isEmpty) }

    ahead.clock.advance(1_000)
    await ahead.reconcile()
    #expect(cloud.cloudItems().count == 1)

    for device in devices { device.clock.advance(181 * day) }
    await right.reconcile()
    cloud.deliverAll()
    #expect(cloud.cloudItems().isEmpty)
  }

  /// C: a Mac that had the gateway before sync, with sync off, switches it on 30 days after a
  /// removal on all devices: it keeps its copy, device-only, and the removal stands.
  @Test func probeC() async throws {
    let world = try EngineWorld(2)
    try await world[1].engine.setSyncEnabled(false)
    try await world.discloseAll()

    // The Mac's gateway predates sync: written by hand, no "added here".
    let macId = GatewayRegistry.newGatewayId()
    try await GatewayRegistryStore(store: world[1].database).add(
      GatewayRecord(id: macId, name: "Home", address: homeAddress, authKind: .sessionToken, addedAt: startOfTime))
    try world[1].secrets.set(SecretKeys.Gateway(id: macId).sessionToken, "tok-mac")

    let phone = try await addGateway(world[0], address: homeAddress, token: "tok-phone")
    await world.settle()
    try await world[0].engine.removeGateway(id: phone, scope: .allDevices)
    await world.settle()

    world.advance(30 * day)
    try await world[1].engine.setSyncEnabled(true)
    await world.settle()

    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
    #expect(try await world[1].only().id == macId)
    #expect(world[1].token(macId) == "tok-mac")
    #expect(try await world[1].state()?.entries[macId]?.detached == .absent)
    #expect(try await world[0].gateways().isEmpty)
  }

  /// D: a device away for 181 days renames its stale copy of a gateway removed everywhere; it does
  /// not come back anywhere else.
  @Test func probeD() async throws {
    let (world, ids) = try await sharedWorld()

    world.cloud.hold("device1")
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world[0].reconcile()
    world.advance(181 * day)
    await world[0].reconcile()
    world.cloud.deliverAll()
    #expect(world.cloudRecord(homeAddress) == nil)

    try await GatewayRegistryStore(store: world[1].database).rename(id: ids[1], to: "Stale")
    await world[1].reconcile()
    world.cloud.release("device1")
    await world.settle()

    #expect(try await world[0].gateways().isEmpty)
    #expect(world.cloudRecord(homeAddress)?.isLive != true)
    #expect(try await world[1].only().id == ids[1])
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == .absent)
  }

  /// E: a crash between the purge and the clean-up of a removal that came from elsewhere; the key
  /// is not hidden, the device-only items go, and the gateway added again elsewhere comes back.
  @Test(arguments: [SyncApplyStep.willPurge, .localTransaction, .secrets])
  func probeE(step: SyncApplyStep) async throws {
    var (world, ids) = try await sharedWorld()
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world[0].reconcile()
    world.cloud.deliverAll()

    await world[1].engine.setProbe(crash(after: step))
    await world[1].reconcile()
    world[1].restart()
    await world[1].reconcile()

    #expect(try await world[1].gateways().isEmpty)
    #expect(world[1].gatewayKeys.isEmpty)
    #expect(try await world[1].state()?.hidden.isEmpty == true)

    world.advance(1_000)
    try await addGateway(world[0], address: homeAddress, name: "Again", token: "tok-again")
    await world.settle()
    let again = try await world[1].only()
    #expect(again.name == "Again")
    #expect(world[1].token(again.id) == "tok-again")
  }
}
