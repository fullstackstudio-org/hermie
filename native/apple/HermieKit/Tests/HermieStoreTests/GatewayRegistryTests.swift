import Foundation
import Testing

@_spi(GatewaySync) @testable import HermieStore

private let one = "g0123456789abcdef"
private let two = "gfedcba9876543210"

private func record(_ id: String, _ address: String = "https://gateway.test", addedAt: Double = 1) -> GatewayRecord {
  GatewayRecord(id: id, name: "", address: address, authKind: .sessionToken, addedAt: addedAt)
}

@Suite("Gateway registry")
struct GatewayRegistryTests {
  @Test("ids are g and hex, and only those pass the check")
  func ids() {
    let id = GatewayRegistry.newGatewayId()

    #expect(id.count == 17)
    #expect(GatewayRegistry.isGatewayId(id))
    #expect(GatewayRegistry.isGatewayId("g00"))
    #expect(!GatewayRegistry.isGatewayId("g0"))
    #expect(!GatewayRegistry.isGatewayId("G00"))
    #expect(!GatewayRegistry.isGatewayId("g0A"))
    #expect(!GatewayRegistry.isGatewayId("g00@x"))
    #expect(!GatewayRegistry.isGatewayId("g" + String(repeating: "a", count: 65)))
  }

  @Test("decoding drops rows that are not rows, defaults the rest and repairs the pointer")
  func tolerantDecoding() {
    let text = """
      {"v":1,"activeGatewayId":"g999","gateways":[
        {"id":"g0123456789abcdef","address":"https://gateway.test:8443/base","addedAt":5},
        {"id":"not-an-id","address":"https://other.test"},
        {"id":"gfedcba9876543210","address":""},
        {"id":"gaa","address":"http://gateway.test","authKind":"carrier_pigeon","name":"Pi","signedInUser":""},
        "nonsense"
      ]}
      """
    let registry = GatewayRegistry.decode(text)

    #expect(registry.gateways.map(\.id) == ["g0123456789abcdef", "gaa"])
    #expect(registry.gateways[0].name == "gateway.test")
    #expect(registry.gateways[0].authKind == .nativePKCE)
    #expect(registry.gateways[0].addedAt == 5)
    #expect(registry.gateways[1].authKind == .other("carrier_pigeon"))
    #expect(registry.gateways[1].signedInUser == nil)
    #expect(registry.activeGatewayId == "g0123456789abcdef")
    #expect(GatewayRegistry.decode(nil) == .empty)
    #expect(!GatewayRegistry.decode(nil).unreadable)

    // Text that is not a registry reads as empty, and says so: unknown is not "no gateways".
    let garbage = GatewayRegistry.decode("[]")
    #expect(garbage.gateways.isEmpty)
    #expect(garbage.unreadable)
    #expect(GatewayRegistry.decode("{not json").unreadable)
  }

  @Test("fields this build does not know survive a read-modify-write")
  func unknownFieldsPreserved() throws {
    let text = """
      {"v":1,"futureField":{"kept":true},"activeGatewayId":"g0123456789abcdef","gateways":[
        {"id":"g0123456789abcdef","name":"Home","address":"https://gateway.test","authKind":"cookie",
         "signedInUser":"Test Person","addedAt":1769000000000,"pinnedColour":"teal"}
      ]}
      """
    let renamed = GatewayRegistry.decode(text).renaming(id: one, to: "Work")
    let written = try renamed.encoded()
    let object = try #require(try JSONSerialization.jsonObject(with: Data(written.utf8)) as? [String: Any])
    let row = try #require((object["gateways"] as? [[String: Any]])?.first)

    #expect((object["futureField"] as? [String: Any])?["kept"] as? Bool == true)
    #expect(object["v"] as? Int == 1)
    #expect(row["pinnedColour"] as? String == "teal")
    #expect(row["name"] as? String == "Work")
    #expect(row["authKind"] as? String == "cookie")
    #expect(row["addedAt"] as? Int64 == 1_769_000_000_000)
    #expect(written.contains(#""addedAt":1769000000000"#))
    #expect(GatewayRegistry.decode(written) == renamed)
  }

  @Test("an unknown version reads as empty and is never written over")
  func unknownVersion() async throws {
    let store = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: store)
    let stored = #"{"v":2,"gateways":[{"id":"g00","address":"x"}]}"#

