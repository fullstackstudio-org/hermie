import Foundation
import Synchronization
import Testing

import HermieTranscript

@testable import HermieCore

/// A chat of `bot` holding one `message_agent` dispatch per `(stamp, target, message)`.
private func chat(_ bot: String, _ dispatches: [(ts: Double, target: String, message: String)]) -> ChatState {
  var chat = createChatState(bot, "stored-\(bot)", "stored-\(bot)")

  for (index, dispatch) in dispatches.enumerated() {
    let id = "\(bot)-dm-\(index)"
    chat.items[id] = .botDmOut(
      BotDmOutItem(
        base: ItemBase(id: id, seq: index, ts: dispatch.ts, origin: .history, version: 0),
        toolID: "t-\(bot)-\(index)",
        target: "@\(dispatch.target)",
        targetHandle: dispatch.target,
        message: dispatch.message,
        dispatch: BotDmDispatch(status: .queued)
      )
    )
    chat.order.append(id)
  }

  return chat
}

/// What the screen asks of the gateway, scripted.
private final class StubActivity: ActivityBackend, Sendable {
  struct State {
    var bots: [Bot] = []
    var live: [ChatState] = []
    var tails: [String: ChatState] = [:]
    var counters = ActivityCounters()
    var tailReads: [String] = []
    var counterReads = 0
  }

  let state = Mutex(State())

  func bots() async -> [Bot] { state.withLock { $0.bots } }
  func liveStates() async -> [ChatState] { state.withLock { $0.live } }

  func tail(of bot: Bot) async -> ChatState? {
    state.withLock { state in
      state.tailReads.append(bot.name)

      return state.tails[bot.name]
    }
  }

  func counters(for bots: [Bot]) async -> ActivityCounters {
    state.withLock { state in
      state.counterReads += 1

      return state.counters
    }
  }
}

/// 2026-10-04 12:00:00 UTC, in a calendar pinned to UTC so a day is the same day everywhere.
private let activityNoon = Date(timeIntervalSince1970: 1_791_115_200)

private var activityUTC: Calendar {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(secondsFromGMT: 0)!

  return calendar
}

@MainActor
private func model(_ backend: StubActivity) -> ActivityModel {
  ActivityModel(backend: backend, calendar: activityUTC, now: { activityNoon })
}

