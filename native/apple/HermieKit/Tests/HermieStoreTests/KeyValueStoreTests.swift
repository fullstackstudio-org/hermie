import Foundation
import Testing

@testable import HermieStore

private struct ChatView: Codable, Equatable, Sendable {
  var showThinking: Bool
  var level: String
}

@Suite("Key-value store")
struct KeyValueStoreTests {
  private func makeStore() throws -> KeyValueStore {
    KeyValueStore(store: try SQLiteStore(.inMemory))
  }

  @Test("strings and Codable values round trip as JSON text")
  func roundTrips() async throws {
    let kv = try makeStore()

    try await kv.setString("plain", forKey: "hermie.a")
    try await kv.set(ChatView(showThinking: true, level: "normal"), forKey: "hermie.chat.view@g01")
    try await kv.set(["url": "https://gateway.test/x"], forKey: "hermie.b")

    #expect(try await kv.string(forKey: "hermie.a") == "plain")
    let view = try await kv.value(ChatView.self, forKey: "hermie.chat.view@g01")

    #expect(view == ChatView(showThinking: true, level: "normal"))
    // Written the way JSON.stringify writes it, so the Expo app could read it back.
    #expect(try await kv.string(forKey: "hermie.b") == #"{"url":"https://gateway.test/x"}"#)
    #expect(try await kv.string(forKey: "hermie.missing") == nil)

    try await kv.removeValue(forKey: "hermie.a")

    #expect(try await kv.string(forKey: "hermie.a") == nil)
    #expect(try await kv.keys() == ["hermie.b", "hermie.chat.view@g01"])
  }

  @Test("a value that does not decode is reported and left in place")
  func undecodable() async throws {
    let kv = try makeStore()

    try await kv.setString("{not json", forKey: StoreKeys.lock)

    await #expect(throws: KeyValueError.self) {
      _ = try await kv.value(ChatView.self, forKey: StoreKeys.lock)
    }

    #expect(try await kv.string(forKey: StoreKeys.lock) == "{not json")
  }

  @Test("namespaced keys use the TypeScript suffixes and split back at the first @")
  func namespacing() {
    let ns = GatewayNamespace("g0123456789abcdef")

    #expect(ns.key(StoreKeys.chatView) == "hermie.chat.view@g0123456789abcdef")
    #expect(ns.secretKey("hermie.auth.access_token") == "hermie.auth.access_token-g0123456789abcdef")

    let split = GatewayNamespace.split("hermie.gateway.config@g0123456789abcdef")

    #expect(split?.base == "hermie.gateway.config")
    #expect(split?.id == "g0123456789abcdef")
    #expect(GatewayNamespace.split("hermie.lock") == nil)
  }

  @Test("a batch lands completely or not at all")
  func atomicBatch() async throws {
    let kv = try makeStore()

    try await kv.setString("old", forKey: "hermie.a")
    try await kv.apply([
      .set(key: "hermie.a", value: "new"), .set(key: "hermie.b", value: "b"), .remove(key: "hermie.c")
    ])

    #expect(try await kv.string(forKey: "hermie.a") == "new")
    #expect(try await kv.string(forKey: "hermie.b") == "b")

    await #expect(throws: CancellationError.self) {
      try await kv.store.write { database in
        try database.kvSet("half", forKey: "hermie.a")
        try database.kvSet("half", forKey: "hermie.b")
        throw CancellationError()
      }
    }

    #expect(try await kv.string(forKey: "hermie.a") == "new")
    #expect(try await kv.string(forKey: "hermie.b") == "b")
  }

  @Test("a key's stream yields each committed change and nil on removal")
  func streams() async throws {
    let kv = try makeStore()
    var changes = kv.changes(forKey: "hermie.watched").makeAsyncIterator()

    try await kv.setString("one", forKey: "hermie.watched")
    #expect(await changes.next() == .some("one"))

    try await kv.setString("other key", forKey: "hermie.unwatched")
    try await kv.apply([.set(key: "hermie.watched", value: "two"), .set(key: "hermie.x", value: "x")])
    #expect(await changes.next() == .some("two"))

    try await kv.removeValue(forKey: "hermie.watched")
    #expect(await changes.next() == .some(nil))
  }

  @Test("a rolled-back write is never announced")
  func rollbackIsSilent() async throws {
    let kv = try makeStore()
    var changes = kv.changes(forKey: "hermie.watched").makeAsyncIterator()

    _ = try? await kv.store.write { database in
      try database.kvSet("never", forKey: "hermie.watched")
      throw CancellationError()
    }

    try await kv.setString("after", forKey: "hermie.watched")
    #expect(await changes.next() == .some("after"))
  }

  @Test("typed streams decode, and report a value that does not decode")
  func typedStreams() async throws {
    let kv = try makeStore()
    var values = kv.values(ChatView.self, forKey: "hermie.view").makeAsyncIterator()

    try await kv.set(ChatView(showThinking: false, level: "x"), forKey: "hermie.view")

    let first = await values.next()

    #expect(try first?.get() == ChatView(showThinking: false, level: "x"))

    try await kv.setString("[]", forKey: "hermie.view")

    let second = await values.next()

    #expect(throws: KeyValueError.self) {
      _ = try second?.get()
    }
  }

  @Test("a stream that is dropped unsubscribes")
  func unsubscribe() async throws {
    let kv = try makeStore()

    do {
      let stream = kv.changes(forKey: "hermie.gone")

      #expect(kv.store.observers.subscriberCount(forKey: "hermie.gone") == 1)
      _ = stream
    }

    #expect(kv.store.observers.subscriberCount(forKey: "hermie.gone") == 0)
  }
}
