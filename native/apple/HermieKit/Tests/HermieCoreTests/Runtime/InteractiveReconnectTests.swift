import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
/// A value nobody else in the test writes, so finding it anywhere is a leak.
private let typed = "reconnect-7f3a-never-anywhere"
/// A list that holds every interactive method in full.
private let all = Set(InteractiveCapabilities.deviceMethods())

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

    h.center.reconcile(session: Fixture.runtime, open: ["srq-2"], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())

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

    // A copy the gateway re-delivers later says it still waits after all: it opens again.
    let again = try await h.raiseOpen("srq-1", replayed: true)
    #expect(!again.earlierAnswerLost, "nothing was answered")
    #expect(await h.card("srq-1")?.state == .open)
  }

  @Test("a list that does not hold a method in full closes none of its requests")
  func onlyTheMethodsListedInFull() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("form")
    try await h.raiseOpen("draft", "review.draft", params: InteractiveFrames.draft())
    await h.clock.advance(by: .seconds(1))

    // Read before this socket's methods were accepted: it says nothing about them.
    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: [], index: h.link.nextIndex())
    #expect(h.center.prompts.map(\.id) == ["form", "draft"])
    #expect(h.center.notices.isEmpty)

    // Only `input.form` was accepted when this one was read.
    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: ["input.form"], index: h.link.nextIndex())
    #expect(h.center.prompts.map(\.id) == ["draft"])
    #expect(h.center.notices[bot]?.requestID == "form")
  }

  @Test("a request first seen at or after the call went out is kept: it may be newer than the list")
  func keepsWhatCameAfterTheCall() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("before")
    await h.clock.advance(by: .seconds(1))
    let askedAt = h.clock.now
    try await h.raiseOpen("after")

    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: askedAt, listed: all, index: h.link.nextIndex())

    #expect(h.center.prompts.map(\.id) == ["after"])
    #expect(h.center.notices[bot]?.requestID == "before")
  }

  @Test("only the session the list is for: another session's requests stay")
  func onlyThatSession() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("mine")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: "rt-other", open: [], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())
    h.center.reconcile(session: "", open: [], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())

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

    center.reconcile(session: "rt-9", open: [], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())

    #expect(center.parkedCount == 0)
    #expect(center.prompts.isEmpty)
    #expect(center.notices.isEmpty)
    #expect(h.link.declines.isEmpty)
    #expect(h.link.answers.isEmpty)

    // Its park limit passing later declines nothing either.
    await h.clock.advance(by: .seconds(20))
    #expect(h.link.declines.isEmpty)
  }

  @Test("a list that leaves out a request whose answer is on its way waits for the verdict: taken is answered")
  func listWhileSendingTaken() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("slow")
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      return ["status": "ok"]
    }
    await h.clock.advance(by: .seconds(1))

    let center = h.center
    let sending = Task { @MainActor in await center.answer("slow", .form(["name": .text(typed)])) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    // The list may leave it out because this very answer settled it.
    center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())
    #expect(center.isOpen("slow"), "the verdict decides")
    gate.open()
    #expect(await sending.value)

    #expect(!center.isOpen("slow"))
    #expect(center.lastAnswered?.requestID == "slow")
    #expect(center.notices[bot] == nil)
    #expect(await h.card("slow")?.state == .answered)
  }

  @Test("a list that leaves out a request whose answer got no verdict closes it: it may not have arrived")
  func listWhileSendingNoVerdict() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("slow")
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      throw GatewayRPCError(.timeout, "request timed out after 30s: request.answer")
    }
    await h.clock.advance(by: .seconds(1))

    let center = h.center
    let sending = Task { @MainActor in await center.answer("slow", .form(["name": .text(typed)])) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: all, index: h.link.nextIndex())
    gate.open()
    #expect(await sending.value == false)

    #expect(!center.isOpen("slow"))
    #expect(center.lastAnswered == nil)
    #expect(center.phases["slow"] == nil)
    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    #expect(await center.answer("slow", .form(["name": .text(typed)])) == false)
    #expect(gate.answers.count == 1)
    #expect(await h.card("slow")?.cancelReason == "lapsed")
  }

  // MARK: The connection's own reads, and their order

  @Test("the connection's read after the acceptance closes a request that ended while the socket was down")
  func connectionListCloses() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-gone")
    try await h.raiseOpen("srq-kept")
    await h.clock.advance(by: .seconds(1))

    h.link.list(Fixture.runtime, open: ["srq-kept"], askedAt: h.clock.now)
    let center = h.center
    try await eventually("srq-gone to close") { await !center.isOpen("srq-gone") }
    #expect(center.isOpen("srq-kept"))
    #expect(center.notices[bot]?.notice == .lapsed)
    #expect(await h.card("srq-gone")?.cancelReason == "lapsed")
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)
  }

  @Test("a list older than one already read is not read; a copy an older answer re-delivers does not reopen what a list closed")
  func olderListsAndCopies() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-o")
    await h.clock.advance(by: .seconds(1))
    let early = h.link.nextIndex()
    let late = h.link.nextIndex()

    // The newer list still names it; the older one, read after it, does not: it is not read.
    h.center.reconcile(session: Fixture.runtime, open: ["srq-o"], askedAt: h.clock.now, listed: all, index: late)
    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: all, index: early)
    #expect(h.center.isOpen("srq-o"))
    #expect(h.center.notices.isEmpty)

    // A newer list leaves it out: it closes.
    let closing = h.link.nextIndex()
    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: all, index: closing)
    #expect(!h.center.isOpen("srq-o"))

    // A copy from an answer older than that list is stale: not opened again.
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-o", method: "input.form", params: params, replayed: true, index: late)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("srq-o"))

    // One the gateway re-delivers after it: it still waits after all.
    try await h.raiseOpen("srq-o", replayed: true)
  }

  @Test("a request delivered with or after the list is kept, whatever the clock says")
  func deliveredAfterTheList() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let listIndex = h.link.nextIndex()
    try await h.raiseOpen("srq-new")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now, listed: all, index: listIndex)
    #expect(h.center.isOpen("srq-new"))
  }

  @Test("a resolved cancel through the store before the request.answer reply: the card ends answered, with its summary")
  func resolvedThroughTheStoreBeforeTheVerdict() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-rs", params: InteractiveFrames.form(optional: true))
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      return ["status": "ok"]
    }

    let center = h.center
    let sending = Task { @MainActor in await center.skip("srq-rs") }
    try await eventually("the answer to be on its way") { await center.phases["srq-rs"] == .sending }

    // The gateway settles it and tells every client, this one too, before its reply.
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "srq-rs", "method": "input.form", "reason": "resolved"])
    try await h.harness.frame()
    try await eventually("the store to apply the cancel") { await h.card("srq-rs")?.state == .cancelled }
    #expect(center.isOpen("srq-rs"), "the verdict decides")

    gate.open()
    #expect(await sending.value)
    try await h.harness.frame()
    let card = try #require(await h.card("srq-rs"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.status == "skipped")
    #expect(center.notices[bot] == nil, "not answered elsewhere")
    #expect(center.lastAnswered?.requestID == "srq-rs")
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

  @Test("after a reconnect, lists read before this socket's methods were accepted close nothing: the form stays answerable")
  func earlyListsCloseNothing() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-k")
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-k")

    // The resume and the replay raced the second `client.capabilities` call: the gateway hid the
    // form from both lists.
    h.link.setListed([])
    try await reconnect(h, resume: Fixture.resume(extra: ["open_requests": []]), since: Fixture.since(latest: 0))
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.center.isOpen("srq-k"))
    #expect(h.center.notices.isEmpty)
    #expect(model.presented?.id == "srq-k")

    // Once the methods are accepted the gateway re-delivers it; the answer goes through.
    h.link.setListed(all)
    try await h.raiseOpen("srq-k", replayed: true)
    #expect(await model.answer(.form(["name": .text(typed)])))
    #expect(h.answers("srq-k").count == 1)
    #expect(await h.card("srq-k")?.state == .answered)
  }

  @Test("a resume's request this app cannot show draws no card: it is declined 4041 with a notice, and the chat waits for nothing")
  func resumeListedCannotShowDrawsNoCard() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var future = InteractiveFrames.form(fields: [["id": "x", "kind": "hologram", "label": "X"]])
    future["session_id"] = .string(Fixture.runtime)
    var late = InteractiveFrames.form(expires: 1_789_999_990)
    late["session_id"] = .string(Fixture.runtime)
    let listed: JSONValue = [
      ["id": "srq-u", "method": "input.form", "params": .object(future)],
      ["id": "srq-late", "method": "input.form", "params": .object(late)]
    ]

    // As the connection does, the copies are re-delivered before the resume's answer is read.
    h.link.raise(id: "srq-u", method: "input.form", params: future, replayed: true)
    h.link.raise(id: "srq-late", method: "input.form", params: late, replayed: true)
    try await reconnect(h, resume: Fixture.resume(extra: ["open_requests": listed]), since: withoutList(Fixture.since(latest: 0)))
    let link = h.link
    try await eventually("the refusal") { link.declines.contains { $0.id == "srq-u" } }
    try await h.harness.frame()

    #expect(h.cannotShowReason("srq-u") == CannotShowReason.notSupportedOnDevice)
    #expect(await h.card("srq-u") == nil, "no card waits for an answer that went out as an error")
    #expect(await h.card("srq-late") == nil)
    #expect(h.center.prompts.isEmpty)
    #expect(!h.center.needsInput(bot))
    #expect(h.session.chat(bot).openRequests.isEmpty, "the chat waits for nothing")
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
    try await eventually("the passes to end") { await center.liveTaskCount == 3 }
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

  @Test("an answer the gateway took is never asked again, even by a copy a list read before it re-delivers")
  func takenIsNotReopened() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("taken", "review.draft", params: InteractiveFrames.draft())
    #expect(await h.center.answer("taken", .approve(text: InteractiveFrames.draftText)))
    #expect(await h.card("taken")?.state == .answered)

    var params = InteractiveFrames.draft()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "taken", method: "review.draft", params: params, replayed: true)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("taken"))
    #expect(h.center.notices.isEmpty)
    #expect(h.answers("taken").count == 1)
  }

  @Test("a re-delivered copy of a request whose 4041 did not arrive opens it again, saying the answer was lost")
  func reopensWhenTheAnswerWasLost() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.draft()
    params["session_id"] = .string(Fixture.runtime)
    let request = ServerRequest(id: "lost", method: "review.draft", params: params)
    // The 4041 is handed to a socket that goes before it is written.
    await h.center.ingest(
      InteractiveRequestCenter.read(
        InboundRequest(request: request, replayed: false, index: 1, respond: { _ in true }, fail: { _, _ in true })))
    let first = try #require(h.center.prompts.first { $0.id == "lost" })
    #expect(await h.center.cannotShow("lost", reason: CannotShowReason.permissionDenied))
    #expect(!h.center.isOpen("lost"))

    // A live copy of a done id is not proof of anything; only the gateway's re-delivery is.
    h.link.raise(id: "lost", method: "review.draft", params: params, replayed: false)
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("lost"))

    let again = try await h.raiseOpen("lost", "review.draft", params: InteractiveFrames.draft(), replayed: true)
    #expect(again.earlierAnswerLost)
    #expect(again.deadline == first.deadline, "the deadline its first copy had")
    #expect(await h.card("lost")?.state == .open, "the card asks again")
    #expect(await h.center.answer("lost", .approve(text: InteractiveFrames.draftText)))
    #expect(h.answers("lost").count == 1)
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

  @Test("a resolved cancel that overtakes the verdict of this device's answer: answered, and the card hears it")
  func resolvedBeforeTheVerdict() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("mine")
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      return ["status": "ok"]
    }
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("mine")

    let center = h.center
    let sending = Task { @MainActor in await model.answer(.form(["name": .text("v")])) }
    try await eventually("the answer to be on its way") { await center.phases["mine"] == .sending }
    // The gateway's `resolved` goes to every client, this one included, and arrives first. (Told
    // to the center alone, so the card shows what the center makes of it.)
    center.withdraw("mine", reason: "resolved")
    #expect(center.isOpen("mine"), "the verdict decides")
    // Nor does the deadline close it meanwhile.
    await h.clock.advance(by: .seconds(400))
    #expect(center.isOpen("mine"))

    gate.open()
    #expect(await sending.value)
    #expect(!center.isOpen("mine"))
    #expect(center.lastAnswered?.requestID == "mine")
    #expect(center.notices[bot] == nil)
    #expect(model.presentedID == nil)
    let card = try #require(await h.card("mine"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.status == "answered")
  }

  @Test("a resolved cancel after the verdict changes nothing; one for a request this device did not answer says so")
  func resolvedAfterTheVerdictAndElsewhere() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("mine")
    try await h.raiseOpen("theirs")
    #expect(await h.center.answer("mine", .form(["name": .text("v")])))

    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "mine", "method": "input.form", "reason": "resolved"])
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(20))
    #expect(h.center.notices[bot] == nil)
    #expect(h.center.lastAnswered?.requestID == "mine")

    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "theirs", "method": "input.form", "reason": "resolved"])
    let center = h.center
    try await eventually("theirs to close") { await !center.isOpen("theirs") }
    #expect(center.notices[bot]?.notice == .answeredElsewhere)
    #expect(center.notices[bot]?.requestID == "theirs")
    #expect(h.answers("theirs").isEmpty)
  }

  @Test("a timeout cancel while the answer is on its way: the gateway's expired verdict closes it as expired")
  func timeoutWhileSending() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("late")
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      return ["status": "expired"]
    }

    let center = h.center
    let sending = Task { @MainActor in await center.answer("late", .form(["name": .text("v")])) }
    try await eventually("the answer to be on its way") { await center.phases["late"] == .sending }
    center.withdraw("late", reason: "timeout")
    gate.open()
    #expect(await sending.value == false)

    #expect(!center.isOpen("late"))
    #expect(center.notices[bot]?.notice == .expired)
    #expect(center.lastAnswered == nil)
  }

  @Test("a cancel while the answer got no verdict says it may not have arrived")
  func cancelWhileSending() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("slow")
    let gate = ReplyGate()
    h.link.onRequestAnswer { _, result in
      _ = await gate.respond(result)
      throw GatewayRPCError(.closed, "WebSocket closed")
    }

    let center = h.center
    let sending = Task { @MainActor in await center.answer("slow", .form(["name": .text("v")])) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.withdraw("slow", reason: "interrupted")
    gate.open()
    #expect(await sending.value == false)

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
