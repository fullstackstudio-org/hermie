import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// The ui_meta push row writer against `HoldingGateway`: what reaches the gateway's section, and
/// what never does.
@MainActor
@Suite("Push row writer")
struct PushRowWriterTests {
  typealias F = PushFixtures

  static let gatewayKey = "bf796761db84e312"

  /// What the writer reads as the address; a test sets it.
  @MainActor
  final class Address {
    var state: PushAddressState = .none
  }

  static func address(_ n: Int = 1, updatedAt: Double = 1_790_001_453.7) -> PushAddressState {
    .registered(
      PushRelayAddress(
        relay: F.relay,
        handle: F.handle(n),
        sendSecret: F.secret("send", n),
        platform: "ios",
        updatedAt: updatedAt
      )
    )
  }

  struct Device {
    let sync: UIMetaSync
    let writer: PushRowWriter
    let address: Address
  }

  static func device(_ gateway: HoldingGateway, installation: String, clock: TestWallClock = TestWallClock(noon))
    -> Device
  {
    let sync = UIMetaSync.device(gateway.gateway, clock: clock)
    let address = Address()
    let writer = PushRowWriter(
      sync: sync,
      gatewayId: "g1",
      gatewayKey: gatewayKey,
      installation: installation,
      addressState: { _ in address.state },
      now: clock.now
    )

    sync.register(writer)
    return Device(sync: sync, writer: writer, address: address)
  }

  static func push(_ gateway: HoldingGateway) -> JSONObject? {
    gateway.meta("researcher")[ownerKey]?["push"]?.objectValue
  }

  static func row(_ gateway: HoldingGateway, _ installation: String) -> JSONObject? {
    push(gateway)?["registrations"]?[installation]?.objectValue
  }

