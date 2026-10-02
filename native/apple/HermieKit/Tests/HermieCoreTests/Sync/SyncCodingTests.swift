import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The record and state shapes of "Data model", and the order registers merge by.
@Suite struct SyncCodingTests {
  static let address = "https://gateway.test"
  static let key = GatewayKey.of(address)
  static let account = SyncedGatewayRecord.account(forKey: key)

  static func register(_ value: JSONValue, _ t: Double, _ d: String = "a1b2c3d4") -> SyncRegister {
    SyncRegister(value: value, stamp: SyncStamp(t: t, d: d))
  }

  // MARK: Record

  @Test func aRecordIsCanonicalJSONAndReadsBackUnchanged() throws {
    var record = SyncedGatewayRecord(key: Self.key)
    record.addedAt = 1_789_000_000_000
    record.registers[.address] = Self.register(.string(Self.address), 1_790_000_000_123)
    record.registers[.name] = Self.register("Home", 1_790_000_000_123)
    record.registers[.user] = Self.register(.null, 0, "")

    let text = try record.encoded()

    #expect(
      text
        == #"{"addedAt":1789000000000,"address":{"d":"a1b2c3d4","t":1790000000123,"v":"https://gateway.test"},"key":"\#(Self.key)","name":{"d":"a1b2c3d4","t":1790000000123,"v":"Home"},"user":{"d":"","t":0,"v":null},"v":1}"#
    )
    let decoded = try #require(SyncedGatewayRecord.decode(account: Self.account, value: text))
    #expect(decoded == record)
    #expect(try decoded.encoded() == text)
    #expect(SyncedGatewayRecord.decode(text) == record)
    #expect(record.account == "gw.\(Self.key)")
  }

  @Test func unknownFieldsAreCarriedThroughEveryRewrite() throws {
    let text = #"""
      {"address":{"d":"a1b2c399","t":5,"v":"https://gateway.test"},"authKind":{"d":"a1b2c399","t":5,"v":"session_token"},\#
      "frontDoor":{"d":"a1b2c399","t":5,"v":{"clientId":"id","clientSecret":"s","kind":"cloudflare-access","origin":"https://gateway.test","rotation":"weekly"}},\#
      "icon":{"d":"a1b2c399","t":5,"v":"star"},"future":[1,2],\#
      "key":"\#(Self.key)","name":{"d":"a1b2c399","t":5,"v":"Home","x-note":"kept"},"v":1}
      """#
    var world = SyncWorld(devices: 1)
    world.cloud.put(0, account: Self.account, value: text)
    world.reconcile(0)
    let id = try #require(world.devices[0].gateways.first?.id)

    // A rename, then a new front-door secret: each rewrite keeps what this build does not know.
    world.advance(1_000)
    world.rename(0, id, to: "Renamed")
    let renamed = try #require(world.reconcile(0).remotePuts.first)
    world.advance(1_000)
    world.setFrontDoor(0, id, secret: "s2")
    let rotated = try #require(world.reconcile(0).remotePuts.first)

    for record in [renamed, rotated] {
      let root = try #require(try JSONValue(parsing: try record.encoded()).objectValue)
      #expect(root["future"] == [1, 2])
      #expect(root["icon"]?["v"] == "star")
      #expect(root["name"]?["x-note"] == "kept")
      #expect(root["frontDoor"]?["v"]?["rotation"] == "weekly")
    }
    #expect(rotated.frontDoor?.clientSecret == "s2")
    #expect(rotated.name == "Renamed")
  }

  @Test func aRecordFromANewerVersionIsKeptExactlyAsRead() throws {
    let text = #"{"v":2,"key":"\#(Self.key)","address":{"v":"https://gateway.test","t":1,"d":"x"}}"#
    let record = try #require(SyncedGatewayRecord.decode(account: Self.account, value: text))

    #expect(record.foreign == .newerVersion)
    #expect(!record.isSupported)
    #expect(!record.isLive)
    #expect(try record.encoded() == text)
  }

  @Test func recordsThatCannotBeTrustedAreLeftAloneOrIgnored() throws {
    #expect(SyncedGatewayRecord.decode(account: "other.\(Self.key)", value: "{}") == nil)
    #expect(SyncedGatewayRecord.decode(account: "gw.NOTAKEY", value: "{}") == nil)
    #expect(SyncedGatewayRecord.decode(account: Self.account, value: "not json")?.foreign == .unreadable)
    #expect(SyncedGatewayRecord.decode(account: Self.account, value: #"{"v":1,"key":"0000000000000000"}"#)?.foreign == .unreadable)
    #expect(SyncedGatewayRecord.decode(account: Self.account, value: #"{"v":1,"key":"\#(Self.key)"}"#)?.foreign == .invalid)

    // A tombstone does not need an address; a stale one at another origin is simply dropped.
    let tombstone = #"{"address":{"d":"x","t":1,"v":"https://elsewhere.test"},"deleted":{"d":"x","t":2},"key":"\#(Self.key)","v":1}"#
    let dead = try #require(SyncedGatewayRecord.decode(account: Self.account, value: tombstone))
    #expect(dead.isSupported)
    #expect(dead.normalized().isTombstone)
    #expect(try dead.normalized().encoded() == #"{"deleted":{"d":"x","t":2},"key":"\#(Self.key)","v":1}"#)
  }

  @Test func aRecordIsLiveWhileItsAddressIsNewerThanItsDeletion() {
    var record = SyncedGatewayRecord(key: Self.key)
    record.registers[.address] = Self.register(.string(Self.address), 10)
    #expect(record.isLive)

    record.deleted = SyncStamp(t: 9, d: "zz")
    #expect(record.isLive)

    record.deleted = SyncStamp(t: 10, d: "a")
    #expect(!record.isLive)
    #expect(record.isTombstone)
  }

  @Test func aTombstoneKeepsNothingButItsStamp() throws {
    var live = SyncedGatewayRecord(key: Self.key)
    live.addedAt = 1
    live.registers[.address] = Self.register(.string(Self.address), 10)
    live.registers[.name] = Self.register("Renamed later", 30)
    live.registers[.sessionToken] = Self.register(["origin": "https://gateway.test", "token": "t"], 30)
    live.extra["future"] = "x"
    var tombstone = SyncedGatewayRecord(key: Self.key)
    tombstone.deleted = SyncStamp(t: 20, d: "a1b2c3d4")

    let joined = SyncedGatewayRecord.join(live, tombstone)

    #expect(joined.isTombstone)
    #expect(try joined.encoded() == #"{"deleted":{"d":"a1b2c3d4","t":20},"key":"\#(Self.key)","v":1}"#)
    #expect(SyncedGatewayRecord.join(tombstone, live) == joined)
  }

  @Test func normalisingDropsWhatCannotTakePart() {
    var record = SyncedGatewayRecord(key: Self.key)
    record.registers[.address] = Self.register(.string(Self.address), 10)
    record.registers[.name] = Self.register("", 10)
    record.registers[.sessionToken] = Self.register(["origin": "https://elsewhere.test", "token": "t"], 10)
    record.registers[.headers] = Self.register(["origin": "https://gateway.test", "headers": ["X": 1]], 10)
    record.registers[.provider] = Self.register(["label": "no name"], 10)
    record.registers[.user] = Self.register(.null, 10)
    record.deleted = SyncStamp(t: 5, d: "a")
    record.registers[.authKind] = Self.register("session_token", 5)

    let normalized = record.normalized()

    #expect(normalized.registers.keys.sorted() == [.address, .user])
    #expect(normalized.normalized() == normalized)

    var cleartext = SyncedGatewayRecord(key: GatewayKey.of("http://gateway.test"))
    cleartext.registers[.address] = Self.register("http://gateway.test", 1)
    cleartext.registers[.frontDoor] = Self.register(
      ["origin": "http://gateway.test", "kind": "cloudflare-access", "clientId": "i", "clientSecret": "s"], 1)
    #expect(cleartext.normalized().registers[.frontDoor] == nil)
  }

  // MARK: Order

  @Test func stampsOrderByTimeThenByDeviceTag() {
    #expect(SyncStamp(t: 1, d: "ffffffff") < SyncStamp(t: 2, d: "00000000"))
    #expect(SyncStamp(t: 2, d: "a1b2c300") < SyncStamp(t: 2, d: "a1b2c301"))
    #expect(!(SyncStamp(t: 2, d: "a") < SyncStamp(t: 2, d: "a")))
  }

  @Test func twoDifferentWritesWithOneStampResolveTheSameWayEverywhere() {
    let left = Self.register("Left", 5)
    let right = Self.register("Right", 5)

    #expect(SyncRegister.winner(left, right) == SyncRegister.winner(right, left))
    #expect(SyncRegister.winner(left, right) == right)
    #expect(SyncRegister.winner(left, nil) == left)
  }

  @Test func aLocalEditIsStampedAboveEverythingInTheRecord() throws {
    var world = SyncWorld(devices: 2)
    world.devices[1].clockOffset = 10_000
    let id = world.add(0, address: Self.address)
    world.settle()

    // Device 1's clock is ahead, so its first-attach stamps... none: it adopted. Its rename is.
    world.rename(1, world.devices[1].gateways[0].id, to: "Ahead")
    world.settle()
    let ahead = try #require(world.cloudRecord(key: Self.key)?.registers[.name]?.stamp)
    #expect(ahead.t == startOfTime + 10_000)

    // Device 0, behind, stamps highest + 1; with a clock past that, it stamps `now`.
    world.rename(0, id, to: "Behind")
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.registers[.name]?.stamp == SyncStamp(t: ahead.t + 1, d: "a1b2c300"))

    world.advance(60_000)
    world.rename(0, id, to: "Later")
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.registers[.name]?.stamp.t == startOfTime + 60_000)
  }

  /// Merging is a join: the order two records meet in does not matter, and meeting oneself
  /// changes nothing.
  @Test func joiningIsCommutativeAndIdempotent() {
    var rng = SeededGenerator(seed: 42)
    let values: [JSONValue] = ["A", "B", .null]

    func randomRecord() -> SyncedGatewayRecord {
      var record = SyncedGatewayRecord(key: Self.key)
      if Bool.random(using: &rng) {
        record.registers[.address] = Self.register(.string(Self.address), Double(Int.random(in: 0...9, using: &rng)), ["a", "b"].randomElement(using: &rng)!)
      }
      for field in [SyncField.name, .user] where Bool.random(using: &rng) {
        record.registers[field] = Self.register(values.randomElement(using: &rng)!, Double(Int.random(in: 0...9, using: &rng)), ["a", "b"].randomElement(using: &rng)!)
      }
      if Int.random(in: 0..<3, using: &rng) == 0 {
        record.deleted = SyncStamp(t: Double(Int.random(in: 0...9, using: &rng)), d: "c")
      }
      if Bool.random(using: &rng) { record.addedAt = Double(Int.random(in: 0...9, using: &rng)) }
      if Bool.random(using: &rng) { record.extra["icon"] = Self.register(values.randomElement(using: &rng)!, Double(Int.random(in: 0...9, using: &rng))).json }
      return record.normalized()
    }

    for _ in 0..<2_000 {
      let left = randomRecord()
      let right = randomRecord()
      #expect(SyncedGatewayRecord.join(left, right) == SyncedGatewayRecord.join(right, left))
      #expect(SyncedGatewayRecord.join(left, left) == left)
    }
  }

  // MARK: State

  @Test func theStateRoundTripsWithEveryFieldItDoesNotKnow() throws {
    let text = #"""
      {"device":"a1b2c3d4","disclosed":true,"enabled":true,"entries":{"g0123456789abcdef":{"detached":"absent",\#
      "key":"\#(Self.key)","later":true,"prints":{"name":"p:1"},"removal":"allDevices","seen":true,"signedOut":false,\#
      "stamps":{"name":{"d":"a1b2c3d4","t":5}}}},"future":{"x":1},"hidden":["9f3ab0c2d4e5f601"],\#
      "tombstones":{"9f3ab0c2d4e5f602":{"d":"a1b2c3d4","t":7}},"v":1}
      """#
    let state = try #require(SyncState.decode(text))

    #expect(state.device == "a1b2c3d4")
    #expect(state.hidden == ["9f3ab0c2d4e5f601"])
    #expect(state.tombstones["9f3ab0c2d4e5f602"] == SyncStamp(t: 7, d: "a1b2c3d4"))
    let entry = try #require(state.entries["g0123456789abcdef"])
    #expect(entry.detached == .absent)
    #expect(entry.removal == .allDevices)
    #expect(entry.stamp(.name) == SyncStamp(t: 5, d: "a1b2c3d4"))
    #expect(try state.encoded() == text)
  }

  @Test func aStateThisBuildCannotWriteIsMarked() {
    #expect(SyncState.decode(nil) == nil)
    #expect(SyncState.decode("[]") == nil)
    #expect(SyncState.decode(#"{"v":3}"#)?.unsupportedVersion == "3")
    #expect(SyncState.decode(#"{"device":"a1b2c3d4"}"#)?.unsupportedVersion == "missing")
    #expect(SyncState.isValidDevice("a1b2c3d4"))
    #expect(!SyncState.isValidDevice("A1B2C3D4"))
    #expect(!SyncState.isValidDevice("a1b2c3d"))
  }
}
