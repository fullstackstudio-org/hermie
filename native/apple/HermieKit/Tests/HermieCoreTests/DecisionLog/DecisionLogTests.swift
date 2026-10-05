import Foundation
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A clock a test moves.
final class DecisionClock: Sendable {
  private let value: Mutex<Date>

  init(_ start: Date) {
    value = Mutex(start)
  }

  var now: Date { value.withLock { $0 } }

  func advance(days: Double) {
    value.withLock { $0 = $0.addingTimeInterval(days * 86_400) }
  }
}

enum DecisionFixture {
  /// 2026-10-05 12:00 UTC.
  static let start = Date(timeIntervalSince1970: 1_790_000_000)

  static func entry(
    _ id: String = UUID().uuidString,
    at: Date = start,
    gatewayID: String = "g1",
    bot: String = "researcher",
    kind: DecisionKind = .approval,
    outcome: DecisionOutcome = .approved,
    method: DecisionMethod = .tap,
    summary: String? = nil
  ) -> DecisionEntry {
    DecisionEntry(
      id: id, at: at, gatewayID: gatewayID, gateway: "Home", bot: bot, session: "sess-\(bot)", kind: kind,
      outcome: outcome, method: method, summary: summary)
  }

  @MainActor
  static func log(
    store: SQLiteStore? = nil,
    limits: DecisionLimits = .standard,
    clock: DecisionClock = DecisionClock(start)
  ) throws -> DecisionLog {
    DecisionLog(store: try store ?? SQLiteStore(.inMemory), limits: limits, now: { clock.now })
  }
}

/// The log's storage: what is kept, how much, for how long, and what goes with a gateway.
@Suite("Decision log: storage", .timeLimit(.minutes(1))) @MainActor
struct DecisionLogTests {
  @Test("an entry comes back as it was written, newest first")
  func roundTrip() async throws {
    let log = try DecisionFixture.log()
    let one = DecisionFixture.entry("a", at: DecisionFixture.start.addingTimeInterval(-60), summary: "ls -la")
    let two = DecisionFixture.entry(
      "b", at: DecisionFixture.start, kind: .confirm, outcome: .confirmed, method: .passkey)

    await log.record(one)
    await log.record(two)

    let entries = await log.entries()

    #expect(entries.map(\.id) == ["b", "a"])
    #expect(entries[1] == one)
    #expect(entries[0] == two)
    #expect(entries[0].method == .passkey && entries[0].kind == .confirm && entries[0].outcome == .confirmed)
    #expect(await log.count() == 2)
  }

  @Test("an entry written twice under one id is kept once")
  func sameID() async throws {
    let log = try DecisionFixture.log()

    await log.record(DecisionFixture.entry("a", outcome: .approved))
    await log.record(DecisionFixture.entry("a", outcome: .denied))

    #expect(await log.entries().map(\.outcome) == [.denied])
  }

  @Test("the standard limits are 5,000 entries and 90 days")
  func standardLimits() {
    #expect(DecisionLimits.standard.maxEntries == 5_000)
    #expect(DecisionLimits.standard.maxAge == 90 * 24 * 3_600)
  }

  @Test("the count limit keeps the newest entries")
  func countCap() async throws {
    let log = try DecisionFixture.log(limits: DecisionLimits(maxEntries: 5, maxAge: 90 * 86_400))

    for index in 0..<8 {
      await log.record(DecisionFixture.entry("e\(index)", at: DecisionFixture.start.addingTimeInterval(Double(index))))
    }

    #expect(await log.count() == 5)
    #expect(await log.entries().map(\.id) == ["e7", "e6", "e5", "e4", "e3"])
  }

  @Test("the standard count limit holds at 5,000: the 5,001st decision pushes the oldest out")
  func fiveThousand() async throws {
    let log = try DecisionFixture.log()

    for index in 0...DecisionLimits.standard.maxEntries {
      await log.record(DecisionFixture.entry("e\(index)", at: DecisionFixture.start.addingTimeInterval(Double(index))))
    }

    #expect(await log.count() == 5_000)

    let entries = await log.entries()

    #expect(entries.first?.id == "e5000")
    #expect(entries.last?.id == "e1")
    #expect(!entries.contains { $0.id == "e0" })
  }

  @Test("entries with the same time are cut by the order they were written in")
  func countCapSameSecond() async throws {
    let log = try DecisionFixture.log(limits: DecisionLimits(maxEntries: 2, maxAge: 90 * 86_400))

    for index in 0..<4 {
      await log.record(DecisionFixture.entry("e\(index)"))
    }

    #expect(await log.entries().map(\.id) == ["e3", "e2"])
  }

