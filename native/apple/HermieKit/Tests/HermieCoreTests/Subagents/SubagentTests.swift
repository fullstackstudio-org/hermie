import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private func child(
  _ id: String, parent: String? = nil, status: Subagent.Status = .running, startedAt: Double = 1_000,
  accepting: Bool? = nil, session: String? = nil
) -> Subagent {
  Subagent(
    id: id, parentID: parent, childSessionID: session, goal: "goal \(id)", taskIndex: 0, taskCount: 1, status: status,
    startedAt: startedAt, updatedAt: startedAt + 1000, filesRead: [], filesWritten: [], stream: [],
    acceptingSteer: accepting)
}

private func state(_ children: [Subagent]) -> ChatState {
  var state = createChatState("researcher", "stored", "stored")

  for child in children {
    state.subagents[child.id] = child
  }

  return state
}

struct SubagentRowsTests {
  @Test func aChatWithoutChildrenHasNoRows() {
    #expect(SubagentRow.rows(of: state([])).isEmpty)
  }

  @Test func parentsComeBeforeTheirChildrenAndEachSaysHowDeepItIs() {
    let rows = SubagentRow.rows(
      of: state([
        child("b", parent: "a", startedAt: 2_000),
        child("a", startedAt: 1_000),
        child("c", parent: "b", startedAt: 3_000),
        child("d", startedAt: 4_000)
      ]))

    #expect(rows.map(\.id) == ["a", "b", "c", "d"])
    #expect(rows.map(\.depth) == [0, 1, 2, 0])
  }

  @Test func onlyAQueuedOrRunningChildIsLive() {
    #expect(SubagentRow(subagent: child("a", status: .running)).isLive)
    #expect(SubagentRow(subagent: child("a", status: .queued)).isLive)

    for status in [Subagent.Status.completed, .failed, .interrupted] {
      #expect(!SubagentRow(subagent: child("a", status: status)).isLive)
    }
  }

  @Test func aLiveChildCanBeSteeredUnlessTheGatewayStoppedTakingCorrections() {
    #expect(SubagentRow(subagent: child("a")).canSteer)
    #expect(SubagentRow(subagent: child("a", accepting: true)).canSteer)
    #expect(!SubagentRow(subagent: child("a", accepting: false)).canSteer)
    #expect(!SubagentRow(subagent: child("a", status: .completed)).canSteer)
  }

  @Test func aChildHasASessionOfItsOwnOnlyWhenTheGatewayNamedOne() {
    #expect(SubagentRow(subagent: child("a")).childSession == nil)
    #expect(SubagentRow(subagent: child("a", session: "")).childSession == nil)
    #expect(SubagentRow(subagent: child("a", session: "child-1")).childSession == "child-1")
  }
}

struct SubagentBarTests {
  @Test func theBarCountsLiveChildrenAndStartsFromTheOldest() {
    let bar = SubagentBar([
      SubagentRow(subagent: child("a", startedAt: 5_000)),
      SubagentRow(subagent: child("b", status: .queued, startedAt: 3_000)),
      SubagentRow(subagent: child("c", status: .completed, startedAt: 1_000))
    ])

    #expect(bar.running == 2)
    #expect(bar.startedAtMs == 3_000)
    #expect(bar.isShown)
  }

  @Test func withNothingRunningTheBarIsHidden() {
    let bar = SubagentBar([SubagentRow(subagent: child("a", status: .failed))])

    #expect(!bar.isShown)
    #expect(bar.startedAtMs == nil)
    #expect(!SubagentBar([]).isShown)
  }

  @Test func theClockCountsFromTheStartAndNeverGoesBelowZero() {
    let bar = SubagentBar(running: 1, startedAtMs: 10_000)

    #expect(bar.elapsed(atMs: 52_000) == 42)
    #expect(bar.elapsed(atMs: 5_000) == 0)
    #expect(SubagentBar(running: 1).elapsed(atMs: 5_000) == nil)
  }

  @Test func theClockIsWrittenAsMinutesAndSecondsThenHours() {
    #expect(SubagentBar.clock(nil) == "0:00")
    #expect(SubagentBar.clock(-3) == "0:00")
    #expect(SubagentBar.clock(.nan) == "0:00")
    #expect(SubagentBar.clock(7.9) == "0:07")
    #expect(SubagentBar.clock(42) == "0:42")
    #expect(SubagentBar.clock(725) == "12:05")
    #expect(SubagentBar.clock(3_723) == "1:02:03")
  }
}

