import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

// The races the second review found: a tail download that held the chat, a
// send or a steer that ran while `/new` put the conversation away, `/new` or
// a second open racing a hydration, a recovery that outlived its chat, and an
// incompatibility cleared by a chat that never resumed.

private let bot = Fixture.profile
private let successor = "stored-new"
private let successorRuntime = "rt-new"

private func live() async throws -> StoreHarness {
  let harness = StoreHarness()
  await harness.attach()
  await harness.store.connectionChanged(ConnectionStatus(.ready))
  try await harness.open()
  return harness
}

private func rosterAnswer(_ names: [String]) -> JSONValue {
  let rows: [JSONValue] = names.map { name in
    let canonical: JSONObject = ["id": .string(name == bot ? Fixture.stored : "stored-\(name)"), "message_count": .number(2)]
    let row: JSONObject = ["name": .string(name), "canonical_session": .object(canonical)]
    return .object(row)
  }
  let object: JSONObject = ["profiles": .array(rows)]
  return .object(object)
}

/// The roster knows the bot, and the calls `/new` retires a chat with answer at once.
private func prepareNew(_ harness: StoreHarness, create: Bool = true) async throws {
  harness.link.respond(to: RPC.ProfilesList.name, with: rosterAnswer([bot]))
  _ = try await harness.roster.refresh()

  for method in [RPC.SessionSetHidden.name, RPC.SessionTitle.name, RPC.SessionClose.name] {
    harness.link.respond(to: method, with: .object([:]))
  }

  if create {
    let created: JSONObject = ["session_id": .string(successorRuntime), "stored_session_id": .string(successor)]
    harness.link.respond(to: RPC.SessionCreate.name, with: .object(created))
  }
}

/// Answer the hydration of the successor `/new` (or a test) opens.
private func openSuccessor(_ harness: StoreHarness) async throws {
  let resume = try await harness.link.pendingCall(RPC.SessionResume.name, within: shortBound) { call in
    call.params["session_id"] == .string(successor)
  }
  harness.link.answer(resume, Fixture.resume(runtime: successorRuntime, stored: successor))
  let history = try await harness.link.pendingCall(RPC.SessionHistory.name, within: shortBound) { call in
    call.params["session_id"] == .string(successorRuntime)
  }
  harness.link.answer(history, ["count": 0, "messages": []])
  let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name, within: shortBound) { call in
    call.params["session_id"] == .string(successorRuntime)
  }
  harness.link.answer(since, Fixture.since(latest: 0))
}

private func reply(_ state: ChatState) -> String? {
  state.orderedItems.compactMap(\.asAssistant).last { $0.rowID == nil }?.text
}

/// A turn that was stopped with one message still queued behind it.
private func stoppedWithQueue(_ harness: StoreHarness) async throws -> String {
  harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])
  harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
  await harness.settle()
  _ = try await harness.store.send(bot, text: "more")
  try await harness.store.stopTurn(bot)
  await harness.settle()
  return try #require(await harness.store.chats[bot]?.queue.first?.id)
}