private let researcher = Bot(name: "researcher", displayName: "Researcher")
private let writer = Bot(name: "writer", displayName: "Writer")

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ActivityModelTests {
  @Test func startsLoadingAndThenHoldsTheTimeline() async {
    let backend = StubActivity()
    let model = model(backend)

    #expect(model.phase == .loading)
    #expect(model.days.isEmpty)

    await model.refresh()

    #expect(model.phase == .ready, "an empty timeline is a timeline")
    #expect(model.entries.isEmpty)
  }

  @Test func everyBotWithoutALiveChatGetsItsTailRead() async {
    let backend = StubActivity()
    backend.state.withLock {
      $0.bots = [researcher, writer]
      $0.tails = ["researcher": chat("researcher", [(1_791_100_000, "writer", "draft the announcement")])]
    }
    let model = model(backend)

    await model.refresh()

    #expect(backend.state.withLock { $0.tailReads.sorted() } == ["researcher", "writer"])
    #expect(model.entries.map(\.fromHandle) == ["researcher"])
    #expect(model.entries.first?.toHandle == "writer")
    #expect(model.entries.first?.text == "draft the announcement")
    #expect(model.entries.first?.botName == "researcher")
  }

  @Test func aLiveChatIsNeverReadAgainAndItsTruthWins() async {
    let backend = StubActivity()
    backend.state.withLock {
      $0.bots = [researcher, writer]
      $0.live = [chat("researcher", [(1_791_100_000, "writer", "from the live chat")])]
      $0.tails = ["researcher": chat("researcher", [(1_791_000_000, "writer", "from a stale tail")])]
    }
    let model = model(backend)

    await model.refresh()

    #expect(backend.state.withLock { $0.tailReads } == ["writer"], "researcher has a live chat: no tail")
    #expect(model.entries.map(\.text) == ["from the live chat"])
  }

  @Test func aBotWhoseTailCannotBeReadContributesNothingAndKeepsItsEarlierRows() async {
    let backend = StubActivity()
    backend.state.withLock {
      $0.bots = [researcher, writer]
      $0.tails = ["researcher": chat("researcher", [(1_791_100_000, "writer", "first read")])]
    }
    let model = model(backend)
    await model.refresh()

    backend.state.withLock { $0.tails = [:] }
    await model.refresh()

    #expect(model.entries.map(\.text) == ["first read"], "a flaky read is no reason to empty a bot's rows")
  }

  @Test func aBotThatLeftTheRosterLeavesTheTimeline() async {
    let backend = StubActivity()
    backend.state.withLock {
      $0.bots = [researcher, writer]
      $0.tails = ["researcher": chat("researcher", [(1_791_100_000, "writer", "hello")])]
    }
    let model = model(backend)
    await model.refresh()

    backend.state.withLock { $0.bots = [writer] }
    await model.refresh()

    #expect(model.entries.isEmpty)
  }

  @Test func reloadingDerivesFromTheStoreWithoutReadingTheGateway() async {
    let backend = StubActivity()
    backend.state.withLock { $0.bots = [researcher] }
    let model = model(backend)
    await model.refresh()
    let reads = backend.state.withLock { $0.tailReads.count }

    // The reader's live chat gets traffic.
    backend.state.withLock { $0.live = [chat("researcher", [(1_791_110_000, "writer", "just now")])] }
    await model.reload()

    #expect(model.entries.map(\.text) == ["just now"])
    #expect(backend.state.withLock { $0.tailReads.count } == reads)
  }

  @Test func theCountersAreTheBackendsAnswer() async {
    let backend = StubActivity()
    backend.state.withLock {
      $0.bots = [researcher]
      $0.counters = ActivityCounters(botsWorking: 2, activeSubagents: 3, inFlightDeliveries: 1)
    }
    let model = model(backend)

    #expect(model.counters == ActivityCounters())
    await model.refresh()
    #expect(model.counters == ActivityCounters(botsWorking: 2, activeSubagents: 3, inFlightDeliveries: 1))

    backend.state.withLock { $0.counters = ActivityCounters(botsWorking: 0) }
    await model.refreshCounters()
    #expect(model.counters == ActivityCounters())
  }

  // MARK: Days

  @Test func theTimelineIsGroupedByDayNewestFirst() async {
    let backend = StubActivity()
    let today = activityNoon.timeIntervalSince1970 - 3600
    let yesterday = today - 86_400
    backend.state.withLock {
      $0.bots = [researcher]
      $0.tails = [
        "researcher": chat(
          "researcher",
          [
            (yesterday, "writer", "y1"), (today - 600, "writer", "t1"), (today, "writer", "t2"),
            (yesterday + 60, "writer", "y2")
          ])
      ]
    }
    let model = model(backend)

    await model.refresh()

    #expect(model.days.count == 2)
    #expect(model.days.map { $0.entries.map(\.text) } == [["t2", "t1"], ["y2", "y1"]])
    #expect(model.days[0].start == activityUTC.startOfDay(for: activityNoon))
    #expect(model.days[1].start == activityUTC.startOfDay(for: activityNoon).addingTimeInterval(-86_400))
  }

  @Test func aDayBoundaryIsTheCalendarsNotAFixedTwentyFourHours() {
    let entries = [
      ActivityEntry(id: "a", botName: "r", itemID: "a", kind: .dmOut, at: 1_791_071_999, fromHandle: "r", text: "late"),
      ActivityEntry(id: "b", botName: "r", itemID: "b", kind: .dmOut, at: 1_791_072_000, fromHandle: "r", text: "early")
    ]

    // 1_791_072_000 is 2026-10-04T00:00:00Z.
    let days = ActivityModel.group(entries, calendar: activityUTC)

    #expect(days.map { $0.entries.map(\.id) } == [["b"], ["a"]])
  }

  // MARK: Names

  @Test func aHandleIsShownAsTheBotsDisplayName() async {
    let backend = StubActivity()
    backend.state.withLock { $0.bots = [researcher, writer] }
    let model = model(backend)

    #expect(model.displayName(forHandle: "researcher") == "researcher", "before the roster is read")
    await model.refresh()

    #expect(model.displayName(forHandle: "researcher") == "Researcher")
    #expect(model.displayName(forHandle: "Writer") == "Writer", "matched case-insensitively")
    #expect(model.displayName(forHandle: "stranger") == "stranger")
    #expect(model.knows(bot: "writer"))
    #expect(!model.knows(bot: "stranger"))
  }
}
