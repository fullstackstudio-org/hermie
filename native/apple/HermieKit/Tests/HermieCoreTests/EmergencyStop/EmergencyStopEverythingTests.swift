import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

// The emergency stop over the fork's `session.interrupt_all`: the one-call path, what it says in the summary,
// the fallback to turn-by-turn on a gateway without it, and the wire decode of its answer.

@MainActor
@Suite("Emergency stop: in one call", .timeLimit(.minutes(1)))
struct EmergencyStopEverythingTests {
  private func turn(_ id: String, bot: String = "") -> RunningTurn {
    RunningTurn(id: id, chatKey: bot.isEmpty ? nil : bot, botName: bot.capitalized)
  }

  private func plan(_ model: EmergencyStopModel) -> StopPlan? {
    if case .confirming(let plan) = model.phase { plan } else { nil }
  }

  private func summary(_ model: EmergencyStopModel) -> StopSummary? {
    if case .finished(let summary) = model.phase { summary } else { nil }
  }

  private func stopped(_ id: String, bot: String, title: String = "", source: String = "tui") -> RunningTurn {
    RunningTurn(id: id, botName: bot, title: title, source: source)
  }

  @Test("the gateway's one call stops it all: no turn is interrupted one by one, and the summary is its answer")
  func oneCallInsteadOfTurnByTurn() async {
    let home = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher"), turn("rt-2", bot: "writer")], unreachable: 2)
    home.everything = .answered(
      StopEverythingReport(
        stopped: [
          stopped("rt-1", bot: "Researcher", title: "Quarterly numbers"),
          stopped("rt-9", bot: "Ops", source: "cli")
        ],
        alreadyIdle: 5, notAllowed: 2, failed: 1))

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()

    #expect(plan(model)?.total == 2, "the question still says how many turns it is about")
    #expect(home.everythingCalls == 0, "nothing is stopped before the person says yes")

    await model.confirm()

    #expect(home.everythingCalls == 1, "one call")
    #expect(home.stopped.isEmpty, "and no interrupt per session")

    let done = summary(model)
    #expect(done?.usedStopEverything == true)
    // One line per turn the gateway stopped, with what it said of each, even one the app had not listed.
    #expect(done?.records.map(\.turn.id) == ["rt-1", "rt-9"])
    #expect(done?.records.map(\.turn.botName) == ["Researcher", "Ops"])
    #expect(done?.records.map(\.turn.title) == ["Quarterly numbers", ""])
    #expect(done?.records.map(\.turn.source) == ["tui", "cli"])
    #expect(done?.records.allSatisfy { $0.outcome == .stopped && $0.gatewayName == "Home" } == true)

    // The counts are the gateway's.
    #expect(done?.stopped == 2)
    #expect(done?.alreadyIdleCount == 5)
    #expect(done?.notAllowed == 2)
    #expect(done?.failed == 1)
    #expect(done?.wasIdle == false)
  }

  @Test("the 'cannot be stopped from here' caveat and the unreadable-list caveat go when the one call answered")
  func theCaveatsGo() async {
    let home = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")], unreachable: 3, complete: false)
    home.everything = .answered(StopEverythingReport(stopped: [stopped("rt-1", bot: "Researcher")], notAllowed: 3))

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()

    #expect(plan(model)?.unreachable == 3, "before the call it cannot be known")
    #expect(plan(model)?.incomplete == true)

    await model.confirm()

    let done = summary(model)
    #expect(done?.unreachable == 0)
    #expect(done?.incomplete == false)
    #expect(done?.notAllowed == 3, "the gateway says whose they were instead")
    #expect(done?.usedStopEverything == true, "the cron note is for a summary of the one call")
  }

  @Test("a gateway without the call is stopped turn by turn, and its caveats stay")
  func olderGatewayFallsBack() async {
    let home = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher"), turn("rt-2")], unreachable: 1, complete: false)
    home.everything = .unsupported

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    #expect(home.everythingCalls == 1, "it asked once and was told no")
    #expect(Set(home.stopped) == ["rt-1", "rt-2"])

    let done = summary(model)
    #expect(done?.usedStopEverything == false)
    #expect(done?.stopped == 2)
    #expect(done?.unreachable == 1)
    #expect(done?.incomplete == true)
    #expect(done?.notAllowed == 0)
    #expect(done?.alreadyIdleCount == 0)
  }

  @Test("a call that did not go through is not the end of it: the turns are stopped one by one")
  func failedCallFallsBack() async {
    let home = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    home.everything = .failed("request timed out")

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    #expect(home.stopped == ["rt-1"])
    #expect(summary(model)?.stopped == 1)
    #expect(summary(model)?.usedStopEverything == false)
  }

  @Test("a connection that went before the call is every turn not connected, and nothing else is tried")
  func notConnectedIsAFailure() async {
    let home = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    home.everything = .notConnected

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    #expect(home.stopped.isEmpty)
    #expect(summary(model)?.records.map(\.outcome) == [.notConnected])
    #expect(summary(model)?.failed == 1)
  }

  @Test("with two gateways each goes its own way: one in a call, one turn by turn, each caveat only where it holds")
  func mixedGateways() async {
    let modern = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")], unreachable: 4, complete: false)
    modern.everything = .answered(StopEverythingReport(stopped: [stopped("rt-1", bot: "Researcher")]))
    let older = FakeStoppable(id: "g2", name: "Work", turns: [turn("rt-7", bot: "ops")], unreachable: 1)

    let model = EmergencyStopModel(gateways: { [modern, older] })
    await model.begin()
    await model.confirm()

    #expect(modern.stopped.isEmpty)
    #expect(older.stopped == ["rt-7"])

    let done = summary(model)
    #expect(done?.records.map(\.gatewayName) == ["Home", "Work"])
    #expect(done?.stopped == 2)
    #expect(done?.unreachable == 1, "only the older gateway's turns cannot be reached")
    #expect(done?.incomplete == false, "the modern one's unreadable list does not matter to a call that does not use it")
    #expect(done?.usedStopEverything == true)
  }

