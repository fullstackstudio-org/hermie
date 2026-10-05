import Foundation
import Testing

@testable import HermieCore

/// The screen's model: scope, filters, search, days and what is exported.
@Suite("Decision log: the screen's model", .timeLimit(.minutes(1))) @MainActor
struct DecisionLogModelTests {
  private static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)

    calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt

    return calendar
  }

  private static let noon = DecisionFixture.start  // 2026-09-21 14:13:20 UTC

  /// Five decisions over three days, two bots, three kinds.
  private func filled() async throws -> (DecisionLog, DecisionLogModel) {
    let log = try DecisionFixture.log(limits: DecisionLimits(maxEntries: 100, maxAge: 400 * 86_400))
    let day = 86_400.0

    await log.record(
      DecisionFixture.entry("a", at: Self.noon, bot: "researcher", kind: .approval, outcome: .approvedAlways, summary: "npm test"))
    await log.record(
      DecisionFixture.entry("b", at: Self.noon.addingTimeInterval(-60), bot: "writer", kind: .clarify, outcome: .answered))
    await log.record(
      DecisionFixture.entry(
        "c", at: Self.noon.addingTimeInterval(-day), bot: "researcher", kind: .confirm, outcome: .confirmed, method: .passkey))
    await log.record(
      DecisionFixture.entry(
        "d", at: Self.noon.addingTimeInterval(-day - 10), bot: "writer", kind: .approval, outcome: .denied, summary: "rm -rf ./build"))
    await log.record(
      DecisionFixture.entry("e", at: Self.noon.addingTimeInterval(-3 * day), bot: "researcher", kind: .secure, outcome: .entered))

    let model = DecisionLogModel(log: log, calendar: Self.utc)

    await model.load()

    return (log, model)
  }

  @Test("everything is listed newest first until a filter or a search narrows it")
  func listsEverything() async throws {
    let (_, model) = try await filled()

    #expect(model.loaded)
    #expect(model.filtered.map(\.id) == ["a", "b", "c", "d", "e"])
    #expect(!model.isNarrowed)
    #expect(model.bots == ["researcher", "writer"])
    #expect(model.kinds == [.approval, .clarify, .confirm, .secure], "only kinds that occur, in the declared order")
  }

  @Test("the entries are grouped by calendar day, the latest day first")
  func groupsByDay() async throws {
    let (_, model) = try await filled()
    let days = model.days

    #expect(days.count == 3)
    #expect(days.map { $0.entries.map(\.id) } == [["a", "b"], ["c", "d"], ["e"]])
    #expect(days[0].day == Self.utc.startOfDay(for: Self.noon))
    #expect(days[0].day > days[1].day && days[1].day > days[2].day)
  }

  @Test("a decision just after midnight is on the next day")
  func midnight() {
    let before = DecisionFixture.entry("x", at: Self.utc.date(from: DateComponents(year: 2026, month: 9, day: 20, hour: 23, minute: 59, second: 59))!)
    let after = DecisionFixture.entry("y", at: Self.utc.date(from: DateComponents(year: 2026, month: 9, day: 21, hour: 0, minute: 0, second: 1))!)
    let days = DecisionLogModel.group([after, before], calendar: Self.utc)

    #expect(days.map { $0.entries.map(\.id) } == [["y"], ["x"]])
  }

  @Test("the bot filter keeps one bot's decisions")
  func botFilter() async throws {
    let (_, model) = try await filled()

    model.botFilter = "writer"
    #expect(model.filtered.map(\.id) == ["b", "d"])
    #expect(model.isNarrowed)
    #expect(model.days.map { $0.entries.map(\.id) } == [["b"], ["d"]])
  }

  @Test("the kind filter keeps one kind")
  func kindFilter() async throws {
    let (_, model) = try await filled()

    model.kindFilter = .approval
    #expect(model.filtered.map(\.id) == ["a", "d"])
  }

  @Test("the bot and the kind filters work together")
  func bothFilters() async throws {
    let (_, model) = try await filled()

    model.botFilter = "writer"
    model.kindFilter = .approval
    #expect(model.filtered.map(\.id) == ["d"])

    model.kindFilter = .confirm
    #expect(model.filtered.isEmpty)
    #expect(model.days.isEmpty)
  }

  @Test("a bot that left the log is no longer a filter")
  func filterFollowsTheLog() async throws {
    let (log, model) = try await filled()

    model.botFilter = "writer"
    await log.purge(gatewayID: "g1")
    await model.load()
    #expect(model.botFilter == nil)
    #expect(model.entries.isEmpty)
  }

  @Test("the search needs every word, in any order, in the bot, gateway, summary, kind or outcome")
  func search() async throws {
    let (_, model) = try await filled()

    model.query = "NPM"
    #expect(model.filtered.map(\.id) == ["a"], "case does not matter")

    model.query = "writer approval"
    #expect(model.filtered.map(\.id) == ["d"], "words from different fields")

    model.query = "home researcher"
    #expect(model.filtered.map(\.id) == ["a", "c", "e"], "the gateway's name")

    model.query = "denied"
    #expect(model.filtered.map(\.id) == ["d"], "the outcome")

    model.query = "  "
    #expect(model.filtered.count == 5, "blank is no search")

    model.query = "nothing like this"
    #expect(model.filtered.isEmpty)
  }

  @Test("the screen can add the words it shows for a kind, in the reader's language")
  func localisedSearch() async throws {
    let (_, model) = try await filled()

    model.searchText = { entry in entry.kind == .confirm ? "bevestiging" : "" }
    model.query = "bevestiging"
    #expect(model.filtered.map(\.id) == ["c"])
  }

  @Test("a search ignores accents")
  func diacritics() async throws {
    let log = try DecisionFixture.log()

    await log.record(DecisionFixture.entry("a", summary: "café"))

    let model = DecisionLogModel(log: log)

    await model.load()
    model.query = "cafe"
    #expect(model.filtered.map(\.id) == ["a"])
  }

  @Test("a bot's page shows that bot of that gateway only")
  func botScope() async throws {
    let (log, _) = try await filled()

    await log.record(DecisionFixture.entry("other", gatewayID: "g2", bot: "researcher"))

    let model = DecisionLogModel(log: log, scope: .init(gatewayID: "g1", bot: "researcher"), calendar: Self.utc)

    await model.load()
    #expect(model.entries.map(\.id) == ["a", "c", "e"])

    model.botFilter = "writer"
    #expect(model.filtered.map(\.id) == ["a", "c", "e"], "the page is about one bot: the bot filter does not apply")
  }

  @Test("what is exported is what the filters leave")
  func exportsTheFilteredList() async throws {
    let (_, model) = try await filled()

    model.kindFilter = .approval
    model.query = "npm"

    let rows = String(decoding: model.export(as: .csv), as: UTF8.self).components(separatedBy: "\r\n").filter { !$0.isEmpty }

    #expect(rows.count == 2)
    #expect(rows[1].contains("npm test"))
    #expect(model.fileName(.json, now: Self.noon) == "hermie-decisions-2026-09-21.json")
  }
}
