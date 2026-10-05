import Foundation
import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// A reinstall on iOS: SQLite and the app's files are gone, the device-only keychain (the print
/// key, the device tag, the old credentials) and iCloud Keychain are not. The person adds their
/// gateway again and answers "Sync with iCloud" on the disclosure.
@MainActor
@Suite(.timeLimit(.minutes(5))) struct ReinstallSyncTests {
  /// The same device after a reinstall: a new database and status, the same keychains.
  static func reinstalled(_ device: EngineDevice) -> EngineDevice {
    EngineDevice(reinstalling: device)
  }

  /// The launch, the onboarding's look in iCloud, the wizard's add, then "Sync with iCloud".
  @discardableResult
  static func reinstallAndAccept(
    _ device: EngineDevice, world: EngineWorld, address: String = homeAddress, token: String? = "tok-new"
  ) async throws -> (ICloudSyncModelTests.Screen, String) {
    let screen = await ICloudSyncModelTests.Screen(device)
    await device.reconcile()
    screen.model.lookInICloud()
    await screen.idle()

    let id = try await addGateway(device, address: address, token: token)
    await screen.idle()
    #expect(screen.model.needsDisclosure)

    await screen.model.acceptDisclosure()
    await world.settle()
    await screen.idle()
    return (screen, id)
  }

  @Test func theSameGatewayAddedAgainAfterAReinstallMergesIntoOne() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    await world.settle()
    #expect(world.cloudRecord(homeAddress)?.isLive == true)

    world[0] = Self.reinstalled(world[0])
    let (screen, id) = try await Self.reinstallAndAccept(world[0], world: world)

    #expect(screen.model.isOn)
    #expect(try await world[0].gateways().map(\.id) == [id])
    #expect(world.cloudRecord(homeAddress)?.isLive == true)
  }

  @Test func reinstallSignedInWithoutASessionToken() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: nil)
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let (screen, id) = try await Self.reinstallAndAccept(world[0], world: world, token: nil)
    #expect(screen.model.isOn)
    #expect(try await world[0].gateways().map(\.id) == [id])
  }

  @Test func reinstallWithSeveralGatewaysInICloud() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    try await addGateway(world[0], address: "https://lab.test", name: "Lab", token: nil)
    try await addGateway(world[0], address: "https://work.test", name: "Work", token: "tok-w")
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let (screen, _) = try await Self.reinstallAndAccept(world[0], world: world)
    #expect(screen.model.isOn)
    #expect(Set(try await world[0].gateways().map(\.address)) == [homeAddress, "https://lab.test", "https://work.test"])
  }

  @Test func reinstallWhileAnotherDeviceKeepsTheSameGateway() async throws {
    var world = try EngineWorld(2)
    try await world.discloseAll()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    try await addGateway(world[1], address: homeAddress, token: "tok-mac")
    try await addGateway(world[1], address: "https://lab.test", name: "Lab", token: nil)
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let (screen, _) = try await Self.reinstallAndAccept(world[0], world: world)
    #expect(screen.model.isOn)
    #expect(Set(try await world[0].gateways().map(\.address)) == [homeAddress, "https://lab.test"])
  }

  @Test func reinstallAfterTheGatewayWasRemovedFromAllDevices() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    let old = try await addGateway(world[0], address: homeAddress, token: "tok-old")
    await world.settle()
    try await world[0].engine.removeGateway(id: old, scope: .allDevices)
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let (screen, id) = try await Self.reinstallAndAccept(world[0], world: world)
    #expect(screen.model.isOn)
    #expect(try await world[0].gateways().map(\.id) == [id])
  }

  @Test func reinstallAddingBeforeTheLaunchSyncRan() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let screen = await ICloudSyncModelTests.Screen(world[0])
    let id = try await addGateway(world[0], address: homeAddress, token: "tok-new")
    screen.model.lookInICloud()
    await screen.idle()
    await world[0].reconcile()
    await screen.idle()
    await screen.model.acceptDisclosure()
    await world.settle()
    await screen.idle()
    #expect(try await world[0].gateways().map(\.id) == [id])
  }

  /// A register `{ v, t, d }` as text.
  nonisolated static func register(_ value: String, t: String = "1790000000000", d: String = "00000000") -> String {
    #"{"v":\#(value),"t":\#(t),"d":"\#(d)"}"#
  }

  /// The live address register of the gateway set up again.
  nonisolated static let address = #""address":"# + register(#""https://gateway.test""#)

  /// Records the earlier install, an older or newer build, or damage could have left at the key of
  /// the gateway set up again (`KEY`).
  nonisolated static let strangeRecords: [String] = [
    #"{"v":0,"key":"KEY"}"#,
    #"{"v":2,"key":"KEY","address":{"v":"x"}}"#,
    "not json",
    #"{"v":1,"key":"KEY","address":"# + register(#""https://elsewhere.test""#, t: "1") + "}",
    #"{"v":1,"key":"KEY",\#(address),"name":\#(register(#""Home""#)),"extra":{"a":[1,2]}}"#,
    #"{"v":1,"key":"KEY","sessionToken":\#(register(#""x""#, t: "1", d: "zz"))}"#,
    #"{"v":1,"key":"KEY","deleted":{"t":1,"d":"00000000"}}"#,
    #"{"v":1,"key":"KEY",\#(address),"addedAt":-1e300}"#,
    #"{"v":1,"key":"KEY",\#(address),"name":\#(register("42"))}"#,
    #"{"v":1,"key":"KEY",\#(address),"authKind":\#(register(#""weird""#))}"#,
    #"{"v":1,"key":"KEY",\#(address),"sessionToken":\#(register(#"{"a":1}"#))}"#,
    #"{"v":1,"key":"KEY",\#(address),"frontDoor":\#(register(#""str""#, d: ""))}"#,
    #"{"v":1,"key":"KEY",\#(address),"headers":\#(register("[1]", d: "ffffffffff"))}"#,
    #"{"v":1,"key":"KEY",\#(address),"signIn":\#(register(#"{"kind":"x"}"#))}"#,
    #"{"v":1,"key":"KEY",\#(address),"provider":\#(register(#""oidc""#)),"user":\#(register("7"))}"#,
    #"{"v":1,"key":"KEY","address":\#(register(#""https://gateway.test""#, t: "9007199254740991"))}"#,
    #"{"v":1,"key":"KEY",\#(address),"deleted":{"t":1790000000001,"d":"00000000"}}"#
  ]

  @Test(arguments: Self.strangeRecords)
  func reinstallOverAStrangeRecord(_ template: String) async throws {
    var world = try EngineWorld(1)
    let key = GatewayKey.of(homeAddress)
    let value = template.replacingOccurrences(of: "KEY", with: key)
    try world.cloud.replica("seed").put(SyncedItem(account: SyncedGatewayRecord.account(forKey: key), value: value))
    world.cloud.deliverAll()

    world[0] = Self.reinstalled(world[0])
    let (screen, id) = try await Self.reinstallAndAccept(world[0], world: world)
    #expect(screen.model.isOn)
    #expect(try await world[0].gateways().map(\.id).contains(id))
  }

  @Test(arguments: [0, 1, 2, 3])
  func reinstallWithAKeychainThatLostSomething(_ variant: Int) async throws {
    var world = try EngineWorld(2)
    try await world.discloseAll()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    try await addGateway(world[1], address: "https://lab.test", name: "Lab", token: "tok-lab")
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    switch variant {
    case 0: try world[0].secrets.delete(SyncPrintKey.storageKey)
    case 1: try world[0].secrets.delete(SyncPrintKey.deviceKey)
    case 2:
      try world[0].secrets.delete(SyncPrintKey.storageKey)
      try world[0].secrets.delete(SyncPrintKey.deviceKey)
    default: try world[0].secrets.set(SyncPrintKey.storageKey, "not a key")
    }
    let (screen, _) = try await Self.reinstallAndAccept(world[0], world: world)
    #expect(screen.model.isOn)
    #expect(Set(try await world[0].gateways().map(\.address)) == [homeAddress, "https://lab.test"])
  }

  /// Set up again with another way in: still one gateway. On a first attach the record wins for the
  /// auth kind (the first-attach table of the plan), so the earlier install's session token comes
  /// back with it.
  @Test func reinstallSignedInAnotherWay() async throws {
    var world = try EngineWorld(1)
    try await world[0].engine.disclose()
    try await addGateway(world[0], address: homeAddress, token: "tok-old")
    await world.settle()

    world[0] = Self.reinstalled(world[0])
    let (screen, id) = try await Self.reinstallAndAccept(world[0], world: world, token: nil)
    #expect(screen.model.isOn)
    #expect(try await world[0].gateways().map(\.id) == [id])
    #expect(try await world[0].only().authKind == .sessionToken)
    #expect(world[0].token(id) == "tok-old")
  }
}
