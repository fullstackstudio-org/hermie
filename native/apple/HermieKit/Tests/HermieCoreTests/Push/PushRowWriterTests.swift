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
    await phone.writer.refresh()
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
          "updatedAt": 1_790_001_453,
          // This build handles clearing pushes, and says so (`clear.optIn` in the contract).
          "clears": true,
          // It never shows Allow or Deny for a request that is not an approval (`requests`).
          "requestMethods": true
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

    // Registered from the start of the launch: every check, the one after the copy is taken in
    // included, sees the address (a `none` in between would rightly remove the row, carried keys
    // and all).
    let phone = Self.device(gateway, installation: "i-phone")
    phone.address.state = Self.address()
    await phone.sync.reconcile()
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
    #expect(!phone.writer.perChat)

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
    let stamp: @Sendable () -> Double? = { sync.app?["push"]?["seen"]?["i-phone"]?["at"]?.doubleValue }

    sync.register(writer)
    await sync.reconcile()

    writer.setOpenChat("researcher")
    #expect(stamp() == noon)

    clock.set(noon + 60)
    try await eventually("the next beat") { stamp() == noon + 60 }

    writer.setForeground(false)
    clock.set(noon + 120)
    try await Task.sleep(for: .milliseconds(30))
    #expect(stamp() == noon + 60)
  }

  // MARK: Review fixes

  static func advert(_ capabilities: [String], relayOrigins: [String]? = nil) -> JSONObject {
    var advert: JSONObject = [
      "v": 1, "version": "0.3.0", "capabilities": .array(capabilities.map(JSONValue.string)), "modules": ["push": "on"]
    ]
    advert["relayOrigins"] = relayOrigins.map { .array($0.map(JSONValue.string)) }
    return advert
  }

  @Test("delivery: a plugin without push.relay, a relay not on its list, then an advert that allows it")
  func delivery() async throws {
    let gateway = HoldingGateway(capabilities: [UIMeta.perUserCapability])
    let rig = try PushControllerTests.Rig()
    let sync = UIMetaSync.device(gateway.gateway)
    let writer = PushRowWriter(sync: sync, gatewayId: "g1", gatewayKey: Self.gatewayKey, installation: "i-phone", push: rig.controller)
    sync.register(writer)

    await sync.reconcile()
    #expect(writer.delivery == .cannotDeliver(.pluginTooOld))
    #expect(rig.controller.deliveries["g1"] == .cannotDeliver(.pluginTooOld))

    gateway.write("researcher", [UIMeta.pluginKey: .object(Self.advert([UIMeta.perUserCapability, "push.relay"], relayOrigins: ["https://elsewhere.example.test"]))])
    await sync.reconcile()
    #expect(rig.controller.deliveries["g1"] == .cannotDeliver(.relayNotAllowed))

    gateway.write("researcher", [UIMeta.pluginKey: .object(Self.advert([UIMeta.perUserCapability, "push.relay"], relayOrigins: [F.relay]))])
    await sync.reconcile()
    #expect(rig.controller.deliveries["g1"] == .ready)
  }

  @Test("the verdict reads the advert as the gateway client does: no list is an empty one")
  func deliveryRules() {
    #expect(PushDelivery.of(advert: nil, relay: F.relay) == .cannotDeliver(.pluginTooOld))
    #expect(PushDelivery.of(advert: Self.advert(["push.expo"]), relay: F.relay) == .cannotDeliver(.pluginTooOld))
    #expect(PushDelivery.of(advert: Self.advert(["push.relay"]), relay: F.relay) == .cannotDeliver(.relayNotAllowed))
    #expect(PushDelivery.of(advert: Self.advert(["push.relay"], relayOrigins: [F.relay + "/"]), relay: F.relay) == .ready)
  }

  @Test("a plugin that starts reading the per-person key gets this device's row there, unasked")
  func perUserMove() async throws {
    let gateway = HoldingGateway(capabilities: ["push.relay"])
    let phone = Self.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = Self.address()
    await phone.writer.refresh()
    await phone.sync.flush()

    #expect(gateway.meta("researcher")[UIMeta.legacyAppKey]?["push"]?["registrations"]?["i-phone"] != nil)
    #expect(Self.row(gateway, "i-phone") == nil)

    gateway.write("researcher", [UIMeta.pluginKey: .object(Self.advert([UIMeta.perUserCapability, "push.relay"]))])
    await phone.sync.reconcile()
    await phone.sync.flush()

    #expect(Self.row(gateway, "i-phone")?["handle"] == .string(F.handle(1)))
  }

  @Test("switched off before the first copy of a launch arrived: the gateway's stale row is removed")
  func noneBeforeTheFirstCopy() async throws {
    let gateway = HoldingGateway()
    let earlier = Self.device(gateway, installation: "i-phone")
    await earlier.sync.reconcile()
    earlier.address.state = Self.address()
    await earlier.writer.refresh()
    await earlier.sync.flush()
    #expect(Self.row(gateway, "i-phone") != nil)

    // The next launch: nothing registered any more, and the gateway not read yet.
    let next = Self.device(gateway, installation: "i-phone")
    next.address.state = .none
    await next.writer.refresh()
    await next.sync.reconcile()
    await next.sync.flush()

    #expect(Self.row(gateway, "i-phone") == nil)
  }

  @Test("two checks that overlap: the later address lands, never the older one")
  func refreshesInOrder() async throws {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    let first = Recorder<CheckedContinuation<Void, Never>>()
    let calls = Recorder<Int>()

    let writer = PushRowWriter(
      sync: sync, gatewayId: "g1", gatewayKey: Self.gatewayKey, installation: "i-phone",
      addressState: { _ in
        calls.items.append(calls.items.count)

        if calls.items.count == 1 {
          // The first check reads, then stalls before it writes.
          await withCheckedContinuation { first.items.append($0) }
          return Self.address(1)
        }

        return Self.address(2)
      })

    let older = Task { await writer.refresh() }
    try await eventually("the first read") { await !first.items.isEmpty }
    let newer = Task { await writer.refresh() }

    first.items.first?.resume()
    _ = await older.value
    _ = await newer.value

    #expect(writer.ownRow?["handle"] == .string(F.handle(2)))
  }

  @Test("no stamp before the gateway's capabilities are read, then the right shape")
  func noStampBeforeCapabilities() async throws {
    let clock = TestWallClock(noon)
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "push": ["seen": ["i-other": ["bot": "x", "at": .number(noon - 10)]]]]])

    let phone = Self.device(gateway, installation: "i-phone", clock: clock)
    phone.writer.setOpenChat("researcher")
    phone.writer.stop()
    #expect(phone.sync.app?["push"]?["seen"] == nil)

    await phone.sync.reconcile()
    await phone.sync.flush()

    let seen = Self.push(gateway)?["seen"]?.objectValue
    #expect(seen?["i-phone"] == ["bot": "researcher", "at": .number(noon)])
    #expect(seen?["i-other"] == ["bot": "x", "at": .number(noon - 10)])
  }

  @Test("two first-launch callers get one installation id")
  func oneInstallationId() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))

    async let a = PushInstallation.id(in: keyValues)
    async let b = PushInstallation.id(in: keyValues)
    let (first, second) = try await (a, b)

    #expect(first == second)
  }

  @Test("documents, snapshots, changes and rows describe themselves without a secret")
  func redaction() {
    let row = UIMetaPushRow(transport: "relay", relay: F.relay, handle: F.handle(4), sendSecret: F.secret("send", 4),
                            carried: ["token": "ExponentPushToken[leak]"])
    let app: JSONObject = ["v": 1, "push": ["registrations": ["i": .object(row.json)], "seen": ["i": 1]]]
    let documents = UIMetaDocuments(app: app)
    let snapshot = UIMetaSnapshot(app: app, remote: app, pushHome: app)
    let change = UIMetaChange(documents: documents, snapshot: snapshot)

    var texts: [String] = []

    for value in [row, documents, snapshot, change] as [Any] {
      texts.append(String(describing: value))
      texts.append(String(reflecting: value))

      var dumped = ""
      dump(value, to: &dumped)
      texts.append(dumped)
    }

    for text in texts {
      #expect(!text.contains(F.secret("send", 4)))
      #expect(!text.contains("ExponentPushToken[leak]"))
      #expect(!text.contains(F.handle(4)))
    }
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
    #expect(minted.hasPrefix("i"))
    #expect(minted != "iabcdef0123456789")
    #expect(try await PushInstallation.id(in: keyValues) == minted)
  }
}
