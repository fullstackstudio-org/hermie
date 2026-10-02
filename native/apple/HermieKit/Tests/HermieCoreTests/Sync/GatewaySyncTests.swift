import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The rules of `GatewaySync.reconcile` one at a time: gates, local removal, detaching, sign-out,
/// origins (I13), limits (I16), and what counts as published.
@Suite struct GatewaySyncTests {
  static let address = "https://gateway.test"
  static let key = GatewayKey.of(address)
  static let account = SyncedGatewayRecord.account(forKey: key)

  static func shared(devices: Int = 2, conflict: TestCloud.ConflictPolicy = .newestWrite) -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: devices, conflict: conflict)
    world.add(0, address: address, name: "Home", token: "tok-1", frontDoorSecret: "door-1")
    world.settle()
    return (world, world.devices.map { $0.gateways.first!.id })
  }

  // MARK: Unchanged state

  @Test func reconcilingAnUnchangedStateProducesAnEmptyPlan() {
    var (world, ids) = Self.shared(devices: 3)
    world.add(1, address: "https://alpha.gateway.test", name: "Alpha", authKind: "native_pkce")
    world.add(2, address: "http://beta.gateway.test:8080", name: "Beta", frontDoorSecret: "withheld")
    world.add(2, address: Self.address + "/second", name: "Second account")  // duplicateOrigin
    world.settle()
    world.setGatewaySynced(1, ids[1], false)
    world.signOut(2, ids[2])
    world.settle()

    for device in world.devices.indices {
      world.advance(5_000)
      #expect(world.reconcile(device).isEmpty)
    }
  }

  @Test func nothingHappensWhileSyncIsOffUndisclosedOrTheStateIsForeign() {
    var world = SyncWorld(devices: 1)
    world.add(0, address: Self.address)

    world.devices[0].state.enabled = false
    #expect(world.plan(0) == SyncPlan(state: world.devices[0].state))

    world.devices[0].state.enabled = true
    world.devices[0].state.disclosed = false
    #expect(world.plan(0).isEmpty)

    world.devices[0].state.disclosed = true
    world.devices[0].state.device = ""
    #expect(world.plan(0).isEmpty)

    let foreign = SyncState.decode(#"{"v":2,"device":"a1b2c300"}"#)!
    #expect(foreign.unsupportedVersion == "2")
    world.devices[0].state = foreign
    #expect(world.plan(0).isEmpty)
  }

  // MARK: Removal

  @Test func removingFromThisDeviceHidesTheKeyAndLeavesTheRest() {
    var (world, ids) = Self.shared()

    world.remove(1, ids[1], scope: .thisDevice)
    let plan = world.reconcile(1)
    world.settle()

    #expect(!plan.hasRemoteWrites)
    #expect(world.devices[1].gateways.isEmpty)
    #expect(world.devices[1].state.hidden == [Self.key])
    #expect(world.devices[0].gateways.map(\.id) == [ids[0]])
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)

    // Adding it again on this device clears the key from `hidden` and attaches again.
    world.add(1, address: Self.address, name: "Again")
    world.settle()
    #expect(world.devices[1].state.hidden.isEmpty)
    #expect(world.devices[1].gateways.first.map { world.devices[1].state.entries[$0.id]?.detached } == .some(nil))
    #expect(world.cloud.cloudItems.count == 1)
  }

  @Test func aRemoteTombstonePurgesTheGatewayAndAnnouncesIt() throws {
    var (world, ids) = Self.shared()

    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)

    #expect(plan.localOps == [.purge(gatewayId: ids[1])])
    #expect(plan.events == [.removedElsewhere(gatewayId: ids[1], name: "Home")])
    #expect(plan.state.entries[ids[1]] == nil)
    #expect(plan.state.hidden.isEmpty)
    let tombstone = world.cloudRecord(key: Self.key)!
    #expect(try tombstone.encoded() == #"{"deleted":{"d":"a1b2c300","t":\#(Int(startOfTime) + 1)},"key":"\#(Self.key)","v":1}"#)
  }

  /// Found by the property test (seed 589): a device that never saw a removal merges its older
  /// credential into the re-added gateway; when the remembered tombstone comes back and cuts it,
  /// the device drops it in the same reconcile instead of publishing it again one reconcile later.
  @Test func aCredentialFromBeforeARemovalDoesNotComeBackWithTheReaddedGateway() throws {
    var world = SyncWorld(devices: 3, conflict: .newestWrite)
    world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()

    world.advance(1_000)
    world.remove(0, world.devices[0].gateways[0].id, scope: .allDevices)
    #expect(world.reconcile(0).state.tombstones[Self.key]?.stamp.t == startOfTime + 1_000)

    // Device 2 adds the gateway again without having seen the removal; its whole item lands last.
    let reborn = #"""
      {"addedAt":\#(Int(startOfTime) + 2_000),"address":{"d":"a1b2c302","t":\#(Int(startOfTime) + 2_000),"v":"https://gateway.test"},\#
      "authKind":{"d":"a1b2c302","t":\#(Int(startOfTime) + 2_000),"v":"native_pkce"},"key":"\#(Self.key)",\#
      "name":{"d":"a1b2c302","t":\#(Int(startOfTime) + 2_000),"v":"Again"},"v":1}
      """#
    world.cloud.put(2, account: Self.account, value: reborn)
    world.cloud.deliverAll()

    // Device 1 merges its token from before the removal into it.
    world.advance(1_000)
    #expect(world.reconcile(1).remotePuts.first?.sessionToken?.token == "tok-1")
    world.cloud.deliverAll()

    // Device 0 still remembers the removal: everything written before it is cut.
    let reassert = world.reconcile(0)
    #expect(reassert.remotePuts.first?.deleted?.t == startOfTime + 1_000)
    #expect(reassert.remotePuts.first?.sessionToken == nil)
    world.cloud.deliverAll()

    let drop = world.reconcile(1)
    #expect(drop.localOps.map(\.description) == ["update(\(world.devices[1].gateways[0].id), [\"sessionToken\"])"])
    #expect(!drop.hasRemoteWrites)
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(world.reconcile(1).isEmpty)
  }

  // MARK: Detaching

  @Test func stoppingSyncForOneGatewayDeletesItsItemOnce() {
    var (world, ids) = Self.shared()

    world.setGatewaySynced(0, ids[0], false)
    let first = world.reconcile(0)
    let second = world.reconcile(0)

    #expect(first.remoteDeletes == [Self.account])
    #expect(first.state.entries[ids[0]]?.stamps.isEmpty == true)
    #expect(second.isEmpty)

    world.cloud.deliverAll()
    world.reconcile(1)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)

    // Switched on again: published again, and the absent copy elsewhere attaches by itself.
    world.setGatewaySynced(0, ids[0], true)
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices.allSatisfy { $0.state.entries.values.allSatisfy { $0.detached == nil } })
  }

  @Test func twoLocalEntriesAtOneOriginSyncOnlyTheOldest() {
    var world = SyncWorld(devices: 2)
    let first = world.add(0, address: Self.address, name: "Personal")
    world.advance(1_000)
    let second = world.add(0, address: Self.address + "/team", name: "Team")
    world.settle()

    #expect(world.devices[0].state.entries[first]?.detached == nil)
    #expect(world.devices[0].state.entries[second]?.detached == .duplicateOrigin)
    #expect(world.cloud.cloudItems.count == 1)
    #expect(world.devices[1].gateways.map(\.name) == ["Personal"])

    // Removing the synced one does not promote the other.
    world.remove(0, first, scope: .thisDevice)
    world.settle()
    #expect(world.devices[0].state.entries[second]?.detached == .duplicateOrigin)
  }

  // MARK: Signing out

  @Test func signingOutHereIsNotUndoneBySync() {
    var (world, ids) = Self.shared()

    world.signOut(1, ids[1])
    world.settle()

    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(world.devices[0].gateways.first?.sessionToken?.token == "tok-1")
    #expect(world.cloudRecord(key: Self.key)?.sessionToken?.token == "tok-1")

    // The token changes elsewhere: still not put back here.
    world.advance(1_000)
    world.setToken(0, ids[0], to: "tok-2")
    world.settle()
    #expect(world.devices[1].gateways.first?.sessionToken == nil)

    // Signing in again here with a new token publishes it.
    world.advance(1_000)
    world.setToken(1, ids[1], to: "tok-3")
    world.settle()
    #expect(world.devices.map { $0.gateways.first?.sessionToken?.token } == ["tok-3", "tok-3"])
  }

  @Test func signingOutOnAllDevicesClearsTheTokenEverywhere() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.signOutEverywhere(0, ids[0])
    world.reconcile(0)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)

    #expect(world.cloudRecord(key: Self.key)?.registers[.sessionToken]?.value == .null)
    #expect(world.devices[1].gateways.first?.sessionToken == nil)
    #expect(world.devices[1].gateways.first?.frontDoor?.clientSecret == "door-1")
    #expect(plan.events == [.needsSignIn(gatewayId: ids[1])])
  }

  // MARK: Origins (I13)

  @Test func anOriginChangeIsATombstoneAndANewRecordAndCarriesNoCredential() {
    var (world, ids) = Self.shared()
    let newAddress = "https://alpha.gateway.test"
    let newKey = GatewayKey.of(newAddress)

    world.advance(1_000)
    world.setAddress(0, ids[0], to: newAddress)
    let plan = world.reconcile(0)

    #expect(plan.remotePuts.map(\.key).sorted() == [Self.key, newKey].sorted())
    #expect(plan.remotePuts.first { $0.key == Self.key }?.isTombstone == true)
    let moved = plan.remotePuts.first { $0.key == newKey }!
    #expect(moved.isLive)
    #expect(moved.sessionToken == nil)
    #expect(moved.frontDoor == nil)

    world.cloud.deliverAll()
    world.settle()

    let other = world.devices[1]
    #expect(other.gateways.count == 1)
    #expect(other.gateways.first?.id != ids[1])
    #expect(other.gateways.first?.address == newAddress)
    #expect(other.gateways.first?.sessionToken == nil)
    #expect(other.gateways.first?.frontDoor == nil)
    #expect(other.events.contains(.removedElsewhere(gatewayId: ids[1], name: "Home")))
  }

  @Test func aCredentialBoundToAnotherOriginIsNeverApplied() throws {
    var world = SyncWorld(devices: 1)
    let record = #"""
      {"address":{"d":"a1b2c399","t":5,"v":"https://gateway.test"},"authKind":{"d":"a1b2c399","t":5,"v":"session_token"},\#
      "frontDoor":{"d":"a1b2c399","t":5,"v":{"clientId":"id","clientSecret":"s","kind":"cloudflare-access","origin":"https://elsewhere.test"}},\#
      "key":"\#(Self.key)","name":{"d":"a1b2c399","t":5,"v":"Home"},\#
      "sessionToken":{"d":"a1b2c399","t":5,"v":{"origin":"https://elsewhere.test","token":"stolen"}},"v":1}
      """#
    world.cloud.put(0, account: Self.account, value: record)

    let plan = world.reconcile(0)
    guard case let .add(gateway)? = plan.localOps.first else {
      Issue.record("not adopted")
      return
    }

    #expect(gateway.sessionToken == nil)
    #expect(gateway.frontDoor == nil)
    #expect(plan.events.contains(.needsSignIn(gatewayId: gateway.id)))
  }

  @Test func aFrontDoorOnACleartextGatewayIsNeverSynced() {
    var world = SyncWorld(devices: 2)
    world.add(0, address: "http://beta.gateway.test:8080", name: "Beta", frontDoorSecret: "withheld")
    world.settle()

    #expect(world.cloudRecord(key: GatewayKey.of("http://beta.gateway.test:8080"))?.frontDoor == nil)
    #expect(world.devices[1].gateways.first?.frontDoor == nil)
    #expect(world.devices[0].gateways.first?.frontDoor?.clientSecret == "withheld")
  }

  @Test func aRecordWhoseAddressDoesNotHashToItsKeyIsIgnored() {
    var world = SyncWorld(devices: 1)
    let wrong = #"{"address":{"d":"x","t":5,"v":"https://elsewhere.test"},"key":"\#(Self.key)","v":1}"#
    world.cloud.put(0, account: Self.account, value: wrong)
    world.add(0, address: Self.address)

    let plan = world.reconcile(0)

    #expect(plan.localOps.isEmpty)
    #expect(!plan.hasRemoteWrites)
    #expect(SyncedGatewayRecord.decode(account: Self.account, value: wrong)?.foreign == .invalid)
  }

  // MARK: Limits (I16)

  @Test func noNewItemIsWrittenPastSixtyFour() {
    var world = SyncWorld(devices: 1)
    for index in 0..<64 {
      let address = "https://g\(index).gateway.test"
      let tombstone = #"{"deleted":{"d":"x","t":\#(Int(startOfTime))},"key":"\#(GatewayKey.of(address))","v":1}"#
      world.cloud.put(0, account: SyncedGatewayRecord.account(forKey: GatewayKey.of(address)), value: tombstone)
    }
    let id = world.add(0, address: Self.address)

    let first = world.reconcile(0)
    #expect(first.remotePuts.isEmpty)
    #expect(world.devices[0].state.entries[id]?.seen == false)
    #expect(world.reconcile(0).isEmpty)

    // A tombstone pruned makes room.
    world.advance(181 * day)
    let later = world.reconcile(0)
    #expect(later.remoteDeletes.count == 64)
    #expect(later.remotePuts.map(\.key) == [Self.key])
  }

  @Test func aRecordOverEightKilobytesKeepsItsHeadersOnTheDevice() throws {
    var world = SyncWorld(devices: 2)
    let id = world.add(0, address: Self.address, token: "tok-1")
    let origin = GatewayAddress.origin(of: Self.address)
    let big = Dictionary(uniqueKeysWithValues: (0..<200).map { ("X-Header-\($0)", String(repeating: "v", count: 40)) })
    world.edit(0, id) { $0.headers = SyncHeaders(origin: origin, headers: big) }

    world.settle()

    let record = try #require(world.cloudRecord(key: Self.key))
    #expect(record.headers == nil)
    #expect(record.sessionToken?.token == "tok-1")
    #expect(try record.encoded().utf8.count <= SyncedGatewayRecord.maximumBytes)
    #expect(world.devices[0].gateways.first?.headers?.headers.count == 200)
    #expect(world.devices[1].gateways.first?.headers == nil)
    #expect(world.reconcile(0).isEmpty)
  }

  // MARK: What counts as published

  /// The device's own write is not proof the item reached iCloud: when the cloud refuses it, the
  /// next reconcile publishes again instead of calling the gateway absent.
  @Test func anOwnWriteTheCloudRefusedIsPublishedAgain() {
    var world = SyncWorld(devices: 2, conflict: .cloudWins)
    // The account was used before and deleted; device 1 never had a copy.
    world.add(0, address: Self.address)
    world.settle()
    world.setGatewaySynced(0, world.devices[0].gateways[0].id, false)
    world.settle()
    world.remove(1, world.devices[1].gateways[0].id, scope: .thisDevice)
    world.reconcile(1)
    world.cloud.wipeLocal(1)
    world.cloud.rejoin(1)

    let id = world.add(1, address: Self.address, name: "New here")
    let publish = world.reconcile(1)
    #expect(publish.remotePuts.map(\.key) == [Self.key])
    world.cloud.deliverAll()
    #expect(world.cloud.refused == 1)
    #expect(world.cloud.items(1).isEmpty)

    let retry = world.reconcile(1)
    #expect(world.devices[1].state.entries[id]?.detached == nil)
    #expect(retry.remotePuts.map(\.key) == [Self.key])
    world.cloud.deliverAll()
    #expect(world.cloudRecord(key: Self.key)?.name == "New here")
  }

  @Test func aRegisterLostToAWholeItemWriteIsWrittenAgain() {
    var (world, ids) = Self.shared(conflict: .newestWrite)

    // Both edit; device 1's whole item reaches the cloud last and drops device 0's rename.
    world.advance(1_000)
    world.rename(0, ids[0], to: "Renamed on 0")
    world.setToken(1, ids[1], to: "tok-2")
    world.reconcile(0)
    world.reconcile(1)
    world.cloud.deliverAll()
    #expect(world.cloudRecord(key: Self.key)?.name == "Home")

    let again = world.reconcile(0)
    #expect(again.remotePuts.first?.name == "Renamed on 0")
    #expect(again.remotePuts.first?.sessionToken?.token == "tok-2")
  }

  // MARK: New devices

  @Test func aNewDeviceAdoptsEveryLiveRecordWithFreshIds() {
    var newcomer = SyncWorld(devices: 2)
    newcomer.cloud.wipeLocal(1)
    newcomer.add(0, address: Self.address, name: "Home", token: "tok-1", frontDoorSecret: "door-1")
    newcomer.advance(1_000)
    newcomer.add(0, address: "https://alpha.gateway.test", name: "Alpha", authKind: "native_pkce")
    newcomer.settle()
    #expect(newcomer.devices[1].gateways.isEmpty)

    // The new device signs in to iCloud: every item arrives.
    newcomer.cloud.rejoin(1)

    #expect(GatewaySync.adoptable(newcomer.records(1)).map(\.name) == ["Home", "Alpha"])
    let plan = newcomer.reconcile(1)
    let added = plan.localOps.compactMap { op -> LocalGateway? in
      if case let .add(gateway) = op { return gateway }
      return nil
    }

    #expect(added.map(\.name) == ["Home", "Alpha"])
    #expect(added.allSatisfy { $0.id.hasPrefix("g01") })
    #expect(added.first?.sessionToken?.token == "tok-1")
    #expect(added.first?.frontDoor?.clientSecret == "door-1")
    #expect(plan.events.contains(.needsSignIn(gatewayId: added[1].id)))
    #expect(!plan.events.contains(.needsSignIn(gatewayId: added[0].id)))
    #expect(!plan.hasRemoteWrites)
    #expect(newcomer.reconcile(1).isEmpty)
  }
}
