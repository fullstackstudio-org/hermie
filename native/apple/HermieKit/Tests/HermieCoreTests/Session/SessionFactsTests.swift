import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

@MainActor
private final class Finished {
  var tasks: [BackgroundTaskFinished] = []
}

private func me(provider: String, userID: String, name: String = "") -> AuthIdentity {
  AuthIdentity(userID: userID, email: "", displayName: name, orgID: "", provider: provider, expiresAt: 0, pictureURL: "")
}

/// Who the session is, what the gateway can do, and what reaches the session's
/// own models beside the transcript.
@Suite(.timeLimit(.minutes(1))) @MainActor struct SessionFactsTests {
  private func started(
    identity: IdentityProbe,
    capabilities: JSONValue? = ["per_session_exclusive_submit": true, "per_message_author": true],
    keyValues: KeyValueStore? = nil
  ) async throws -> SessionHarness {
    let harness = SessionHarness(keyValues: keyValues)
    harness.link.setIdentity(identity)

    if let capabilities {
      harness.link.respond(to: RPC.GatewayCapabilities.name, with: capabilities)
    }

    try await harness.start()
    try await eventually("the identity read") { harness.link.identityReads > 0 }
    try await eventually("the identity") { await harness.session.identityState != .unknownYet }
    return harness
  }

  // MARK: Identity, per auth mode

  @Test func aSessionTokenGatewayTreatsTheClientAsAnonymous() async throws {
    let harness = try await started(identity: .sessionToken)
    let session = harness.session

    #expect(session.identityState == .anonymous(.sessionToken))
    #expect(session.identity == nil)
    #expect(session.ownAuthorID == nil, "nothing is drawn as somebody else's")
    #expect(session.identityFailure == nil)
    await session.shutdown()
  }

  @Test func aSignedInGatewayNamesTheClientAsItStampsRows() async throws {
    let harness = try await started(identity: .answered(me(provider: " self-hosted ", userID: "sam-sub", name: "Sam")))
    let session = harness.session

    let identity = try #require(session.identity)
    #expect(identity.authorID == "self-hosted:sam-sub", "provider first, each half stripped, as the gateway builds it")
    #expect(identity.displayName == "Sam")
    #expect(identity.verified)
    try await eventually("the capabilities") { await session.capabilities != nil }
    #expect(session.rowAuthorsTrusted)
    #expect(session.ownAuthorID == "self-hosted:sam-sub")

    // The optimistic bubble carries the author the row will carry.
    try await harness.open()
    let sending = Task { @MainActor in try await session.store.send(bot, text: "hello") }
    try await harness.link.answerNext(RPC.PromptSubmit.name, ["status": "streaming"])
    _ = try await sending.value
    let bubble = await session.store.state(of: bot)?.orderedItems.compactMap(\.asUser).last
    #expect(bubble?.author?.id == "self-hosted:sam-sub")
    await session.shutdown()
  }

  @Test func aGatewayThatDoesNotStampRowsIsNotTrustedWithAuthors() async throws {
    let harness = try await started(
      identity: .answered(me(provider: "self-hosted", userID: "sam-sub")),
      capabilities: ["per_session_exclusive_submit": true]
    )
    let session = harness.session

    try await eventually("the capabilities") { await session.capabilities != nil }
    #expect(session.identity?.authorID == "self-hosted:sam-sub")
    #expect(session.rowAuthorsTrusted == false)
    #expect(session.ownAuthorID == nil)
    await session.shutdown()
  }

  @Test func anAnswerWithoutAProviderOrAUserIsAnonymousNotInvented() async throws {
    let harness = try await started(identity: .answered(me(provider: "", userID: "someone@example.invalid")))
    #expect(harness.session.identityState == .anonymous(.noAccount))
    #expect(harness.session.identity == nil)
    await harness.session.shutdown()
  }

  @Test func aFailedReadWithNothingKnownIsReportedAndAskedAgainOnTheNextConnect() async throws {
    let harness = try await started(identity: .failed("This gateway was set up with a sign-in this app cannot use."))
    let session = harness.session
    #expect(session.identityState == .failed("This gateway was set up with a sign-in this app cannot use."))

    harness.link.setIdentity(.answered(me(provider: "self-hosted", userID: "sam-sub")))
    harness.link.status(.reconnecting)
    harness.link.status(.ready)
    try await harness.link.answerNext(RPC.ProfilesList.name, SessionHarness.roster)
    try await eventually("the second read") { await session.identity != nil }
    #expect(session.identityFailure == nil)
    await session.shutdown()
  }

  @Test func aFailedReadKeepsTheIdentityTheGatewayGaveBefore() async throws {
    let harness = try await started(identity: .answered(me(provider: "self-hosted", userID: "sam-sub")))
    let session = harness.session

    harness.link.setIdentity(.failed("The gateway answered HTTP 503."))
    await session.refreshIdentity()
    #expect(session.identity?.authorID == "self-hosted:sam-sub")
    #expect(session.identityFailure == "The gateway answered HTTP 503.")

    await session.forgetIdentity()
    #expect(session.identityState == .unknownYet)
    await session.shutdown()
  }

  @Test func theLastIdentityIsShownUntilTheGatewayConfirmsItAndForgottenWhenItSaysNoOne() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let first = try await started(identity: .answered(me(provider: "self-hosted", userID: "sam-sub", name: "Sam")), keyValues: keyValues)
    let key = GatewayNamespace("g1").key(StoreKeys.ownAuthor)
    try await eventually("the identity to be written") { (try? await keyValues.string(forKey: key)) != nil }
    #expect(try await keyValues.value(StoredOwnAuthor.self, forKey: key) == StoredOwnAuthor(id: "self-hosted:sam-sub", name: "Sam"))
    await first.session.shutdown()

    // A cold start shows the remembered one before the socket is even up.
    let second = SessionHarness(keyValues: keyValues)
    second.link.setIdentity(.sessionToken)
    await second.session.start()
    #expect(second.session.identity == GatewayIdentity(authorID: "self-hosted:sam-sub", displayName: "Sam", verified: false))

    second.link.status(.ready)
    try await second.link.answerNext(RPC.ProfilesList.name, SessionHarness.roster)
    try await eventually("the answer") { await second.session.identityState == .anonymous(.sessionToken) }
    try await eventually("the remembered id to go") { (try? await keyValues.string(forKey: key)) == nil }
    await second.session.shutdown()
  }

  // MARK: Signals

  @Test func noticesConnectionCardsProgressAndBackgroundTasksReachTheirModels() async throws {
    let harness = try await started(identity: .sessionToken)
    let session = harness.session
    let model = session.chat(bot)
    let finished = Finished()
    session.onBackgroundTaskFinished = { finished.tasks.append($0) }

    let pending: JSONObject = [
      "op_id": "op-1", "seq": 1, "deadline_at": 1_790_000_300, "timeout_seconds": 300, "tool_call_id": "call-1",
      "targets": [["name": "calendar", "kind": "connector", "action": "authorize", "state": "initiated", "connect_url": "https://auth.example.invalid/x"]]
    ]
    try await harness.open(resume: Fixture.resume(extra: ["pending_connection": .object(pending)]))
    try await eventually("the restored card") { await session.connectionRequests.request(for: bot) != nil }
    #expect(session.connectionRequests.request(for: bot)?.runtimeSessionID == Fixture.runtime)

    harness.link.emit(
      "notification.show",
      session: Fixture.runtime,
      seq: 1,
      payload: ["text": "Still starting the agent", "level": "info", "kind": "agent", "key": "agent.slow"]
    )
    harness.link.emit("session.resume_progress", session: Fixture.runtime, seq: 2, payload: ["phase": "history", "status": "loading"])
    harness.link.emit(
      "connection.update",
      session: Fixture.runtime,
      seq: 3,
      payload: [
        "op_id": "op-1", "seq": 2, "deadline_at": 1_790_000_300, "settled": false,
        "owner": ["type": "session", "session_id": .string(Fixture.runtime)],
        "targets": [["name": "calendar", "kind": "connector", "action": "authorize", "state": "connected"]]
      ]
    )
    harness.link.emit("background.complete", session: Fixture.runtime, seq: 4, payload: ["task_id": "bg-1", "text": "Done."])
    // The connection's own replay can hand the same frame over twice; the chat applied it once.
    harness.link.emit("background.complete", session: Fixture.runtime, seq: 4, payload: ["task_id": "bg-1", "text": "Done."])
    try await harness.frame()

    try await eventually("the notice") { await session.notices.notice("agent.slow") != nil }
    #expect(session.notices.notice("agent.slow")?.chat == bot)
    try await eventually("the progress") { await model.resumeProgress?.status == .loading }
    try await eventually("the card to move") {
      await session.connectionRequests.request(for: bot)?.targets.first?.state == .connected
    }
    try await eventually("the background task") { await finished.tasks.count == 1 }
    #expect(finished.tasks.first == BackgroundTaskFinished(chat: bot, taskID: "bg-1", text: "Done."))

    harness.link.emit("notification.clear", session: Fixture.runtime, seq: 5, payload: ["key": "agent.slow"])
    harness.link.emit(
      "connection.update",
      session: Fixture.runtime,
      seq: 6,
      payload: [
        "op_id": "op-1", "seq": 3, "deadline_at": 1_790_000_300, "settled": true, "settled_by": "all_resolved",
        "owner": ["type": "session", "session_id": .string(Fixture.runtime)], "targets": []
      ]
    )
    try await harness.frame()
    try await eventually("the clear") { await session.notices.notices.isEmpty }
    try await eventually("the settlement") { await session.connectionRequests.request(for: bot) == nil }

    // The transcript engine saw none of it as items.
    #expect(await session.store.state(of: bot)?.lastSeq == 6)
    await session.shutdown()
  }

  @Test func unknownEventsAreCountedForTheDeveloperDetail() async throws {
    let harness = try await started(identity: .sessionToken)
    try await harness.open()
    harness.link.emit("moa.reference", session: Fixture.runtime, seq: 1, payload: ["label": "a", "text": "b"])
    harness.link.emit("moa.reference", session: Fixture.runtime, seq: 2, payload: ["label": "a", "text": "c"])
    harness.link.emit("skin.changed", session: nil, payload: [:])
    harness.link.emit("message.start", session: Fixture.runtime, seq: 3)
    try await harness.frame()

    let counts = await harness.session.unknownEventCounts()
    #expect(counts == ["moa.reference": 2, "skin.changed": 1])
    await harness.session.shutdown()
  }

  @Test func aConnectionLinkOnASessionTokenNeverAsksAndOnACookieItCannotAsk() async throws {
    let token = try ConnectionLink(
      baseURL: "https://gateway.example.invalid",
      credentials: SessionTokenCredentials(token: "t"),
      transport: URLSessionTransport()
    )
    #expect(await token.probeIdentity() == .sessionToken)
    await token.shutdown()

    let cookie = try ConnectionLink(
      baseURL: "https://gateway.example.invalid",
      credentials: SignInRequiredCredentials(storedMode: .cookie),
      transport: URLSessionTransport()
    )
    guard case .failed(let reason) = await cookie.probeIdentity() else {
      Issue.record("a cookie sign-in read an identity")
      return
    }
    #expect(reason.contains("Sign in again"))
    await cookie.shutdown()
  }
}
