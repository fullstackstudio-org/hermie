import Foundation
import Testing

@testable import HermieStore

private func transcript(_ bot: String) -> CachedTranscript {
  CachedTranscript(
    bot: bot, itemsJSON: #"[{"kind":"assistant","id":"a1"}]"#, lastRowId: 7, lastSeq: 41, epoch: "e1",
    updatedAt: 1_770_000_000_000)
}

@Suite("The cache the reader can switch off")
struct GatedChatCacheTests {
  private static let bot = CachedBot(name: "researcher", json: "{}", avatarRevision: 1, updatedAt: 5)

  @Test("on, it is the cache it wraps; off, it reads nothing and keeps nothing")
  func gate() async throws {
    let store = try SQLiteStore(.inMemory)
    let inner = SQLiteChatCache(store: store, gatewayId: "g01")
    let gate = ChatCacheSwitch()
    let cache = GatedChatCache(inner, gate: gate)

    try await cache.write(transcript("researcher"))
    try await cache.writeBots([Self.bot])
    #expect(try await cache.read(bot: "researcher") == transcript("researcher"))
    #expect(try await cache.readBots() == [Self.bot])

    gate.isEnabled = false

    // What is stored stays stored while it is off (clearing is its own action), but nothing reads it.
    #expect(try await cache.read(bot: "researcher") == nil)
    #expect(try await cache.readBots().isEmpty)
    #expect(try await inner.read(bot: "researcher") == transcript("researcher"))

    try await cache.write(transcript("writer"))
    try await cache.writeBots([])
    #expect(try await inner.read(bot: "writer") == nil, "nothing is written while it is off")
    #expect(try await inner.readBots() == [Self.bot], "an empty roster is not written either")

    gate.isEnabled = true
    #expect(try await cache.read(bot: "researcher") == transcript("researcher"))
  }

  @Test("forgetting and clearing happen whatever the switch says")
  func removalsPassThrough() async throws {
    let store = try SQLiteStore(.inMemory)
    let inner = SQLiteChatCache(store: store, gatewayId: "g01")
    let cache = GatedChatCache(inner, gate: ChatCacheSwitch(enabled: false))

    try await inner.write(transcript("researcher"))
    try await inner.write(transcript("writer"))
    try await cache.forget(bot: "researcher")
    #expect(try await inner.read(bot: "researcher") == nil)

    try await cache.clear()
    #expect(try await inner.read(bot: "writer") == nil)
  }

  @Test("clearing every cache leaves the settings alone")
  func clearAll() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)

    try await keyValues.setString("kept", forKey: "hermie.something")
    try await SQLiteChatCache(store: store, gatewayId: "g01").write(transcript("a"))
    try await SQLiteChatCache(store: store, gatewayId: "g02").write(transcript("a"))
    try await SQLiteChatCache(store: store, gatewayId: "g02").writeBots([Self.bot])

    try await store.clearAllChatCaches()

    #expect(try await store.read { try $0.query("SELECT count(*) AS n FROM transcripts").first?["n"].integer } == 0)
    #expect(try await store.read { try $0.query("SELECT count(*) AS n FROM bots").first?["n"].integer } == 0)
    #expect(try await keyValues.string(forKey: "hermie.something") == "kept")
  }
}
