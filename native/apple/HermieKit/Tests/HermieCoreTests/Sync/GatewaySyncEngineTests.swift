import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

let homeAddress = "https://gateway.test"
let homeOrigin = GatewayAddress.origin(of: homeAddress)
let homeKey = GatewayKey.of(homeAddress)
let otherAddress = "https://other.test"

/// Two devices sharing one gateway with a token, a front door and headers, everything settled.
func sharedWorld(
  devices: Int = 2,
  conflict: FakeCloud.Conflict = .newestWrite
) async throws -> (EngineWorld, [String]) {
  let world = try EngineWorld(devices, conflict: conflict)
  try await world.discloseAll()
  try await addGateway(world[0], address: homeAddress, token: "tok-1", frontDoorSecret: "door-1", headers: ["X-Team": "blue"])
  await world[0].engine.waitUntilIdle()
  await world.settle()
  var ids: [String] = []
  for device in world.devices { ids.append(try await device.only().id) }
  return (world, ids)
}

/// The flows of I9 and the new-device flow, through engines sharing a `FakeCloud`.
@Suite(.timeLimit(.minutes(5))) struct GatewaySyncEngineFlowTests {
  @Test(arguments: conflictPolicies)
  func aNewDeviceListsRecordsBeforeTheDisclosureAndAdoptsThemAfterUseTheseGateways(conflict: FakeCloud.Conflict) async throws {
    let world = try EngineWorld(2, conflict: conflict)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-1", frontDoorSecret: "door-1", headers: ["X-Team": "blue"])
    await world[0].engine.waitUntilIdle()
    // The read-back that marks the item seen, then nothing more to do.
    await world[0].reconcile()
    #expect(await world[0].reconcile() == .upToDate)
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
    world.cloud.deliverAll()

    // Before the disclosure: reading is allowed, nothing is written.
    #expect(await world[1].reconcile() == .skipped(.notDisclosed))
    let offered = try await world[1].engine.adoptable()
    #expect(offered.map(\.address) == [homeAddress])
    #expect(offered.first?.hasSessionToken == true)
    #expect(offered.first?.hasFrontDoor == true)
    #expect(try await world[1].gateways().isEmpty)
    #expect(world.cloud.writes().allSatisfy { $0.device != "device1" })

    var events = world[1].engine.events.makeAsyncIterator()
    let outcome = try await world[1].engine.adopt(offered)
    guard case .applied = outcome else {
      Issue.record("adopting applied nothing: \(outcome)")
      return
    }

    let gateway = try await world[1].only()
    #expect(gateway.address == homeAddress)
    #expect(gateway.name == "Home")
    #expect(gateway.authKind == .sessionToken)
    #expect(world[1].token(gateway.id) == "tok-1")
    #expect(world[1].headers(gateway.id) == "{\"X-Team\":\"blue\"}")
    let door = GatewaySecrets.decodeFrontDoor(world[1].frontDoor(gateway.id), baseURL: homeAddress)
    #expect(door == .cloudflareAccess(.init(clientID: "client.access", clientSecret: "door-1", origin: homeOrigin)))
    let config = try await world[1].kv(SyncMaterializer.configKey(gateway.id))
    #expect(config?.contains("\"baseUrl\":\"https://gateway.test\"") == true)
    #expect(config?.contains("\"authMode\":\"session_token\"") == true)
    #expect(await events.next() == .adopted(gatewayId: gateway.id))
    #expect(try await world[1].registry().activeGatewayId == gateway.id)

    await world.settle()
    #expect(try await world[0].gateways().count == 1)
    #expect(try await world[1].gateways().count == 1)
  }

  @Test(arguments: conflictPolicies)
  func anAddARenameAndAnAddressChangeTravel(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    // Added on device 1, it reaches device 0.
    world.advance(1_000)
    try await addGateway(world[1], address: otherAddress, name: "Office", token: "tok-office")
    await world.settle()
    let office = try #require(try await world[0].gateways().first { $0.address == otherAddress })
    #expect(office.name == "Office")
    #expect(world[0].token(office.id) == "tok-office")

    // Renamed on device 0 outside the engine, it is renamed on device 1.
    world.advance(1_000)
    try await GatewayRegistryStore(store: world[0].database).rename(id: ids[0], to: "Renamed")
    await world.settle()
    #expect(try await world[1].registry().gateway(id: ids[1])?.name == "Renamed")

    // A new path at the same origin is a field edit; the credentials stay.
    world.advance(1_000)
    try await world[0].engine.changeAddress(of: ids[0], to: "https://gateway.test/hermes")
    await world.settle()
    #expect(try await world[1].registry().gateway(id: ids[1])?.address == "https://gateway.test/hermes")
    #expect(world[1].token(ids[1]) == "tok-1")

    // Another origin: the old credentials go at once here; elsewhere the old entry is purged and
    // the new one arrives without any credential of the old origin (I13).
    world.advance(1_000)
    let before = world[1].secrets.keys
    try await world[0].engine.changeAddress(of: ids[0], to: "https://moved.test")
    #expect(world[0].token(ids[0]) == nil)
    #expect(world[0].frontDoor(ids[0]) == nil)
    #expect(world[0].headers(ids[0]) == nil)
    await world.settle()

    let moved = try #require(try await world[1].gateways().first { $0.address == "https://moved.test" })
    #expect(try await world[1].registry().gateway(id: ids[1]) == nil)
    #expect(world[1].lifecycle.purged == [ids[1]])
    #expect(world[1].token(moved.id) == nil)
    #expect(world[1].frontDoor(moved.id) == nil)
    #expect(SecretKeys.Gateway(id: ids[1]).all.allSatisfy { !world[1].secrets.keys.contains($0) })
    #expect(before.contains(SecretKeys.Gateway(id: ids[1]).sessionToken))
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
    #expect(try await world[0].gateways().map(\.address).sorted() == ["https://moved.test", otherAddress])
  }

  @Test(arguments: conflictPolicies)
  func removingOnThisDeviceKeepsItElsewhereAndRemovingEverywherePurgesIt(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(devices: 3, conflict: conflict)

    try await world[1].engine.removeGateway(id: ids[1], scope: .thisDevice)
    #expect(try await world[1].gateways().isEmpty)
    #expect(world[1].gatewayKeys.isEmpty)
    await world.settle()
    #expect(try await world[1].gateways().isEmpty)
    #expect(try await world[0].gateways().count == 1)
    #expect(world.cloudRecord(homeAddress)?.isLive == true)

    var events = world[2].engine.events.makeAsyncIterator()
    world.advance(1_000)
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world.settle()

    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
    for device in world.devices {
      #expect(try await device.gateways().isEmpty)
      #expect(device.gatewayKeys.isEmpty)
    }
    #expect(world[2].lifecycle.purged == [ids[2]])
    #expect(await events.next() == .removedElsewhere(gatewayId: ids[2], name: "Home"))
  }

  @Test func removeFromAllDevicesIsRefusedForAGatewayThatIsNotSynced() async throws {
    let (world, ids) = try await sharedWorld()
    #expect(await world[1].status.gateways[ids[1]]?.canRemoveFromAllDevices == true)
    try await world[1].engine.setGatewaySynced(false, id: ids[1])
    await world.settle()

    await #expect(throws: SyncEngineError.notAttached) {
      try await world[1].engine.removeGateway(id: ids[1], scope: .allDevices)
    }
    #expect(await world[1].status.gateways[ids[1]]?.canRemoveFromAllDevices == false)
    // Its item is gone, so the other copy is device-only (absent) now, and not removable everywhere either.
    #expect(await world[0].status.gateways[ids[0]]?.canRemoveFromAllDevices == false)
  }

  @Test(arguments: conflictPolicies)
  func signingOutHereStaysHereAndSigningOutEverywhereReachesEveryDevice(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    try await world[1].engine.signOut(id: ids[1], scope: .thisDevice)
    #expect(world[1].token(ids[1]) == nil)
    await world.settle()
    #expect(world[1].token(ids[1]) == nil)
    #expect(await !world[1].engine.lastTraces.contains(.credentialRestored))
    #expect(world[0].token(ids[0]) == "tok-1")
    #expect(world.cloudRecord(homeAddress)?.sessionToken?.token == "tok-1")
    #expect(await world[1].status.gateways[ids[1]]?.signedOut == true)

    // Signed in again (here: "Use the Token from iCloud Keychain"), the token comes back.
    try await world[1].engine.signedIn(id: ids[1])
    await world.settle()
    #expect(world[1].token(ids[1]) == "tok-1")

    world.advance(1_000)
    try await world[0].engine.signOut(id: ids[0], scope: .allDevices)
    await world.settle()
    #expect(world[0].token(ids[0]) == nil)
    #expect(world[1].token(ids[1]) == nil)
    #expect(world.cloudRecord(homeAddress)?.registers[.sessionToken]?.value == .null)
    #expect(await !world[0].engine.lastTraces.contains(.credentialRestored))
    // Signed out here like any sign-out: this device's front door goes and is not put back; the
    // other device keeps its own, since nobody cleared it.
    #expect(world[0].frontDoor(ids[0]) == nil)
    #expect(world[1].frontDoor(ids[1]) != nil)
    #expect(try await world[0].state()?.entries[ids[0]]?.signedOut == true)
  }

  @Test(arguments: conflictPolicies)
  func stoppingSyncForOneGatewayDeletesItsItemAndOthersKeepTheirCopy(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    try await world[0].engine.setGatewaySynced(false, id: ids[0])
    await world.settle()

    #expect(world.cloudRecord(homeAddress) == nil)
    #expect(try await world[1].only().id == ids[1])
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(await world[1].status.gateways[ids[1]]?.state == .absent)
    #expect(await world[0].status.gateways[ids[0]]?.state == .deviceOnly(.switchedOff))

    // On again: published again (as on first sight); the other copy stays absent until resynced.
    try await world[0].engine.setGatewaySynced(true, id: ids[0])
    await world.settle()
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
    try await world[1].engine.resync(id: ids[1])
    await world.settle()
    #expect(await world[1].status.gateways[ids[1]]?.state == .synced)
  }

  @Test(arguments: conflictPolicies)
  func switchingSyncOffKeepsEverythingAndOnCatchesUp(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    try await world[1].engine.setSyncEnabled(false)
    #expect(await world[1].status.enabled == false)
    world.advance(1_000)
    try await GatewayRegistryStore(store: world[0].database).rename(id: ids[0], to: "Renamed")
    let outcomes = await world.settle()
    #expect(outcomes[1] == .skipped(.disabled))
    #expect(try await world[1].only().name == "Home")
    #expect(world[1].token(ids[1]) == "tok-1")

    try await world[1].engine.setSyncEnabled(true)
    await world.settle()
    #expect(try await world[1].only().name == "Renamed")
  }

  @Test(arguments: conflictPolicies)
  func deletingEverythingFromICloudKeepsEveryDevicesGateways(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    try await addGateway(world[0], address: otherAddress, name: "Office", token: "tok-office")
    await world.settle()
    #expect(try await world[0].state()?.tombstones.isEmpty == false)

    let putsBefore = world.cloud.writes().filter { $0.device == "device1" && $0.kind == .put }.count
    try await world[0].engine.deleteEverythingFromICloud()
    #expect(world.cloud.cloudItems().isEmpty)
    #expect(try await world[0].state()?.tombstones.isEmpty == true)

    // The deleting device keeps every gateway, absent, and its own next reconcile publishes none.
    let mine = try await world[0].only()
    #expect(mine.address == otherAddress)
    #expect(world[0].token(mine.id) == "tok-office")
    #expect(await world[0].status.gateways[mine.id]?.state == .absent)
    world.cloud.deliverAll()
    let writes = world.cloud.writes().filter { $0.device == "device0" }.count
    await world[0].reconcile()
    await world[0].reconcile()
    #expect(world.cloud.writes().filter { $0.device == "device0" }.count == writes)

    await world.settle()
    #expect(world.cloud.writes().filter { $0.device == "device0" }.count == writes)
    let office = try await world[1].only()
    #expect(office.address == otherAddress)
    #expect(world[1].token(office.id) == "tok-office")
    #expect(await world[1].status.gateways[office.id]?.state == .absent)

    // Device 1 read the empty store as "delete everything": nothing is written back, not even the
    // tombstone of the gateway removed earlier, which it still remembers.
    #expect(world.cloud.cloudItems().isEmpty)
    #expect(world.cloud.writes().filter { $0.device == "device1" && $0.kind == .put }.count == putsBefore)
  }

  @Test(arguments: conflictPolicies)
  func aDeviceThatLosesItsItemsKeepsItsGatewaysAndRejoins(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    world.cloud.wipeLocal("device1")
    let outcome = await world[1].reconcile()
    #expect(world.cloud.writes().filter { $0.device == "device1" && $0.kind == .delete }.isEmpty)
    guard case .applied = outcome else {
      Issue.record("expected the entry to go absent: \(outcome)")
      return
    }
    #expect(try await world[1].only().id == ids[1])
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(await world[1].status.gateways[ids[1]]?.state == .absent)

    world.cloud.rejoin("device1")
    await world.settle()
    #expect(await world[1].status.gateways[ids[1]]?.state == .synced)
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(world[0].token(ids[0]) == "tok-1")
  }

  @Test(arguments: conflictPolicies)
  func threeDevicesConvergeOnAddRenameAndRemoval(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(devices: 3, conflict: conflict)

    world.advance(1_000)
    try await GatewayRegistryStore(store: world[2].database).rename(id: ids[2], to: "From the Mac")
    try await addGateway(world[1], address: otherAddress, name: "Office", token: "tok-office")
    await world.settle()
    for device in world.devices {
      #expect(try await device.gateways().map(\.name).sorted() == ["From the Mac", "Office"])
    }

    world.advance(1_000)
    try await world[1].engine.removeGateway(id: ids[1], scope: .allDevices)
    await world.settle()
    for device in world.devices {
      #expect(try await device.gateways().map(\.name) == ["Office"])
      #expect(device.gatewayKeys.allSatisfy { !$0.hasSuffix(ids[0]) && !$0.hasSuffix(ids[1]) && !$0.hasSuffix(ids[2]) })
    }
  }
}
