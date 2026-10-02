import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

private func opened() async throws -> StoreHarness {
  let harness = StoreHarness()
  await harness.attach()
  await harness.store.connectionChanged(ConnectionStatus(.ready))
  try await harness.open()
  return harness
}

private func lastUser(_ state: ChatState) -> UserItem? {
  state.orderedItems.compactMap(\.asUser).last
}

@Suite(.timeLimit(.minutes(1))) struct SubmitPipelineTests {
  // MARK: Submit

  @Test func aSendPaintsFirstAndSettlesOnTheAnswer() async throws {
    let harness = try await opened()

    let sending = Task { try await harness.store.send(bot, text: "hello there") }
    let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    #expect(call.params["text"] == "hello there")

    var state = await harness.state()
    #expect(lastUser(state)?.text == "hello there")
    #expect(lastUser(state)?.pending == true)
    #expect(lastUser(state)?.origin == .optimistic)
    #expect(state.turn.active)

    harness.link.answer(call, ["status": "streaming"])
    let painted = try await sending.value
    await harness.settle()

    state = await harness.state()
    #expect(painted == state.order.last)
    #expect(lastUser(state)?.pending == false)
    #expect(state.turn.active)
    await harness.shutdown()
  }

  @Test(arguments: [GatewayRPCError(.rejected, "busy", code: 4009), GatewayRPCError(.closed, "WebSocket closed")])
  func aRefusedOrDroppedSubmitKeepsTheBubbleAndGivesTheComposerBack(_ failure: GatewayRPCError) async throws {
    let harness = try await opened()

    let sending = Task { try await harness.store.send(bot, text: "do it") }
    let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    harness.link.fail(call, failure)

    await #expect(throws: GatewayRPCError.self) { try await sending.value }
    await harness.settle()

    let state = await harness.state()
    #expect(lastUser(state)?.text == "do it", "the words are the reader's")
    #expect(lastUser(state)?.pending == false)
    #expect(state.turn.active == false)
    #expect(state.turn.interrupted == true)
    await harness.shutdown()
  }

  @Test func aChatThatIsNotAttachedRefusesToSend() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.restoreFromCache([])

    await #expect(throws: (any Error).self) { try await harness.store.send(bot, text: "hi") }
    await harness.shutdown()
  }

  @Test func stopInterruptsAndKeepsThePartialReply() async throws {
    let harness = try await opened()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Partial"])
    await harness.settle()

    let stopping = Task { try await harness.store.stopTurn(bot) }
    try await harness.link.answerNext(RPC.SessionInterrupt.name, ["status": "interrupted"])
    try await stopping.value
    await harness.settle()

    let state = await harness.state()
    let reply = state.orderedItems.compactMap(\.asAssistant).last
    #expect(reply?.text == "Partial")
    #expect(reply?.status == .interrupted)
    #expect(state.turn.active == false)
    await harness.shutdown()
  }

  // MARK: The queue

  @Test func aSendDuringATurnIsParkedAndGoesOutWhenTheTurnEnds() async throws {
    let harness = try await opened()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    let queued = try await harness.store.send(bot, text: "and then?")
    #expect(queued == nil)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty, "parked here, not on the gateway")

    harness.link.emit("message.complete", session: Fixture.runtime, seq: 2, payload: ["text": "done"])
    harness.link.setREST { _, _ in [] }
    let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(call.params["text"] == "and then?")
    harness.link.answer(call, ["status": "streaming"])
    await harness.settle()
    await harness.shutdown()
  }

  @Test func aSteeredMessageIsPaintedAndARefusedOneGoesBackInTheQueue() async throws {
    let harness = try await opened()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    _ = try await harness.store.send(bot, text: "use the staging host")
    _ = try await harness.store.send(bot, text: "and skip the tests")
    let first = try #require(await harness.store.chats[bot]?.queue.first)

    // Taken: painted as a steer, out of the strip.
    let steering = Task { try await harness.store.steerQueued(bot, first.id) }
    let call = try await harness.link.pendingCall(RPC.SessionSteer.name)
    #expect(call.params["text"] == "use the staging host")
    var state = await harness.state()
    #expect(lastUser(state)?.displayKind == .steer)
    #expect(await harness.store.chats[bot]?.queue.map(\.text) == ["and skip the tests"])
    harness.link.answer(call, ["status": "queued"])
    #expect(try await steering.value == .queued)

    // Refused: un-painted, parked again.
    let second = try #require(await harness.store.chats[bot]?.queue.first)
    let refusing = Task { try await harness.store.steerQueued(bot, second.id) }
    try await harness.link.answerNext(RPC.SessionSteer.name, ["status": "rejected"])
    #expect(try await refusing.value == .rejected)
    await harness.settle()

    state = await harness.state()
    let steers = state.orderedItems.compactMap(\.asUser).filter { $0.displayKind == .steer }
    #expect(steers.map(\.text) == ["use the staging host"])
    #expect(await harness.store.chats[bot]?.queue.map(\.text) == ["and skip the tests"])

    // Edit takes it back for the composer.
    #expect(await harness.store.editQueued(bot, second.id) == "and skip the tests")
    #expect(await harness.store.chats[bot]?.queue.isEmpty == true)
    await harness.shutdown()
  }

  // MARK: Answers

  @Test func anApprovalIsAnsweredOnItsOwnReplyAndAcknowledged() async throws {
    let harness = try await opened()
    harness.link.raise(
      id: "srq-1",
      method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "rm -rf ./build"]
    )
    await harness.settle()
    try await eventually("the acknowledgement") { !harness.link.calls(RPC.ApprovalReceived.name).isEmpty }
    #expect(harness.link.calls(RPC.ApprovalReceived.name).first?.params["request_id"] == "appr-1")

    let sent = try await harness.store.respondApproval(bot, requestID: "srq-1", choice: "once")
    #expect(sent)
    #expect(harness.link.answers.map(\.id) == ["srq-1"])
    #expect(harness.link.answers.first?.result["choice"] == "once")

    let card = await harness.state().orderedItems.compactMap(\.asApproval).first
    #expect(card?.state == .answered)
    #expect(card?.answer == "once")
    await harness.shutdown()
  }

  @Test func anAnswerWhoseSocketIsGoneLeavesTheCardOpenForItsRedeliveredCopy() async throws {
    let harness = try await opened()
    let params: JSONObject = ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "deploy"]
    harness.link.raise(id: "srq-1", method: "approval", params: params)
    await harness.settle()

    // The socket that delivered it drops before the answer goes out.
    harness.link.setSocketOpen(false)
    let sent = try await harness.store.respondApproval(bot, requestID: "srq-1", choice: "once")
    #expect(sent == false)
    #expect(harness.link.answers.isEmpty, "nothing is answered into the void")
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).map(\.state) == [.open])

    // The reconnect re-delivers it, with the same id, over the new socket.
    harness.link.setSocketOpen(true)
    harness.link.raise(id: "srq-1", method: "approval", params: params, replayed: true)
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).count == 1, "one question, one card")

    #expect(try await harness.store.respondApproval(bot, requestID: "srq-1", choice: "once"))
    #expect(harness.link.answers.map(\.id) == ["srq-1"])
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).map(\.state) == [.answered])
    await harness.shutdown()
  }

  @Test func aCardWithNoLiveReplyIsAnsweredThroughTheQueue() async throws {
    let harness = try await opened()
    harness.link.respond(to: RPC.ApprovalRespond.name, with: ["resolved": true])
    let pending: JSONValue = ["approvals": [["request_id": "appr-9", "command": "ls"]]]
    harness.link.respond(to: RPC.ApprovalPending.name, with: pending)

    await harness.store.refreshPendingApprovals(bot)
    await harness.settle()
    let card = try #require(await harness.state().orderedItems.compactMap(\.asApproval).first)
    #expect(card.requestID == "pending:appr-9")

    #expect(try await harness.store.respondApproval(bot, requestID: card.requestID, choice: "deny"))
    let call = try #require(harness.link.calls(RPC.ApprovalRespond.name).first)
    #expect(call.params["request_id"] == "appr-9")
    #expect(call.params["choice"] == "deny")
    #expect(harness.link.answers.isEmpty)

    // A notification action re-validates against the gateway first.
    #expect(await harness.store.openApprovals(bot).map(\.requestID) == ["appr-9"])
    await harness.shutdown()
  }

  @Test func aBatchClarifyAnswersByQuestionAndAPartialOneLocks() async throws {
    let harness = try await opened()
    let questions: JSONValue = [
      ["qid": "q1", "question": "Which environment?", "choices": ["staging", "production"]],
      ["qid": "q2", "question": "Notify the team?", "choices": ["yes", "no"]]
    ]
    harness.link.raise(
      id: "srq-2",
      method: "clarify",
      params: ["session_id": .string(Fixture.runtime), "questions": questions]
    )
    await harness.settle()

    harness.link.respond(to: RPC.ClarifyLock.name, with: ["locked": true])
    try await harness.store.respondClarify(bot, requestID: "srq-2", answers: ["q1": "staging"])
    #expect(harness.link.calls(RPC.ClarifyLock.name).map { $0.params["question_id"] } == ["q1"])
    #expect(harness.link.answers.isEmpty)

    try await harness.store.respondClarify(bot, requestID: "srq-2", answers: ["q1": "staging", "q2": "yes"])
    #expect(harness.link.answers.first?.result["answers"] == ["q1": "staging", "q2": "yes"])
    #expect(await harness.state().orderedItems.compactMap(\.asClarify).first?.state == .answered)
    await harness.shutdown()
  }

  // MARK: A new conversation

  @Test func newRetiresTheOldChatAndOpensTheSuccessor() async throws {
    let harness = try await opened()
    harness.link.respond(to: RPC.ProfilesList.name, with: [
      "profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored)]]]
    ])
    _ = try await harness.roster.refresh()
    for method in [RPC.SessionSetHidden.name, RPC.SessionTitle.name, RPC.SessionClose.name] {
      harness.link.respond(to: method, with: [:])
    }
    harness.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-new", "stored_session_id": "stored-new"])

    let starting = Task { try await harness.store.startNewConversation(bot) }
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume(runtime: "rt-new", stored: "stored-new"))
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 0, "messages": []])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await starting.value
    await harness.settle()

    let methods = harness.link.calls.map(\.method).filter {
      [RPC.SessionSetHidden.name, RPC.SessionTitle.name, RPC.SessionCreate.name, RPC.SessionClose.name].contains($0)
    }
    #expect(methods == ["session.set_hidden", "session.title", "session.create", "session.title", "session.close"])

    let retire = harness.link.calls(RPC.SessionTitle.name)[0]
    #expect(retire.params["session_id"] == .string(Fixture.runtime), "the old session's RUNTIME id")
    #expect(retire.params["title"]?.stringValue?.hasPrefix("Bot Chat · ") == true)
    let create = try #require(harness.link.calls(RPC.SessionCreate.name).first)
    #expect(create.params["hidden"] == true)
    #expect(create.params["follow_profile_config"] == true)
    #expect(create.params["parent_session_id"] == .string(Fixture.stored))
    #expect(harness.link.calls(RPC.SessionTitle.name)[1].params["session_id"] == "rt-new")

    let state = await harness.state()
    #expect(state.storedSessionID == "stored-new")
    #expect(state.runtimeSessionID == "rt-new")
    #expect(state.orderedItems.compactMap(\.asNotice).last?.body?.hasPrefix("New conversation started.") == true)
    await harness.shutdown()
  }

  @Test func newPutsTheOldNameBackWhenTheCreateFails() async throws {
    let harness = try await opened()
    harness.link.respond(to: RPC.ProfilesList.name, with: ["profiles": [["name": .string(bot)]]])
    _ = try await harness.roster.refresh()
    harness.link.respond(to: RPC.SessionSetHidden.name, with: [:])
    harness.link.respond(to: RPC.SessionTitle.name, with: [:])

    let starting = Task { try await harness.store.startNewConversation(bot) }
    let create = try await harness.link.pendingCall(RPC.SessionCreate.name)
    harness.link.fail(create, GatewayRPCError(.rejected, "no"))
    try await starting.value

    let titles = harness.link.calls(RPC.SessionTitle.name).map { $0.params["title"]?.stringValue ?? "" }
    #expect(titles.last == "Bot Chat")
    #expect(harness.link.calls(RPC.SessionSetHidden.name).map { $0.params["hidden"] } == [false, true])
    #expect(await harness.state().storedSessionID == Fixture.stored)
    #expect(await harness.state().orderedItems.compactMap(\.asNotice).last?.body?.contains("still in the one") == true)
    await harness.shutdown()
  }
}
