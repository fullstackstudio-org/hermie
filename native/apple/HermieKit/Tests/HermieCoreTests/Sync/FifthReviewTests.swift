import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One test (or more) per finding of the fifth review of the merge: when things happened.
@Suite struct FifthReviewTests {
  static let address = "https://gateway.test"
  static let alpha = "https://alpha.gateway.test"
  static let key = GatewayKey.of(address)
  static let alphaKey = GatewayKey.of(alpha)

  static func shared(devices: Int = 2) -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: devices)
    world.add(0, address: address, name: "Home", token: "tok-1")
    world.settle()
    return (world, world.devices.map { $0.gateways.first!.id })
  }

  // MARK: 1. A re-add after this device's own removal, in the same reconcile

  /// The person removes the gateway from all devices (t), the reconcile never runs, the person adds
  /// it again (t + 50 s), and only then a reconcile runs: the tombstone goes out and the new add is
  /// published over it, on every device.
  @Test func aReaddBeforeTheRemovalWasReconciledIsPublished() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.advance(50_000)
    let again = world.add(0, address: Self.address, name: "Again", token: "tok-2")
    world.advance(10_000)
    let plan = world.reconcile(0)

    #expect(plan.traces.contains(.readded))
    #expect(plan.events.isEmpty)
    #expect(plan.state.entries[again]?.detached == nil)
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices.map { $0.gateways.map(\.name) } == [["Again"], ["Again"]])
  }

  /// Found by the wide property run (seed 104185): removed, added, removed and added again, all
  /// before one reconcile. The last add follows the last removal, and goes out.
  @Test func aReaddAfterTwoOwnRemovalsInOneReconcileIsPublished() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.advance(1_000)
    let second = world.add(0, address: Self.address, name: "Second")
    world.advance(1_000)
    world.remove(0, second, scope: .allDevices)
    world.advance(1_000)
    let third = world.add(0, address: Self.address, name: "Third")
    world.advance(1_000)
    let plan = world.reconcile(0)

    #expect(plan.events.isEmpty)
    #expect(plan.state.entries[third]?.detached == nil)
    world.settle()
    #expect(world.devices[1].gateways.map(\.name) == ["Third"])
  }

  /// Found by the wide property run (seed 111400): a removal the record was already re-added over
  /// is no longer in effect. On a device whose clock runs a year behind, a re-add after its own
  /// removal is not judged against that old one.
  @Test func anOverriddenRemovalDoesNotHoldBackAReaddAfterTheDevicesOwn() {
    var world = SyncWorld(devices: 2)
    world.devices[1].clockOffset = -year
    let first = world.add(0, address: Self.address, name: "Home")
    world.settle()
    world.remove(0, first, scope: .allDevices)
    world.settle()
    world.advance(1_000)
    let again = world.add(1, address: Self.address, name: "Again")
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.cloudRecord(key: Self.key)?.deleted != nil)

    world.advance(1_000)
    world.remove(1, again, scope: .allDevices)
    world.advance(1_000)
    let third = world.add(1, address: Self.address, name: "Third")
    world.advance(1_000)
    let plan = world.reconcile(1)

    #expect(plan.events.isEmpty)
    #expect(plan.state.entries[third]?.detached == nil)
    world.settle()
    #expect(world.devices[0].gateways.map(\.name) == ["Third"])
  }

  /// A copy added between two own removals at the key, all before one reconcile, is older than the
  /// later removal: it stays here, device-only, announced.
  @Test func aCopyAddedBetweenTwoOwnRemovalsIsKeptHere() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.advance(1_000)
    let kept = world.add(0, address: Self.address, name: "Kept")
    world.advance(1_000)
    let gone = world.add(0, address: Self.address, name: "Gone")
    world.advance(1_000)
    world.remove(0, gone, scope: .allDevices)
    world.advance(1_000)
    let plan = world.reconcile(0)

    #expect(plan.events == [.removedElsewhereKeptHere(gatewayIds: [kept])])
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[1].gateways.isEmpty)
  }

  /// The same, but another device removed the gateway everywhere after the re-add and before the
  /// reconcile: the re-add is older than that removal, which this device's own tombstone covers.
  @Test func aReaddDoesNotOutrankANewerRemovalItsOwnTombstoneCovers() {
    var (world, ids) = Self.shared()

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.advance(50_000)
    let again = world.add(0, address: Self.address, name: "Again", token: "tok-2")
    world.advance(50_000)
    world.remove(1, ids[1], scope: .allDevices)
    world.reconcile(1)
    world.cloud.deliverAll()
    world.advance(10_000)
    let plan = world.reconcile(0)

    #expect(plan.traces.contains(.addedBeforeRemovalKeptAbsent))
    #expect(plan.events == [.removedElsewhereKeptHere(gatewayIds: [again])])
    #expect(!plan.remotePuts.contains { $0.isLive })
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[1].gateways.isEmpty)
  }

  // MARK: 2. A move is an add as of the move, not of the reconcile

  /// A Mac with sync off moves a gateway to origin B (day 5); a phone removes B on all devices
  /// (day 10); the Mac switches sync on (day 40). The move is older than the removal: the gateway
  /// stays on the Mac, device-only, announced, and its token and front door do not go out.
  @Test func aMoveMadeWithSyncOffDoesNotUndoALaterRemovalOfItsNewOrigin() {
    var world = SyncWorld(devices: 2)
    world.setEnabled(1, false)
    let phone = world.add(0, address: Self.alpha, name: "B", token: "tok-b")
    world.settle()
    let mac = world.add(1, address: Self.address, name: "Mac", token: "tok-mac", frontDoorSecret: "door-mac")
    world.reconcile(1)

    world.advance(5 * day)
    world.setAddress(1, mac, to: Self.alpha)
    world.advance(5 * day)
    world.remove(0, phone, scope: .allDevices)
    world.settle()

    world.advance(30 * day)
    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.events == [.removedElsewhereKeptHere(gatewayIds: [mac])])
    #expect(!plan.remotePuts.contains { $0.isLive })
    #expect(world.cloudRecord(key: Self.alphaKey)?.isTombstone == true)
    #expect(world.devices[0].gateways.isEmpty)
    #expect(world.devices[1].state.entries[mac]?.detached == .absent)
  }

  /// The same move made after the removal is published over it.
  @Test func aMoveMadeWithSyncOffAfterTheRemovalIsPublishedOverIt() {
    var world = SyncWorld(devices: 2)
    world.setEnabled(1, false)
    let phone = world.add(0, address: Self.alpha, name: "B", token: "tok-b")
    world.settle()
    let mac = world.add(1, address: Self.address, name: "Mac", token: "tok-mac")
    world.reconcile(1)

    world.advance(5 * day)
    world.remove(0, phone, scope: .allDevices)
    world.settle()
    world.advance(5 * day)
    world.setAddress(1, mac, to: Self.alpha)

    world.advance(30 * day)
    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    world.settle()

    #expect(plan.traces.contains(.readded))
    #expect(world.cloudRecord(key: Self.alphaKey)?.isLive == true)
    #expect(world.devices[0].gateways.map(\.name) == ["Mac"])
  }

  /// Found by the wide property run (seed 101290): a move away is no removal of the key it leaves.
  /// A second gateway this device added at that origin before the move, and that reaches the same
  /// reconcile as the move, takes the key over.
  @Test func aSiblingTakesOverTheKeyAMoveLeaves() {
    var (world, ids) = Self.shared()
    world.advance(1_000)
    world.add(0, address: Self.address, name: "Second")

    world.advance(1_000)
    world.setAddress(0, ids[0], to: Self.alpha)
    let plan = world.reconcile(0)
    world.settle()

    #expect(!plan.events.contains { if case .removedElsewhereKeptHere = $0 { true } else { false } })
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(Set(world.devices[1].gateways.map(\.name)) == ["Home", "Second"])
  }

  /// A move the engine did not record (a state from before `markMoved`) counts as of the reconcile
  /// that sees it, as before.
  @Test func anUnrecordedMoveCountsAsOfTheReconcile() {
    var world = SyncWorld(devices: 1)
    let id = world.add(0, address: Self.address, name: "Home")
    world.settle()
    world.advance(1_000)
    world.edit(0, id) { $0.address = Self.alpha }
    let plan = world.reconcile(0)

    #expect(plan.state.entries[id]?.key == Self.alphaKey)
    #expect(plan.remotePuts.contains { $0.key == Self.alphaKey && $0.isLive })
  }
}
