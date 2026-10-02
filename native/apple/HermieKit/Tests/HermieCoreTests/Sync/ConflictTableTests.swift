import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// One test per row of the conflict table in `.claude/plans/native-rewrite-icloud.md` ("Flows",
/// "Conflict"), each under both whole-item conflict policies of the keychain where the policy can
/// matter.
@Suite struct ConflictTableTests {
  static let address = "https://gateway.test"
  static let key = GatewayKey.of(address)
  static let policies = TestCloud.ConflictPolicy.allCases

  /// Two devices that already share one gateway.
  static func sharedGateway(conflict: TestCloud.ConflictPolicy, token: String? = "tok-1") -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: 2, conflict: conflict)
    world.add(0, address: address, name: "Home", token: token)
    world.settle()
    let ids = world.devices.map { $0.gateways.first!.id }
    return (world, ids)
  }

  // Row: "Two devices add the same gateway offline | same key, one item; fields merge by stamp;
  // one row on every device"
  @Test(arguments: policies)
  func twoDevicesAddTheSameGatewayOffline(conflict: TestCloud.ConflictPolicy) {
    var world = SyncWorld(devices: 2, conflict: conflict)
    world.add(0, address: Self.address, name: "Home", token: "tok-a")
    world.advance(1_000)
    world.add(1, address: Self.address + "/", name: "Lab", token: "tok-b")

    world.reconcile(0)
    world.advance(1_000)
    world.reconcile(1)
    world.cloud.deliverAll()
    world.settle()

    #expect(world.cloud.cloudItems.count == 1)
    for device in world.devices {
      #expect(device.gateways.count == 1)
      #expect(device.gateways.first?.name == "Lab")
      #expect(device.gateways.first?.sessionToken?.token == "tok-b")
      #expect(device.gateways.first?.addedAt == startOfTime)
    }
  }

  // Row: "Phone renames, Mac replaces the session token, both offline | both survive: different
  // registers"
  @Test(arguments: policies)
  func aRenameAndATokenReplacementMadeOfflineBothSurvive(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    world.advance(1_000)
    world.rename(0, ids[0], to: "Phone name")
    world.setToken(1, ids[1], to: "tok-2")
    world.reconcile(0)
    world.reconcile(1)
    world.cloud.deliverAll()
    world.settle()

    for device in world.devices {
      #expect(device.gateways.first?.name == "Phone name")
      #expect(device.gateways.first?.sessionToken?.token == "tok-2")
    }
  }

  // Row: "Both rename | later stamp wins, ties by device tag; the same result on every device"
  @Test(arguments: policies)
  func whenBothRenameTheLaterStampWins(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    world.advance(1_000)
    world.rename(1, ids[1], to: "Later")
    world.rename(0, ids[0], to: "Earlier")
    world.reconcile(0)
    world.advance(5)
    world.reconcile(1)
    world.cloud.deliverAll()
    world.settle()

    #expect(world.devices.map { $0.gateways.first?.name } == ["Later", "Later"])
  }

  @Test(arguments: policies)
  func whenBothRenameInTheSameMillisecondTheDeviceTagDecides(conflict: TestCloud.ConflictPolicy) {
    for order in [[0, 1], [1, 0]] {
      var (world, ids) = Self.sharedGateway(conflict: conflict)

      world.advance(1_000)
      world.rename(0, ids[0], to: "From a1b2c300")
      world.rename(1, ids[1], to: "From a1b2c301")
      for device in order { world.reconcile(device) }
      world.cloud.deliverAll()
      world.settle()

      // Same t on both sides; "a1b2c301" > "a1b2c300".
      #expect(world.devices.map { $0.gateways.first?.name } == ["From a1b2c301", "From a1b2c301"])
    }
  }

  // Row: "Remove from all devices on one, rename on another | removed (I4)". The rename is made
  // later than the removal and its whole item reaches the cloud last, so the keychain alone would
  // have kept the gateway.
  @Test(arguments: policies)
  func removingEverywhereWinsOverAConcurrentRename(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.advance(1_000)
    world.rename(1, ids[1], to: "Renamed")
    world.reconcile(1)
    world.cloud.deliverAll()
    world.settle()

    #expect(world.devices.allSatisfy { $0.gateways.isEmpty })
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[1].events.contains(.removedElsewhere(gatewayId: ids[1], name: "Renamed")))
  }

  // Row: "Remove from all devices on one, added again later on another | added: the newer address
  // register wins"
  @Test(arguments: policies)
  func addingAgainAfterARemovalEverywhereBringsItBack(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    world.remove(0, ids[0], scope: .allDevices)
    world.settle()
    #expect(world.devices.allSatisfy { $0.gateways.isEmpty })

    world.advance(60_000)
    world.add(1, address: Self.address, name: "Back again", token: "tok-new")
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    for device in world.devices {
      #expect(device.gateways.map(\.name) == ["Back again"])
      #expect(device.gateways.first?.sessionToken?.token == "tok-new")
    }
  }

  // Row: "A device's clock is a year ahead | its writes carry a high stamp; any later edit
  // elsewhere stamps above it and wins"
  @Test(arguments: policies)
  func aClockAYearAheadDoesNotBlockLaterEditsElsewhere(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)
    world.devices[1].clockOffset = year

    world.rename(1, ids[1], to: "From the future")
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.registers[.name]?.stamp.t == startOfTime + year)

    world.advance(1_000)
    world.rename(0, ids[0], to: "From the present")
    world.settle()

    #expect(world.devices.map { $0.gateways.first?.name } == ["From the present", "From the present"])
    let stamp = world.cloudRecord(key: Self.key)?.registers[.name]?.stamp
    #expect(stamp?.d == world.devices[0].state.device)
    #expect(stamp?.t ?? 0 > startOfTime + year)
  }

  // Row: "Item vanishes (deleted elsewhere, keychain reset, iCloud Keychain switched off) | local
  // entry kept and marked absent; nothing is purged, nothing is republished"
  @Test(arguments: policies)
  func anItemThatVanishesFromADeviceLeavesItsGatewayInPlace(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    world.cloud.wipeLocal(1)
    let plan = world.reconcile(1)

    #expect(plan.localOps.isEmpty)
    #expect(!plan.hasRemoteWrites)
    #expect(world.devices[1].gateways.map(\.id) == [ids[1]])
    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-1")
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
    #expect(world.reconcile(1).isEmpty)

    // Sync comes back: the item returns and the gateway attaches again by itself.
    world.cloud.rejoin(1)
    world.cloud.deliverAll()
    world.settle()
    #expect(world.devices[1].state.entries[ids[1]]?.detached == nil)
    #expect(world.cloud.cloudItems.count == 1)
  }

  @Test(arguments: policies)
  func anItemDeletedElsewhereLeavesTheGatewayAndIsNotRepublished(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.sharedGateway(conflict: conflict)

    // "Stop syncing this gateway" on device 0 deletes the item.
    world.setGatewaySynced(0, ids[0], false)
    world.settle()

    #expect(world.cloud.cloudItems.isEmpty)
    #expect(world.devices[1].gateways.map(\.id) == [ids[1]])
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
    #expect(world.devices[0].gateways.map(\.id) == [ids[0]])
    #expect(world.devices[0].state.entries[ids[0]]?.detached == .user)
  }

  // Row: "Record from a newer build (`v` above 1) | left alone; the local entry keeps working and is
  // not synced until the app is updated"
  @Test func aRecordFromANewerBuildIsLeftAlone() throws {
    var (world, ids) = Self.sharedGateway(conflict: .newestWrite)
    let newer = #"{"key":"\#(Self.key)","v":2,"whatever":{"comes":"next"}}"#
    world.cloud.put(0, account: SyncedGatewayRecord.account(forKey: Self.key), value: newer)
    world.cloud.deliverAll()
    let before = world.devices[1].state

    world.rename(1, ids[1], to: "Local edit")
    let plan = world.reconcile(1)

    #expect(plan.isEmpty)
    #expect(world.devices[1].state == before)
    #expect(world.cloud.cloudItems[SyncedGatewayRecord.account(forKey: Self.key)] == newer)

    // A device without the gateway does not adopt it either.
    var fresh = SyncWorld(devices: 1)
    fresh.cloud.put(0, account: SyncedGatewayRecord.account(forKey: Self.key), value: newer)
    #expect(fresh.reconcile(0).localOps.isEmpty)
  }

  // Row: "A device offline for more than 180 days still holds a gateway that was removed
  // everywhere | tombstone already pruned: the entry stays on that device, device-only"
  @Test func aTombstonePrunedWhileADeviceWasAwayLeavesItsGateway() {
    var world = SyncWorld(devices: 3)
    world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    let away = world.devices[2].gateways.first!.id

    // Device 2 is away: nothing reaches it until the end.
    world.cloud.wipeLocal(2)
    world.remove(0, world.devices[0].gateways.first!.id, scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll()
    world.reconcile(1)
    #expect(world.devices[1].gateways.isEmpty)

    world.advance(181 * day)
    let prune = world.reconcile(1)
    #expect(prune.remoteDeletes == [SyncedGatewayRecord.account(forKey: Self.key)])
    world.cloud.deliverAll()
    #expect(world.cloud.cloudItems.isEmpty)

    world.cloud.rejoin(2)
    world.cloud.deliverAll()
    let plan = world.reconcile(2)

    #expect(plan.localOps.isEmpty)
    #expect(world.devices[2].gateways.map(\.id) == [away])
    #expect(world.devices[2].state.entries[away]?.detached == .absent)
  }

  @Test func aTombstoneYoungerThan180DaysIsKept() {
    var (world, ids) = Self.sharedGateway(conflict: .newestWrite)
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()

    world.advance(179 * day)
    #expect(world.reconcile(1).remoteDeletes.isEmpty)
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }
}
