import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// Intents racing reconciles, cut short by crashes, and credentials entered again afterwards.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineIntentTests {
  /// A reconcile holding a same-origin address update from elsewhere is parked before its
  /// transaction while the person moves the gateway to another origin. The move stands, the
  /// parked plan is discarded, nothing throws.
  @Test func anAddressMoveRacingAParkedAddressUpdateStands() async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)
    try await world[0].engine.changeAddress(of: ids[0], to: "https://gateway.test/hermes")
    await world[0].engine.waitUntilIdle()
    world.cloud.deliverAll()

    let gate = StepGate<SyncApplyStep>(at: .willPurge)
    await world[1].engine.setProbe(gate.probe)
    let reconciling = Task { await world[1].reconcile() }
    await gate.reached()

    try await world[1].engine.changeAddress(of: ids[1], to: movedAddress)
    gate.open()
    _ = await reconciling.value
    await world[1].engine.setProbe(nil)
    await world.settle()

    #expect(try await world[1].only().address == movedAddress)
    #expect(world[1].token(ids[1]) == nil)
    #expect(try await world[0].gateways().map(\.address).contains(movedAddress))
  }

  @Test func aFrontDoorEnteredAgainAfterACrashedClearIsKeptAndPublished() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.clearCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.clear(.frontDoor, of: ids[0]) }
    #expect(world[0].frontDoor(ids[0]) != nil)

    // Settings enters a new front door after the restart, before any reconcile.
    world[0].restart()
    try await world[0].engine.storeCredential(.frontDoor(clientID: "client.access", clientSecret: "door-2"), of: ids[0])
    let door = try #require(
      GatewaySecrets.encodeFrontDoor(
        .cloudflareAccess(.init(clientID: "client.access", clientSecret: "door-2", origin: homeOrigin)),
        baseURL: homeAddress))
    #expect(world[0].frontDoor(ids[0]) == door)
    world.advance(1_000)
    await world.settle()

    #expect(world[0].frontDoor(ids[0]) == door)
    #expect(world[1].frontDoor(ids[1]) == door)
    #expect(try await world[0].state()?.entries[ids[0]]?.clearing.isEmpty == true)
    #expect(try await world[0].kv(SyncJournal.storageKey) == nil)
  }

  @Test func aFrontDoorEnteredAgainWithoutTellingTheEngineIsStillNotDeleted() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.clearCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.clear(.frontDoor, of: ids[0]) }

    world[0].restart()
    let door = try #require(
      GatewaySecrets.encodeFrontDoor(
        .cloudflareAccess(.init(clientID: "client.access", clientSecret: "door-3", origin: homeOrigin)),
        baseURL: homeAddress))
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).frontDoor, door)
    await world[0].reconcile()

    #expect(world[0].frontDoor(ids[0]) == door)
    #expect(try await world[0].kv(SyncJournal.storageKey) == nil)
  }

  @Test func tokensStoredAfterACrashedSignOutAreKept() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.signOutCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.signOut(id: ids[0], scope: .thisDevice) }
    #expect(world[0].token(ids[0]) == "tok-1")

    // The sign-in flow stores the new token through the engine.
    world[0].restart()
    try await world[0].engine.storeCredential(.sessionToken("tok-new"), of: ids[0])
    world.advance(1_000)
    await world.settle()

    #expect(world[0].token(ids[0]) == "tok-new")
    #expect(world[1].token(ids[1]) == "tok-new")
    #expect(try await world[0].state()?.entries[ids[0]]?.signedOut == false)
  }

  @Test func aTokenStoredAfterACrashedSignOutWithoutSignedInIsNotDeleted() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.signOutCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.signOut(id: ids[0], scope: .thisDevice) }

    world[0].restart()
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).sessionToken, "tok-new")
    await world[0].reconcile()

    #expect(world[0].token(ids[0]) == "tok-new")
    #expect(world[0].frontDoor(ids[0]) == nil)
  }

  @Test(arguments: conflictPolicies)
  func deleteEverythingThatFailsHalfwayIsFinishedByTheNextReconcile(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)
    try await addGateway(world[0], address: otherAddress, name: "Office", token: "tok-office")
    await world.settle()
    #expect(world.cloud.cloudItems().count == 2)

    world.cloud.failNext(.delete, on: "device0", with: .keychain(operation: .delete, status: -34_018))
    await #expect(throws: SyncEngineError.self) { try await world[0].engine.deleteEverythingFromICloud() }
    #expect(!world.cloud.cloudItems().isEmpty)
    #expect(try await world[0].kv(SyncJournal.storageKey) != nil)

    await world[0].reconcile()
    #expect(world.cloud.cloudItems().isEmpty)
    #expect(try await world[0].kv(SyncJournal.storageKey) == nil)
    await world.settle()

    #expect(world.cloud.cloudItems().isEmpty)
    for device in world.devices {
      #expect(try await device.gateways().count == 2)
      for gateway in try await device.gateways() {
        #expect(await device.status.gateways[gateway.id]?.state == .absent)
      }
    }
    #expect(world[1].token(ids[1]) == "tok-1")
  }

  /// Review finding 4 (engine side of the merge's `addedHere` rule): a gateway added while sync
  /// was off, then removed on all devices elsewhere, stays device-only when sync comes on.
  @Test func aGatewayAddedWithSyncOffStaysDeviceOnlyAfterARemovalElsewhere() async throws {
    let world = try EngineWorld(2)
    try await world.discloseAll()
    try await world[0].engine.setSyncEnabled(false)
    let phone = try await addGateway(world[1], address: homeAddress, token: "tok-phone")
    await world.settle()
    #expect(try await world[0].gateways().isEmpty)

    world.advance(1_000)
    let mac = try await addGateway(world[0], address: homeAddress, token: "tok-mac")
    #expect(try await world[0].state()?.entries[mac]?.addedHere == true)

    world.advance(1_000)
    try await world[1].engine.removeGateway(id: phone, scope: .allDevices)
    await world.settle()

    world.advance(1_000)
    try await world[0].engine.setSyncEnabled(true)
    await world.settle()

    #expect(try await world[0].only().id == mac)
    #expect(world[0].token(mac) == "tok-mac")
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
    #expect(try await world[1].gateways().isEmpty)
    #expect(try await world[0].state()?.entries[mac]?.detached == .absent)
    #expect(await !world[0].engine.lastTraces.contains(.readded))
  }
}