/// A scripted gateway for the sheet's three calls.
private final class AgentsGateway: Sendable {
  struct State {
    var steers: [(id: String, text: String)] = []
    var stops: [String] = []
    var tails: [String] = []
    var steerOutcome = SubagentSteerOutcome.queued
    var found = true
    var tail: [Result<SubagentTail, any Error>] = [.success(.text("hello"))]
    var failing: (any Error)?
  }

  let state = Mutex(State())

  var gateway: SubagentGateway {
    SubagentGateway(
      steer: { id, text in
        try self.state.withLock { state in
          state.steers.append((id, text))

          if let failing = state.failing { throw failing }

          return state.steerOutcome
        }
      },
      interrupt: { id in
        try self.state.withLock { state in
          state.stops.append(id)

          if let failing = state.failing { throw failing }

          return state.found
        }
      },
      tail: { id in
        try self.state.withLock { state in
          state.tails.append(id)
          let next = state.tail.count > 1 ? state.tail.removeFirst() : state.tail[0]

          return try next.get()
        }
      })
  }
}

@MainActor
struct SubagentPanelModelTests {
  @Test func aCorrectionIsHandedOverTrimmedAndTheSheetSaysItIsQueued() async {
    let gateway = AgentsGateway()
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    let sent = await panel.steer("a", text: "  Use the other file.\n")

    #expect(sent)
    #expect(panel.notice == .steerQueued)
    #expect(gateway.state.withLock { $0.steers.map { "\($0.id)|\($0.text)" } } == ["a|Use the other file."])
    #expect(panel.busy.isEmpty)
  }

  @Test func nothingTypedSendsNothing() async {
    let gateway = AgentsGateway()
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    #expect(await panel.steer("a", text: " \n ") == false)
    #expect(gateway.state.withLock { $0.steers.isEmpty })
    #expect(panel.notice == nil)
  }

  @Test func aRejectedCorrectionIsSaidAndKeepsTheWordsInTheField() async {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.steerOutcome = .rejected }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    #expect(await panel.steer("a", text: "Stop reading") == false)
    #expect(panel.notice == .steerRejected)
  }

  @Test func aFailureToSteerIsSaidInTheGatewaysWords() async {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.failing = GatewayRPCError(.rejected, "no such child", code: 4040) }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    #expect(await panel.steer("a", text: "x") == false)

    guard case .failed(let reason)? = panel.notice else {
      Issue.record("expected a failure notice, got \(String(describing: panel.notice))")
      return
    }

    #expect(reason.contains("no such child"))
  }

  @Test func stoppingAChildAsksForThatChildOnly() async {
    let gateway = AgentsGateway()
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    await panel.stop("b")

    #expect(gateway.state.withLock { $0.stops } == ["b"])
    #expect(panel.notice == .stopping)
  }

  @Test func aChildThatIsGoneAlreadyIsSaidToHaveFinished() async {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.found = false }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    await panel.stop("b")

    #expect(panel.notice == .finished)
  }

  @Test func aStopThatFailsIsSaid() async {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.failing = GatewayRPCError(.notConnected, "gateway not connected") }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    await panel.stop("b")

    guard case .failed? = panel.notice else {
      Issue.record("expected a failure notice")
      return
    }
  }

  @Test func theTailOpensEmptyThenFillsAndIsFollowedUntilItClosesOrIsCancelled() async throws {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.tail = [.success(.text("first")), .success(.text("second"))] }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    panel.openTail("a", goal: "Read the repo")
    #expect(panel.tail == SubagentPanelModel.Tail(id: "a", goal: "Read the repo"))
    #expect(panel.tail?.loading == true)

    let following = Task { await panel.followTail(every: .milliseconds(5)) }
    try await eventually("the second read") { await MainActor.run { panel.tail?.text == "second" } }
    #expect(panel.tail?.loading == false)

    panel.closeTail()
    await following.value

    #expect(panel.tail == nil)
    #expect(gateway.state.withLock { Set($0.tails) } == ["a"])
  }

  @Test func aChildWithNoLiveTranscriptYetSaysSo() async {
    let gateway = AgentsGateway()
    gateway.state.withLock { $0.tail = [.success(.unavailable)] }
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    panel.openTail("a", goal: "g")
    await panel.refreshTail("a")

    #expect(panel.tail?.unavailable == true)
    #expect(panel.tail?.loading == false)
    #expect(panel.tail?.error == nil)
  }

  @Test func aFailedReadKeepsWhatWasReadBeforeAndSaysWhy() async {
    let gateway = AgentsGateway()
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    panel.openTail("a", goal: "g")
    await panel.refreshTail("a")
    #expect(panel.tail?.text == "hello")

    gateway.state.withLock { $0.tail = [.failure(GatewayRPCError(.timeout, "slow"))] }
    await panel.refreshTail("a")

    #expect(panel.tail?.text == "hello")
    #expect(panel.tail?.error != nil)
  }

  @Test func aReadThatArrivesAfterThePageClosedIsDropped() async {
    let gateway = AgentsGateway()
    let panel = SubagentPanelModel(gateway: gateway.gateway)

    panel.openTail("a", goal: "g")
    panel.closeTail()
    await panel.refreshTail("a")

    #expect(panel.tail == nil)
  }
}

