import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
/// A value nobody else in the test writes, so finding it anywhere is a leak.
private let typed = "reconnect-7f3a-never-anywhere"

/// The center hears the live socket only. What the gateway said while the socket was down (a
/// `request.cancel`, a request that timed out) reaches it through what the reconnect reads: the
/// replay's events and the `open_requests` lists.
@Suite("Interactive requests: what a reconnect tells them", .timeLimit(.minutes(1))) @MainActor
struct InteractiveReconnectTests {
  // MARK: The center

  @Test("a request its session's open_requests no longer lists closes as lapsed, and nothing can be sent to it")
  func closesWhatTheListLeftOut() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-1")
    try await h.raiseOpen("srq-2", "review.draft", params: InteractiveFrames.draft())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-1")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: Fixture.runtime, open: ["srq-2"], askedAt: h.clock.now)

    #expect(h.center.prompts.map(\.id) == ["srq-2"])
    #expect(h.center.notices[bot]?.notice == .lapsed)
    #expect(h.center.notices[bot]?.requestID == "srq-1")
    #expect(model.presentedOutcome == .lapsed, "the sheet says so")
    #expect(model.notice == nil, "not twice")
    #expect(await model.answer(.form(["name": .text(typed)])) == false)
    #expect(await h.center.answer("srq-1", .form(["name": .text(typed)])) == false)
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)

    let card = try #require(await h.card("srq-1"))
    #expect(card.state == .cancelled)
    #expect(card.cancelReason == "lapsed")

    // The gateway stopped waiting for it: a copy that turns up later is not opened again.
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-1", method: "input.form", params: params, replayed: true)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("srq-1"))
  }

  @Test("a request first seen at or after the call went out is kept: it may be newer than the list")
  func keepsWhatCameAfterTheCall() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("before")
    await h.clock.advance(by: .seconds(1))
    let askedAt = h.clock.now
    try await h.raiseOpen("after")

    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: askedAt)

    #expect(h.center.prompts.map(\.id) == ["after"])
    #expect(h.center.notices[bot]?.requestID == "before")
  }

  @Test("only the session the list is for: another session's requests stay")
  func onlyThatSession() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("mine")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: "rt-other", open: [], askedAt: h.clock.now)
    h.center.reconcile(session: "", open: [], askedAt: h.clock.now)

    #expect(h.center.isOpen("mine"))
    #expect(h.center.notices.isEmpty)
  }

  @Test("a request waiting for its chat is let go quietly: no notice, no answer, no refusal")
  func waitingGoesQuietly() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.form()
    params["session_id"] = "rt-9"
    h.link.raise(id: "far", method: "input.form", params: params)
    let center = h.center
    try await eventually("far to wait for its chat") { await center.parkedCount == 1 }
    await h.clock.advance(by: .seconds(1))

    center.reconcile(session: "rt-9", open: [], askedAt: h.clock.now)

    #expect(center.parkedCount == 0)
    #expect(center.prompts.isEmpty)
    #expect(center.notices.isEmpty)
    #expect(h.link.declines.isEmpty)
    #expect(h.link.answers.isEmpty)

    // Its park limit passing later declines nothing either.
    await h.clock.advance(by: .seconds(20))
    #expect(h.link.declines.isEmpty)
  }

  @Test("a request whose answer is on its way when the list leaves it out says it may not have arrived, once")
  func listWhileSending() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let gate = ReplyGate()
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    let request = ServerRequest(id: "slow", method: "input.form", params: params)
    let inbound = InboundRequest(
      request: request,
      replayed: false,
      index: 1,
      respond: { result in await gate.respond(result) },
      fail: { _, _ in true }
    )
    await h.center.ingest(InteractiveRequestCenter.read(inbound))
    #expect(h.center.isOpen("slow"))
    await h.clock.advance(by: .seconds(1))

    let center = h.center
    let sending = Task { @MainActor in await center.answer("slow", .form(["name": .text(typed)])) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now)
    #expect(!center.isOpen("slow"))
    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    gate.open()
    _ = await sending.value

    // The frame already handed to the socket is the only one: the re-check after the await neither
    // records it as answered nor sends anything more.
    #expect(gate.answers.count == 1)
    #expect(center.lastAnswered == nil)
    #expect(center.phases["slow"] == nil)
    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    #expect(await center.answer("slow", .form(["name": .text(typed)])) == false)
    #expect(gate.answers.count == 1)

    // Closed as the gateway's doing: a re-delivered copy is not opened again.
    await center.ingest(
      InteractiveRequestCenter.read(
        InboundRequest(
          request: request,
          replayed: true,
          index: 2,
          respond: { result in await gate.respond(result) },
          fail: { _, _ in true }
        )))
    #expect(!center.isOpen("slow"))
  }

  // MARK: Through the store

  @Test("after a reconnect, a request the replay's open_requests no longer lists closes as lapsed, nothing sent")
  func replayListClosesALapsedRequest() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-r", "review.draft", params: InteractiveFrames.draft())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-r")

    // The socket drops; the gateway gives up on the request meanwhile. As the gateway answers: the
    // resume leaves an empty list out, the replay carries `[]`.
    let resume = Fixture.resume()
    #expect(resume["open_requests"] == nil)
    try await reconnect(h, resume: resume, since: Fixture.since(latest: 0))

    let center = h.center
    try await eventually("srq-r to close") { await !center.isOpen("srq-r") }
    #expect(model.presentedOutcome == .lapsed)
    #expect(await model.answer(.approve(text: typed)) == false)
    #expect(h.link.answers.isEmpty)
    #expect(await h.card("srq-r")?.state == .cancelled)
  }

  @Test("a resume whose open_requests no longer lists the request closes it, without the replay's list")
  func resumeListClosesALapsedRequest() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-gone")
    let other: JSONValue = [
      "id": "srq-other", "method": "input.form",
      "params": .object(InteractiveFrames.form().merging(["session_id": .string(Fixture.runtime)]) { $1 })
    ]

    try await reconnect(
      h,
      resume: Fixture.resume(extra: ["open_requests": [other]]),
      since: withoutList(Fixture.since(latest: 0))
    )

    let center = h.center
    try await eventually("srq-gone to close") { await !center.isOpen("srq-gone") }
    #expect(center.notices[bot]?.notice == .lapsed)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a replay that fails leaves the request open, to its deadline: no list, no verdict")
  func failedReplayKeepsTheRequest() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-f")

    h.link.respond(to: RPC.ProfilesList.name, with: SessionHarness.roster)
    h.link.status(.reconnecting)
    await h.clock.advance(by: .seconds(1))
    h.link.status(.ready)
    try await h.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    let since = try await h.link.pendingCall(RPC.SessionEventsSince.name)
    h.link.fail(since, GatewayRPCError(.timeout, "request timed out: session.events.since"))
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(50))

    #expect(h.center.isOpen("srq-f"))
    #expect(h.center.notices.isEmpty)

    // Its own deadline still closes it.
    await h.clock.advance(by: .seconds(299))
    #expect(!h.center.isOpen("srq-f"))
    #expect(h.center.notices[bot]?.notice == .expired)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a reconnect whose answers carry no open_requests says nothing about what is open")
  func noListNoVerdict() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-k")

    try await reconnect(
      h,
      resume: Fixture.resume(extra: ["open_requests": .null]),
      since: withoutList(Fixture.since(latest: 0))
    )
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(50))

    #expect(h.center.isOpen("srq-k"))
    #expect(h.center.notices.isEmpty)
  }

  @Test("a request.cancel the replay carried closes the request as a live one would")
  func replayedCancelCloses() async throws {
    let h = InteractiveHarness()
    try await h.open()
    // A warm chat: its replay applies the events it carries.
    h.link.emit("test.unknown", session: Fixture.runtime, seq: 7)
    try await h.harness.frame()
    #expect(await h.session.store.state(of: bot)?.lastSeq == 7)
    try await h.raiseOpen("srq-c", "review.draft", params: InteractiveFrames.draft())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-c")

    let cancel: JSONValue = [
      "type": "request.cancel",
      "session_id": .string(Fixture.runtime),
      "seq": 8,
      "payload": ["id": "srq-c", "method": "review.draft", "reason": "interrupted"]
    ]
    // No list, so the cancel alone closes it.
    try await reconnect(
      h,
      resume: Fixture.resume(extra: ["open_requests": .null]),
      since: withoutList(Fixture.since(latest: 8, events: [cancel]))
    )

    let center = h.center
    try await eventually("srq-c to close") { await !center.isOpen("srq-c") }
    #expect(model.presentedOutcome == .withdrawn)
    #expect(await model.answer(.approve(text: typed)) == false)
    #expect(h.link.answers.isEmpty)
  }

  // MARK: Nobody answers a request the person never saw

  @Test("a request that arrives while a pass reads its keys is not declined by that pass")
  func passDoesNotJudgeNewcomers() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let gate = LookupGate([Fixture.runtime: bot, "rt-b": "writer"])
    h.center.chatKey = { session in await gate.lookup(session) }
    try await h.raiseOpen("a-form")

    // A pass starts and pauses reading bot A's session.
    gate.hold(Fixture.runtime)
    h.center.storeChanged()
    try await eventually("the pass to pause") { gate.waitingCount == 1 }

    // Meanwhile bot B raises a draft, placed on its chat.
    var params = InteractiveFrames.draft()
    params["session_id"] = "rt-b"
    h.link.raise(id: "b-draft", method: "review.draft", params: params)
    let center = h.center
    try await eventually("b-draft to open") { await center.isOpen("b-draft") }

    gate.release()
    try await Task.sleep(for: .milliseconds(50))
    try await eventually("the passes to end") { await center.liveTaskCount == 2 }
    #expect(center.isOpen("b-draft"), "never declined behind the person's back")
    #expect(center.prompts.first { $0.id == "b-draft" }?.chatKey == "writer")
    #expect(center.isOpen("a-form"))
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)
  }

  @Test("a request placed with a key read before its session moved follows the session")
  func routeWithAStaleKeyIsCorrected() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let gate = LookupGate(["rt-x": bot])
    h.center.chatKey = { session in await gate.lookup(session) }

    // The route reads the key, and pauses before using it.
    gate.hold("rt-x")
    var params = InteractiveFrames.form()
    params["session_id"] = "rt-x"
    h.link.raise(id: "moved", method: "input.form", params: params)
    try await eventually("the route to pause") { gate.waitingCount == 1 }

    // The session moves to another chat; the store's frame finds nothing to move.
    gate.set("rt-x", "writer")
    h.center.storeChanged()
    gate.release()
    let center = h.center
    try await eventually("it to follow its session") {
      await center.prompts.first { $0.id == "moved" }?.chatKey == "writer"
    }
    #expect(h.link.answers.isEmpty)
  }

  // MARK: An answer that never arrived is asked again

  @Test("a re-delivered copy of an answered request opens it again, saying the answer did not arrive")
  func reopensWhenTheAnswerWasLost() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let first = try await h.raiseOpen("lost", "review.draft", params: InteractiveFrames.draft())
    #expect(await h.center.answer("lost", .approve(text: InteractiveFrames.draftText)))
    #expect(!h.center.isOpen("lost"))
    #expect(await h.card("lost")?.state == .answered)

    // A live copy of a done id is not proof of anything; only the gateway's re-delivery is.
    var params = InteractiveFrames.draft()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "lost", method: "review.draft", params: params, replayed: false)
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("lost"))

    let again = try await h.raiseOpen("lost", "review.draft", params: InteractiveFrames.draft(), replayed: true)
    #expect(again.earlierAnswerLost)
    #expect(again.deadline == first.deadline, "the deadline its first copy had")
    #expect(await h.card("lost")?.state == .open, "the card asks again")
    #expect(await h.center.answer("lost", .approve(text: InteractiveFrames.draftText)))
    #expect(h.answers("lost").count == 2)
  }

  @Test("a withdrawn request is never opened again; an abandoned one whose refusal did not arrive is")
  func reopenRules() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("gone")
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "gone", "method": "input.form", "reason": "interrupted"])
    let center = h.center
    try await eventually("gone to close") { await !center.isOpen("gone") }
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "gone", method: "input.form", params: params, replayed: true)
    try await Task.sleep(for: .milliseconds(30))
    #expect(!center.isOpen("gone"))

    // The chat lets go while the socket is down: its refusal does not go out.
    try await h.raiseOpen("let-go")
    h.link.setSocketOpen(false)
    h.link.emit("session.reclaimed", session: Fixture.runtime, payload: [:])
    try await h.harness.frame()
    try await eventually("let-go to close") { await !center.isOpen("let-go") }
    h.link.setSocketOpen(true)

    // After the reconnect the gateway re-delivers it: taken in again (waiting for a chat to hold
    // its session), not ignored as done.
    h.link.raise(id: "let-go", method: "input.form", params: params, replayed: true)
    try await eventually("let-go to be taken in again") { await center.parkedCount == 1 }
  }

  // MARK: A cancel during the send says what is true

  @Test("a request.cancel while the answer is on its way says it may not have arrived")
  func cancelWhileSending() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let gate = ReplyGate()
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    let inbound = InboundRequest(
      request: ServerRequest(id: "slow", method: "input.form", params: params),
      replayed: false,
      index: 1,
      respond: { result in await gate.respond(result) },
      fail: { _, _ in true }
    )
    await h.center.ingest(InteractiveRequestCenter.read(inbound))
    #expect(h.center.isOpen("slow"))

    let center = h.center
    let sending = Task { @MainActor in await center.answer("slow", .form(["name": .text("v")])) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.withdraw("slow", reason: "timeout")
    gate.open()
    _ = await sending.value

    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    #expect(!center.isOpen("slow"))
  }

  // MARK: Notices never take a request's parking place

  @Test("requests this app cannot show, for an unbound session, never crowd out a request")
  func noticesDoNotPark() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var future = InteractiveFrames.form()
    future["v"] = 2
    future["session_id"] = "rt-other"

    for index in 0..<40 {
      h.link.raise(id: "v2-\(index)", method: "input.form", params: future)
    }
    var params = InteractiveFrames.form()
    params["session_id"] = "rt-other"
    h.link.raise(id: "real", method: "input.form", params: params)
    let center = h.center
    try await eventually("all taken in") { await center.parkedNoticeCount == 16 }
    try await eventually("the request to wait") { await center.parkedCount == 1 }
    #expect(
      !h.link.declines.contains { $0.id == "real" }, "the request waits for its chat")
    #expect(center.parkedNoticeCount == 16, "bounded, oldest dropped")
    #expect(h.link.declines.filter { $0.id.hasPrefix("v2-") }.count == 40, "each was told 4041 at once")
  }

  // MARK: Shutdown flushes its last answers

  @Test("shutdown waits for its refusals to reach the socket before closing it")
  func shutdownFlushes() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("left-open")

    await h.session.shutdown()
    let lifecycle = h.link.lifecycle
    let flush = try #require(lifecycle.firstIndex(of: "flush"))
    let shutdown = try #require(lifecycle.firstIndex(of: "shutdown"))
    #expect(flush < shutdown)
    #expect(h.cannotShowReason("left-open") == CannotShowReason.shuttingDown)
  }

  // MARK: Helpers

  /// Drop the socket, let the shared clock move on, bring it back, and answer the recovery's
  /// resume and replay.
  private func reconnect(_ h: InteractiveHarness, resume: JSONValue, since: JSONValue) async throws {
    h.link.respond(to: RPC.ProfilesList.name, with: SessionHarness.roster)
    h.link.setSocketOpen(false)
    h.link.status(.reconnecting)
    await h.clock.advance(by: .seconds(1))
    h.link.setSocketOpen(true)
    h.link.status(.ready)
    try await h.link.answerNext(RPC.SessionResume.name, resume)
    try await h.link.answerNext(RPC.SessionEventsSince.name, since)
  }

  private func withoutList(_ value: JSONValue) -> JSONValue {
    var object = value.objectValue ?? [:]
    object["open_requests"] = .null
    return .object(object)
  }
}