  @Test("a list that could not be read stays a caveat for a gateway that was not stopped in one call")
  func incompleteOnTheOlderGateway() async {
    let modern = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    modern.everything = .answered(StopEverythingReport(stopped: [stopped("rt-1", bot: "Researcher")]))
    let older = FakeStoppable(id: "g2", name: "Work", turns: [turn("rt-7", bot: "ops")], complete: false)

    let model = EmergencyStopModel(gateways: { [modern, older] })
    await model.begin()
    await model.confirm()

    #expect(summary(model)?.incomplete == true)
  }

  @Test("when the call stops nothing it is idle, however many sessions it found with no turn in them")
  func nothingLeftToStop() async {
    let home = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    home.everything = .answered(StopEverythingReport(stopped: [], alreadyIdle: 12))

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    let done = summary(model)
    #expect(done?.wasIdle == true, "the turn ended by itself between the question and the yes")
    #expect(done?.alreadyIdleCount == 12)
    #expect(done?.failed == 0)
  }

  @Test("another person's turn it left running is not idle: it says so")
  func leftRunningIsNotIdle() async {
    let home = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    home.everything = .answered(StopEverythingReport(stopped: [], notAllowed: 1))

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    #expect(summary(model)?.wasIdle == false)
    #expect(summary(model)?.notAllowed == 1)
  }

  @Test("a stop that failed on the gateway is counted even when it names no turn")
  func failedWithoutAName() async {
    let home = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    home.everything = .answered(StopEverythingReport(stopped: [], failed: 2))

    let model = EmergencyStopModel(gateways: { [home] })
    await model.begin()
    await model.confirm()

    #expect(summary(model)?.failed == 2)
    #expect(summary(model)?.wasIdle == false)
  }
}

// MARK: - The wire

@Suite("session.interrupt_all: the wire answer")
struct InterruptAllWireTests {
  @Test func theAnswerIsReadFieldByField() throws {
    let answer = try #require(
      InterruptAllResult.parse(
        .object([
          "stopped": .array([
            .object([
              "session_id": "rt-1", "session_key": "stored-1", "profile": "researcher",
              "title": "Quarterly numbers", "source": "tui"
            ]),
            .object(["session_id": "rt-2", "session_key": "stored-2", "profile": "ops", "title": .null, "source": "cli"])
          ]),
          "already_idle": 4, "not_allowed": 1, "failed": 2
        ])))

    #expect(answer.stopped.count == 2)
    #expect(answer.stopped[0] == .init(sessionID: "rt-1", sessionKey: "stored-1", profile: "researcher", title: "Quarterly numbers", source: "tui"))
    #expect(answer.stopped[1].title.isEmpty, "a session with no title yet is an empty one")
    #expect(answer.stopped[1].source == "cli")
    #expect(answer.alreadyIdle == 4)
    #expect(answer.notAllowed == 1)
    #expect(answer.failed == 2)
  }

  @Test func anAnswerWithNoTurnsIsStillAnAnswer() throws {
    let answer = try #require(
      InterruptAllResult.parse(.object(["stopped": .array([]), "already_idle": 0, "not_allowed": 0, "failed": 0])))

    #expect(answer == InterruptAllResult())
  }

  @Test func aRowWithNoSessionIdIsDroppedAndAnythingThatIsNotThisAnswerIsNil() {
    let rows: JSONValue = .array([.object(["profile": "researcher"]), .string("x"), .object(["session_id": ""])])

    #expect(InterruptAllResult.parse(.object(["stopped": rows]))?.stopped.isEmpty == true)
    #expect(InterruptAllResult.parse(.object(["status": "interrupted"])) == nil)
    #expect(InterruptAllResult.parse(.object([:])) == nil)
    #expect(InterruptAllResult.parse(.string("ok")) == nil)
    #expect(InterruptAllResult.parse(nil) == nil)
  }

  @Test func countsAreWholeNonNegativeNumbersAndTextIsCleanedAndBounded() throws {
    let long = String(repeating: "t", count: 500)
    let answer = try #require(
      InterruptAllResult.parse(
        .object([
          "stopped": .array([
            .object(["session_id": "rt-1", "profile": "res\nearcher\u{202E}", "title": .string(long), "source": "tui"])
          ]),
          "already_idle": -3, "not_allowed": "many", "failed": 1.0
        ])))

    #expect(answer.alreadyIdle == 0)
    #expect(answer.notAllowed == 0)
    #expect(answer.failed == 1)
    #expect(!answer.stopped[0].profile.contains("\n"))
    #expect(!answer.stopped[0].profile.contains("\u{202E}"))
    #expect(answer.stopped[0].title.count <= 61, "a title is cut to a line")
  }

  @Test func aRunawayListIsCut() throws {
    let rows: [JSONValue] = (0..<500).map { .object(["session_id": .string("rt-\($0)")]) }
    let answer = try #require(InterruptAllResult.parse(.object(["stopped": .array(rows)])))

    #expect(answer.stopped.count == InterruptAllResult.stoppedLimit)
  }
}
