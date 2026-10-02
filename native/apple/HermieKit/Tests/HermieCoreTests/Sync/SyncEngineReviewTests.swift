import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

let movedAddress = "https://moved.test"

/// One test (or more) per finding of the engine review.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineReviewTests {
  // MARK: 1. Intents in flight, and a purge of a gateway that moved

  /// The address change is half done (old credentials deleted, new address not yet committed)
  /// when a reconcile starts, with a removal on all devices waiting for the old origin. The
  /// reconcile waits for the intent, so it sees the new address and leaves the gateway alone.
  @Test func aReconcileStartedWhileAnIntentRunsWaitsForIt() async throws {
    let (world, ids) = try await sharedWorld()
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world[0].engine.waitUntilIdle()
    world.cloud.deliverAll()

    let gate = StepGate<SyncIntentStep>(at: .addressCommitted)
    await world[1].engine.setIntentProbe(gate.probe)
    let moving = Task { try await world[1].engine.changeAddress(of: ids[1], to: movedAddress) }
    await gate.reached()

    let reconciling = Task { await world[1].reconcile() }
    #expect(await eventually { await world[1].engine.waitingForIntents == 1 })
    gate.open()
    try await moving.value
    _ = await reconciling.value
    await world[1].engine.setIntentProbe(nil)

    // The person enters the token for the new origin.
    try world[1].secrets.set(SecretKeys.Gateway(id: ids[1]).sessionToken, "tok-new")
    await world.settle()

    let moved = try await world[1].only()
    #expect(moved.id == ids[1])
    #expect(moved.address == movedAddress)
    #expect(world[1].token(ids[1]) == "tok-new")
    #expect(world[1].lifecycle.purged.isEmpty)
  }

  /// The plan purges a gateway for a removal at its old key; while it waits in `willPurge` the
  /// address moves (here outside the engine). The purge is discarded with the plan.
  @Test func aPurgeOfAGatewayThatMovedSinceTheSnapshotIsDiscarded() async throws {
    let (world, ids) = try await sharedWorld()
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world[0].engine.waitUntilIdle()
    world.cloud.deliverAll()

    let gate = StepGate<SyncApplyStep>(at: .willPurge)
    await world[1].engine.setProbe(gate.probe)
    let reconciling = Task { await world[1].reconcile() }
    await gate.reached()
    try await GatewayRegistryStore(store: world[1].database).update { registry in
      registry.updating(id: ids[1]) { $0.address = movedAddress }
    }
    gate.open()
    _ = await reconciling.value
    await world[1].engine.setProbe(nil)
    await world.settle()

    #expect(try await world[1].only().address == movedAddress)
  }

  // MARK: 2. A damaged registry deletes nothing

  @Test(arguments: [
    "not json",
    "{\"v\":1,\"gateways\":[{\"id\":\"bad id\",\"address\":\"https://gateway.test\"}],\"activeGatewayId\":null}",
    "{\"v\":1,\"activeGatewayId\":null}"
  ])
  func aRegistryThatCannotBeReadWholeStopsEverythingAndDeletesNothing(text: String) async throws {
    let (world, _) = try await sharedWorld()
    let keys = world[1].secrets.items
    try await world[1].database.write { try $0.kvSet(text, forKey: StoreKeys.gateways) }

    #expect(await world[1].reconcile() == .failed(.unreadableRegistry))
    #expect(world[1].secrets.items == keys)
    await #expect(throws: SyncEngineError.unreadableRegistry) {
      try await addGateway(world[1], address: otherAddress)
    }
    #expect(world[1].secrets.items == keys)
    #expect(try await world[1].kv(StoreKeys.gateways) == text)
  }

  // MARK: 3. An address changed outside the engine

  /// Contract breach, defence in depth: the token and headers (no origin of their own) go, a
  /// front door already stored for the new origin stays.
  @Test func anAddressChangedOutsideTheEngineKeepsAFrontDoorStoredForTheNewOrigin() async throws {
    let (world, ids) = try await sharedWorld()
    let keys = SecretKeys.Gateway(id: ids[1])
    let door = GatewaySecrets.encodeFrontDoor(
      .cloudflareAccess(.init(clientID: "client.moved", clientSecret: "door-moved", origin: movedAddress)),
      baseURL: movedAddress)
    try await GatewayRegistryStore(store: world[1].database).update { registry in
      registry.updating(id: ids[1]) { $0.address = movedAddress }
    }
    try world[1].secrets.set(keys.frontDoor, try #require(door))

    await world[1].reconcile()

    #expect(world[1].frontDoor(ids[1]) == door)
    #expect(world[1].token(ids[1]) == nil)
    #expect(world[1].headers(ids[1]) == nil)
  }

  // MARK: 4. The share-delivery hook

  @Test func theShareDeliveryHookHearsOfAdoptedPurgedAndMovedGateways() async throws {
    let world = try EngineWorld(2)
    let recorder = HookRecorder()
    await world[1].engine.setCredentialsChangedHandler(recorder.handler)
    try await world.discloseAll()
    let home = try await addGateway(world[0], address: homeAddress)
    let office = try await addGateway(world[0], address: otherAddress, name: "Office")
    await world.settle()

    let adopted = try await world[1].gateways()
    #expect(Set(recorder.calls) == Set(adopted.map(\.id)))
    let homeHere = try #require(adopted.first { $0.address == homeAddress }).id
    let officeHere = try #require(adopted.first { $0.address == otherAddress }).id

    // A purge cut short after its transaction: the next run deletes the items and says so.
    try await world[0].engine.removeGateway(id: home, scope: .allDevices)
    await world[0].engine.waitUntilIdle()
    world.cloud.deliverAll()
    await world[1].engine.setProbe(crash(after: SyncApplyStep.localTransaction))
    await world[1].reconcile()
    var restarted = world
    restarted[1].restart()
    let after = HookRecorder()
    await restarted[1].engine.setCredentialsChangedHandler(after.handler)
    await restarted[1].reconcile()
    #expect(after.calls == [homeHere])
    #expect(restarted[1].gatewayKeys.allSatisfy { !$0.hasSuffix(homeHere) })

    // An address moved outside the engine: the old origin's credentials go, and the hook hears it.
    try await GatewayRegistryStore(store: restarted[1].database).update { registry in
      registry.updating(id: officeHere) { $0.address = movedAddress }
    }
    await restarted[1].reconcile()
    #expect(after.calls.last == officeHere)
    #expect(restarted[1].token(officeHere) == nil)
    _ = office
  }

  // MARK: 5. Crashes on the device that entered the credential, and inside intents

  struct EnteredCase: Sendable, CustomTestStringConvertible {
    let step: SyncApplyStep
    let conflict: FakeCloud.Conflict
    var testDescription: String { "\(step), \(conflict)" }
  }

  static let enteredCases = SyncApplyStep.allCases.flatMap { step in
    conflictPolicies.map { EnteredCase(step: step, conflict: $0) }
  }

  /// Device 0 enters a new token for a gateway and adds another; its reconcile dies after each
  /// step. After a restart everything arrives on device 1, stamped by device 0, exactly once.
  @Test(arguments: enteredCases)
  func aCrashOnTheDeviceThatEnteredTheCredentialConverges(_ test: EnteredCase) async throws {
    var (world, ids) = try await sharedWorld(conflict: test.conflict)
    world.advance(1_000)

    await world[0].engine.setProbe(crash(after: test.step))
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).sessionToken, "tok-entered")
    let added = try await addGateway(world[0], address: otherAddress, name: "Office", token: "tok-office")
    await world[0].engine.waitUntilIdle()
    world[0].restart()
    await world.settle()

    let tag = try #require(world[0].secrets.items[SyncPrintKey.deviceKey])
    #expect(world[0].token(ids[0]) == "tok-entered")
    #expect(world[1].token(ids[1]) == "tok-entered")
    #expect(world.cloudRecord(homeAddress)?.registers[.sessionToken]?.stamp.d == tag)
    #expect(world.cloudRecord(otherAddress)?.registers[.sessionToken]?.stamp.d == tag)
    #expect(try await world[0].gateways().map(\.id).sorted() == [ids[0], added].sorted())
    let office = try #require(try await world[1].gateways().first { $0.address == otherAddress })
    #expect(world[1].token(office.id) == "tok-office")
    #expect(try await world[1].gateways().count == 2)
  }

  @Test func aCrashInsideRemoveIsFinishedByTheNextRun() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.removeCommitted))
    await #expect(throws: Crash.self) {
      try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    }
    #expect(world[0].token(ids[0]) == "tok-1")

    world[0].restart()
    let recorder = HookRecorder()
    await world[0].engine.setCredentialsChangedHandler(recorder.handler)
    await world.settle()

    #expect(world[0].gatewayKeys.isEmpty)
    #expect(recorder.calls == [ids[0]])
    #expect(try await world[1].gateways().isEmpty)
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
  }

  @Test func aCrashInsideSignOutIsFinishedByTheNextRun() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.signOutCommitted))
    await #expect(throws: Crash.self) {
      try await world[0].engine.signOut(id: ids[0], scope: .thisDevice)
    }
    #expect(world[0].token(ids[0]) == "tok-1")

    world[0].restart()
    await world.settle()

    #expect(world[0].token(ids[0]) == nil)
    #expect(world[0].frontDoor(ids[0]) == nil)
    #expect(try await world[0].state()?.entries[ids[0]]?.signedOut == true)
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(try await world[0].kv(SyncJournal.storageKey) == nil)
  }

  /// Dead between committing the new address and deleting the old origin's credentials: the
  /// credentials are still bound to the old origin, so the next run's clean-up deletes them before
  /// anything is read; nothing of the old origin ever reaches the new one, here or elsewhere.
  @Test func aCrashInsideChangeAddressIsFinishedByTheNextRun() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.addressCommitted))
    await #expect(throws: Crash.self) {
      try await world[0].engine.changeAddress(of: ids[0], to: movedAddress)
    }
    #expect(try await world[0].only().address == movedAddress)
    #expect(world[0].token(ids[0]) == "tok-1")

    world[0].restart()
    let recorder = HookRecorder()
    await world[0].engine.setCredentialsChangedHandler(recorder.handler)
    await world.settle()

    #expect(try await world[0].only().address == movedAddress)
    #expect(world[0].token(ids[0]) == nil)
    #expect(world[0].frontDoor(ids[0]) == nil)
    #expect(world[0].headers(ids[0]) == nil)
    #expect(try await world[0].kv(SyncMaterializer.credentialOriginKey(ids[0])) == GatewayAddress.origin(of: movedAddress))
    #expect(recorder.calls.first == ids[0])

    let moved = try await world[1].only()
    #expect(moved.address == movedAddress)
    #expect(world[1].token(moved.id) == nil)
    #expect(world[1].frontDoor(moved.id) == nil)
    #expect(world[1].gatewayKeys.allSatisfy { !$0.hasSuffix(ids[1]) })
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
    #expect(world.cloudRecord(movedAddress)?.registers[.sessionToken] == nil)
    #expect(world.cloudRecord(movedAddress)?.registers[.frontDoor] == nil)
  }

  // MARK: 5. Cleartext front doors and the developer notes

  @Test func aCleartextGatewayNeverReceivesAFrontDoor() async throws {
    let world = try EngineWorld(2)
    try await world.discloseAll()
    let plain = "http://plain.test"
    try await addGateway(world[0], address: plain, frontDoorSecret: "door-plain")
    await world.settle()

    // A record written by something else, with a front door bound to a cleartext origin.
    let raw = "http://raw.test"
    var record = SyncedGatewayRecord(key: GatewayKey.of(raw))
    let stamp = SyncStamp(t: startOfTime, d: "0badc0de")
    record.registers[.address] = SyncRegister(value: .string(raw), stamp: stamp)
    record.registers[.name] = SyncRegister(value: .string("Raw"), stamp: stamp)
    record.registers[.authKind] = SyncRegister(value: .string("session_token"), stamp: stamp)
    record.registers[.frontDoor] = SyncRegister(
      value: .object([
        "origin": .string(GatewayAddress.origin(of: raw)), "kind": .string(SyncFrontDoor.cloudflareAccess),
        "clientId": .string("client.raw"), "clientSecret": .string("door-raw")
      ]),
      stamp: stamp)
    try world.cloud.replica("intruder").put(SyncedItem(account: record.account, value: try record.encoded()))
    await world.settle()

    #expect(world.cloudRecord(plain)?.registers[.frontDoor] == nil)
    let adopted = try await world[1].gateways()
    #expect(Set(adopted.map(\.address)) == [plain, raw])
    for gateway in adopted {
      #expect(world[1].frontDoor(gateway.id) == nil)
    }
  }

  @Test func restoredCredentialsAndHeadersKeptHereAreDeveloperNotesOnly() async throws {
    let world = try EngineWorld(2)
    try await world.discloseAll()
    var events = world[1].engine.events.makeAsyncIterator()
    let big = String(repeating: "a", count: 9_000)
    let id = try await addGateway(world[0], address: homeAddress, headers: ["X-Big": big])
    await world.settle()
    #expect(await world[0].status.developerNotes.contains("headersNotSynced(\(id))"))

    let other = try await world[1].only()
    try world[1].secrets.delete(SecretKeys.Gateway(id: other.id).sessionToken)
    await world.settle()
    #expect(world[1].token(other.id) == "tok-1")
    #expect(await world[1].status.developerNotes.contains { $0.hasPrefix("credentialRestored(\(other.id)") })

    // The UI hears neither: up to the next "unavailable", device 1 announced its adoption only.
    world.cloud.setAvailability(.unavailable, on: "device1")
    await world[1].reconcile()
    var heard: [SyncNotice] = []
    while let notice = await events.next(), notice != .unavailable { heard.append(notice) }
    #expect(heard == [.adopted(gatewayId: other.id)])
  }

  // MARK: 6 is in the flow tests. Optional 8: an unreadable item is reported once, never restored

  @Test func anUnreadableLocalItemIsReportedOnceAndTheMergeStopsProposingIt() async throws {
    let (world, ids) = try await sharedWorld()
    let foreign = "{\"kind\":\"something-newer\",\"origin\":\"https://gateway.test\"}"
    try world[1].secrets.set(SecretKeys.Gateway(id: ids[1]).frontDoor, foreign)

    await world.settle()
    #expect(await world[1].reconcile() == .upToDate)
    #expect(world[1].frontDoor(ids[1]) == foreign)
    #expect(world[0].frontDoor(ids[0]) != nil)
    #expect(await world[1].status.developerNotes.filter { $0.hasPrefix("unreadable(") }.count == 1)
  }
}
