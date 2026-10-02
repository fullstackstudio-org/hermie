import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

// The interleavings the review found unguarded, forced one by one: a read that
// held a streaming chat, an answer overtaking the frames before it, a request
// overtaken by its own withdrawal, a chat replaced while work for it was in
// the air, the store a gateway switch left behind, unread counts after a cold
// start, a second tap, and the turn claim.

private let bot = Fixture.profile

private func opened(_ harness: StoreHarness = StoreHarness()) async throws -> StoreHarness {
  await harness.attach()
  await harness.store.connectionChanged(ConnectionStatus(.ready))
  try await harness.open()
  return harness
}

private func reply(_ state: ChatState) -> String? {
  state.orderedItems.compactMap(\.asAssistant).last { $0.rowID == nil }?.text
}

private func approvalParams(_ session: String, _ queueID: String) -> JSONObject {
  ["session_id": .string(session), "request_id": .string(queueID), "command": .string("rm -rf ./build")]
}

private func profile(_ name: String, capabilities: [String] = []) -> JSONValue {
  let canonical: JSONObject = ["id": .string(Fixture.stored), "message_count": .number(2)]
  var row: JSONObject = ["name": .string(name), "is_default": .bool(true), "canonical_session": .object(canonical)]

  if !capabilities.isEmpty {
    let advert: JSONObject = ["v": .number(1), "capabilities": .array(capabilities.map { .string($0) })]
    let meta: JSONObject = [PluginCapabilities.advertKey: .object(advert)]
    row["ui_meta"] = .object(meta)
  }

  return .object(row)
}

/// A resume of a turn that is running and has said "Hello" so far.
private func inflightResume() -> JSONValue {
  let inflight: JSONObject = ["user": .string("go"), "assistant": .string("Hello"), "streaming": .bool(true)]
  return Fixture.resume(extra: ["running": .bool(true), "inflight": .object(inflight)])
}

private func roster(_ rows: [JSONValue]) -> JSONValue {
  let object: JSONObject = ["profiles": .array(rows)]
  return .object(object)
}

