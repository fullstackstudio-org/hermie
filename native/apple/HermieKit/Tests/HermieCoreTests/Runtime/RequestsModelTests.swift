import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A session over a scripted link, opened, with the requests model of its chat.
@MainActor
private struct RequestsHarness {
  let harness: SessionHarness
  let requests: RequestsModel

  static func opened() async throws -> RequestsHarness {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.respond(to: RPC.ApprovalReceived.name, with: ["acknowledged": true])
    let requests = RequestsModel(chat: harness.session.chat(bot))
    try await harness.open()
    try await harness.frame()
    return RequestsHarness(harness: harness, requests: requests)
  }

  var link: ScriptedLink { harness.link }

  /// A live approval on its own reply, its queue entry listed by `approval.pending`
  /// unless `listed` is false.
  func raiseApproval(id: String = "srq-1", queueID: String = "appr-1", listed: Bool = true) async throws {
    link.raise(
      id: id,
      method: "approval",
      params: [
        "session_id": .string(Fixture.runtime),
        "request_id": .string(queueID),
        "command": "rm -rf ./build",
        "choices": ["once", "deny"]
      ]
    )
    let pending: JSONValue = listed ? ["approvals": [["request_id": .string(queueID)]]] : ["approvals": []]
    link.respond(to: RPC.ApprovalPending.name, with: pending)
    try await harness.frame()
  }

