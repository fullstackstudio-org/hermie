import Foundation
import HermieGateway
import HermieStore
import Testing

@testable import HermieCore

/// The fifth merge round through the engine: removal and move times recorded by the intents.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineTimedIntentTests {
  /// The Mac moves a gateway on day 5 with sync off; the phone removes the gateway at the new
  /// address from all devices on day 10; the Mac switches sync on at day 40. The move is older
  /// than the removal: the gateway stays on the Mac only, and nothing is published over it.
  @Test func aMoveWithSyncOffIsOlderThanALaterRemovalElsewhere() async throws {
    let (world, ids) = try await sharedWorld()
    var notices = world[0].engine.events.makeAsyncIterator()
    try await world[0].engine.setSyncEnabled(false)
    let phoneMoved = try await addGateway(world[1], address: movedAddress, name: "Moved", token: "tok-phone")
    await world.settle()

    world.advance(5 * day)
    try await world[0].engine.changeAddress(of: ids[0], to: movedAddress)
    let entry = try #require(try await world[0].state()?.entries[ids[0]])
    #expect(entry.movedToKey == GatewayKey.of(movedAddress))
    #expect(entry.movedAt == world.clock.now)

    world.advance(5 * day)
    try await world[1].engine.removeGateway(id: phoneMoved, scope: .allDevices)
    await world.settle()
    #expect(world.cloudRecord(movedAddress)?.isTombstone == true)

    world.advance(30 * day)
    try await world[0].engine.setSyncEnabled(true)
    await world.settle()

    #expect(try await world[0].only().address == movedAddress)
    #expect(try await world[0].state()?.entries[ids[0]]?.detached == .absent)
    #expect(world.cloudRecord(movedAddress)?.isTombstone == true)
    #expect(try await world[1].gateways().allSatisfy { $0.address != movedAddress })

    world.cloud.setAvailability(.unavailable, on: "device0")
    await world[0].reconcile()
    var heard: [SyncNotice] = []
    while let notice = await notices.next(), notice != .unavailable { heard.append(notice) }
    #expect(heard.contains(.removedElsewhereKeptHere(gatewayIds: [ids[0]])))
  }

  /// "Remove from All Devices", the reconcile that should carry it fails, the person adds the
  /// gateway again: the re-add (newer than the removal) is what every device ends with.
  @Test(arguments: conflictPolicies)
  func aReAddAfterARemovalWhoseReconcileFailedIsPublished(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)

    world.advance(1_000)
    world.cloud.failNext(.all, on: "device0", with: .interactionNotAllowed)
    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world[0].engine.waitUntilIdle()
    #expect(try await world[0].state()?.entries[ids[0]]?.removedAt == world.clock.now)
    #expect(world.cloudRecord(homeAddress)?.isLive == true)

    world.advance(1_000)
    let again = try await addGateway(world[0], address: homeAddress, name: "Again", token: "tok-again")
    await world.settle()

    #expect(world.cloudRecord(homeAddress)?.isLive == true)
    #expect(try await world[0].only().id == again)
    let elsewhere = try await world[1].only()
    #expect(elsewhere.name == "Again")
    #expect(world[1].token(elsewhere.id) == "tok-again")
  }
}
