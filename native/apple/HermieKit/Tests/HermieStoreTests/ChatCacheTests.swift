import Foundation
import Testing

@testable import HermieStore

private func transcript(
  _ bot: String,
  items: String = #"[{"kind":"assistant","id":"a1"}]"#,
  seq: Int64? = 41
) -> CachedTranscript {
  CachedTranscript(bot: bot, itemsJSON: items, lastRowId: 7, lastSeq: seq, epoch: "e1", updatedAt: 1_770_000_000_000)
}

@Suite("Chat cache")
struct ChatCacheTests {
  @Test("a transcript snapshot round trips, is replaced in place and can be forgotten")
  func transcripts() async throws {
    let store = try SQLiteStore(.inMemory)
    let cache = SQLiteChatCache(store: store, gatewayId: "g01")

    #expect(try await cache.read(bot: "researcher") == nil)

    try await cache.write(transcript("researcher"))
    #expect(try await cache.read(bot: "researcher") == transcript("researcher"))

    let replaced = CachedTranscript(
      bot: "researcher", itemsJSON: "[]", lastRowId: nil, lastSeq: nil, epoch: nil, updatedAt: 2
    )

    try await cache.write(replaced)
    #expect(try await cache.read(bot: "researcher") == replaced)
    #expect(try await store.read { try $0.query("SELECT count(*) AS n FROM transcripts").first?["n"].integer } == 1)

    try await cache.forget(bot: "researcher")
    #expect(try await cache.read(bot: "researcher") == nil)
  }

  @Test("two gateways with the same bot name do not see each other's rows")
  func namespaces() async throws {
    let store = try SQLiteStore(.inMemory)
    let first = SQLiteChatCache(store: store, gatewayId: "g01")
    let second = SQLiteChatCache(store: store, gatewayId: "g02")

    try await first.write(transcript("researcher", items: "[1]"))
    try await second.write(transcript("researcher", items: "[2]"))

    #expect(try await first.read(bot: "researcher")?.itemsJSON == "[1]")
    #expect(try await second.read(bot: "researcher")?.itemsJSON == "[2]")

    try await first.clear()

    #expect(try await first.read(bot: "researcher") == nil)
    #expect(try await second.read(bot: "researcher")?.itemsJSON == "[2]")
  }

  @Test("the roster is replaced wholesale for one gateway only, sorted by name")
  func roster() async throws {
    let store = try SQLiteStore(.inMemory)
    let first = SQLiteChatCache(store: store, gatewayId: "g01")
    let second = SQLiteChatCache(store: store, gatewayId: "g02")
    let writer = CachedBot(name: "writer", json: #"{"name":"writer"}"#, avatarRevision: 3, updatedAt: 1)
    let coder = CachedBot(name: "code reviewer", json: "{}", avatarRevision: 0, updatedAt: 1)

    try await first.writeBots([writer, coder])
    try await second.writeBots([writer])
    #expect(try await first.readBots() == [coder, writer])

    try await first.writeBots([coder])
    #expect(try await first.readBots() == [coder])
    #expect(try await second.readBots() == [writer])
  }

  @Test("large opaque item JSON is kept byte for byte")
  func largeItems() async throws {
    let cache = SQLiteChatCache(store: try SQLiteStore(.inMemory), gatewayId: "g01")
    let rows = (0..<ChatCacheLimits.items).map { #"{"id":"a\#($0)","text":"héllo ✓ \#($0)"}"# }
    let items = "[" + rows.joined(separator: ",") + "]"

    try await cache.write(transcript("researcher", items: items))
    #expect(try await cache.read(bot: "researcher")?.itemsJSON == items)
  }

  @Test("the fallback cache downgrades to memory for good after the first failure")
  func fallback() async throws {
    let store = try SQLiteStore(.inMemory)

    try await store.write { try $0.execute("DROP TABLE transcripts") }

    let cache = FallbackChatCache(primary: SQLiteChatCache(store: store, gatewayId: "g01"))

    #expect(await !cache.degraded)
    #expect(try await cache.read(bot: "researcher") == nil)
    #expect(await cache.degraded)

    try await cache.write(transcript("researcher"))
    #expect(try await cache.read(bot: "researcher") == transcript("researcher"))

    try await cache.clear()
    #expect(try await cache.read(bot: "researcher") == nil)
  }
}