@Suite(.timeLimit(.minutes(1))) struct SessionRaceTests {
  // MARK: 1. The tail's fallback holds nothing

  @Test func theTailFallbackDoesNotHoldTheChat() async throws {
    let harness = try await live()
    harness.link.setREST { _, _ in nil }
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    let tail = Task { await harness.store.reconcileTail(bot) }
    let call = try await harness.link.pendingCall(RPC.SessionHistory.name)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "streaming"])
    await harness.settle()
    #expect(reply(await harness.state()) == "streaming", "the delta is on screen while the history downloads")
    #expect(await harness.store.outstanding.isEmpty)

    harness.link.answer(call, ["count": 0, "messages": []])
    await tail.value
    await harness.shutdown()
  }

  // MARK: 2. Sends and steers while `/new` runs

  @Test func aSendWhileNewRunsIsRefusedBeforeAnythingIsPainted() async throws {
    let harness = try await live()
    try await prepareNew(harness, create: false)

    let starting = Task { try await harness.store.startNewConversation(bot) }
    let create = try await harness.link.pendingCall(RPC.SessionCreate.name)

    let refusal = await #expect(throws: ChatRuntimeError.self) {
      _ = try await within("the send") { try await harness.store.send(bot, text: "hi") }
    }
    #expect(refusal?.isNotAttached == true, "nothing was painted: the draft stays")
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)

    let created: JSONObject = ["session_id": .string(successorRuntime), "stored_session_id": .string(successor)]
    harness.link.answer(create, .object(created))
    try await openSuccessor(harness)
    try await within("/new") { try await starting.value }

    let state = await harness.state()
    #expect(state.storedSessionID == successor)
    #expect(!state.orderedItems.contains { $0.asUser?.text == "hi" })
    await harness.shutdown()
  }

  @Test func aSteerInTheAirMakesNewRefuse() async throws {
    let harness = try await live()
    try await prepareNew(harness)
    let queued = try await stoppedWithQueue(harness)

    let steer = Task { try await harness.store.steerQueued(bot, queued) }
    let call = try await harness.link.pendingCall(RPC.SessionSteer.name)
    #expect(await harness.store.chats[bot]?.queue.isEmpty == true, "the queue alone does not show the steer")

    await #expect(throws: ConversationBusyError.self) {
      try await within("/new") { try await harness.store.startNewConversation(bot) }
    }
    #expect(harness.link.calls(RPC.SessionSetHidden.name).isEmpty)

    harness.link.answer(call, ["status": "queued"])
    _ = try await steer.value
    await harness.shutdown()
  }

  @Test func aSteerRefusedAfterItsChatWasReplacedLandsNowhere() async throws {
    let harness = try await live()
    let queued = try await stoppedWithQueue(harness)

    let steer = Task { try await harness.store.steerQueued(bot, queued) }
    let call = try await harness.link.pendingCall(RPC.SessionSteer.name)

    await harness.store.forget(bot)
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: successor)) }
    try await openSuccessor(harness)
    try await reopening.value

    harness.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    _ = try? await steer.value
    await harness.settle()

    #expect(await harness.store.chats[bot]?.queue.isEmpty == true, "the old conversation's message is not the new one's")
    #expect(!(await harness.state()).orderedItems.contains { $0.asUser?.text == "more" })
    await harness.shutdown()
  }

  @Test func aSendThatFailsAfterItsChatWasReplacedLeavesTheSuccessorsCountAlone() async throws {
    let harness = try await live()
    let first = Task { try await harness.store.send(bot, text: "old") }
    let old = try await harness.link.pendingCall(RPC.PromptSubmit.name)

    await harness.store.forget(bot)
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: successor)) }
    try await openSuccessor(harness)
    try await reopening.value

    let second = Task { try await harness.store.send(bot, text: "new") }
    let fresh = try await harness.link.pendingCall(RPC.PromptSubmit.name) { $0.params["session_id"] == .string(successorRuntime) }
    #expect(await harness.store.chats[bot]?.sending == 1)

    harness.link.fail(old, GatewayRPCError(.closed, "WebSocket closed"))
    _ = try? await first.value
    #expect(await harness.store.chats[bot]?.sending == 1, "the old send does not count against the new conversation")

    harness.link.answer(fresh, ["status": "streaming"])
    _ = try await second.value
    await harness.shutdown()
  }

  // MARK: 3. `/new` and a second open against a hydration

  @Test func anOpenOfAnotherConversationDoesNotJoinTheOldHydration() async throws {
    let harness = StoreHarness()
    await harness.attach()
    let opening = Task { try await harness.store.open(Fixture.bot()) }
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)

    // `/new` put another conversation under the key while the old one was opening.
    await harness.store.forget(bot)
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: successor)) }
    try await openSuccessor(harness)
    try await within("the successor to open") { try await reopening.value }

    harness.link.answer(since, Fixture.since(latest: 0))
    _ = try? await opening.value
    let state = await harness.state()
    #expect(state.storedSessionID == successor)
    #expect(state.hydration == .live)
    await harness.shutdown()
  }

  @Test func newWaitsForAHydrationInFlight() async throws {
    let harness = StoreHarness()
    await harness.attach()
    harness.link.respond(to: RPC.ProfilesList.name, with: rosterAnswer([bot]))
    _ = try await harness.roster.refresh()
    for method in [RPC.SessionTitle.name, RPC.SessionClose.name] {
      harness.link.respond(to: method, with: .object([:]))
    }
    let created: JSONObject = ["session_id": .string(successorRuntime), "stored_session_id": .string(successor)]
    harness.link.respond(to: RPC.SessionCreate.name, with: .object(created))

    let opening = Task { try await harness.store.open(Fixture.bot()) }
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)

    let starting = Task { try await harness.store.startNewConversation(bot) }
    let early = try? await harness.link.pendingCall(RPC.SessionSetHidden.name, within: .milliseconds(500))
    #expect(early == nil, "nothing is retired while the chat is still opening")

    harness.link.answer(since, Fixture.since(latest: 0))
    try await opening.value
    try await harness.link.answerNext(RPC.SessionSetHidden.name, .object([:]))
    try await openSuccessor(harness)
    try await within("/new") { try await starting.value }

    let state = await harness.state()
    #expect(state.storedSessionID == successor)
    #expect(state.hydration == .live)
    await harness.shutdown()
  }

  // MARK: 4. Work for a chat that was replaced leaves the successor's ladder alone

  enum Outcome: String, CaseIterable, Sendable {
    case answered
    case failed
  }

  @Test(arguments: Outcome.allCases)
  func aRecoveryThatOutlivesItsChatDoesNotMarkTheSuccessor(_ outcome: Outcome) async throws {
    let harness = try await live()
    harness.link.respond(to: RPC.ProfilesList.name, with: rosterAnswer([bot]))
    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    let old = try await harness.link.pendingCall(RPC.SessionResume.name)

    // `/new` on the chat finishes first: the roster points at the successor.
    await harness.store.forget(bot)
    await harness.roster.setCanonical(bot, CanonicalSession(id: successor, resolvedID: successor))
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: successor)) }
    try await openSuccessor(harness)
    try await reopening.value
    #expect(await harness.state().hydration == .live)

    switch outcome {
    case .answered: harness.link.answer(old, Fixture.resume())
    case .failed: harness.link.fail(old, GatewayRPCError(.closed, "WebSocket closed"))
    }

    try await eventually("the recovery to end") { await harness.store.liveTaskCount == 0 }
    #expect(await harness.state().hydration == .live)
    await harness.shutdown()
  }

  @Test func aHydrationThatOutlivesItsChatDoesNotMarkTheSuccessor() async throws {
    let harness = StoreHarness()
    await harness.attach()
    let opening = Task { try await harness.store.open(Fixture.bot()) }
    let old = try await harness.link.pendingCall(RPC.SessionResume.name)

    await harness.store.forget(bot)
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: successor)) }
    try await openSuccessor(harness)
    try await reopening.value

    harness.link.fail(old, GatewayRPCError(.closed, "WebSocket closed"))
    _ = try? await opening.value
    #expect(await harness.state().hydration == .live)
    await harness.shutdown()
  }

  // MARK: Optional: the turn claim's bound, and a poll after a dropped one

  @Test func theTurnClaimReturnsAtItsLimitWhateverTheClaimIsDoing() async throws {
    let clock = ManualClock()
    let claim = Task {
      await ConnectionLink.bounded(.milliseconds(1_500), clock: clock) {
        try? await Task.sleep(for: .seconds(3_600))
      }
    }

    try await eventually("the timer") { clock.pendingCount == 1 }
    await clock.advance(by: .milliseconds(1_500))
    try await within("the claim to give up") { await claim.value }
  }

  @Test func aPollAfterAStaleOneLandsItsCard() async throws {
    let harness = try await live()
    let entry: JSONObject = ["request_id": .string("appr-1"), "command": .string("ls")]
    let answer: JSONObject = ["approvals": .array([.object(entry)])]

    let first = Task { await harness.store.refreshPendingApprovals(bot) }
    let stale = try await harness.link.pendingCall(RPC.ApprovalPending.name)
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1, index: 500)
    await harness.settle()
    harness.link.answer(stale, .object(answer), index: 400)
    await first.value
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).isEmpty)

    let second = Task { await harness.store.refreshPendingApprovals(bot) }
    try await harness.link.answerNext(RPC.ApprovalPending.name, .object(answer), index: 600)
    await second.value
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).map(\.requestID) == ["pending:appr-1"])
    await harness.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct SessionContractTests {
  // MARK: 5. Only a resume clears an incompatibility, and a recovery checks too

  @Test func anAlreadyLiveChatDoesNotClearAnIncompatibility() async throws {
    let harness = SessionHarness()
    try await harness.start(roster: rosterAnswer([bot, "writer"]))
    try await harness.open()

    let session = harness.session
    let refused = Task { @MainActor in try await session.open("writer") }
    var old = Fixture.resume(runtime: "rt-writer", stored: "stored-writer").objectValue ?? [:]
    let info: JSONObject = ["desktop_contract": .number(5)]
    old["info"] = .object(info)
    try await harness.link.answerNext(RPC.SessionResume.name, .object(old))
    _ = try? await refused.value
    try await eventually("incompatible") { await session.status.phase == .incompatible }

    // Back to the live chat: it opens without a resume, which proves nothing.
    try await session.open(bot)
    try await harness.frame()
    #expect(session.status.phase == .incompatible)
    #expect(session.incompatibility != nil)
    await session.shutdown()
  }

  @Test func aRecoveryOnADowngradedGatewayReportsIt() async throws {
    let harness = SessionHarness()
    try await harness.start()
    try await harness.open()
    let session = harness.session

    harness.link.respond(to: RPC.ProfilesList.name, with: SessionHarness.roster)
    harness.link.status(.reconnecting)
    harness.link.status(.ready)
    var old = Fixture.resume().objectValue ?? [:]
    let info: JSONObject = ["desktop_contract": .number(5)]
    old["info"] = .object(info)
    try await harness.link.answerNext(RPC.SessionResume.name, .object(old))

    try await eventually("incompatible") { await session.status.phase == .incompatible }
    #expect(await session.store.state(of: bot)?.hydration == .stale)
    await session.shutdown()
  }

  // MARK: Optional: an answer that did not go out says so on its card

  @Test func anAnswerThatDidNotGoOutLeavesANoticeOnTheCard() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    let params: JSONObject = ["session_id": .string(Fixture.runtime), "request_id": .string("appr-1"), "command": .string("ls")]
    harness.link.raise(id: "srq-1", method: "approval", params: params)
    harness.link.respond(to: RPC.ApprovalReceived.name, with: ["received": true])
    try await harness.frame()

    harness.link.setSocketOpen(false)
    await model.respondApproval("srq-1", choice: "once")
    #expect(model.cardNotices["srq-1"] == ChatModel.unsentAnswerNotice)

    harness.link.setSocketOpen(true)
    harness.link.raise(id: "srq-1", method: "approval", params: params, replayed: true)
    try await harness.frame()
    await model.respondApproval("srq-1", choice: "once")
    try await harness.frame()
    #expect(model.cardNotices.isEmpty)
    await harness.session.shutdown()
  }
}
