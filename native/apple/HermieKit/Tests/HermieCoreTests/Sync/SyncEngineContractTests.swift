import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// The engine against the merge's third-round contract: an empty store is "delete everything",
/// so a read error must never pass for one; sync off still saves the scrubbed intents; a resync
/// survives a restart; one local op per gateway.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineContractTests {
  // MARK: A read error is not an empty store

  @Test(arguments: [
    SecretStoreError.interactionNotAllowed, .missingEntitlement, .keychain(operation: .list, status: -25_308)
  ])
  func aStoreListingThatFailsChangesNothing(error: SecretStoreError) async throws {
    let (world, ids) = try await sharedWorld()
    let state = try await world[1].kv(SyncState.storageKey)
    let writes = world.cloud.writes().count

    world.cloud.failNext(.all, on: "device1", with: error)
    #expect(await world[1].reconcile() == .failed(.syncedStore(error)))

    #expect(try await world[1].kv(SyncState.storageKey) == state)
    #expect(world.cloud.writes().count == writes)
    #expect(await world[1].status.gateways[ids[1]]?.state == .synced)
    #expect(await !world[1].engine.lastTraces.contains(.deletedEverything))
  }

  /// The store answers with nothing because it became unavailable while it was read: a failed
  /// read, not "Delete everything".
  @Test func aStoreThatVanishesDuringTheReadIsAFailureNotAnEmptyStore() async throws {
    var (world, ids) = try await sharedWorld()
    let state = try await world[1].kv(SyncState.storageKey)
    let writes = world.cloud.writes().count

    world[1].engine = world[1].engine(on: VanishingStore(replica: world[1].store))
    #expect(await world[1].reconcile() == .failed(.storeUnavailable))

    #expect(try await world[1].kv(SyncState.storageKey) == state)
    #expect(world.cloud.writes().count == writes)
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == nil)

    // Back, and read whole: still synced, nothing was deleted anywhere.
    world.cloud.setAvailability(.available, on: "device1")
    world[1].restart()
    await world.settle()
    #expect(await world[1].status.gateways[ids[1]]?.state == .synced)
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
  }

  /// And the other direction: a store that is really empty is read as empty.
  @Test func anEmptyStoreReadWithoutAnErrorIsDeleteEverything() async throws {
    let (world, ids) = try await sharedWorld()
    let other = world.cloud.replica("other")
    world.cloud.deliverAll()
    try other.delete(account: SyncedGatewayRecord.account(forKey: homeKey))
    world.cloud.deliverAll()
    #expect(world[1].store.availability() == .available)
    #expect(try world[1].store.all().isEmpty)

    guard case .applied = await world[1].reconcile() else {
      Issue.record("an empty store changed nothing")
      return
    }
    #expect(await world[1].engine.lastTraces.contains(.deletedEverything))
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == .absent)
    #expect(world[1].token(ids[1]) == "tok-1")
  }

  @Test func theRunThatFindsTheStoreEmptiedTellsTheUIOnce() async throws {
    let (world, ids) = try await sharedWorld()
    var events = world[1].engine.events.makeAsyncIterator()
    let other = world.cloud.replica("other")
    world.cloud.deliverAll()
    try other.delete(account: SyncedGatewayRecord.account(forKey: homeKey))
    world.cloud.deliverAll()

    await world[1].reconcile()
    await world[1].reconcile()
    world.cloud.setAvailability(.unavailable, on: "device1")
    await world[1].reconcile()

    var heard: [SyncNotice] = []
    while let notice = await events.next(), notice != .unavailable { heard.append(notice) }
    #expect(heard == [.storeEmptied(gatewayIds: [ids[1]])])
  }

  // MARK: Push secrets belong to the push registrar

  /// Whatever removes a gateway here, its push manage secret stays for the registrar, which
  /// still has to unregister at the relay.
  @Test(arguments: ["thisDevice", "remoteTombstone", "orphanSweep", "crashedRemove"])
  func aPurgeLeavesThePushSecretsAlone(path: String) async throws {
    var (world, ids) = try await sharedWorld()
    let push = SecretKeys.Gateway(id: ids[1]).pushManage
    try world[1].secrets.set(push, "manage-1")

    switch path {
    case "thisDevice":
      try await world[1].engine.removeGateway(id: ids[1], scope: .thisDevice)
    case "remoteTombstone":
      try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    case "orphanSweep":
      // Gone from the list behind the engine's back: the sweep deletes what the state knew of.
      try await GatewayRegistryStore(store: world[1].database).remove(id: ids[1])
    default:
      await world[1].engine.setIntentProbe(crash(after: SyncIntentStep.removeCommitted))
      await #expect(throws: Crash.self) { try await world[1].engine.removeGateway(id: ids[1], scope: .thisDevice) }
      world[1].restart()
    }
    await world.settle()

    #expect(try await world[1].gateways().isEmpty)
    #expect(SecretKeys.Gateway(id: ids[1]).credentials.allSatisfy { world[1].secrets.items[$0] == nil })
    #expect(world[1].secrets.items[push] == "manage-1")
  }

  /// After a reinstall the earlier install's credentials go, its push secrets do not.
  @Test func theReinstallCleanUpLeavesThePushSecretsAlone() async throws {
    let cloud = FakeCloud()
    let first = try EngineDevice(name: "phone", cloud: cloud)
    try await first.engine.disclose()
    let id = try await addGateway(first, address: homeAddress)
    await first.engine.waitUntilIdle()
    let push = SecretKeys.Gateway(id: id).pushManage
    try first.secrets.set(push, "manage-1")

    let second = EngineDevice(reinstalling: first)
    await second.reconcile()
    #expect(second.token(id) == nil)
    #expect(second.secrets.items[push] == "manage-1")
  }

  // MARK: Sync off still saves what the merge scrubbed

  @Test func aReconcileWithSyncOffSavesTheScrubbedIntentsAndTouchesNoICloud() async throws {
    let (world, ids) = try await sharedWorld()
    var state = try #require(try await world[1].state())
    state.markClearing(.sessionToken, gatewayId: ids[1], key: homeKey)
    state.entries[ids[1]]!.removal = .allDevices
    // A state saved with sync off but intents still in it (by an older build, say).
    let text = try state.encoded().replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false")
    try await world[1].database.write { try $0.kvSet(text, forKey: SyncState.storageKey) }
    let writes = world.cloud.writes().count
    world.cloud.failNext(.all, on: "device1", with: .interactionNotAllowed)

    #expect(await world[1].reconcile() == .skipped(.disabled))

    let saved = try #require(try await world[1].state())
    #expect(saved.enabled == false)
    #expect(saved.entries[ids[1]]?.clearing.isEmpty == true)
    #expect(saved.entries[ids[1]]?.removal == .thisDevice)
    #expect(world.cloud.writes().count == writes)
    // iCloud was not even listed: the failure set up above is still waiting.
    #expect(throws: SecretStoreError.interactionNotAllowed) { try world[1].store.all() }
  }

  // MARK: Republish survives a restart

  @Test func aResyncSurvivesARestartBeforeTheNextReconcile() async throws {
    var (world, ids) = try await sharedWorld()
    let zeroTag = try #require(world[0].secrets.items[SyncPrintKey.deviceKey])
    let oneTag = try #require(world[1].secrets.items[SyncPrintKey.deviceKey])
    #expect(world.cloudRecord(homeAddress)?.registers[.address]?.stamp.d == zeroTag)

    // Device 0 stops syncing it: the item goes and device 1 keeps its copy, absent.
    try await world[0].engine.setGatewaySynced(false, id: ids[0])
    await world.settle()
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == .absent)

    // "Resync" on device 1; the process dies before the reconcile it asked for gets anywhere.
    await world[1].engine.setProbe(crash(after: SyncApplyStep.willPurge))
    try await world[1].engine.resync(id: ids[1])
    await world[1].engine.waitUntilIdle()
    #expect(try await world[1].state()?.entries[ids[1]]?.republish == true)

    world[1].restart()
    world.advance(1_000)
    await world.settle()

    #expect(try await world[1].state()?.entries[ids[1]]?.republish == false)
    let record = try #require(world.cloudRecord(homeAddress))
    #expect(record.isLive)
    #expect(record.registers[.address]?.stamp.d == oneTag)
    #expect(await world[1].status.gateways[ids[1]]?.state == .synced)
  }

  // MARK: One local op per gateway

  @Test func aPlanWithTwoOpsForOneGatewayIsRefused() throws {
    let gateway = LocalGateway(id: "g0011", name: "Home", address: homeAddress, authKind: "session_token", addedAt: 0)
    var plan = SyncPlan(state: SyncState(device: "a1b2c3d4"))
    plan.localOps = [.update(gateway, fields: [.name]), .update(gateway, fields: [.sessionToken])]
    #expect(throws: SyncEngineError.invalidPlan) { try GatewaySyncEngine.validate(plan) }

    plan.localOps = [.update(gateway, fields: [.name]), .purge(gatewayId: gateway.id)]
    #expect(throws: SyncEngineError.invalidPlan) { try GatewaySyncEngine.validate(plan) }

    plan.localOps = [.update(gateway, fields: [.name, .sessionToken])]
    try GatewaySyncEngine.validate(plan)
  }

  /// Through the engine: every plan of a scenario with adds, updates, purges and a move to
  /// another origin had one op per gateway.
  @Test func everyPlanTheEngineAppliedHadOneOpPerGateway() async throws {
    let (world, ids) = try await sharedWorld(devices: 3)
    world.advance(1_000)
    try await addGateway(world[1], address: otherAddress, name: "Office", token: "tok-office")
    try await GatewayRegistryStore(store: world[2].database).rename(id: ids[2], to: "Renamed")
    try world[2].secrets.set(SecretKeys.Gateway(id: ids[2]).sessionToken, "tok-2")
    await world.settle()
    try await world[0].engine.changeAddress(of: ids[0], to: movedAddress)
    await world.settle()
    let office = try #require(try await world[0].gateways().first { $0.address == otherAddress })
    try await world[0].engine.removeGateway(id: office.id, scope: .allDevices)
    await world.settle()

    var plans = 0
    for device in world.devices {
      for ops in await device.engine.opLog {
        plans += 1
        #expect(Set(ops).count == ops.count)
      }
    }
    #expect(plans > 6)
    for device in world.devices {
      #expect(try await device.gateways().map(\.address) == [movedAddress])
    }
  }

  // MARK: A tombstone rewrite that died before iCloud is not spent

  @Test func aTombstoneRewriteCutShortBeforeICloudIsNotCounted() async throws {
    var world = try EngineWorld(1)
    try await world.discloseAll()
    let id = try await addGateway(world[0], address: homeAddress)
    await world.settle()
    try await world[0].engine.removeGateway(id: id, scope: .allDevices)
    await world.settle()
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)

    // The tombstone vanishes (another device's racing delete).
    let other = world.cloud.replica("other")
    world.cloud.deliverAll()
    try other.delete(account: SyncedGatewayRecord.account(forKey: homeKey))
    world.cloud.deliverAll()
    #expect(world.cloudRecord(homeAddress) == nil)

    for _ in 0..<4 {
      await world[0].engine.setProbe(crash(after: SyncApplyStep.secrets))
      #expect(await world[0].reconcile() == .failed(.other("interrupted after secrets")))
      world[0].restart()
      #expect(try await world[0].state()?.tombstones[homeKey]?.rewrites == 0)
    }

    await world[0].reconcile()
    world.cloud.deliverAll()
    #expect(try await world[0].state()?.tombstones[homeKey]?.rewrites == 1)
    #expect(world.cloudRecord(homeAddress)?.isTombstone == true)
  }
}