private let bot = Fixture.profile

@MainActor
struct SubagentChatTests {
  private func opened() async throws -> (SessionHarness, ChatModel) {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open(resume: Fixture.resume())
    try await harness.frame()
    return (harness, model)
  }

  private func start(_ harness: SessionHarness, _ id: String, goal: String, seq: Int) {
    harness.link.emit(
      "subagent.start", session: Fixture.runtime, seq: seq,
      payload: ["subagent_id": .string(id), "goal": .string(goal), "task_index": 0, "task_count": 2])
  }

  @Test func theBarFollowsTheEventsOfTheChildren() async throws {
    let (harness, model) = try await opened()

    #expect(!model.subagentBar.isShown)

    start(harness, "a", goal: "Read the repo", seq: 1)
    start(harness, "b", goal: "Write the notes", seq: 2)
    try await harness.frame()

    #expect(model.subagents.map(\.id).sorted() == ["a", "b"])
    #expect(model.subagentBar.running == 2)

    harness.link.emit(
      "subagent.complete", session: Fixture.runtime, seq: 3,
      payload: ["subagent_id": "a", "status": "completed", "summary": "Done."])
    try await harness.frame()

    #expect(model.subagentBar.running == 1)
    #expect(model.subagents.first { $0.id == "a" }?.subagent.status == .completed)
    await harness.session.shutdown()
  }

  @Test func steerStopAndTailAskTheGatewayForThisChatsRuntimeSession() async throws {
    let (harness, model) = try await opened()
    harness.link.respond(to: RPC.SubagentSteer.name, with: ["status": "queued", "subagent_id": "a", "text": "x"])
    harness.link.respond(to: RPC.SubagentInterrupt.name, with: ["found": true, "subagent_id": "a"])
    harness.link.respond(to: RPC.SubagentTail.name, with: ["subagent_id": "a", "available": true, "text": "tail text"])
    let panel = model.subagentPanel()

    #expect(await panel.steer("a", text: "Use the other file"))
    await panel.stop("a")
    panel.openTail("a", goal: "g")
    await panel.refreshTail("a")

    let steer = try #require(harness.link.calls(RPC.SubagentSteer.name).first)
    #expect(steer.params["session_id"] == .string(Fixture.runtime))
    #expect(steer.params["profile"] == .string(bot))
    #expect(steer.params["subagent_id"] == "a")
    #expect(steer.params["text"] == "Use the other file")

    let stop = try #require(harness.link.calls(RPC.SubagentInterrupt.name).first)
    #expect(stop.params == ["session_id": .string(Fixture.runtime), "profile": .string(bot), "subagent_id": "a"])

    let tail = try #require(harness.link.calls(RPC.SubagentTail.name).first)
    #expect(tail.params["session_id"] == .string(Fixture.runtime))
    #expect(panel.tail?.text == "tail text")
    #expect(panel.notice == .stopping)
    await harness.session.shutdown()
  }

  @Test func aRejectedSteerFromTheGatewayIsRead() async throws {
    let (harness, model) = try await opened()
    harness.link.respond(to: RPC.SubagentSteer.name, with: ["status": "rejected", "subagent_id": "a", "text": "x"])
    let panel = model.subagentPanel()

    #expect(await panel.steer("a", text: "late") == false)
    #expect(panel.notice == .steerRejected)
    await harness.session.shutdown()
  }

  @Test func aChatThatIsNotAttachedHasNothingToAsk() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    let panel = model.subagentPanel()

    #expect(await panel.steer("a", text: "x") == false)

    guard case .failed? = panel.notice else {
      Issue.record("expected a failure notice")
      return
    }

    #expect(harness.link.calls(RPC.SubagentSteer.name).isEmpty)
    await harness.session.shutdown()
  }
}
