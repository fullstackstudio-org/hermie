#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"

@MainActor
private func gapWait(_ what: String, _ condition: @MainActor () async -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

@MainActor
private func makeSession(_ gateway: FakeGateway, credentials: any CredentialProvider) throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(id: "g-gaps", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)

  return try GatewaySession(record: record, credentials: credentials, transport: URLSessionTransport(), options: options)
}

/// `FakeGateway.with`, with a body that runs on the main actor, where the models live.
private func withGapsGateway(
  _ options: FakeGateway.Options,
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

extension Integration {
  /// The session-layer gaps against the real fake gateway, over real sockets.
  @Suite("Session gaps") @MainActor
  struct SessionGapsIntegrationTests {
    @Test("a truncated replay after the app comes back reads the chat again, without doubling anything")
    func truncatedReplay() async throws {
      try await withGapsGateway(FakeGateway.Options(streamDelayMs: 5)) { gateway in
        let session = try makeSession(gateway, credentials: SessionTokenCredentials(token: ""))
        let model = session.chat(researcher)
        await session.start()
        try await gapWait("the socket") { session.status.phase == .ready }
        try await gapWait("the roster") { session.chatList.rows[researcher] != nil }
        try await session.open(researcher)

        // One turn while connected, so the connection holds a watermark for the session.
        try await gapWait("the chat to accept a message") { model.canSend }
        await model.send("summarise the notes")
        try await gapWait("the reply") {
          let state = await session.store.state(of: researcher)
          return state?.turn.active == false && (state?.lastSeq ?? 0) > 0
        }

        // Away: a teammate's turn lands while the socket is closed, and the ring
        // has lost what the replay would have carried.
        await session.enterBackground()
        try await gapWait("the socket to close") { session.status.phase != .ready }
        try await gateway.inject(FakeGateway.Injection(user: "The night shift says all green.", assistant: "Thanks.", stream: true))
        try await gateway.control("POST", "/__fake/truncate-next-replay")
        let before = try await gateway.state().methodLog.filter { $0 == "session.history" }.count

        await session.enterForeground()
        try await gapWait("the re-fetch") {
          let log = (try? await gateway.state().methodLog) ?? []
          return log.filter { $0 == "session.history" }.count > before
        }
        try await gapWait("the chat to be live with the missed turn") {
          let state = await session.store.state(of: researcher)
          let missed = state?.orderedItems.compactMap(\.asUser).contains { $0.text.contains("all green") } ?? false
          return state?.hydration == .live && missed
        }

        let state = try #require(await session.store.state(of: researcher))
        #expect(Set(state.order).count == state.order.count)
        #expect(state.orderedItems.compactMap(\.asUser).filter { $0.text.contains("all green") }.count == 1)
        #expect(state.orderedItems.compactMap(\.asUser).filter { $0.text == "summarise the notes" }.count == 1)
        #expect(try await gateway.state().eventsSinceCalls.isEmpty == false)
        await session.shutdown()
        #expect(await session.hasNoLiveTasks())
      }
    }

    /// HERM-188: the fake's `connection.respond` is as strict as the gateway's
    /// contract (`extra="forbid"`, `owner: ConnectorOwner`), so an answer in any
    /// other shape would be refused and the card would not move.
    @Test("answers a connection card in exactly the shape the gateway's strict contract takes")
    func connectionCardAnswers() async throws {
      try await withGapsGateway(FakeGateway.Options()) { gateway in
        let session = try makeSession(gateway, credentials: SessionTokenCredentials(token: ""))
        let cards = session.connectionRequests
        await session.start()
        try await gapWait("the socket") { session.status.phase == .ready }
        try await gapWait("the roster") { session.chatList.rows[researcher] != nil }
        try await session.open(researcher)
        try await gapWait("the chat to be live") { await session.store.state(of: researcher)?.hydration == .live }

        let runtime = try await gateway.openConnectionRequest(opID: "op-9", targets: ["github", "linear"])
        try await gapWait("the card") { cards.request(for: researcher) != nil }
        #expect(cards.request(for: researcher)?.runtimeSessionID == runtime)

        #expect(await cards.skip(chat: researcher, target: "github"))
        #expect(cards.lastError == nil, "the strict contract took the skip")
        try await gapWait("the skip to come back as connection.update") {
          cards.request(for: researcher)?.targets.first { $0.name == "github" }?.state == .skipped
        }

        #expect(await cards.cancel(chat: researcher))
        #expect(cards.lastError == nil, "the strict contract took the cancel")
        try await gapWait("the card to go once the operation settles") { cards.request(for: researcher) == nil }

        let owner: JSONValue = ["type": "session", "session_id": .string(runtime)]
        let answers = try await gateway.state().connectionResponses
        #expect(
          answers == [
            [
              "profile": .string(researcher), "owner": owner, "op_id": "op-9",
              "result": ["targets": [["name": "github", "status": "skipped"]]],
            ],
            ["profile": .string(researcher), "owner": owner, "op_id": "op-9", "result": ["settled_by": "continue"]],
          ]
        )
        for answer in answers {
          #expect(Set(answer.objectValue?.keys.map { $0 } ?? []) == ["profile", "owner", "op_id", "result"])
          #expect(Set(answer["owner"]?.objectValue?.keys.map { $0 } ?? []) == ["type", "session_id"])
        }
        await session.shutdown()
      }
    }

    @Test("a session-token gateway treats the client as anonymous, and says so")
    func anonymousOnASessionToken() async throws {
      try await withGapsGateway(FakeGateway.Options()) { gateway in
        let session = try makeSession(gateway, credentials: SessionTokenCredentials(token: ""))
        await session.start()
        try await gapWait("the identity") { session.identityState != .unknownYet }

        #expect(session.identityState == .anonymous(.sessionToken))
        #expect(session.ownAuthorID == nil)
        try await gapWait("the capabilities") { session.capabilities != nil }
        await session.shutdown()
      }
    }

    @Test("a signed-in gateway names the client in the spelling its rows carry")
    func identityOnANativeSignIn() async throws {
      try await withGapsGateway(FakeGateway.Options(auth: .native)) { gateway in
        let signIn = try await NativeSession(gateway: gateway)
        let tokens = try await signIn.signIn()
        let session = try makeSession(gateway, credentials: signIn.credentials)
        await session.start()
        try await gapWait("the identity") { session.identity != nil }

        let identity = try #require(session.identity)
        #expect(identity.authorID == "\(tokens.provider):\(tokens.userID)")
        #expect(identity.verified)
        await session.shutdown()
      }
    }
  }
}
#endif
