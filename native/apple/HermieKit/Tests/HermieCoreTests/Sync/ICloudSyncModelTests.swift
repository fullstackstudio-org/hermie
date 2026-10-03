import Foundation
import HermieGateway
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// `ICloudSyncModel` against real engines on a shared `FakeCloud`: what Settings, the gateway
/// badges and the disclosure read, and what their actions do to the engine and to iCloud.
@MainActor
@Suite(.timeLimit(.minutes(5))) struct ICloudSyncModelTests {
  /// One device's model over its engine and its own gateway list.
  @MainActor
  struct Screen {
    let device: EngineDevice
    let directory: GatewayDirectory
    let model: ICloudSyncModel

    init(_ device: EngineDevice) async {
      self.device = device
      directory = GatewayDirectory(
        store: GatewayRegistryStore(store: device.database), changes: KeyValueStore(store: device.database),
        remover: device.engine)
      await directory.load()
      model = ICloudSyncModel(engine: device.engine, directory: directory)
      model.start()
    }

    /// Wait until the engine is idle, the list has caught up and the model has settled.
    func idle() async {
      await device.engine.waitUntilIdle()
      await directory.load()
      await settle(model)
    }
  }

  /// Let the model's observation and the event stream run, then wait for the records it reads.
  static func settle(_ model: ICloudSyncModel) async {
    for _ in 0..<50 { await Task.yield() }
    await model.availableSettled()
    for _ in 0..<50 { await Task.yield() }
  }

  /// Writes a device made to iCloud Keychain.
  static func writes(of device: EngineDevice, in world: EngineWorld) -> [FakeCloud.Write] {
    world.cloud.writes().filter { $0.device == device.name }
  }

  // MARK: The disclosure

  @Test func theDisclosureIsDueOnlyWithSomethingToSyncAndGoesOnceAnswered() async throws {
    let world = try EngineWorld(1)
    let screen = await Screen(world[0])

    await world[0].reconcile()
    await screen.idle()
    #expect(screen.model.status.availability == .available)
    #expect(!screen.model.needsDisclosure, "no gateway here and nothing in iCloud")

    try await addGateway(world[0], address: homeAddress)
    await screen.idle()
    #expect(screen.model.needsDisclosure)
    #expect(screen.model.phase == .awaitingAnswer)
    #expect(world.cloud.writes().isEmpty, "nothing is written before the answer")

    await screen.model.acceptDisclosure()
    await world[0].reconcile()
    await screen.idle()
    #expect(!screen.model.needsDisclosure)
    #expect(screen.model.isOn)
    #expect(!Self.writes(of: world[0], in: world).isEmpty)

    // Once per device: a new launch on the same stores does not ask again.
    var device = world[0]
    device.restart()
    let again = await Screen(device)
    await device.reconcile()
    await again.idle()
    #expect(!again.model.needsDisclosure)
  }

  @Test func aNewDeviceWithRecordsInICloudIsAskedBeforeTakingThem() async throws {
    let world = try EngineWorld(2)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-1")
    await world.settle()

    let screen = await Screen(world[1])
    await world[1].reconcile()
    await screen.idle()

    // The launch does not look in iCloud before the answer; the onboarding does.
    #expect(screen.model.available.isEmpty)
    #expect(!screen.model.needsDisclosure)
    screen.model.lookInICloud()
    await screen.idle()

    #expect(try await world[1].gateways().isEmpty)
    #expect(screen.model.available.map(\.address) == [homeAddress])
    #expect(screen.model.available.first?.removedHere == false)
    #expect(screen.model.needsDisclosure)

    await screen.model.acceptDisclosure()
    await world.settle()
    await screen.idle()
    #expect(try await world[1].only().address == homeAddress)
    #expect(screen.model.available.isEmpty)
  }

  /// Setup's "Use These Gateways": taking them is the answer, and each comes with its id here.
  @Test func useTheseGatewaysInSetupAdoptsEveryOfferAndAnswersTheDisclosure() async throws {
    let world = try EngineWorld(2)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-1")
    try await addGateway(world[0], address: "https://lab.test", name: "Lab", token: nil)
    await world.settle()

    let screen = await Screen(world[1])
    screen.model.lookInICloud()
    await screen.idle()
    #expect(screen.model.available.count == 2)

    let results = await screen.model.useAvailable()
    await world.settle()
    await screen.idle()

    let ids = Dictionary(uniqueKeysWithValues: try await world[1].gateways().map { ($0.address, $0.id) })
    // In the order offered (oldest first; these two were added in the same millisecond).
    #expect(results.count == 2)
    #expect(results.contains(ICloudSyncModel.AddResult(gatewayId: ids[homeAddress], needsSignIn: false)))
    #expect(results.contains(ICloudSyncModel.AddResult(gatewayId: ids["https://lab.test"], needsSignIn: true)))
    #expect(screen.model.status.disclosed)
    #expect(screen.model.isOn)
    #expect(world[1].token(try #require(ids[homeAddress])) == "tok-1")
    #expect(screen.model.signInNeeded == [try #require(ids["https://lab.test"])])
    #expect(screen.model.available.isEmpty)
  }

  @Test func decliningWritesNothingEver() async throws {
    let world = try EngineWorld(1)
    let screen = await Screen(world[0])
    try await addGateway(world[0], address: homeAddress)
    await world[0].reconcile()
    await screen.idle()
    #expect(screen.model.needsDisclosure)

    await screen.model.declineDisclosure()
    await screen.idle()
    #expect(!screen.model.needsDisclosure)
    #expect(!screen.model.isOn)
    #expect(screen.model.phase == .off)

    // Time passes, gateways are added, sync is asked for: still nothing in iCloud.
    for round in 0..<3 {
      world.advance(60_000)
      try await addGateway(world[0], address: "https://gateway\(round).test")
      await world[0].reconcile()
      await screen.model.syncNow()
    }

    // Turning the switch on asks first, and turns nothing on by itself.
    await screen.model.turnOn()
    await screen.idle()
    #expect(screen.model.disclosureRequested)
    #expect(screen.model.showsDisclosure)
    #expect(!screen.model.status.enabled)
    await world[0].reconcile()

    #expect(world.cloud.writes().isEmpty)
    #expect(world.cloud.cloudItems().isEmpty)

    // Answering it there is what turns sync on.
    await screen.model.acceptDisclosure()
    await world[0].reconcile()
    await screen.idle()
    #expect(screen.model.isOn)
    #expect(!screen.model.disclosureRequested)
    #expect(world.cloud.cloudItems().count == 4)
  }

  @Test func anUnavailableStoreNeverAsksAndDisablesTheSwitch() async throws {
    let world = try EngineWorld(1)
    world.cloud.setAvailability(.unavailable, on: "device0")
    let screen = await Screen(world[0])
    try await addGateway(world[0], address: homeAddress)
    await world[0].reconcile()
    await screen.idle()

    #expect(screen.model.phase == .unavailable)
    #expect(!screen.model.needsDisclosure)
    #expect(!screen.model.canChangeSwitch)
    #expect(screen.model.available.isEmpty)
    #expect(screen.model.badge(for: try await world[0].only().id) == nil)

    // Asking from Settings shows nothing either.
    await screen.model.turnOn()
    #expect(!screen.model.showsDisclosure)
  }

  // MARK: The switches

  @Test func switchingOffKeepsICloudUnlessAskedToRemove() async throws {
    let (world, ids) = try await sharedWorld()
    let screen = await Screen(world[0])
    await screen.idle()
    #expect(screen.model.rows.map(\.state) == [.synced])
    #expect(screen.model.badge(for: ids[0]) == .synced)

    await screen.model.turnOff(removingFromICloud: false)
    await screen.idle()
    #expect(!screen.model.isOn)
    #expect(screen.model.rows.map(\.state) == [.off])
    #expect(screen.model.badge(for: ids[0]) == nil)
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
    #expect(try await world[0].only().id == ids[0])

    await screen.model.turnOn()
    await world.settle()
    await screen.idle()
    #expect(screen.model.isOn)
    #expect(screen.model.rows.map(\.state) == [.synced])

    await screen.model.turnOff(removingFromICloud: true)
    await screen.idle()
    #expect(!screen.model.isOn)
    world.cloud.deliverAll()
    #expect(world.cloud.cloudItems().isEmpty, "this device's gateways left iCloud Keychain")
    #expect(try await world[0].only().id == ids[0], "and stayed here")

    // The other device keeps its copy, device-only.
    await world.settle()
    #expect(try await world[1].only().id == ids[1])
    #expect(world[1].token(ids[1]) == "tok-1")
  }

  @Test func syncThisGatewayDeletesAndRepublishesItsItem() async throws {
    let (world, ids) = try await sharedWorld()
    let screen = await Screen(world[0])
    await screen.idle()
    let row = try #require(screen.model.rows.first)
    #expect(row.syncThisGateway && row.canToggle)

    await screen.model.setSynced(false, gatewayId: ids[0])
    await world.settle()
    await screen.idle()
    #expect(screen.model.rows.first?.state == .thisDeviceOnly)
    #expect(screen.model.rows.first?.syncThisGateway == false)
    #expect(screen.model.badge(for: ids[0]) == .thisDeviceOnly)
    #expect(!screen.model.canRemoveFromAllDevices(ids[0]))
    #expect(world.cloudRecord(homeAddress) == nil)

    await screen.model.setSynced(true, gatewayId: ids[0])
    await world.settle()
    await screen.idle()
    #expect(screen.model.rows.first?.state == .synced)
    #expect(screen.model.canRemoveFromAllDevices(ids[0]))
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
  }

  @Test func deleteEverythingEmptiesICloudAndKeepsEveryGatewayHere() async throws {
    let (world, ids) = try await sharedWorld()
    let screen = await Screen(world[0])
    let other = await Screen(world[1])
    await screen.idle()

    await screen.model.deleteEverything()
    await screen.idle()
    #expect(world.cloud.cloudItems().isEmpty)
    #expect(screen.model.rows.first?.state == .notInICloud)
    #expect(screen.model.rows.first?.canSyncAgain == true)
    #expect(try await world[0].only().id == ids[0])

    // The other device keeps its gateway and is told; "Sync Again" there puts it back.
    world.cloud.deliverAll()
    await world[1].reconcile()
    await other.idle()
    let notice = try #require(other.model.notices.first)
    #expect(notice.kind == .storeEmptied)
    #expect(notice.gatewayIds == [ids[1]])
    #expect(other.model.names(in: notice) == ["Home"])
    #expect(other.model.attentionCount == 1)

    await other.model.syncAgain(notice)
    await world.settle()
    await other.idle()
    #expect(other.model.notices.isEmpty, "resolved by syncing again")
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
  }

  // MARK: Adding from iCloud

  @Test func aGatewayRemovedHereIsOfferedAndAddedBackWithItsSharedCredentials() async throws {
    let (world, ids) = try await sharedWorld()
    let screen = await Screen(world[1])

    try await screen.directory.remove(id: ids[1], scope: .thisDevice)
    await world.settle()
    await screen.idle()
    #expect(try await world[1].gateways().isEmpty)
    let offer = try #require(screen.model.available.first)
    #expect(offer.removedHere)
    #expect(offer.name == "Home")
    #expect(!offer.needsSignIn)

    let result = try #require(await screen.model.add(offer))
    await world.settle()
    await screen.idle()

    let added = try await world[1].only()
    #expect(result.gatewayId == added.id)
    #expect(!result.needsSignIn)
    #expect(world[1].token(added.id) == "tok-1", "the session token came down from iCloud")
    #expect(screen.model.available.isEmpty)
    #expect(screen.model.rows.first?.state == .synced)
  }

  @Test func anIdentityProviderGatewayAddedFromICloudNeedsASignIn() async throws {
    let world = try EngineWorld(2)
    try await world.discloseAll()
    try await addGateway(world[0], address: homeAddress, token: nil)
    let screen = await Screen(world[1])
    await world.settle()
    await screen.idle()

    // Adopted by the sync: told once, and marked until signed in.
    let id = try await world[1].only().id
    #expect(screen.model.signInNeeded == [id])
    #expect(screen.model.rows.first?.needsSignIn == true)
    #expect(screen.model.notices.map(\.kind).contains(.needsSignIn))
    #expect(screen.model.notices.map(\.kind).contains(.adopted))

    screen.model.signedIn(id)
    #expect(screen.model.signInNeeded.isEmpty)
    #expect(!screen.model.notices.map(\.kind).contains(.needsSignIn))

    // Removed here and added back from the offer: the result asks for the sign-in seam.
    try await screen.directory.remove(id: id, scope: .thisDevice)
    await world.settle()
    await screen.idle()
    let offer = try #require(screen.model.available.first)
    #expect(offer.needsSignIn)
    let result = try #require(await screen.model.add(offer))
    #expect(result.needsSignIn)
    let again = try #require(result.gatewayId)
    #expect(screen.model.signInNeeded == [again])
  }

  // MARK: Notices

  @Test func aRemovalElsewhereIsToldByNameAndDismissed() async throws {
    let (world, ids) = try await sharedWorld()
    let screen = await Screen(world[1])

    try await world[0].engine.removeGateway(id: ids[0], scope: .allDevices)
    await world.settle()
    await screen.idle()

    #expect(try await world[1].gateways().isEmpty)
    let notice = try #require(screen.model.notices.first)
    #expect(notice.kind == .removedElsewhere(name: "Home"))
    #expect(screen.model.attentionCount == 1)

    screen.model.dismiss(notice)
    #expect(screen.model.notices.isEmpty)
  }

  /// The Mac adds a gateway with sync off; the phone removes it from all devices; the Mac turns
  /// sync on. The Mac keeps it, device-only, and says why; "Sync Again" is not offered for it.
  @Test func aGatewayKeptAfterARemovalElsewhereSaysSoUntilItIsResolved() async throws {
    let world = try EngineWorld(2)
    try await world.discloseAll()
    let screen = await Screen(world[0])
    try await world[0].engine.setSyncEnabled(false)
    let mine = try await addGateway(world[0], address: homeAddress, name: "Mine")
    let theirs = try await addGateway(world[1], address: homeAddress, name: "Theirs")
    await world.settle()

    world.advance(day)
    try await world[1].engine.removeGateway(id: theirs, scope: .allDevices)
    await world.settle()

    world.advance(day)
    await screen.model.turnOn()
    await world.settle()
    await screen.idle()

    #expect(try await world[0].only().id == mine)
    #expect(screen.model.keptAfterRemoval == [mine])
    let row = try #require(screen.model.rows.first)
    #expect(row.state == .removedElsewhereKeptHere)
    #expect(!row.canSyncAgain)
    let notice = try #require(screen.model.notices.first { $0.kind == .removedElsewhereKeptHere })
    #expect(notice.gatewayIds == [mine])

    // Removing it here resolves it.
    try await screen.directory.remove(id: mine, scope: .thisDevice)
    await world.settle()
    await screen.idle()
    #expect(screen.model.notices.isEmpty)
    #expect(screen.model.keptAfterRemoval.isEmpty)
  }

  @Test func theStatusLineFollowsTheLastSync() async throws {
    let (world, _) = try await sharedWorld()
    let screen = await Screen(world[0])
    await screen.idle()
    #expect(screen.model.phase == .waiting || screen.model.phase == .upToDate)

    await screen.model.syncNow()
    #expect(screen.model.phase == .upToDate)
    #expect(screen.model.lastSynced != nil)

    world.cloud.failNext(.all, on: "device0", with: .interactionNotAllowed)
    await screen.model.syncNow()
    #expect(screen.model.phase == .failed(.locked))
    #expect(screen.model.actionFailure == .locked)

    await screen.model.syncNow()
    #expect(screen.model.phase == .upToDate)
    #expect(screen.model.actionFailure == nil)
  }
}