@Suite(.timeLimit(.minutes(1))) struct RuntimeConsistencyTests {
  // MARK: 1. Snapshot reads hold nothing

  @Test func aSubagentPollInTheAirDoesNotHoldTheStream() async throws {
    let harness = try await opened()
    harness.link.unrespond(RPC.SubagentList.name)
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    let polling = Task { await harness.store.reconcileSubagents(bot) }
    let call = try await harness.link.pendingCall(RPC.SubagentList.name)

    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "streaming"])
    await harness.settle()
    #expect(reply(await harness.state()) == "streaming", "the delta is on screen while the poll is in the air")

    // Its answer is older than what the chat has applied since: stale, dropped.
    let child: JSONObject = ["id": .string("sa-1"), "status": .string("running"), "goal": .string("check")]
    let answer: JSONObject = ["subagents": .array([.object(child)])]
    harness.link.answer(call, .object(answer), index: 1)
    await polling.value
    await harness.settle()
    #expect(await harness.state().subagents.isEmpty)
    await harness.shutdown()
  }

  @Test func anApprovalPollAnsweredAfterNewerFramesIsDropped() async throws {
    let harness = try await opened()
    let polling = Task { await harness.store.refreshPendingApprovals(bot) }
    let call = try await harness.link.pendingCall(RPC.ApprovalPending.name)

    harness.link.emit("message.start", session: Fixture.runtime, seq: 1, index: 500)
    await harness.settle()
    #expect(await harness.state().turn.active, "the turn starts while the poll is in the air")

    let entry: JSONObject = ["request_id": .string("appr-1"), "command": .string("ls")]
    let answer: JSONObject = ["approvals": .array([.object(entry)])]
    harness.link.answer(call, .object(answer), index: 400)
    await polling.value
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).isEmpty)
    await harness.shutdown()
  }

  @Test func openingALiveChatAgainDoesNotHydrateIt() async throws {
    let harness = try await opened()
    try await harness.store.open(Fixture.bot())
    #expect(harness.link.calls(RPC.SessionResume.name).count == 1)
    await harness.shutdown()
  }

  @Test func aQuestionIsNotHeldBehindACallInTheAir() async throws {
    let harness = try await opened()
    let sending = Task { try await harness.store.send(bot, text: "go") }
    let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)

    harness.link.raise(id: "srq-1", method: "approval", params: approvalParams(Fixture.runtime, "appr-1"), index: 900)
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).count == 1)

    harness.link.answer(call, ["status": "streaming"])
    _ = try await sending.value
    await harness.shutdown()
  }

  // MARK: 4. Nothing in flight outlives its chat

  @Test func forgettingAChatLetsGoOfItsCallsInTheAir() async throws {
    let harness = try await opened()

    // A submit holds the lane; a recovery's resume (binding) answers behind it.
    let sending = Task { try await harness.store.send(bot, text: "go") }
    let submit = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.link.answerNext(RPC.ProfilesList.name, roster([profile(bot)]))
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    try await eventually("the resume to wait behind the submit") {
      await harness.store.outstanding.values.contains { $0.binding && $0.answered }
    }

    await harness.store.forget(bot)
    #expect(await harness.store.outstanding.isEmpty)
    #expect(await harness.store.hasBindingInFlight == false)

    // A frame for a session nobody holds is not kept around any more.
    harness.link.emit("message.start", session: "rt-elsewhere", seq: 1)
    await harness.settle()
    #expect(await harness.store.unboundCount == 0)

    harness.link.answer(submit, ["status": "streaming"])
    _ = try? await sending.value
    await harness.shutdown()
  }

  @Test func aTailFetchedForTheOldConversationDoesNotLandOnTheNewOne() async throws {
    let harness = try await opened()
    harness.link.setREST { _, _ in Fixture.rows(30, from: 100).map { TranscriptRow(json: $0.objectValue ?? [:]) } }
    harness.link.holdREST()

    let tail = Task { await harness.store.reconcileTail(bot) }
    try await eventually("the tail read") { !harness.link.restCalls.isEmpty }

    // `/new` put another conversation under the key meanwhile.
    await harness.store.forget(bot)
    let reopening = Task { try await harness.store.open(Fixture.bot(stored: "stored-2")) }
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume(runtime: "rt-2", stored: "stored-2"))
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 0, "messages": []])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await reopening.value

    harness.link.releaseREST()
    await tail.value
    await harness.settle()
    #expect(await harness.state().order.isEmpty, "the new conversation holds none of the old one's rows")
    await harness.shutdown()
  }

  // MARK: 6. Answers

  @Test func anAnswerByCallShowsOnlyOnceItWentOutAndASecondTapSendsNothing() async throws {
    let harness = try await opened()
    let entry: JSONObject = ["request_id": .string("appr-9"), "command": .string("ls")]
    let pending: JSONObject = ["approvals": .array([.object(entry)])]
    harness.link.respond(to: RPC.ApprovalPending.name, with: .object(pending))
    await harness.store.refreshPendingApprovals(bot)
    await harness.settle()
    harness.link.unrespond(RPC.ApprovalPending.name)

    let first = Task { try await harness.store.respondApproval(bot, requestID: "pending:appr-9", choice: "once") }
    let call = try await harness.link.pendingCall(RPC.ApprovalRespond.name)
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).first?.state == .open)

    let second = try await harness.store.respondApproval(bot, requestID: "pending:appr-9", choice: "once")
    #expect(second == false, "a double tap sends nothing")

    harness.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await #expect(throws: GatewayRPCError.self) { try await first.value }
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).first?.state == .open, "the answer is not lost")
    #expect(harness.link.calls(RPC.ApprovalRespond.name).count == 1)

    harness.link.respond(to: RPC.ApprovalRespond.name, with: ["resolved": true])
    #expect(try await harness.store.respondApproval(bot, requestID: "pending:appr-9", choice: "once"))
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).first?.state == .answered)
    #expect(try await harness.store.respondApproval(bot, requestID: "pending:appr-9", choice: "once") == false)
    await harness.shutdown()
  }

  @Test func aDoubleTapOnALiveCardAnswersOnce() async throws {
    let harness = try await opened()
    harness.link.raise(id: "srq-1", method: "approval", params: approvalParams(Fixture.runtime, "appr-1"))
    await harness.settle()

    async let first = harness.store.respondApproval(bot, requestID: "srq-1", choice: "once")
    async let second = harness.store.respondApproval(bot, requestID: "srq-1", choice: "deny")
    let results = try await [first, second]

    #expect(results.filter { $0 }.count == 1)
    #expect(harness.link.answers.count == 1)
    #expect(harness.link.calls(RPC.ApprovalRespond.name).isEmpty)
    await harness.shutdown()
  }

  // MARK: 7. A request overtaken by its own end

  @Test func aWithdrawalThatOvertakesItsRequestLeavesNoCard() async throws {
    let harness = try await opened()
    harness.link.emit("request.cancel", session: Fixture.runtime, seq: 1, payload: ["id": "srq-9"], index: 20)
    await harness.settle()
    harness.link.raise(id: "srq-9", method: "approval", params: approvalParams(Fixture.runtime, "appr-9"), index: 10)
    await harness.settle()

    #expect(await harness.state().orderedItems.compactMap(\.asApproval).isEmpty)
    await harness.shutdown()
  }

  @Test func aRequestFromATurnThatHasEndedLeavesNoCard() async throws {
    let harness = try await opened()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1, index: 10)
    harness.link.emit("message.complete", session: Fixture.runtime, seq: 2, payload: ["text": "done"], index: 30)
    harness.link.setREST { _, _ in [] }
    await harness.settle()
    harness.link.raise(id: "srq-3", method: "approval", params: approvalParams(Fixture.runtime, "appr-3"), index: 25)
    await harness.settle()

    #expect(await harness.state().orderedItems.compactMap(\.asApproval).isEmpty)
    await harness.shutdown()
  }

  // MARK: 8 and 12. The answer before the frames that preceded it

  /// The resume's answer reaches the store while a delta it already contains is
  /// still on its way: the store must wait for it (`catchUp`) and drop it.
  @Test func anAnswerThatOvertakesAFrameItContainsWaitsForIt() async throws {
    let harness = StoreHarness()
    await harness.attach()
    let resume = inflightResume()
    let opening = Task { try await harness.store.open(Fixture.bot()) }
    let call = try await harness.link.pendingCall(RPC.SessionResume.name)

    // The connection dispatched seq 1 before it handed over the answer…
    harness.link.overstateWatermark(Fixture.runtime, 1)
    harness.link.answer(call, resume, index: 20)
    try await eventually("the store to wait for seq 1") { await !harness.store.seqWaiters.isEmpty }

    // …and the frame comes in after the answer.
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 1, payload: ["text": "Hello"], index: 10)
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 1))
    try await opening.value
    await harness.settle()

    #expect(reply(await harness.state()) == "Hello")
    await harness.shutdown()
  }

  /// `catchUp` gives up after its limit; a contained frame that comes in later
  /// still must not be applied on top of the snapshot.
  @Test func aFrameBelowTheBindThatComesInAfterCatchUpGaveUpIsDropped() async throws {
    let harness = StoreHarness()
    await harness.attach()
    let resume = inflightResume()
    let opening = Task { try await harness.store.open(Fixture.bot()) }
    let call = try await harness.link.pendingCall(RPC.SessionResume.name)

    harness.link.overstateWatermark(Fixture.runtime, 1)
    harness.link.answer(call, resume, index: 20)
    try await eventually("the store to wait for seq 1") { await !harness.store.seqWaiters.isEmpty }
    await harness.clock.advance(by: .seconds(2))

    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await eventually("the store to wait again") { await !harness.store.seqWaiters.isEmpty }
    await harness.clock.advance(by: .seconds(2))

    // The snapshot is applied and the replay is in the air; the contained frame
    // turns up only now, below the answer that bound the session.
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 1, payload: ["text": "Hello"], index: 10)
    await harness.settle()
    #expect(reply(await harness.state()) == "Hello", "not HelloHello")

    harness.link.answer(since, Fixture.since(latest: 1))
    try await opening.value
    #expect(reply(await harness.state()) == "Hello")
    await harness.shutdown()
  }

  // MARK: 9. The turn claim

  @Test func aSendIsClaimedWhenThePluginReadsClaims() async throws {
    for offered in [true, false] {
      let harness = try await opened()
      let capabilities = offered ? [PluginCapabilities.contextTurnClaim] : []
      harness.link.respond(to: RPC.ProfilesList.name, with: roster([profile(bot, capabilities: capabilities)]))
      _ = try await harness.roster.refresh()

      let sending = Task { try await harness.store.send(bot, text: "go") }
      let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
      let claims = harness.link.lifecycle.filter { $0.hasPrefix("claimTurn") }
      #expect(claims == (offered ? ["claimTurn \(Fixture.runtime)"] : []), "offered: \(offered)")

      harness.link.answer(call, ["status": "streaming"])
      _ = try await sending.value
      await harness.shutdown()
    }
  }

  // MARK: 11. `/new` refuses while something would be lost

  @Test func newRefusesWhileMessagesWaitInTheQueue() async throws {
    let harness = try await opened()
    harness.link.respond(to: RPC.ProfilesList.name, with: roster([profile(bot)]))
    _ = try await harness.roster.refresh()
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()
    _ = try await harness.store.send(bot, text: "next")
    try await harness.store.stopTurn(bot)
    await harness.settle()

    await #expect(throws: ConversationBusyError.self) { try await harness.store.startNewConversation(bot) }
    #expect(harness.link.calls(RPC.SessionSetHidden.name).isEmpty)
    await harness.shutdown()
  }

  // MARK: 14 and 15

  @Test @MainActor func listSummariesAreThrottledAndReleasedChatsAreNotProjected() async throws {
    let link = ScriptedLink()
    let clock = ManualClock()
    let frames = ManualFrameScheduler()
    let roster = BotRoster(link: link, gatewayID: "g1", clock: clock)
    var options = TranscriptStore.Options()
    options.clock = clock
    options.frames = frames
    options.now = { 1_790_000_000_000 }
    let store = TranscriptStore(link: link, roster: roster, options: options)
    let harness = StoreHarness(link: link, clock: clock, frames: frames, roster: roster, store: store)
    _ = try await opened(harness)

    let received = Received()
    await store.setSink { batch in received.batches.append(batch) }
    await store.observe(bot, options: VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true))
    await frames.tick()
    #expect(received.batches.last?.summaries[bot] != nil)

    link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()
    await frames.tick()
    #expect(received.batches.last?.chats[bot] != nil)
    #expect(received.batches.last?.summaries.isEmpty == true, "the list waits for its interval")

    await clock.advance(by: .milliseconds(250))
    await frames.tick()
    #expect(received.batches.last?.summaries[bot]?.busy == true)

    await store.stopObserving(bot)
    link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "x"])
    await harness.settle()
    await clock.advance(by: .milliseconds(250))
    await frames.tick()
    #expect(received.batches.last?.chats.isEmpty == true)
    await harness.shutdown()
  }

  @Test func aNewReplayEpochForgetsTheSeqsTakenIn() async throws {
    let harness = try await opened()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 7)
    harness.link.emit("gateway.ready", session: nil, payload: ["replay_epoch": "e1"])
    await harness.settle()
    #expect(await harness.store.ingestedSeq[Fixture.runtime] == 7)

    harness.link.emit("gateway.ready", session: nil, payload: ["replay_epoch": "e2"])
    await harness.settle()
    #expect(await harness.store.ingestedSeq.isEmpty)
    await harness.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct SessionConsistencyTests {
  // MARK: 2. A gateway switch leaves nothing behind

  @Test func theStoreIsFreedAfterShutdown() async throws {
    weak var weakStore: TranscriptStore?
    weak var weakRoster: BotRoster?

    do {
      let harness = SessionHarness()
      try await harness.start()
      try await harness.open()
      weakStore = harness.session.store
      weakRoster = harness.session.roster
      await harness.session.shutdown()
    }

    // Its tasks end on their own schedule; the last one lets go of the store.
    let deadline = ContinuousClock.now + generousWait

    while weakStore != nil || weakRoster != nil {
      guard ContinuousClock.now < deadline else {
        throw TimedOut(what: "the store and the roster to be freed")
      }

      try await Task.sleep(for: .milliseconds(2))
    }
  }

  // MARK: 3. Unread counts after a cold start

  @Test func aColdStartCountsUnreadFromTheReadWatermark() async throws {
    let cache = MemoryChatCache()
    let database = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: database)

    let earlier = SessionHarness(cache: cache)
    try await earlier.start()
    try await earlier.open()
    await earlier.session.shutdown()

    // The reader had read up to after the last cached reply.
    let watermark: JSONObject = [bot: .number(1_789_999_010)]
    try await keyValues.setString(
      try JSONValue.object(watermark).canonicalString(),
      forKey: GatewayNamespace("g1").key(StoreKeys.botsLastSeen)
    )

    let harness = SessionHarness(cache: cache, keyValues: keyValues)
    await harness.session.start()
    try await harness.frame()

    let row = try #require(harness.session.chatList.rows[bot])
    #expect(row.hydration == .cached)
    #expect(row.unreadCount == 0, "nothing arrived after the watermark")
    await harness.session.shutdown()
  }

  // MARK: 10. An incompatible gateway that was updated

  @Test func incompatibilityClearsAfterAResumeThatPasses() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let session = harness.session

    var old = Fixture.resume().objectValue ?? [:]
    let info: JSONObject = ["desktop_contract": .number(5)]
    old["info"] = .object(info)
    let failing = Task { @MainActor in try await session.open(bot) }
    try await harness.link.answerNext(RPC.SessionResume.name, .object(old))
    _ = try? await failing.value
    #expect(session.status.phase == .incompatible)

    try await harness.open()
    #expect(session.incompatibility == nil)
    #expect(session.status.phase == .ready)
    await session.shutdown()
  }

  // MARK: 17. A bot the gateway stopped listing

  @Test func aBotThatLeavesTheRosterTakesItsChatWithIt() async throws {
    let harness = SessionHarness()
    try await harness.start()
    _ = harness.session.chat(bot)
    try await harness.open()

    harness.link.respond(to: RPC.ProfilesList.name, with: roster([]))
    _ = try await harness.session.roster.refresh()
    try await eventually("the chat to be forgotten") { await harness.session.store.state(of: bot) == nil }
    await harness.session.shutdown()
  }

  // MARK: 18. Sending without a socket

  @Test func aSendWithoutASocketKeepsTheDraftAndPaintsNothing() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    #expect(model.canSend)

    harness.link.status(.reconnecting)
    try await eventually("the socket to go") { await !model.canSend }

    model.draft = "hello"
    await model.send()
    #expect(model.draft == "hello")
    #expect(model.lastError != nil)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asUser).contains { $0.text == "hello" } == false)
    await harness.session.shutdown()
  }
}