  @Test("writes the contract's relay row, which every sender's reader accepts, and no manage secret")
  func writesTheRow() async throws {
    let gateway = HoldingGateway()
    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()

    phone.address.state = Self.address()
    #expect(await phone.writer.refresh())
    await phone.sync.flush()

    let row = try #require(Self.row(gateway, "i-phone"))
    #expect(
      row
        == [
          "v": 1,
          "transport": "relay",
          "relay": .string(F.relay),
          "handle": .string(F.handle(1)),
          "secret": .string(F.secret("send", 1)),
          "platform": "ios",
          "types": .object(PushRows.defaultTypes),
          "preview": false,
          "gatewayKey": .string(Self.gatewayKey),
          "updatedAt": 1_790_001_453
        ]
    )
    #expect(
      PushRows.addressOf(.object(row))
        == ["transport": "relay", "relay": .string(F.relay), "handle": .string(F.handle(1)), "secret": .string(F.secret("send", 1))]
    )

    let everything = try JSONValue.object(gateway.meta("researcher")).canonicalString()
    #expect(!everything.contains(F.secret("manage", 1)))
    #expect(!everything.contains("manageSecret"))
  }

  @Test("two installations on one gateway keep each other's rows")
  func twoInstallations() async throws {
    let gateway = HoldingGateway()
    let phone = Self.device(gateway, installation: "i-phone")
    let mac = Self.device(gateway, installation: "i-mac")

    await phone.sync.reconcile()
    phone.address.state = Self.address(1)
    await phone.writer.refresh()
    await phone.sync.flush()

    await mac.sync.reconcile()
    mac.address.state = Self.address(2)
    await mac.writer.refresh()
    await mac.sync.flush()

    await phone.sync.reconcile()
    phone.address.state = Self.address(1, updatedAt: 1_790_100_000)
    await phone.writer.refresh()
    await phone.sync.flush()

    #expect(Self.row(gateway, "i-phone")?["handle"] == .string(F.handle(1)))
    #expect(Self.row(gateway, "i-phone")?["updatedAt"] == 1_790_100_000)
    #expect(Self.row(gateway, "i-mac")?["handle"] == .string(F.handle(2)))
  }

  @Test("none removes the row; unknown leaves it exactly as it is")
  func noneAndUnknown() async throws {
    let gateway = HoldingGateway()
    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = Self.address()
    await phone.writer.refresh()
    await phone.sync.flush()

    phone.address.state = .unknown
    #expect(await phone.writer.refresh() == false)
    await phone.sync.flush()
    #expect(Self.row(gateway, "i-phone") != nil)

    phone.address.state = .none
    #expect(await phone.writer.refresh())
    await phone.sync.flush()
    #expect(Self.row(gateway, "i-phone") == nil)

    #expect(await phone.writer.refresh() == false)
  }

  @Test("nothing changed, nothing written: no churn")
  func noChurn() async throws {
    let gateway = HoldingGateway()
    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = Self.address()
    await phone.writer.refresh()
    await phone.sync.flush()

    let writes = gateway.configures.count

    #expect(await phone.writer.refresh() == false)
    await phone.sync.reconcile()
    #expect(await phone.writer.refresh() == false)
    await phone.sync.flush()

    #expect(gateway.configures.count == writes)
  }

  @Test("keys of its own row this build does not write are carried; another transport's address is not")
  func carriesUnknownKeys() async throws {
    let gateway = HoldingGateway()
    gateway.write(
      "researcher",
      [
        ownerKey: [
          "v": 1,
          "push": [
            "registrations": [
              "i-phone": [
                "v": 1, "transport": "expo", "token": "ExponentPushToken[old]", "enc": ["kid": 1], "futureField": true
              ],
              "i-other": ["v": 1, "transport": "expo", "token": "ExponentPushToken[theirs]"]
            ]
          ]
        ]
      ]
    )

    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = Self.address()
    await phone.writer.refresh()
    await phone.sync.flush()

    let row = try #require(Self.row(gateway, "i-phone"))
    #expect(row["enc"] == ["kid": 1])
    #expect(row["futureField"] == true)
    #expect(row["token"] == nil)
    #expect(row["transport"] == "relay")
    #expect(Self.row(gateway, "i-other")?["token"] == "ExponentPushToken[theirs]")
  }

  @Test("no type wanted is no row, as every reader treats it")
  func noTypeWanted() async throws {
    let gateway = HoldingGateway()
    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = Self.address()
    await phone.writer.refresh()
    await phone.sync.flush()

    phone.writer.types = PushRows.noTypes()
    await phone.writer.refresh()
    await phone.sync.flush()

    #expect(Self.row(gateway, "i-phone") == nil)
  }

  @Test("switching notifications off removes the row, through the controller and its relay")
  func switchedOff() async throws {
    let gateway = HoldingGateway()
    let rig = try PushControllerTests.Rig()
    let sync = UIMetaSync.device(gateway.gateway)
    let writer = PushRowWriter(sync: sync, gatewayId: "g1", gatewayKey: PushGateways.one.key, installation: "i-phone", push: rig.controller)
    let pending = Recorder<Task<Void, Never>>()

    sync.register(writer)
    rig.controller.onAddressesChanged = { ids in pending.items.append(Task { await writer.addressesChanged(ids) }) }
    await sync.reconcile()

    try await rig.registered([PushGateways.one])
    for task in pending.items { await task.value }
    await sync.flush()
    #expect(Self.row(gateway, "i-phone")?["handle"] == .string(F.handle(1)))

    await rig.controller.setEnabled(false)
    for task in pending.items { await task.value }
    await sync.flush()
    #expect(Self.row(gateway, "i-phone") == nil)
  }

  // MARK: The heartbeat

  @Test("seen is stamped as soon as a chat is open, bare until the plugin says it reads {bot, at}")
  func heartbeatShape() async throws {
    let clock = TestWallClock(noon)
    let gateway = HoldingGateway(capabilities: [UIMeta.perUserCapability])
    let phone = Self.device(gateway, installation: "i-phone", clock: clock)
    await phone.sync.reconcile()

    phone.writer.setOpenChat("researcher")
    phone.writer.stop()
    await phone.sync.flush()
    #expect(Self.push(gateway)?["seen"]?["i-phone"] == .number(noon))

    let perChat = HoldingGateway()
    let mac = Self.device(perChat, installation: "i-mac", clock: clock)
    await mac.sync.reconcile()
    #expect(mac.writer.perChat)

    mac.writer.setOpenChat("writer")
    mac.writer.stop()
    await mac.sync.flush()
    #expect(Self.push(perChat)?["seen"]?["i-mac"] == ["bot": "writer", "at": .number(noon)])
  }

  @Test("a stamp sweeps every entry older than a day and keeps the rest; another device's row is untouched")
  func heartbeatSweeps() async throws {
    let clock = TestWallClock(noon)
    let gateway = HoldingGateway()
    let foreignRow: JSONValue = ["v": 1, "transport": "expo", "token": "x"]
    gateway.write(
      "researcher",
      [
        ownerKey: [
          "v": 1,
          "push": [
            "registrations": ["i-other": foreignRow],
            "seen": ["i-stale": .number(noon - 2 * hour - PushRows.seenTTL), "i-fresh": ["bot": "x", "at": .number(noon - hour)]]
          ]
        ]
      ]
    )

    let phone = Self.device(gateway, installation: "i-phone", clock: clock)
    await phone.sync.reconcile()
    phone.writer.beat()
    await phone.sync.flush()

    let seen = Self.push(gateway)?["seen"]?.objectValue
    #expect(seen?["i-stale"] == nil)
    #expect(seen?["i-fresh"] == ["bot": "x", "at": .number(noon - hour)])
    #expect(seen?["i-phone"] != nil)
    #expect(Self.push(gateway)?["registrations"]?["i-other"] == foreignRow)
  }

  @Test("the heartbeat repeats on its cadence while a chat is open in front, and stops otherwise")
  func heartbeatCadence() async throws {
    let clock = TestWallClock(noon)
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway, clock: clock)
    let writer = PushRowWriter(
      sync: sync, gatewayId: "g1", gatewayKey: Self.gatewayKey, installation: "i-phone", addressState: { _ in .none },
      heartbeat: .milliseconds(5), now: clock.now)
    let stamp: @Sendable () -> Double? = { sync.app?["push"]?["seen"]?["i-phone"]?.doubleValue }

    writer.setOpenChat("researcher")
    #expect(stamp() == noon)

    clock.set(noon + 60)
    try await eventually("the next beat") { stamp() == noon + 60 }

    writer.setForeground(false)
    clock.set(noon + 120)
    try await Task.sleep(for: .milliseconds(30))
    #expect(stamp() == noon + 60)
  }

  // MARK: The installation id

  @Test("the installation id is minted once, in the Expo app's shape, and found again")
  func installationId() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let first = try await PushInstallation.id(in: keyValues)

    #expect(first.count == 17)
    #expect(first.hasPrefix("i"))
    #expect(try await PushInstallation.id(in: keyValues) == first)
    #expect(try await keyValues.string(forKey: StoreKeys.installation) == #"{"installationId":"\#(first)"}"#)

    try await keyValues.setString(#"{"installationId":"iabcdef0123456789"}"#, forKey: StoreKeys.installation)
    #expect(try await PushInstallation.id(in: keyValues) == "iabcdef0123456789")

    try await keyValues.setString("garbage", forKey: StoreKeys.installation)
    let minted = try await PushInstallation.id(in: keyValues)
    #expect(minted != "iabcdef0123456789")
    #expect(try await PushInstallation.id(in: keyValues) == minted)
  }
}