  @Test("the age limit drops what is older than 90 days, at the next write and at launch")
  func ageLimit() async throws {
    let clock = DecisionClock(DecisionFixture.start)
    let log = try DecisionFixture.log(clock: clock)

    await log.record(DecisionFixture.entry("old", at: clock.now))
    clock.advance(days: 60)
    await log.record(DecisionFixture.entry("middle", at: clock.now))
    #expect(await log.entries().map(\.id) == ["middle", "old"])

    // 91 days after the first: it goes at the next write.
    clock.advance(days: 31)
    await log.record(DecisionFixture.entry("new", at: clock.now))
    #expect(await log.entries().map(\.id) == ["new", "middle"])

    // Nobody writes for another 60 days: `prune` (the launch) takes the middle one.
    clock.advance(days: 60)

    let before = log.revision

    await log.prune()
    #expect(await log.entries().map(\.id) == ["new"])
    #expect(log.revision > before, "a screen is told")

    let unchanged = log.revision

    await log.prune()
    #expect(log.revision == unchanged, "nothing to drop, nothing to tell")
  }

  @Test("an entry exactly on the age limit is kept, one past it is not")
  func ageEdge() async throws {
    let clock = DecisionClock(DecisionFixture.start)
    let log = try DecisionFixture.log(clock: clock)
    let limit = DecisionLimits.standard.maxAge

    await log.record(DecisionFixture.entry("edge", at: clock.now.addingTimeInterval(-limit)))
    await log.record(DecisionFixture.entry("past", at: clock.now.addingTimeInterval(-limit - 1)))

    #expect(await log.entries().map(\.id) == ["edge"])
  }

  @Test("purging a gateway removes its entries and no other's")
  func purgeGateway() async throws {
    let log = try DecisionFixture.log()

    await log.record(DecisionFixture.entry("a", gatewayID: "g1"))
    await log.record(DecisionFixture.entry("b", gatewayID: "g2"))
    await log.record(DecisionFixture.entry("c", gatewayID: "g1"))

    let before = log.revision

    await log.purge(gatewayID: "g1")

    #expect(await log.entries().map(\.id) == ["b"])
    #expect(log.revision > before)
  }

  @Test("clearing removes everything")
  func clear() async throws {
    let log = try DecisionFixture.log()

    await log.record(DecisionFixture.entry("a", gatewayID: "g1"))
    await log.record(DecisionFixture.entry("b", gatewayID: "g2"))
    await log.clear()

    #expect(await log.count() == 0)
  }

  @Test("a gateway's entries can be read, and counted, for one bot")
  func scope() async throws {
    let log = try DecisionFixture.log()

    await log.record(DecisionFixture.entry("a", gatewayID: "g1", bot: "researcher"))
    await log.record(DecisionFixture.entry("b", gatewayID: "g1", bot: "writer"))
    await log.record(DecisionFixture.entry("c", gatewayID: "g2", bot: "researcher"))

    #expect(await log.entries(gatewayID: "g1", bot: "researcher").map(\.id) == ["a"])
    #expect(await log.entries(gatewayID: "g1").map(\.id).sorted() == ["a", "b"])
    #expect(await log.entries(bot: "researcher").map(\.id).sorted() == ["a", "c"])
    #expect(await log.count(gatewayID: "g1", bot: "writer") == 1)
    #expect(await log.count(gatewayID: "g2", bot: "writer") == 0)
    #expect(await log.count() == 3)
  }

  @Test("a row this build cannot read is left out, and does not stop the rest")
  func unreadableRow() async throws {
    let store = try SQLiteStore(.inMemory)
    let log = try DecisionFixture.log(store: store)

    await log.record(DecisionFixture.entry("good"))
    try await store.write { database in
      try database.execute(
        "INSERT INTO decisions (id, ns, bot, at, json) VALUES (?, ?, ?, ?, ?)",
        [.text("bad"), .text("g1"), .text("researcher"), .integer(1_790_000_001_000), .text(#"{"kind":"from-the-future"}"#)]
      )
    }

    #expect(await log.entries().map(\.id) == ["good"])
  }

  @Test("a write that fails is dropped and never throws")
  func failedWrite() async throws {
    let store = try SQLiteStore(.inMemory)
    let log = try DecisionFixture.log(store: store)

    try await store.write { database in
      try database.execute("DROP TABLE decisions")
    }

    await log.record(DecisionFixture.entry("a"))
    #expect(await log.entries().isEmpty)
  }

  @Test("the log is in the database file's own table, which backups leave out, and not in the key-value store")
  func whereItLives() async throws {
    let store = try SQLiteStore(.inMemory)
    let log = try DecisionFixture.log(store: store)

    await log.record(DecisionFixture.entry("a"))

    let kv = KeyValueStore(store: store)

    #expect(try await kv.keys().isEmpty, "nothing in the settings that the synced gateway list or a sync reads")
    #expect(try await store.read { try $0.query("SELECT count(*) AS n FROM decisions").first?["n"].integer } == 1)
  }
}