  func card(_ requestID: String = "srq-1") async -> ApprovalItem? {
    await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asApproval).first { $0.requestID == requestID }
  }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct RequestsModelTests {
  @Test func anApprovalIsReValidatedThenAnsweredOnItsOwnReply() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    #expect(opened.requests.openRequests.map(\.requestID) == ["srq-1"])
    #expect(opened.requests.nextToPresent == "srq-1")

    await opened.requests.answerApproval("srq-1", choice: "once")

    let order = opened.link.calls.map(\.method).filter { $0 == RPC.ApprovalPending.name }
    #expect(order.count == 1, "asked approval.pending first")
    #expect(opened.link.answers.map(\.id) == ["srq-1"])
    #expect(opened.link.answers.first?.result["choice"] == "once")
    #expect(await opened.card()?.state == .answered)
    #expect(opened.requests.phase(of: "srq-1") == nil)
    #expect(opened.requests.lastAnswered?.requestID == "srq-1")
    await opened.shutdown()
  }

  @Test func aRequestTheGatewayNoLongerListsIsClosedWithANoticeAndNothingIsSent() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval(listed: false)
    opened.requests.present("srq-1")

    await opened.requests.answerApproval("srq-1", choice: "once")

    #expect(opened.link.answers.isEmpty, "nothing answered into the void")
    #expect(opened.link.calls(RPC.ApprovalRespond.name).isEmpty)
    let card = try #require(await opened.card())
    #expect(card.state == .cancelled)
    #expect(opened.requests.notice?.notice == .noLongerPending)
    #expect(opened.requests.notice?.requestID == "srq-1")
    #expect(opened.requests.presentedRequestID == "srq-1", "a sheet that is up shows the outcome until it is closed")
    try await opened.harness.frame()
    #expect(opened.requests.presentedRequest?.asApproval?.state == .cancelled)

    // A late copy of the same request does not reopen it.
    opened.link.raise(
      id: "srq-1", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "rm -rf ./build"],
      replayed: true)
    try await opened.harness.frame()
    #expect(await opened.card()?.state == .cancelled)
    await opened.shutdown()
  }

  @Test func anUnknownStandingDoesNotBlockTheAnswer() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    // A gateway that does not answer approval.pending at all.
    opened.link.respond(to: RPC.ApprovalPending.name) { _ in .string("not a list") }

    await opened.requests.answerApproval("srq-1", choice: "deny")
    #expect(opened.link.answers.first?.result["choice"] == "deny")
    #expect(await opened.card()?.state == .answered)
    await opened.shutdown()
  }

  @Test func anApprovalWithNoQueueIDIsAnsweredWithoutAskingTheQueue() async throws {
    let opened = try await RequestsHarness.opened()
    opened.link.raise(
      id: "srq-7", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "command": "ls", "choices": ["once", "deny"]])
    // The queue lists nothing: a check against it would close this card.
    opened.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": []])
    try await opened.harness.frame()

    await opened.requests.answerApproval("srq-7", choice: "once")
    #expect(opened.link.calls(RPC.ApprovalPending.name).isEmpty)
    #expect(opened.link.answers.map(\.id) == ["srq-7"])
    #expect(await opened.card("srq-7")?.state == .answered)
    await opened.shutdown()
  }

  @Test func onlyAChoiceTheRequestOfferedIsSent() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()

    await opened.requests.answerApproval("srq-1", choice: "always")
    #expect(opened.link.calls(RPC.ApprovalPending.name).isEmpty)
    #expect(opened.link.answers.isEmpty)
    #expect(await opened.card()?.state == .open)
    await opened.shutdown()
  }

  @Test func aSecondTapWhileTheFirstIsOnItsWaySendsNothing() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    // Hold the re-validation so the first answer stays in flight.
    opened.link.unrespond(RPC.ApprovalPending.name)
    let requests = opened.requests

    let first = Task { await requests.answerApproval("srq-1", choice: "once") }
    let check = try await opened.link.pendingCall(RPC.ApprovalPending.name)
    #expect(requests.isSending("srq-1"))

    await requests.answerApproval("srq-1", choice: "deny")
    #expect(opened.link.calls(RPC.ApprovalPending.name).count == 1, "the second tap asked nothing")

    opened.link.answer(check, ["approvals": [["request_id": "appr-1"]]])
    await first.value
    #expect(opened.link.answers.map { $0.result["choice"] } == ["once"])
    await opened.shutdown()
  }

  @Test func anAnswerThatDidNotLeaveTheDeviceCanBeRetried() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()

    // The socket that delivered it is gone.
    opened.link.setSocketOpen(false)
    await opened.requests.answerApproval("srq-1", choice: "once")
    #expect(opened.requests.phase(of: "srq-1") == .failed(reason: nil))
    #expect(opened.requests.chat.cardNotices["srq-1"] == ChatModel.unsentAnswerNotice, "the chat model's notice, one record")
    #expect(opened.requests.hasFailed("srq-1"))
    #expect(opened.requests.attempts["srq-1"] == .approval(choice: "once"))
    #expect(await opened.card()?.state == .open, "the question is still open")

    // Re-delivered over the new socket, then retried.
    opened.link.setSocketOpen(true)
    opened.link.raise(
      id: "srq-1", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "rm -rf ./build"],
      replayed: true)
    try await opened.harness.frame()

    await opened.requests.retry("srq-1")
    #expect(opened.link.answers.map(\.id) == ["srq-1"])
    #expect(opened.requests.phase(of: "srq-1") == nil)
    #expect(await opened.card()?.state == .answered)
    await opened.shutdown()
  }

  @Test func aFailedCallKeepsTheAnswerForARetry() async throws {
    let opened = try await RequestsHarness.opened()
    // A card from the queue, with no live reply behind it: answered by call.
    opened.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": [["request_id": "appr-9", "command": "ls"]]])
    await opened.harness.session.store.refreshPendingApprovals(bot)
    try await opened.harness.frame()
    let requestID = try #require(opened.requests.openRequests.first?.requestID)

    let answering = Task { await opened.requests.answerApproval(requestID, choice: "deny") }
    let call = try await opened.link.pendingCall(RPC.ApprovalRespond.name)
    opened.link.fail(call, GatewayRPCError(.timeout, "request timed out: approval.respond"))
    await answering.value
    #expect(opened.requests.phase(of: requestID) == .failed(reason: "request timed out: approval.respond"))
    #expect(await opened.card(requestID)?.state == .open)

    opened.link.respond(to: RPC.ApprovalRespond.name, with: ["resolved": 1])
    await opened.requests.retry(requestID)
    #expect(opened.link.calls(RPC.ApprovalRespond.name).last?.params["choice"] == "deny")
    #expect(await opened.card(requestID)?.state == .answered)
    #expect(opened.requests.phase(of: requestID) == nil)
    await opened.shutdown()
  }

  @Test func aClarifyIsAnsweredWithAnOptionOrFreeText() async throws {
    let opened = try await RequestsHarness.opened()
    opened.link.raise(
      id: "srq-2", method: "clarify",
      params: ["session_id": .string(Fixture.runtime), "question": "Which branch?", "choices": ["main", "next"]])
    try await opened.harness.frame()
    let clarify = try #require(opened.requests.openRequests.first?.asClarify)
    let qid = try #require(clarify.questions.first?.qid)

    // An answer to a question it did not ask is dropped; nothing else is sent.
    await opened.requests.answerClarify("srq-2", answers: ["other": "x"])
    #expect(opened.link.answers.isEmpty)

    await opened.requests.answerClarify("srq-2", answers: [qid: "a branch of my own"])
    #expect(opened.link.answers.first?.result["answer"] == "a branch of my own")
    #expect(opened.link.calls(RPC.ApprovalPending.name).isEmpty, "a clarify is not an approval")
    let answered = await opened.harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asClarify).first
    #expect(answered?.state == .answered)
    await opened.shutdown()
  }

  @Test func aDeadlineCountsDownAndClosesTheCardWhenItPasses() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    let requests = opened.requests
    let start = Date(timeIntervalSince1970: 1_790_000_000)

    #expect(requests.secondsLeft("srq-1", at: start) == nil, "no deadline, no countdown")
    requests.setDeadline("srq-1", start.addingTimeInterval(90))
    #expect(requests.secondsLeft("srq-1", at: start) == 90)
    #expect(requests.secondsLeft("srq-1", at: start.addingTimeInterval(89.5)) == 1)
    #expect(requests.secondsLeft("srq-1", at: start.addingTimeInterval(120)) == 0)

    await requests.expire("srq-1")
    let card = try #require(await opened.card())
    #expect(card.state == .cancelled)
    #expect(card.cancelReason == "timeout")
    #expect(opened.link.answers.isEmpty, "expiry sends nothing")
    #expect(requests.deadline(of: "srq-1") == nil)

    // A late tap on the closed card does nothing either.
    await requests.answerApproval("srq-1", choice: "once")
    #expect(opened.link.answers.isEmpty)
    await opened.shutdown()
  }

  @Test func aSheetPutAwayDoesNotComeBackByItself() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    let requests = opened.requests

    requests.present("srq-1")
    #expect(requests.presentedRequest?.requestID == "srq-1")
    requests.dismissSheet()
    #expect(requests.presentedRequestID == nil)
    #expect(requests.nextToPresent == nil)
    #expect(await opened.card()?.state == .open, "putting it away is not an answer")

    requests.present("srq-1")
    #expect(requests.presentedRequestID == "srq-1")
    await opened.shutdown()
  }

  // MARK: Put away for the session (HERM-251)

  @Test func anApprovalPutAwayStaysPutAwayWhenTheChatIsOpenedAgain() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    let session = opened.harness.session
    let first = RequestsModel(session: session, bot: bot)

    first.present("srq-1")
    first.dismissSheet()

    // The chat screen is made again (another chat, then this one): its model is new, the session is not.
    let again = RequestsModel(session: session, bot: bot)
    #expect(again.nextToPresent == nil, "not raised again by itself")
    #expect(again.waiting == ["srq-1"], "the chat says it waits")
    #expect(await opened.card()?.state == .open, "and it is still open")
    #expect(opened.link.answers.isEmpty, "nothing was answered")

    again.present("srq-1")
    #expect(again.presentedRequestID == "srq-1")
    #expect(again.waiting.isEmpty)
    await opened.shutdown()
  }

  @Test func leavingTheChatPutsAwayTheRequestItsSheetShowedAndANewOneStillComesUp() async throws {
    let opened = try await RequestsHarness.opened()
    try await opened.raiseApproval()
    let session = opened.harness.session
    let first = RequestsModel(session: session, bot: bot)

    #expect(first.nextToPresent == "srq-1")
    first.present("srq-1")
    first.leave()
    #expect(first.presentedRequestID == nil)
    #expect(opened.link.answers.isEmpty, "leaving answers nothing")

    let again = RequestsModel(session: session, bot: bot)
    #expect(again.nextToPresent == nil, "re-entering does not raise what was left")

    // A new request that arrives while the person is in the chat is time-critical: it comes up.
    try await opened.raiseApproval(id: "srq-2", queueID: "appr-2")
    #expect(again.nextToPresent == "srq-2")
    #expect(again.waiting == ["srq-1"])
    await opened.shutdown()
  }

  @Test func whatIsPutAwayInOneChatIsNotPutAwayInAnother() {
    let shelf = RequestShelf()
    shelf.putAway("srq-1", chat: "researcher", kind: .answer)
    #expect(shelf.contains("srq-1", chat: "researcher", kind: .answer))
    #expect(!shelf.contains("srq-1", chat: "writer", kind: .answer))
    #expect(!shelf.contains("srq-1", chat: "researcher", kind: .secure))

    shelf.keep(only: [], chat: "researcher", kind: .answer)
    #expect(!shelf.contains("srq-1", chat: "researcher", kind: .answer), "an ended request is forgotten")
  }
}
