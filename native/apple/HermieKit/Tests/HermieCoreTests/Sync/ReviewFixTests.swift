import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One test per finding of the review of the first merge, and per decision the review asked to
/// see tested on its own.
@Suite struct ReviewFixTests {
  static let address = "https://gateway.test"
  static let origin = GatewayAddress.origin(of: address)
  static let key = GatewayKey.of(address)
  static let account = SyncedGatewayRecord.account(forKey: key)

  /// Two (or more) devices sharing one gateway with a token, a front door and headers.
  static func shared(devices: Int = 2, conflict: TestCloud.ConflictPolicy = .newestWrite) -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: devices, conflict: conflict)
    let id = world.add(0, address: address, name: "Home", token: "tok-1", frontDoorSecret: "door-1")
    world.setHeaders(0, id, ["X-Team": "blue"])
    world.settle()
    return (world, world.devices.map { $0.gateways.first!.id })
  }

  // MARK: 1. A credential missing on one device is never cleared on the others

  /// The regression: device 1 loses its token and front door without signing out.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func aDeviceThatLosesItsCredentialsDoesNotTakeThemFromTheOthers(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(conflict: conflict)

    world.advance(1_000)
    world.loseCredentials(1, ids[1])
    let plan = world.reconcile(1)

    #expect(!plan.hasRemoteWrites)
    #expect(plan.localOps.map(\.description) == ["update(\(ids[1]), [\"frontDoor\", \"headers\", \"sessionToken\"])"])
    #expect(plan.traces.contains(.credentialRestored))

    world.cloud.deliverAll()
    world.settle()
    for device in world.devices {
      #expect(device.gateways.first?.sessionToken?.token == "tok-1")
      #expect(device.gateways.first?.frontDoor?.clientSecret == "door-1")
      #expect(device.gateways.first?.headers?.headers == ["X-Team": "blue"])
    }
  }

  /// (a) Only a clear the person asked for goes out, and the intent is consumed.
  @Test func aCredentialClearedOnPurposeIsClearedEverywhere() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.setFrontDoor(0, ids[0], secret: nil)
    world.signOutEverywhere(0, ids[0])
    world.setHeaders(0, ids[0], nil)
    #expect(world.devices[0].state.entries[ids[0]]?.clearing == [.frontDoor, .headers, .sessionToken])
    let plan = world.reconcile(0)

    #expect(plan.remotePuts.first?.registers[.sessionToken]?.value == .null)
    #expect(plan.remotePuts.first?.registers[.frontDoor]?.value == .null)
    #expect(plan.state.entries[ids[0]]?.clearing.isEmpty == true)

    world.cloud.deliverAll()
    world.settle()
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(world.devices[1].gateways.first?.frontDoor == nil)
    #expect(world.devices[1].gateways.first?.headers == nil)
  }

  /// (b) Signed out here: a front door that went missing stays missing, nothing is published, and
  /// signing in again brings it back.
  @Test func aCredentialMissingWhileSignedOutIsLeftMissing() {
    var (world, ids) = Self.shared()

    world.signOut(1, ids[1])
    world.loseCredentials(1, ids[1])
    let plan = world.reconcile(1)

    #expect(plan.localOps.isEmpty)
    #expect(!plan.hasRemoteWrites)
    #expect(plan.traces.contains(.credentialLeftSignedOut))
    #expect(world.reconcile(1).isEmpty)
    world.settle()
    #expect(world.devices[0].gateways.first?.frontDoor?.clientSecret == "door-1")

    world.advance(1_000)
    world.setToken(1, ids[1], to: "tok-2")
    world.settle()
    #expect(world.devices[1].gateways.first?.frontDoor?.clientSecret == "door-1")
    #expect(world.devices.map { $0.gateways.first?.sessionToken?.token } == ["tok-2", "tok-2"])
  }

  /// (c) A lost print key: every gateway attaches as on first sight; local credentials win and
  /// nothing is cleared anywhere.
  @Test func aLostPrintKeyAttachesAsOnFirstSightAndClearsNothing() throws {
    var (world, ids) = Self.shared()

    world.losePrintKey(1)
    world.edit(1, ids[1]) { gateway in
      gateway.name = "Renamed while the key was lost"
      gateway.sessionToken = SyncSessionToken(origin: Self.origin, token: "tok-local")
      gateway.frontDoor = nil
    }
    world.advance(1_000)
    let plan = world.reconcile(1)

    #expect(plan.traces.contains(.printsReset))
    #expect(plan.state.printCheck == printer(key: "x").check)
    let put = try #require(plan.remotePuts.first)
    #expect(put.sessionToken?.token == "tok-local")
    #expect(put.frontDoor?.clientSecret == "door-1")
    #expect(put.name == "Home")
    #expect(world.devices[1].gateways.first?.frontDoor?.clientSecret == "door-1")
    #expect(world.reconcile(1).isEmpty)

    world.cloud.deliverAll()
    world.settle()
    #expect(world.devices[0].gateways.first?.sessionToken?.token == "tok-local")
    #expect(world.devices[0].gateways.first?.frontDoor?.clientSecret == "door-1")
  }

  // MARK: 2. Pruning measures age by this device's own clock

  @Test func aClockFarAheadOrBehindDoesNotPruneAFreshTombstone() {
    var world = SyncWorld(devices: 3)
    world.devices[0].clockOffset = -200 * day
    world.devices[1].clockOffset = 200 * day
    world.add(0, address: Self.address)
    world.settle()

    world.remove(0, world.devices[0].gateways[0].id, scope: .allDevices)
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices.allSatisfy { $0.gateways.isEmpty })
    #expect(world.cloudRecord(key: Self.key)?.deleted?.t ?? 0 < startOfTime - 199 * day)

    // 180 days of the normal device's own time later, it goes.
    world.advance(181 * day)
    #expect(world.reconcile(2).remoteDeletes == [Self.account])
  }

  // MARK: 3. A gateway that merely existed does not undo a removal on all devices

  @Test func aGatewayThatExistedBeforeSyncDoesNotUndoARemovalEverywhere() {
    var world = SyncWorld(devices: 2)
    // The Mac has the gateway from before, with sync off.
    world.setEnabled(1, false)
    let mac = world.existing(1, address: Self.address, token: "tok-mac")

    world.add(0, address: Self.address, token: "tok-phone")
    world.settle()
    world.remove(0, world.devices[0].gateways[0].id, scope: .allDevices)
    world.settle()

    world.advance(30 * day)
    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    world.settle()

    #expect(!plan.hasRemoteWrites)
    #expect(plan.traces.contains(.existingKeptAbsent))
    #expect(world.devices[1].state.entries[mac]?.detached == .absent)
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-mac")
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }

  /// Found by the wide property run (seed 103713): once the device has pruned the tombstone it
  /// still remembers the removal, and a gateway that was not added here is not published again.
  @Test func aGatewayThatExistedStaysDeviceOnlyAfterTheTombstoneIsPruned() {
    var world = SyncWorld(devices: 2)
    world.setEnabled(1, false)
    let mac = world.existing(1, address: Self.address, token: "tok-mac")
    world.add(0, address: Self.address)
    world.settle()
    world.remove(0, world.devices[0].gateways[0].id, scope: .allDevices)
    world.settle()
    world.setEnabled(1, true)
    world.settle()

    // "Sync this gateway" off and on again: no stamps, and no "added here".
    world.setGatewaySynced(1, mac, false)
    world.settle()
    world.setGatewaySynced(1, mac, true)
    world.advance(200 * day)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.remotePuts.isEmpty)
    #expect(plan.remoteDeletes == [Self.account])
    #expect(world.devices[1].state.entries[mac]?.detached == .absent)
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.cloud.cloudItems.isEmpty)
  }

  /// Decision (7), the other side: a gateway the person adds is added again over the tombstone.
  @Test func aGatewayAddedHereIsAddedAgainOverARemoval() {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()

    world.advance(1_000)
    world.add(1, address: Self.address, name: "Again")
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.traces.contains(.readded))
    #expect(plan.state.entries.values.allSatisfy { !$0.addedHere })
    #expect(world.devices[0].gateways.map(\.name) == ["Again"])
  }

  // MARK: 4. A stale copy turning up after more than 180 days does not bring a gateway back

  @Test func aStaleCopyAfterMoreThan180DaysDoesNotBringARemovedGatewayBack() {
    var (world, ids) = Self.shared()

    // Device 1 is offline from here on, holding its live copy.
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll(except: 1)

    world.advance(181 * day)
    #expect(world.reconcile(0).remoteDeletes == [Self.account])
    world.cloud.deliverAll(except: 1)
    #expect(world.devices[0].state.tombstones[Self.key] != nil)

    // Device 1 renames its stale copy and comes back.
    world.rename(1, ids[1], to: "Stale")
    world.reconcile(1)
    world.cloud.deliverAll()
    world.settle()

    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isLive != true)
    #expect(world.devices[1].gateways.map(\.id) == [ids[1]])
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
  }

  /// Found by the wide property run (seed 103808): a removal on all devices made while the store
  /// already holds an old tombstone writes a fresh one, so this removal does not age out with it.
  @Test func aRemovalOverAnOldTombstoneStartsItsOwnAge() throws {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll()

    // Device 1 has the tombstone but has not acted on it when the person removes the gateway there.
    world.advance(179 * day)
    world.remove(1, ids[1], scope: .allDevices)
    let plan = world.reconcile(1)
    let fresh = try #require(plan.remotePuts.first?.deleted)
    #expect(fresh.t == startOfTime + 179 * day)

    world.cloud.deliverAll()
    world.advance(2 * day)
    #expect(world.reconcile(0).remoteDeletes.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }

  @Test func aRememberedTombstoneLastsThreeYearsOfLocalTime() {
    var (world, ids) = Self.shared(devices: 1)
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()

    world.advance(2 * year + 300 * day)
    world.reconcile(0)
    #expect(world.devices[0].state.tombstones[Self.key] != nil)

    world.advance(70 * day)
    world.reconcile(0)
    #expect(world.devices[0].state.tombstones[Self.key] == nil)
  }

  // MARK: 5. A purge whose state was lost does not hide the key

  @Test func aPurgeWhoseStateWasLostDoesNotHideTheKey() {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll()

    // Device 1 purges, then dies before saving its state.
    var crashed = world.plan(1)
    #expect(crashed.localOps == [.purge(gatewayId: ids[1])])
    crashed.state = world.devices[1].state
    world.apply(crashed, to: 1)

    let next = world.reconcile(1)
    #expect(next.traces.contains(.crashedPurgeRecovered))
    #expect(next.state.hidden.isEmpty)
    #expect(next.state.entries[ids[1]] == nil)

    // Added again elsewhere, it comes back here too.
    world.advance(1_000)
    world.add(0, address: Self.address, name: "Again")
    world.settle()
    #expect(world.devices[1].gateways.map(\.name) == ["Again"])
  }

  // MARK: Decisions (5) and (8)

  /// Decision (5): an `absent` gateway meeting a newer tombstone is purged.
  @Test func anAbsentGatewayMeetingANewerTombstoneIsPurged() {
    var (world, ids) = Self.shared()
    world.cloud.wipeLocal(1)
    world.reconcile(1)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.rejoin(1)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)

    #expect(plan.traces.contains(.absentPurged))
    #expect(plan.localOps == [.purge(gatewayId: ids[1])])
  }

  /// Decision (8): a gateway that leaves the list without a recorded intent is hidden here only.
  @Test func aGatewayGoneWithoutAnIntentIsHiddenHere() {
    var (world, ids) = Self.shared()
    world.devices[1].gateways.removeAll { $0.id == ids[1] }

    let plan = world.reconcile(1)
    world.settle()

    #expect(!plan.hasRemoteWrites)
    #expect(world.devices[1].state.hidden == [Self.key])
    #expect(world.devices[1].gateways.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
  }

  // MARK: Limits and odd stores

  @Test func foreignItemsCountTowardTheItemLimit() {
    var world = SyncWorld(devices: 1)
    for index in 0..<64 {
      let key = GatewayKey.of("https://g\(index).gateway.test")
      world.cloud.put(0, account: SyncedGatewayRecord.account(forKey: key), value: #"{"key":"\#(key)","v":2}"#)
    }
    world.add(0, address: Self.address)

    let plan = world.reconcile(0)
    #expect(plan.remotePuts.isEmpty)
    #expect(plan.traces.contains(.foreignRecord))
  }

  @Test func anOversizedRecordKeepsTheHeadersTheStoreAlreadyHas() throws {
    var (world, ids) = Self.shared()
    let big = Dictionary(uniqueKeysWithValues: (0..<200).map { ("X-Big-\($0)", String(repeating: "v", count: 40)) })

    world.advance(1_000)
    world.setHeaders(1, ids[1], big)
    let plan = world.reconcile(1)

    #expect(plan.events == [.headersNotSynced(gatewayId: ids[1])])
    #expect(plan.traces.contains(.headersOverLimit))
    world.cloud.deliverAll()
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.headers?.headers == ["X-Team": "blue"])
    #expect(world.devices[0].gateways.first?.headers?.headers == ["X-Team": "blue"])
    #expect(world.devices[1].gateways.first?.headers?.headers.count == 200)
    #expect(world.reconcile(1).isEmpty)
  }

  @Test func aDetachmentFromANewerBuildIsLeftAlone() {
    var (world, ids) = Self.shared()
    world.devices[1].state.entries[ids[1]]?.detached = .other("later")
    world.rename(1, ids[1], to: "Local only")

    let plan = world.reconcile(1)

    #expect(plan.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.name == "Home")
  }

  @Test func twoItemsForOneKeyAreMergedAndWrittenAsOne() throws {
    let world = SyncWorld(devices: 1)
    func record(name: String, t: Double) -> SyncedGatewayRecord {
      var record = SyncedGatewayRecord(key: Self.key)
      record.registers[.address] = SyncRegister(value: .string(Self.address), stamp: SyncStamp(t: 5, d: "a"))
      record.registers[.name] = SyncRegister(value: .string(name), stamp: SyncStamp(t: t, d: "a"))
      return record
    }

    let plan = GatewaySync.reconcile(
      local: world.snapshot(0), remote: [record(name: "Older", t: 6), record(name: "Newer", t: 9)],
      state: world.devices[0].state, now: world.now)

    #expect(plan.remotePuts.map(\.name) == ["Newer"])
    #expect(plan.localOps.count == 1)
  }

  // MARK: Optional findings

  /// (8) Stamps outside `[0, 2^53 − 2^20]` are not read, and a wild clock writes none.
  @Test func stampsOutsideTheValidRangeAreRejectedAndNeverWritten() throws {
    #expect(SyncStamp(json: ["t": -1, "d": "a"]) == nil)
    #expect(SyncStamp(json: ["t": .number(SyncStamp.maximumT + 1), "d": "a"]) == nil)
    #expect(SyncStamp(json: ["t": .number(SyncStamp.maximumT), "d": "a"]) != nil)

    var world = SyncWorld(devices: 1)
    world.devices[0].clockOffset = 1e300
    world.add(0, address: Self.address)
    let put = try #require(world.reconcile(0).remotePuts.first)
    #expect(put.registers[.name]?.stamp.t == SyncStamp.maximumT)
  }

  /// (9) Removing the last copy at a key that was a duplicate hides the key.
  @Test func removingTheLastDuplicateHidesTheKey() {
    var world = SyncWorld(devices: 1)
    let first = world.add(0, address: Self.address, name: "Personal")
    world.advance(1_000)
    let second = world.add(0, address: Self.address + "/team", name: "Team")
    world.settle()
    #expect(world.devices[0].state.entries[second]?.detached == .duplicateOrigin)

    world.remove(0, first, scope: .allDevices)
    world.settle()
    world.devices[0].gateways.removeAll { $0.id == second }
    world.devices[0].state.markRemoved(gatewayId: second, key: Self.key, scope: .thisDevice)
    world.reconcile(0)

    #expect(world.devices[0].state.hidden == [Self.key])
  }

  /// (10) Moving a device-only gateway to another origin hides the old key.
  @Test func movingADeviceOnlyGatewayHidesTheOldKey() {
    var (world, ids) = Self.shared()
    // Device 1 keeps its copy device-only; device 0 publishes the gateway again.
    world.setGatewaySynced(1, ids[1], false)
    world.settle()
    world.devices[0].state.resync(gatewayId: ids[0])
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)

    world.setAddress(1, ids[1], to: "https://alpha.gateway.test")
    world.settle()

    #expect(world.devices[1].state.hidden.contains(Self.key))
    #expect(world.devices[1].gateways.allSatisfy { $0.key != Self.key })
  }

  /// (12) Headers and front doors the wizard would refuse are not synced.
  @Test func valuesTheWizardWouldRefuseAreNotSynced() {
    func headers(_ map: [String: JSONValue]) -> JSONValue {
      ["origin": .string(Self.origin), "headers": .object(map)]
    }
    func door(kind: String, id: String) -> JSONValue {
      ["origin": .string(Self.origin), "kind": .string(kind), "clientId": .string(id), "clientSecret": "s"]
    }

    #expect(SyncedGatewayRecord.projection(.headers, headers(["X-Team": "a"]), key: Self.key, origin: Self.origin) != nil)
    #expect(SyncedGatewayRecord.projection(.headers, headers(["Authorization": "a"]), key: Self.key, origin: Self.origin) == nil)
    #expect(SyncedGatewayRecord.projection(.headers, headers(["Host": "a"]), key: Self.key, origin: Self.origin) == nil)
    #expect(SyncedGatewayRecord.projection(.headers, headers(["X-A": "a\r\nInjected: 1"]), key: Self.key, origin: Self.origin) == nil)
    #expect(SyncedGatewayRecord.projection(.headers, headers(["Bad Name": "a"]), key: Self.key, origin: Self.origin) == nil)
    #expect(SyncedGatewayRecord.projection(.frontDoor, door(kind: "cloudflare-access", id: "id"), key: Self.key, origin: Self.origin) != nil)
    #expect(SyncedGatewayRecord.projection(.frontDoor, door(kind: "mystery", id: "id"), key: Self.key, origin: Self.origin) == nil)
    #expect(SyncedGatewayRecord.projection(.frontDoor, door(kind: "cloudflare-access", id: "  "), key: Self.key, origin: Self.origin) == nil)
  }

  // MARK: Engine helpers

  @Test func everyIntentBumpsTheGenerationAndAReconcileKeepsIt() {
    var state = SyncState(device: "a1b2c3d4", disclosed: true)
    state.markAddedHere(gatewayId: "g01", key: Self.key)
    state.markClearing(.sessionToken, gatewayId: "g01", key: Self.key)
    state.setSignedOut(true, gatewayId: "g01", key: Self.key)
    state.setGatewaySynced(false, gatewayId: "g01", key: Self.key)
    state.markRemoved(gatewayId: "g01", key: Self.key, scope: .thisDevice)
    #expect(state.generation == 5)

    let plan = GatewaySync.reconcile(
      local: LocalSyncSnapshot(gateways: [], newIds: [], printer: testPrinter), remote: [], state: state, now: startOfTime)
    #expect(plan.state.generation == 5)
  }

  @Test func resyncPublishesAnAbsentGatewayAgain() {
    var (world, ids) = Self.shared()
    world.setGatewaySynced(0, ids[0], false)
    world.settle()
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)

    world.devices[1].state.resync(gatewayId: ids[1])
    world.settle()

    #expect(world.devices[1].state.entries[ids[1]]?.detached == nil)
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
  }
}
