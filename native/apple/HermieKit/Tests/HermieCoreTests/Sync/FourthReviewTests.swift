import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One test (or more) per finding of the fourth review of the merge.
@Suite struct FourthReviewTests {
  static let address = "https://gateway.test"
  static let alpha = "https://alpha.gateway.test"
  static let key = GatewayKey.of(address)

  // MARK: 1. Only an add newer than the removal outranks it

  /// A Mac with sync off adds the gateway (day 5); the phone removes it from all devices (day 10);
  /// the Mac switches sync on (day 40). Its add is older than the removal: it stays on the Mac,
  /// device-only, and nothing of it (not its token, not its front door) goes out.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func anAddMadeWithSyncOffDoesNotUndoALaterRemovalEverywhere(conflict: TestCloud.ConflictPolicy) {
    var world = SyncWorld(devices: 2, conflict: conflict)
    world.setEnabled(1, false)
    let phone = world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()

    world.advance(5 * day)
    let mac = world.add(1, address: Self.address, name: "Mac", token: "tok-mac", frontDoorSecret: "door-mac")
    world.advance(5 * day)
    world.remove(0, phone, scope: .allDevices)
    world.settle()

    world.advance(30 * day)
    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.traces.contains(.addedBeforeRemovalKeptAbsent))
    #expect(!plan.remotePuts.contains { $0.isLive })
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.devices[1].gateways.map(\.id) == [mac])
    #expect(world.devices[1].state.entries[mac]?.detached == .absent)
  }

  /// The same with the Mac's add after the removal: that add outranks it and goes out.
  @Test func anAddMadeWithSyncOffAfterTheRemovalIsPublishedOverIt() {
    var world = SyncWorld(devices: 2)
    world.setEnabled(1, false)
    let phone = world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    world.advance(5 * day)
    world.remove(0, phone, scope: .allDevices)
    world.settle()

    world.advance(5 * day)
    world.add(1, address: Self.address, name: "Mac", token: "tok-mac")
    world.advance(30 * day)
    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.traces.contains(.readded))
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices[0].gateways.map(\.name) == ["Mac"])
  }

  // MARK: 2. A re-add is stamped above a remembered removal

  /// A removal from a clock running a year ahead; its item is pruned 200 days later where that
  /// clock says it is old. This device remembers it and re-adds the gateway after having seen it:
  /// the add counts as newer, and is stamped above the remembered tombstone, so the device that
  /// still remembers it does not cut it again.
  @Test func aReaddAfterARemovalFromAClockAheadIsStampedAboveIt() throws {
    var world = SyncWorld(devices: 2)
    world.devices[1].clockOffset = year
    world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    world.remove(1, world.devices[1].gateways[0].id, scope: .allDevices)
    world.settle()
    let removal = try #require(world.devices[0].state.tombstones[Self.key])
    #expect(world.devices[0].gateways.isEmpty)

    world.advance(200 * day)
    world.settle()
    #expect(world.cloudRecord(key: Self.key) == nil)

    world.advance(1_000)
    world.add(0, address: Self.address, name: "Again", token: "tok-2")
    let plan = world.reconcile(0)
    let address = try #require(plan.remotePuts.first?.registers[.address])
    #expect(address.stamp > removal.stamp)
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices[1].gateways.map(\.name) == ["Again"])
  }

  /// Found by the wide property run (seed 106150): a device whose clock runs a year behind, its
  /// item gone from its view, removes from all devices a second copy at an origin it also syncs.
  /// The tombstone is stamped above what it knows at the key, so the removal holds.
  @Test func aRemovalFromASlowClockOutranksWhatItKnowsAtTheKey() throws {
    var world = SyncWorld(devices: 2)
    world.devices[1].clockOffset = -year
    let phone = world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.add(0, address: Self.alpha, name: "Other")
    world.settle()
    let synced = try #require(world.devices[1].gateways.first { $0.key == Self.key })
    let copy = world.add(1, address: Self.address, name: "Copy")

    world.setGatewaySynced(0, phone, false)
    world.reconcile(0)
    world.cloud.deliverAll()
    world.remove(1, copy, scope: .allDevices)
    let plan = world.reconcile(1)

    let tombstone = try #require(plan.remotePuts.first { $0.key == Self.key }?.deleted)
    #expect(tombstone.t > world.devices[0].state.entries[phone]!.stamp(.address)!.t)
    #expect(!plan.remotePuts.contains { $0.key == Self.key && $0.isLive })
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(!world.devices[1].gateways.contains { $0.id == synced.id && world.devices[1].state.entries[$0.id]?.detached == nil })
  }

  // MARK: 5. Gateways detached by an empty store are announced

  @Test func gatewaysDetachedByAnEmptyStoreAreAnnouncedOnce() {
    var world = SyncWorld(devices: 2)
    world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    let unread = world.add(1, address: Self.alpha, name: "Unread")
    world.reconcile(1)
    world.cloud.deliverAll()

    world.deleteEverything(0)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)
    let ids = [world.devices[1].gateways.first { $0.key == Self.key }!.id, unread].sorted()

    #expect(plan.events == [.storeEmptied(gatewayIds: ids)])
    #expect(world.reconcile(1).events.isEmpty)
    #expect(!SyncEvent.storeEmptied(gatewayIds: ids).description.contains("tok"))
  }
}
