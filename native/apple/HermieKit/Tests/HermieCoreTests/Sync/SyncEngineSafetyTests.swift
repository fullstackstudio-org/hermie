import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// What the engine must never do: reconcile on a partial or empty-by-mistake snapshot, overwrite
/// an intent, bring back a credential that was removed on purpose, leak a value, or touch more
/// device-only items than a removal names.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineSafetyTests {
  // MARK: Partial snapshots and unavailable stores

  @Test func aCredentialThatCannotBeReadStopsTheReconcileAndNothingIsWritten() async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)
    try await GatewayRegistryStore(store: world[0].database).rename(id: ids[0], to: "Renamed")
    await world[0].reconcile()
    world.cloud.deliverAll()

    let stateBefore = try await world[1].kv(SyncState.storageKey)
    let writesBefore = world.cloud.writes().count
    let token = SecretKeys.Gateway(id: ids[1]).sessionToken
    world[1].secrets.fail(.get, with: .interactionNotAllowed, sticky: true) { $0 == token }

    #expect(await world[1].reconcile() == .failed(.secretStore(.interactionNotAllowed)))
    #expect(try await world[1].kv(SyncState.storageKey) == stateBefore)
    #expect(try await world[1].only().name == "Home")
    #expect(world.cloud.writes().count == writesBefore)

    world[1].secrets.heal()
    await world.settle()
    #expect(try await world[1].only().name == "Renamed")
  }

  @Test func aPrintKeyThatCannotBeReadStopsTheReconcileAndIsNotReplaced() async throws {
    let (world, _) = try await sharedWorld()
    let key = world[1].secrets.items[SyncPrintKey.storageKey]
    #expect(key != nil)

    world[1].secrets.fail(.get, with: .interactionNotAllowed) { $0 == SyncPrintKey.storageKey }
    #expect(await world[1].reconcile() == .failed(.secretStore(.interactionNotAllowed)))
    #expect(world[1].secrets.items[SyncPrintKey.storageKey] == key)
  }

  @Test func anUnavailableStoreIsNotReconciledAndSaysSo() async throws {
    let (world, ids) = try await sharedWorld()
    let stateBefore = try await world[1].kv(SyncState.storageKey)
    var events = world[1].engine.events.makeAsyncIterator()

    world.cloud.setAvailability(.unavailable, on: "device1")
    #expect(await world[1].reconcile() == .skipped(.unavailable))
    #expect(await world[1].status.availability == .unavailable)
    #expect(await events.next() == .unavailable)
    #expect(try await world[1].kv(SyncState.storageKey) == stateBefore)
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == nil)
    await #expect(throws: SyncEngineError.storeUnavailable) { try await world[1].engine.adoptable() }

    world.cloud.setAvailability(.available, on: "device1")
    await world.settle()
    #expect(await world[1].status.availability == .available)
  }

  @Test func aStoreListingThatFailsMarksNothingAbsent() async throws {
    let (world, ids) = try await sharedWorld()
    let stateBefore = try await world[1].kv(SyncState.storageKey)

    world.cloud.failNext(.all, on: "device1", with: .keychain(operation: .list, status: -25_300))
    #expect(await world[1].reconcile() == .failed(.syncedStore(.keychain(operation: .list, status: -25_300))))
    #expect(try await world[1].kv(SyncState.storageKey) == stateBefore)
    #expect(try await world[1].state()?.entries[ids[1]]?.detached == nil)
  }

  // MARK: Intents and in-flight reconciles

  /// The plan is held after `willPurge` (before its transaction); the person switches "Sync this
  /// gateway" off meanwhile. The plan (which would have applied the rename) is thrown away, the
  /// switch survives, and the plan made after it deletes the item instead.
  @Test func anIntentRecordedBeforeThePlanCommitsSurvivesIt() async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)
    try await GatewayRegistryStore(store: world[0].database).rename(id: ids[0], to: "Renamed")
    await world[0].reconcile()
    world.cloud.deliverAll()

    let gate = StepGate<SyncApplyStep>(at: .willPurge)
    await world[1].engine.setProbe(gate.probe)
    let running = Task { await world[1].reconcile() }
    await gate.reached()

    try await world[1].engine.setGatewaySynced(false, id: ids[1])
    gate.open()
    _ = await running.value
    await world[1].engine.setProbe(nil)

    #expect(try await world[1].state()?.entries[ids[1]]?.detached == .user)
    #expect(try await world[1].only().name == "Home")
    #expect(world.cloud.writes().last == FakeCloud.Write(device: "device1", account: SyncedGatewayRecord.account(forKey: homeKey), kind: .delete))
  }

  /// The plan's transaction (which writes the new token's print) has committed, and is held before
  /// the credentials are written; the person signs out here meanwhile. The token is not written
  /// back, and the sign-out stays.
  @Test func aSignOutWhileAPlanIsBetweenItsTransactionAndItsCredentialsIsNotUndone() async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).sessionToken, "tok-2")
    await world[0].reconcile()
    world.cloud.deliverAll()

    let gate = StepGate<SyncApplyStep>(at: .localTransaction)
    await world[1].engine.setProbe(gate.probe)
    let running = Task { await world[1].reconcile() }
    await gate.reached()

    try await world[1].engine.signOut(id: ids[1], scope: .thisDevice)
    gate.open()
    _ = await running.value
    await world[1].engine.setProbe(nil)
    await world.settle()

    #expect(world[1].token(ids[1]) == nil)
    #expect(try await world[1].state()?.entries[ids[1]]?.signedOut == true)
    #expect(world[0].token(ids[0]) == "tok-2")

    try await world[1].engine.signedIn(id: ids[1])
    await world.settle()
    #expect(world[1].token(ids[1]) == "tok-2")
  }

  /// A credential written outside the engine between the snapshot and the write is not overwritten.
  @Test func aCredentialChangedAfterTheSnapshotIsNotOverwritten() async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).sessionToken, "tok-2")
    await world[0].reconcile()
    world.cloud.deliverAll()

    let gate = StepGate<SyncApplyStep>(at: .localTransaction)
    await world[1].engine.setProbe(gate.probe)
    let running = Task { await world[1].reconcile() }
    await gate.reached()
    // The sign-in path writes a new token straight into the keychain.
    try world[1].secrets.set(SecretKeys.Gateway(id: ids[1]).sessionToken, "tok-typed")
    gate.open()
    _ = await running.value
    await world[1].engine.setProbe(nil)
    world.advance(1_000)
    await world.settle()

    #expect(world[1].token(ids[1]) == "tok-typed")
    #expect(world[0].token(ids[0]) == "tok-typed")
  }

  // MARK: Removing credentials on purpose (review A2)

  @Test(arguments: ["frontDoor", "headers", "authKind", "signOutEverywhere"])
  func aCredentialRemovedOnPurposeIsClearedEverywhereAndNotRestored(path: String) async throws {
    let (world, ids) = try await sharedWorld()
    world.advance(1_000)

    let check: (EngineDevice, String) -> String?
    switch path {
    case "frontDoor":
      try await world[0].engine.clear(.frontDoor, of: ids[0])
      check = { $0.frontDoor($1) }
    case "headers":
      try await world[0].engine.clear(.headers, of: ids[0])
      check = { $0.headers($1) }
    case "authKind":
      try await world[0].engine.changeAuthKind(of: ids[0], to: .nativePKCE)
      check = { $0.token($1) }
    default:
      try await world[0].engine.signOut(id: ids[0], scope: .allDevices)
      check = { $0.token($1) }
    }

    #expect(check(world[0], ids[0]) == nil)
    await world.settle()

    #expect(check(world[0], ids[0]) == nil)
    #expect(check(world[1], ids[1]) == nil)
    #expect(await !world[0].engine.lastTraces.contains(.credentialRestored))
    #expect(await !world[1].engine.lastTraces.contains(.credentialRestored))
    if path == "authKind" {
      #expect(try await world[1].only().authKind == .nativePKCE)
    }
  }

  @Test func aLocalSignOutIsNotRestoredAndLeavesTheOtherDevicesAlone() async throws {
    let (world, ids) = try await sharedWorld()

    try await world[0].engine.signOut(id: ids[0], scope: .thisDevice)
    await world.settle()

    #expect(world[0].token(ids[0]) == nil)
    #expect(world[0].frontDoor(ids[0]) == nil)
    #expect(await !world[0].engine.lastTraces.contains(.credentialRestored))
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(world[1].frontDoor(ids[1]) != nil)
  }

  /// Review A1: once signed out here, "Sign Out on All Devices" still reaches the others.
  @Test func signingOutEverywhereAfterSigningOutHereReachesTheOthers() async throws {
    let (world, ids) = try await sharedWorld()
    try await world[0].engine.signOut(id: ids[0], scope: .thisDevice)
    await world.settle()

    world.advance(1_000)
    try await world[0].engine.signOut(id: ids[0], scope: .allDevices)
    await world.settle()

    #expect(world[1].token(ids[1]) == nil)
    #expect(world.cloudRecord(homeAddress)?.registers[.sessionToken]?.value == .null)
  }

  // MARK: What a removal deletes

  @Test(arguments: conflictPolicies)
  func aRemoteTombstoneDeletesOnlyThatGatewaysDeviceOnlyItems(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)
    try await addGateway(world[0], address: otherAddress, name: "Office", token: "tok-office", frontDoorSecret: "door-2")
    await world.settle()
    let office = try #require(try await world[1].gateways().first { $0.address == otherAddress })

    // Device-only items sync knows nothing of, for both gateways and for the app.
    try world[1].secrets.set(SecretKeys.Gateway(id: ids[1]).pushManage, "push-1")
    try world[1].secrets.set(SecretKeys.Gateway(id: ids[1]).accessToken, "access-1")
    try world[1].secrets.set(SecretKeys.Gateway(id: office.id).pushManage, "push-2")
    try world[1].secrets.set(SecretKeys.shareDelivery, "{}")
    let before = world[1].secrets.keys

    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world.settle()

    // Its six credentials; never a push key, which the push registrar removes itself.
    let removed = Set(SecretKeys.Gateway(id: ids[1]).credentials)
    #expect(world[1].secrets.keys == before.subtracting(removed))
    #expect(world[1].secrets.items[SecretKeys.Gateway(id: ids[1]).pushManage] == "push-1")
    #expect(before.isSuperset(of: [SecretKeys.Gateway(id: ids[1]).pushManage, SecretKeys.Gateway(id: ids[1]).frontDoor]))
    #expect(world[1].token(office.id) == "tok-office")
    #expect(try await world[1].kv(SyncMaterializer.configKey(ids[1])) == nil)
    #expect(try await world[1].kv(SyncMaterializer.configKey(office.id)) != nil)
  }

  // MARK: Secrets never in logs or errors

  @Test func noTokenSecretHeaderValueOrRecordAppearsInALogLineOrAnError() async throws {
    var (world, ids) = try await sharedWorld(devices: 3)
    world.advance(1_000)
    try world[0].secrets.set(SecretKeys.Gateway(id: ids[0]).sessionToken, "tok-2")
    try await world[0].engine.clear(.headers, of: ids[0])
    world.cloud.failNext(.put, on: "device0", with: .keychain(operation: .add, status: -34_018))
    await world.settle()
    try await world[1].engine.signOut(id: ids[1], scope: .thisDevice)
    world[2].secrets.fail(.get, with: .interactionNotAllowed) { $0.contains("session_token") }
    await world[2].reconcile()
    await world[2].engine.setProbe(crash(after: .localTransaction))
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world.settle()
    world[2].restart()
    await world.settle()

    let secrets = ["tok-1", "tok-2", "door-1", "blue", "client.access", "clientSecret", "\"token\"", "\"v\":"]
    let lines = world.devices.flatMap(\.logs.all)
    #expect(!lines.isEmpty)
    for line in lines {
      for secret in secrets {
        #expect(!line.contains(secret), "log line leaks \(secret.count) characters: \(line.count)")
      }
    }

    let errors: [SyncEngineError] = [
      .secretStore(.interactionNotAllowed), .syncedStore(.keychain(operation: .add, status: -34_018)),
      .database(code: 5), .other("SQLiteError"), .unreadableConfig
    ]
    for error in errors {
      #expect(!secrets.contains { error.description.contains($0) })
    }
  }

  // MARK: The state the engine rewrites

  /// An intent reads and writes the whole state: pending marks, left-behind prints and tombstone
  /// rewrite counts of the merge must survive it.
  @Test func anIntentKeepsTheMergesPendingMarksLeftBehindPrintsAndRewriteCounts() async throws {
    let (world, ids) = try await sharedWorld(devices: 1)
    var state = try #require(try await world[0].state())
    let pending = SyncEntry.pendingPrint(from: "old-print", to: "new-print")
    let otherKey = GatewayKey.of(otherAddress)
    state.enabled = false
    state.entries[ids[0]]!.prints[SyncField.sessionToken.rawValue] = pending
    state.entries[ids[0]]!.leftBehind = ["left-print"]
    state.tombstones[otherKey] = SyncTombstoneMemory(
      stamp: SyncStamp(t: startOfTime, d: "a1b2c3d4"), firstSeen: startOfTime, rewrites: 2)
    let text = try state.encoded()
    try await world[0].database.write { try $0.kvSet(text, forKey: SyncState.storageKey) }

    try await world[0].engine.setGatewaySynced(true, id: ids[0])
    await world[0].engine.waitUntilIdle()

    let after = try #require(try await world[0].state())
    #expect(after.entries[ids[0]]?.prints[SyncField.sessionToken.rawValue] == pending)
    #expect(after.entries[ids[0]]?.leftBehind == ["left-print"])
    #expect(after.tombstones[otherKey]?.rewrites == 2)
    #expect(after.generation == state.generation + 1)
  }

  // MARK: Gates and arguments

  @Test func nothingIsPublishedBeforeTheDisclosure() async throws {
    let world = try EngineWorld(1)
    try await addGateway(world[0], address: homeAddress)
    await world[0].engine.waitUntilIdle()

    #expect(await world[0].reconcile() == .skipped(.notDisclosed))
    #expect(world.cloud.writes().isEmpty)
    #expect(await world[0].status.gateways.values.map(\.state) == [.off])

    try await world[0].engine.disclose()
    await world[0].engine.waitUntilIdle()
    #expect(world.cloud.writes().map(\.kind) == [.put])
  }

  @Test func anAddressThatNamesNoGatewayIsRefused() async throws {
    let (world, ids) = try await sharedWorld(devices: 1)

    await #expect(throws: SyncEngineError.invalidArgument) {
      try await addGateway(world[0], address: "mailto:someone")
    }
    await #expect(throws: SyncEngineError.invalidArgument) {
      try await world[0].engine.changeAddress(of: ids[0], to: "not an address")
    }
    #expect(try await world[0].only().address == homeAddress)
  }

  // MARK: The print key and the device tag

  @Test func thePrintKeyIsMintedOnceAndALostKeyMintsANewTagWithoutLosingAnything() async throws {
    var (world, ids) = try await sharedWorld()
    let key = try #require(world[1].secrets.items[SyncPrintKey.storageKey])
    let tag = try #require(world[1].secrets.items[SyncPrintKey.deviceKey])
    #expect(try await world[1].state()?.device == tag)

    world[1].restart()
    await world.settle()
    #expect(world[1].secrets.items[SyncPrintKey.storageKey] == key)

    // A keychain reset: both halves of the identity are gone, SQLite is not.
    try world[1].secrets.delete(SyncPrintKey.storageKey)
    try world[1].secrets.delete(SyncPrintKey.deviceKey)
    world[1].restart()
    world.advance(1_000)
    await world.settle()

    let newTag = try #require(world[1].secrets.items[SyncPrintKey.deviceKey])
    #expect(world[1].secrets.items[SyncPrintKey.storageKey] != key)
    #expect(newTag != tag)
    #expect(try await world[1].state()?.device == newTag)
    #expect(world[1].logs.all.contains { $0.hasPrefix("print key missing") })
    #expect(world[0].token(ids[0]) == "tok-1")
    #expect(world[1].token(ids[1]) == "tok-1")
    #expect(world[1].frontDoor(ids[1]) != nil)
    #expect(try await world[0].only().name == "Home")
  }

  /// Review A8: after a reinstall (no SQLite, keychain kept) the print key and tag are kept and
  /// the earlier install's credentials are cleaned up before the first reconcile.
  @Test func aReinstallKeepsTheIdentityAndRemovesTheEarlierInstallsCredentials() async throws {
    let cloud = FakeCloud()
    let first = try EngineDevice(name: "phone", cloud: cloud)
    try await first.engine.disclose()
    let id = try await addGateway(first, address: homeAddress)
    await first.engine.waitUntilIdle()
    let key = first.secrets.items[SyncPrintKey.storageKey]
    let tag = first.secrets.items[SyncPrintKey.deviceKey]
    #expect(first.token(id) == "tok-1")

    // The app is deleted and installed again: SQLite is new, the keychain items are still there.
    let second = EngineDevice(reinstalling: first)
    #expect(await second.reconcile() == .skipped(.notDisclosed))
    #expect(second.token(id) == nil)
    #expect(second.gatewayKeys.isEmpty)
    #expect(second.secrets.items[SyncPrintKey.storageKey] == key)
    #expect(second.secrets.items[SyncPrintKey.deviceKey] == tag)
  }

  // MARK: Triggers

  @Test func localChangesCoalesceIntoOneReconcileAfterTheDelay() async throws {
    let cloud = FakeCloud()
    let device = try EngineDevice(name: "phone", cloud: cloud, timing: SyncTiming())
    await device.engine.trigger(.localChange)
    await device.engine.trigger(.localChange)
    await device.engine.localDidChange()

    for _ in 0..<10_000 where device.clock.sleeping == 0 {
      await Task.yield()
    }
    #expect(device.clock.sleeping == 1)
    #expect(!device.logs.all.contains { $0.hasPrefix("reconcile(") })

    device.clock.advance(1_000)
    await device.engine.waitUntilIdle()
    #expect(device.logs.all.filter { $0.hasPrefix("reconcile(localChange)") }.count == 1)
  }

  @Test func foregroundRunsAtMostOncePerInterval() async throws {
    let cloud = FakeCloud()
    let device = try EngineDevice(name: "phone", cloud: cloud, timing: SyncTiming())
    await device.engine.trigger(.foreground)
    await device.engine.waitUntilIdle()
    device.clock.advance(10_000)
    await device.engine.trigger(.foreground)
    await device.engine.waitUntilIdle()
    #expect(device.logs.all.filter { $0.hasPrefix("reconcile(foreground)") }.count == 1)

    device.clock.advance(30_000)
    await device.engine.trigger(.foreground)
    await device.engine.waitUntilIdle()
    #expect(device.logs.all.filter { $0.hasPrefix("reconcile(foreground)") }.count == 2)
  }

  @Test func requestsMadeWhileOneIsQueuedJoinIt() async throws {
    let cloud = FakeCloud()
    let device = try EngineDevice(name: "phone", cloud: cloud)
    async let first = device.engine.reconcileNow(.manual)
    async let second = device.engine.reconcileNow(.manual)
    async let third = device.engine.reconcileNow(.manual)
    _ = await (first, second, third)
    let runs = device.logs.all.filter { $0.hasPrefix("reconcile(manual)") }.count
    #expect((1...2).contains(runs))
  }
}

extension EngineDevice {
  /// The same device after the app was deleted and installed again: a new SQLite and a new
  /// engine, the same keychain and replica.
  init(reinstalling device: EngineDevice) {
    self.name = device.name
    database = try! SQLiteStore(.inMemory)
    secrets = device.secrets
    store = device.store
    clock = device.clock
    timing = device.timing
    logs = LogCapture()
    lifecycle = RecordingLifecycle()
    status = SyncStatus()
    engine = GatewaySyncEngine(
      database: database, secrets: secrets, synced: store, lifecycle: lifecycle, clock: clock.syncClock,
      timing: timing, logger: logs.logger, status: status)
  }
}