    try await store.write { try $0.kvSet(stored, forKey: StoreKeys.gateways) }

    let loaded = try await registry.load()

    #expect(loaded.gateways.isEmpty)
    #expect(loaded.unsupportedVersion?.description == "2")

    await #expect(throws: GatewayRegistryError.unsupportedVersion("2")) {
      try await registry.add(record(one))
    }

    #expect(try await store.read { try $0.kvValue(forKey: StoreKeys.gateways) } == stored)
  }

  @Test("the first gateway added is active, a later one is not; removing the active moves the pointer")
  func operations() {
    var registry = GatewayRegistry.empty.adding(record(one, addedAt: 2))

    #expect(registry.activeGatewayId == one)

    registry = registry.adding(record(two, "http://gateway.test:8642", addedAt: 1))

    #expect(registry.activeGatewayId == one)
    #expect(registry.inOrder.map(\.id) == [two, one])
    #expect(registry.activating(id: "g999").activeGatewayId == one)
    #expect(registry.activating(id: two).activeGatewayId == two)
    #expect(registry.renaming(id: two, to: "  ").gateway(id: two)?.name == "gateway.test")
    #expect(registry.removing(id: one).activeGatewayId == two)
    #expect(registry.removing(id: two).activeGatewayId == one)
    #expect(registry.removing(id: one).removing(id: two).activeGatewayId == nil)
  }

  @Test("removing a gateway purges its keys, its layout entry and its cache, and nothing else")
  func purge() async throws {
    let store = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: store)
    let kv = KeyValueStore(store: store)

    try await registry.add(record(one))
    try await registry.add(record(two))

    let layout = #"{"\#(one)":{"entries":[]},"\#(two)":{"entries":[1]}}"#

    try await kv.apply([
      .set(key: GatewayNamespace(one).key(StoreKeys.gatewayConfig), value: "{}"),
      .set(key: GatewayNamespace(one).key(StoreKeys.chatView), value: "{}"),
      .set(key: GatewayNamespace(one).key("hermie.something.new"), value: "{}"),
      .set(key: GatewayNamespace(two).key(StoreKeys.gatewayConfig), value: "{}"),
      // A different id that merely starts with the removed one.
      .set(key: "hermie.gateway.config@\(one)00", value: "{}"),
      .set(key: StoreKeys.lock, value: #"{"threshold":"5m"}"#),
      .set(key: StoreKeys.installation, value: #"{"id":"i1"}"#),
      .set(key: StoreKeys.chatsLayout, value: layout)
    ])

    for gateway in [one, two] {
      let cache = SQLiteChatCache(store: store, gatewayId: gateway)

      try await cache.write(
        CachedTranscript(bot: "researcher", itemsJSON: "[]", lastRowId: 1, lastSeq: 1, epoch: nil, updatedAt: 1)
      )
      try await cache.writeBots([CachedBot(name: "researcher", json: "{}", avatarRevision: 0, updatedAt: 1)])
    }

    var configChanges = kv.changes(forKey: GatewayNamespace(one).key(StoreKeys.gatewayConfig)).makeAsyncIterator()
    let after = try await registry.remove(id: one)

    #expect(after.gateways.map(\.id) == [two])
    #expect(after.activeGatewayId == two)
    #expect(try await registry.load() == after)
    #expect(
      try await kv.keys() == [
        "hermie.chats.layout", "hermie.gateway.config@\(one)00", "hermie.gateway.config@\(two)",
        "hermie.gateways", "hermie.installation", "hermie.lock"
      ]
    )
    #expect(try await kv.string(forKey: StoreKeys.chatsLayout) == #"{"\#(two)":{"entries":[1]}}"#)
    #expect(try await SQLiteChatCache(store: store, gatewayId: one).readBots().isEmpty)
    #expect(try await SQLiteChatCache(store: store, gatewayId: one).read(bot: "researcher") == nil)
    #expect(try await SQLiteChatCache(store: store, gatewayId: two).readBots().count == 1)
    #expect(try await SQLiteChatCache(store: store, gatewayId: two).read(bot: "researcher") != nil)
    #expect(await configChanges.next() == .some(nil))
  }
}
