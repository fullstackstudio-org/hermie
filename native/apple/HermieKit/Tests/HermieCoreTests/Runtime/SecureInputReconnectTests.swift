import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
/// A value nobody else in the test writes, so finding it anywhere is a leak.
private let typed = "pw-reconnect-never-anywhere"

/// The center hears the live socket only. What the gateway said while the socket
/// was down (a `request.cancel`, a request that timed out) reaches it through
/// what the reconnect reads: the replay's events and the `open_requests` lists.
@Suite("Secure input: what a reconnect tells it", .timeLimit(.minutes(1))) @MainActor
struct SecureInputReconnectTests {
  // MARK: The center

  @Test("a prompt its session's open_requests no longer lists closes as lapsed, and nothing can be sent to it")
  func closesWhatTheListLeftOut() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-1", "sudo", params: ["command": "ls"])
    try await h.raiseOpen("srq-2")
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-1")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: Fixture.runtime, open: ["srq-2"], askedAt: h.clock.now)

    #expect(h.center.prompts.map(\.id) == ["srq-2"])
    #expect(h.center.notices[bot]?.notice == .lapsed)
    #expect(h.center.notices[bot]?.requestID == "srq-1")
    #expect(model.presentedOutcome == .lapsed, "the sheet says so")
    #expect(model.notice == nil, "not twice")
    #expect(await model.send(SecretValue(typed)) == false)
    #expect(await h.center.send("srq-1", value: SecretValue(typed)) == false)
    #expect(h.link.answers.isEmpty)

    // The gateway stopped waiting for it: a copy that turns up later is not opened again.
    h.link.raise(id: "srq-1", method: "sudo", params: ["session_id": .string(Fixture.runtime)], replayed: true)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("srq-1"))
  }

  @Test("a prompt first seen at or after the call went out is kept: it may be newer than the list")
  func keepsWhatCameAfterTheCall() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("before")
    await h.clock.advance(by: .seconds(1))
    let askedAt = h.clock.now
    try await h.raiseOpen("after")

    h.center.reconcile(session: Fixture.runtime, open: [], askedAt: askedAt)

    #expect(h.center.prompts.map(\.id) == ["after"])
    #expect(h.center.notices[bot]?.requestID == "before")
  }

  @Test("only the session the list is for: another session's prompts stay")
  func onlyThatSession() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("mine")
    await h.clock.advance(by: .seconds(1))

    h.center.reconcile(session: "rt-other", open: [], askedAt: h.clock.now)
    h.center.reconcile(session: "", open: [], askedAt: h.clock.now)

    #expect(h.center.isOpen("mine"))
    #expect(h.center.notices.isEmpty)
  }

  @Test("a prompt waiting for its chat is let go quietly: no notice, no answer, no refusal")
  func waitingGoesQuietly() async throws {
    let h = SecureHarness()
    try await h.open()
    h.link.raise(id: "far", method: "sudo", params: ["session_id": "rt-9"])
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

  @Test("a prompt whose answer is on its way when the list leaves it out says it may not have arrived, once")
  func listWhileSending() async throws {
    let h = SecureHarness()
    try await h.open()
    let gate = ReplyGate()
    let inbound = InboundRequest(
      request: ServerRequest(id: "slow", method: "secret", params: ["session_id": .string(Fixture.runtime)]),
      replayed: false,
      index: 1,
      respond: { result in await gate.respond(result) },
      fail: { _, _ in true }
    )
    await h.center.ingest(SecureInputCenter.read(inbound))
    #expect(h.center.isOpen("slow"))
    await h.clock.advance(by: .seconds(1))

    let center = h.center
    let sending = Task { @MainActor in await center.send("slow", value: SecretValue(typed)) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.reconcile(session: Fixture.runtime, open: [], askedAt: h.clock.now)
    #expect(!center.isOpen("slow"))
    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    gate.open()
    _ = await sending.value

    // The frame already handed to the socket is the only one: the re-check after
    // the await neither records it as answered nor sends anything more.
    #expect(gate.answers.count == 1)
    #expect(center.lastAnswered == nil)
    #expect(center.phases["slow"] == nil)
    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    #expect(await center.send("slow", value: SecretValue(typed)) == false)
    #expect(gate.answers.count == 1)

    // Closed as the gateway's doing: a re-delivered copy is not opened again.
    await center.ingest(SecureInputCenter.read(
      InboundRequest(
        request: ServerRequest(id: "slow", method: "secret", params: ["session_id": .string(Fixture.runtime)]),
        replayed: true,
        index: 2,
        respond: { result in await gate.respond(result) },
        fail: { _, _ in true }
      )))
    #expect(!center.isOpen("slow"))
  }

  // MARK: Through the store

  @Test("after a reconnect, a prompt the replay's open_requests no longer lists closes as lapsed, nothing sent")
  func replayListClosesALapsedPrompt() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-r", "sudo", params: ["command": "ls"])
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-r")

    // The socket drops; the gateway gives up on the request meanwhile. As the
    // gateway answers: the resume leaves an empty list out, the replay carries `[]`.
    let resume = Fixture.resume()
    #expect(resume["open_requests"] == nil)
    try await reconnect(h, resume: resume, since: Fixture.since(latest: 0))

    let center = h.center
    try await eventually("srq-r to close") { await !center.isOpen("srq-r") }
    #expect(model.presentedOutcome == .lapsed)
    #expect(await model.send(SecretValue(typed)) == false)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a resume whose open_requests no longer lists the prompt closes it, without the replay's list")
  func resumeListClosesALapsedPrompt() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-gone")
    let other: JSONValue = [
      "id": "srq-other", "method": "secret", "params": ["session_id": .string(Fixture.runtime), "env_var": "K"]
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

  @Test("a replay that fails leaves the prompt open, to its deadline: no list, no verdict")
  func failedReplayKeepsThePrompt() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-f", "sudo", params: ["command": "ls"])

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
    await h.clock.advance(by: .seconds(119))
    #expect(!h.center.isOpen("srq-f"))
    #expect(h.center.notices[bot]?.notice == .expired)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a reconnect whose answers carry no open_requests says nothing about what is open")
  func noListNoVerdict() async throws {
    let h = SecureHarness()
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

  @Test("a request.cancel the replay carried closes the prompt as a live one would")
  func replayedCancelCloses() async throws {
    let h = SecureHarness()
    try await h.open()
    // A warm chat: its replay applies the events it carries.
    h.link.emit("test.unknown", session: Fixture.runtime, seq: 7)
    try await h.harness.frame()
    #expect(await h.session.store.state(of: bot)?.lastSeq == 7)
    try await h.raiseOpen("srq-c", "vault.code", params: ["site": "example.com"])
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-c")

    let cancel: JSONValue = [
      "type": "request.cancel",
      "session_id": .string(Fixture.runtime),
      "seq": 8,
      "payload": ["id": "srq-c", "method": "vault.code", "reason": "interrupted"]
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
    #expect(await model.send(SecretValue(typed)) == false)
    #expect(h.link.answers.isEmpty)
  }

  // MARK: Helpers

  /// Drop the socket, let the shared clock move on, bring it back, and answer
  /// the recovery's resume and replay.
  private func reconnect(_ h: SecureHarness, resume: JSONValue, since: JSONValue) async throws {
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
