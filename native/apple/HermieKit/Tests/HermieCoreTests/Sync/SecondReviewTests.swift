import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One test per finding of the second review of the merge.
@Suite struct SecondReviewTests {
  static let address = "https://gateway.test"
  static let origin = GatewayAddress.origin(of: address)
  static let key = GatewayKey.of(address)
  static let account = SyncedGatewayRecord.account(forKey: key)

  static func shared(devices: Int = 2, conflict: TestCloud.ConflictPolicy = .newestWrite) -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: devices, conflict: conflict)
    let id = world.add(0, address: address, name: "Home", token: "tok-1", frontDoorSecret: "door-1")
    world.setHeaders(0, id, ["X-Team": "blue"])
    world.settle()
    return (world, world.devices.map { $0.gateways.first!.id })
  }

  // MARK: 1. "Sign Out on All Devices" goes out while signed out here

  @Test func signingOutOnAllDevicesGoesOutWhileSignedOutHere() throws {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.signOutEverywhere(0, ids[0])
    #expect(world.devices[0].state.entries[ids[0]]?.signedOut == true)
    let plan = world.reconcile(0)

    let put = try #require(plan.remotePuts.first)
    #expect(put.registers[.sessionToken]?.value == .null)
    #expect(put.registers[.sessionToken]?.stamp.d == world.devices[0].state.device)
    #expect(plan.state.entries[ids[0]]?.clearing.isEmpty == true)
    #expect(plan.localOps.isEmpty)
    #expect(plan.traces.contains(.clearedWhileSignedOut))
    #expect(world.reconcile(0).isEmpty)

    world.cloud.deliverAll()
    world.settle()
    #expect(world.devices.allSatisfy { $0.gateways.first?.sessionToken == nil })
    #expect(world.devices[1].gateways.first?.frontDoor?.clientSecret == "door-1")

    // Signing in again later publishes the new token, and nothing fires a stale clear.
    world.advance(1_000)
    world.setToken(0, ids[0], to: "tok-3")
    world.settle()
    #expect(world.devices.map { $0.gateways.first?.sessionToken?.token } == ["tok-3", "tok-3"])
  }

  /// The clear went out while signed out, but the keychain lost the write after the state was
  /// saved: it goes out again, at its own stamp.
  @Test func aLostClearSentWhileSignedOutIsSentAgainAtItsStamp() throws {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.signOutEverywhere(0, ids[0])
    var lost = world.plan(0)
    let stamp = try #require(lost.remotePuts.first?.registers[.sessionToken]?.stamp)
    lost.remotePuts = []
    world.apply(lost, to: 0)

    let again = world.reconcile(0)
    #expect(again.remotePuts.first?.registers[.sessionToken] == SyncRegister(value: .null, stamp: stamp))
    world.settle()
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
  }

  // MARK: The apply contract (`SyncPlan.provisionalState`)

  /// The engine saved the registry rows and the provisional state, then died before the keychain
  /// write: the next reconcile writes the token again and publishes nothing.
  @Test func aLocalWriteThatNeverLandedIsMadeAgain() {
    var (world, ids) = Self.shared()
    world.advance(1_000)
    world.setToken(0, ids[0], to: "tok-2")
    world.reconcile(0)
    world.cloud.deliverAll()

    let plan = world.plan(1)
    world.applyCrash(plan, to: 1, at: .afterRegistry)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-1")

    let again = world.reconcile(1)
    #expect(again.traces.contains(.pendingWriteRedone))
    #expect(!again.hasRemoteWrites)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-2")
    #expect(world.reconcile(1).isEmpty)
  }

  /// Found by the wide property run (seed 101181): a write left pending by a crash, and then the
  /// print key lost too. The pending write is redone; the stale local token never goes out.
  @Test func aPendingWriteSurvivesALostPrintKey() {
    var (world, ids) = Self.shared()
    world.advance(1_000)
    world.setToken(0, ids[0], to: "tok-2")
    world.reconcile(0)
    world.cloud.deliverAll()

    world.applyCrash(world.plan(1), to: 1, at: .afterRegistry)
    world.losePrintKey(1)
    let next = world.reconcile(1)

    #expect(!next.hasRemoteWrites)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-2")
    world.settle()
    #expect(world.devices.map { $0.gateways.first?.sessionToken?.token } == ["tok-2", "tok-2"])
  }

  /// Found by the property test (seed 1276): a gateway first attached here received the record's
  /// token, the engine died after the keychain write, and the item then vanished. The token it only
  /// received must not go out as if entered here.
  @Test func aReceivedCredentialNeverPassesForOneEnteredHere() {
    var world = SyncWorld(devices: 2)
    world.setEnabled(1, false)
    world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    world.advance(1_000)
    let id = world.add(1, address: Self.address, name: "Mine")
    world.setEnabled(1, true)

    let plan = world.plan(1)
    #expect(plan.localOps.map(\.gatewayId) == [id])
    world.applyCrash(plan, to: 1, at: .afterKeychain)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-1")
    world.cloud.wipeLocal(1)

    let next = world.reconcile(1)
    #expect(!next.hasRemoteWrites)
    #expect(world.devices[1].state.entries[id]?.detached == .absent)
  }

  // MARK: 2. A lost print key rebuilds from stamps

  /// Device 0 sets tok-2; device 1 has received it but not reconciled, then loses its print key.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func aLostPrintKeyDoesNotLetAStaleCredentialWin(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(conflict: conflict)

    world.advance(1_000)
    world.setToken(0, ids[0], to: "tok-2")
    world.reconcile(0)
    world.cloud.deliverAll()

    world.losePrintKey(1)
    world.advance(1_000)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.traces.contains(.printRebuildYielded))
    #expect(world.devices.map { $0.gateways.first?.sessionToken?.token } == ["tok-2", "tok-2"])
  }

  /// Signed out here with a lost print key: the token stays away and is not cleared elsewhere.
  @Test func aLostPrintKeyKeepsASignOutHere() {
    var (world, ids) = Self.shared()
    world.signOut(1, ids[1])
    world.settle()

    world.losePrintKey(1)
    world.loseCredentials(1, ids[1])
    let plan = world.reconcile(1)
    world.settle()

    #expect(!plan.hasRemoteWrites)
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(world.devices[1].gateways.first?.frontDoor == nil)
    #expect(world.devices[0].gateways.first?.sessionToken?.token == "tok-1")
    #expect(world.devices[0].gateways.first?.frontDoor?.clientSecret == "door-1")
  }

  // MARK: 3. A "stop syncing" delete racing a removal everywhere

  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func aStopSyncingDeleteDoesNotSwallowARemovalEverywhere(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(devices: 3, conflict: conflict)

    // Device 1 removes it everywhere; device 0, not having seen that, stops syncing it, and its
    // delete reaches the cloud after the tombstone.
    world.advance(1_000)
    world.remove(1, ids[1], scope: .allDevices)
    world.reconcile(1)
    world.setGatewaySynced(0, ids[0], false)
    world.reconcile(0)
    world.cloud.deliverAll()
    #expect(world.cloud.cloudItems.isEmpty || conflict == .cloudWins)

    world.settle()

    #expect(world.devices[2].gateways.isEmpty)
    #expect(world.devices[0].gateways.map(\.id) == [ids[0]])
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }

  /// The rewrite is capped: after three, a vanished tombstone is not written again (no endless
  /// back and forth with a device that prunes it).
  @Test func aRewrittenTombstoneIsWrittenAtMostThreeTimes() {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()

    for _ in 0..<3 {
      world.cloud.delete(1, account: Self.account)
      world.cloud.deliverAll()
      #expect(world.reconcile(0).traces.contains(.tombstoneRewrittenOverMissing))
      world.cloud.deliverAll()
    }
    #expect(world.devices[0].state.tombstones[Self.key]?.rewrites == 3)

    world.cloud.delete(1, account: Self.account)
    world.cloud.deliverAll()
    #expect(!world.reconcile(0).hasRemoteWrites)
  }

  /// Found by the wide property runs (seeds 100749, 106591): a rewrite the keychain lost (or the
  /// cloud refused) is made again.
  @Test func aLostTombstoneRewriteIsMadeAgain() {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()
    world.cloud.delete(1, account: Self.account)
    world.cloud.deliverAll()

    var lost = world.plan(0)
    #expect(lost.traces.contains(.tombstoneRewrittenOverMissing))
    lost.remotePuts = []
    world.apply(lost, to: 0)

    let again = world.reconcile(0)
    #expect(again.remotePuts.map(\.key) == [Self.key])
    world.cloud.deliverAll()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.reconcile(0).isEmpty)
  }

  // MARK: 4. A lost "stop syncing" delete is made again

  @Test func aLostStopSyncingDeleteIsMadeAgain() {
    var (world, ids) = Self.shared()

    world.setGatewaySynced(0, ids[0], false)
    var lost = world.plan(0)
    #expect(lost.remoteDeletes == [Self.account])
    lost.remoteDeletes = []
    world.apply(lost, to: 0)

    let again = world.reconcile(0)
    #expect(again.remoteDeletes == [Self.account])
    #expect(again.traces.contains(.stopSyncingDeleteRepeated))
    world.settle()
    #expect(world.cloud.cloudItems.isEmpty)
    #expect(world.devices[0].state.entries[ids[0]]?.seen == false)
  }

  /// A sibling at the same origin that is synced keeps its item: the switched-off one does not
  /// delete it (found by the property test, seed 13).
  @Test func aSwitchedOffGatewayDoesNotDeleteItsSyncedSiblingsItem() {
    var world = SyncWorld(devices: 2)
    let first = world.add(0, address: Self.address, name: "Personal")
    world.settle()
    world.setGatewaySynced(0, first, false)
    world.add(0, address: Self.address + "/team", name: "Team")
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices[0].state.entries[first]?.seen == false)
    #expect(world.devices[1].gateways.count == 1)
    #expect(world.reconcile(0).isEmpty)
  }

  // MARK: 5. A move without the old item still removes it

  @Test func aMoveWhileTheOldItemIsMissingHereIsNotACopy() {
    var (world, ids) = Self.shared()
    let alpha = "https://alpha.gateway.test"

    world.cloud.wipeLocal(1)
    world.advance(1_000)
    world.setAddress(1, ids[1], to: alpha)
    let plan = world.reconcile(1)
    #expect(plan.remotePuts.contains { $0.key == Self.key && $0.isTombstone })

    world.cloud.rejoin(1)
    world.settle()

    // Device 1 read an empty store, which since the third review means "everything was deleted":
    // its moved gateway stays device-only until the person resyncs it. The old key's tombstone
    // went out all the same, so no copy is left at the old origin.
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
    world.devices[1].state.resync(gatewayId: ids[1])
    world.settle()

    for device in world.devices {
      #expect(device.gateways.map(\.address) == [alpha])
    }
  }

  /// Found by the wide property run (seed 100125): a token this device only received stays in its
  /// keychain when the gateway moves away (the engine dies before every keychain write), and the
  /// gateway then moves back. The token is left behind, never sent out as if entered here.
  @Test func aCredentialLeftBehindByAMoveIsNotRevivedByMovingBack() {
    var (world, ids) = Self.shared()
    let alpha = "https://alpha.gateway.test"

    world.advance(1_000)
    world.setAddress(1, ids[1], to: alpha)
    world.applyCrash(world.plan(1), to: 1, at: .afterRegistry)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-1")
    #expect(world.devices[1].state.entries[ids[1]]?.leftBehind.isEmpty == false)

    world.advance(1_000)
    world.setAddress(1, ids[1], to: Self.address)
    let back = world.reconcile(1)

    #expect(back.traces.contains(.credentialsLeftBehind))
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(!back.remotePuts.contains { $0.sessionToken != nil && $0.registers[.sessionToken]?.stamp.d == world.devices[1].state.device })
    world.settle()
    #expect(world.devices[1].state.entries[ids[1]]?.leftBehind.isEmpty == true)
  }

  // MARK: 6. A restore is announced (with item 1's regression in ReviewFixTests)

  @Test func aRestoreIsAnnouncedOnceWithItsFields() {
    var (world, ids) = Self.shared()
    world.edit(1, ids[1]) { $0.sessionToken = nil }

    let plan = world.reconcile(1)

    #expect(plan.events == [.credentialRestored(gatewayId: ids[1], fields: [.sessionToken])])
    #expect(world.reconcile(1).events.isEmpty)
  }

  // MARK: 8. An address that names no gateway is a move

  @Test func anAddressThatNamesNoGatewayIsAMove() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.setAddress(1, ids[1], to: "https://")
    world.settle()

    #expect(world.devices[1].gateways.count == 1)
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }

  // MARK: 9. The tombstone memory is capped

  @Test func atMost512TombstonesAreRemembered() {
    let world = SyncWorld(devices: 1)
    let remote = (0..<520).map { index -> SyncedGatewayRecord in
      var record = SyncedGatewayRecord(key: GatewayKey.of("https://g\(index).gateway.test"))
      record.deleted = SyncStamp(t: startOfTime, d: "x")
      return record
    }

    let plan = GatewaySync.reconcile(local: world.snapshot(0), remote: remote, state: world.devices[0].state, now: world.now)

    #expect(plan.state.tombstones.count == 512)
  }

  // MARK: 10. The generation cannot trap

  @Test func anAbsurdStoredGenerationIsIgnored() throws {
    let text = #"{"device":"a1b2c3d4","disclosed":true,"enabled":true,"entries":{},"generation":1e300,"hidden":[],"v":1}"#
    #expect(try #require(SyncState.decode(text)).generation == 0)
    let big = #"{"device":"a1b2c3d4","generation":9007199254740992,"v":1}"#
    #expect(try #require(SyncState.decode(big)).generation == 9_007_199_254_740_992)
  }

  // MARK: 11. A clear does not linger outside an attach

  @Test func aClearRecordedWhileDeviceOnlyIsDropped() {
    var (world, ids) = Self.shared()
    world.cloud.wipeLocal(1)
    world.reconcile(1)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)

    world.setToken(1, ids[1], to: nil)
    let plan = world.reconcile(1)

    #expect(plan.state.entries[ids[1]]?.clearing.isEmpty == true)
    #expect(!plan.hasRemoteWrites)
  }

  // MARK: 12. A record for another origin under the same key is never applied

  /// No FNV-1a-64 collision is known for short origins and none can be found in test time, so the
  /// local key function is replaced: the local gateway lands on the key of another origin.
  @Test func aRecordForAnotherOriginUnderTheSameKeyIsNeverApplied() {
    var world = SyncWorld(devices: 1)
    let other = "https://alpha.gateway.test"
    var record = SyncedGatewayRecord(key: GatewayKey.of(other))
    record.registers[.address] = SyncRegister(value: .string(other), stamp: SyncStamp(t: 5, d: "x"))
    record.registers[.name] = SyncRegister(value: "Elsewhere", stamp: SyncStamp(t: 5, d: "x"))
    record.registers[.sessionToken] = SyncRegister(
      value: ["origin": .string(other), "token": "not-yours"], stamp: SyncStamp(t: 5, d: "x"))
    let id = world.add(0, address: Self.address, name: "Mine")

    let plan = GatewaySync.reconcile(
      local: world.snapshot(0), remote: [record], state: world.devices[0].state, now: world.now,
      keyOf: { address in address == Self.address ? GatewayKey.of(other) : GatewayKey.of(address) })

    #expect(plan.traces.contains(.originCollision))
    #expect(plan.localOps.isEmpty)
    #expect(!plan.hasRemoteWrites)
    #expect(plan.state.entries[id]?.stamps.isEmpty == true)
  }
}
