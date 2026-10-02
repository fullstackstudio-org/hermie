#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

private let connectionToken = "integration-connection-token"

extension Integration {
  /// `GatewayConnection` against `packages/fake-gateway`: a real socket from
  /// `URLSessionTransport`, the real clock, and the gateway's own account of
  /// what it saw (`/__fake/state`). The unit tests drive the same state machine
  /// with a scripted gateway; these check it against the one the TypeScript
  /// client is tested against.
  @Suite("GatewayConnection against the fake gateway")
  struct ConnectionIntegrationTests {
    enum Auth: String, CaseIterable, Sendable, CustomTestStringConvertible {
      case none, token, native

      var testDescription: String { rawValue }

      var options: FakeGateway.Options {
        switch self {
        case .none: FakeGateway.Options(auth: .none)
        case .token: FakeGateway.Options(auth: .token, token: connectionToken)
        case .native: FakeGateway.Options(auth: .native)
        }
      }

      /// The credential the app would hold: none, the shared token, or a
      /// signed-in native session (PKCE through the gateway's own pages).
      func credentials(for gateway: FakeGateway) async throws -> any CredentialProvider {
        switch self {
        case .none:
          return SessionTokenCredentials(token: "")
        case .token:
          return SessionTokenCredentials(token: connectionToken)
        case .native:
          let session = try await NativeSession(gateway: gateway)
          try await session.signIn()
          return session.credentials
        }
      }
    }

    /// `profiles.list` → the researcher's Bot Chat → `session.resume`: the
    /// runtime session id the socket names it by.
    private func resumeCanonicalChat(_ live: LiveConnection, omitMessages: Bool = true) async throws
      -> (sessionID: String, reply: RPCReply<JSONValue>)
    {
      let profiles = try await live.connection.request("profiles.list")
      let researcher = profiles["profiles"]?.arrayValue?.first { $0["name"] == "researcher" }
      let stored = try #require(researcher?["canonical_session"]?["id"]?.stringValue)
      let reply = try await live.connection.requestReply(
        "session.resume",
        params: ["session_id": .string(stored), "omit_messages": .bool(omitMessages)]
      )
      return (try #require(reply.result["session_id"]?.stringValue), reply)
    }

    /// One session's events, in the order the consumer received them.
    private func events(of sessionID: String, in live: LiveConnection) -> [WireEvent] {
      live.events.values.filter { $0.event.sessionID == sessionID }
    }

    // MARK: Dial, turn, questions: once per auth mode

    @Test("dials (with a ticket where the mode needs one) and streams a turn in wire order", arguments: Auth.allCases)
    func dialAndTurn(_ auth: Auth) async throws {
      try await FakeGateway.with(auth.options) { gateway in
        let credentials = try await auth.credentials(for: gateway)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.ready)

          let state = try await gateway.state()
          #expect(state.connections == 1)
          #expect(state.ticketsMinted == (auth == .native ? 1 : 0))
          #expect(state.ticketsConsumed == (auth == .native ? 1 : 0))

          let (sessionID, _) = try await resumeCanonicalChat(live)
          let submitted = try await live.connection.requestReply(
            "prompt.submit",
            params: ["session_id": .string(sessionID), "text": "Say hello"]
          )
          try await live.waitForEvent("message.complete") {
            $0.type == "message.complete" && $0.sessionID == sessionID
          }

          let turn = events(of: sessionID, in: live)
          let types = turn.map(\.event.type)
          #expect(types.first == "message.start")
          #expect(types.last == "message.complete")
          #expect(types.contains("message.delta"))

          // The reply came first, then every frame of the turn, each one wire
          // step after the last, and each one seq after the last.
          #expect(submitted.index < (turn.first?.index ?? 0))
          let indices = turn.map(\.index)
          #expect(zip(indices, indices.dropFirst()).allSatisfy { $1 == $0 + 1 }, "\(indices)")
          let seqs = turn.compactMap(\.event.seq)
          #expect(seqs.count == turn.count)
          #expect(zip(seqs, seqs.dropFirst()).allSatisfy { $1 == $0 + 1 }, "\(seqs)")
        }
      }
    }

    @Test("answers an approval that parks a turn, and a clarify, and the gateway carries on", arguments: Auth.allCases)
    func approvalAndClarify(_ auth: Auth) async throws {
      try await FakeGateway.with(auth.options) { gateway in
        let credentials = try await auth.credentials(for: gateway)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          let (sessionID, _) = try await resumeCanonicalChat(live)

          // "approve" parks the turn on an approval until it is answered.
          _ = try await live.connection.request(
            "prompt.submit",
            params: ["session_id": .string(sessionID), "text": "Please approve the cleanup"]
          )
          let approvals = try await live.requests.wait("the approval") { $0.contains { $0.request.method == "approval" } }
          let approval = try #require(approvals.first { $0.request.method == "approval" })
          guard case .approval = approval.body else {
            Issue.record("expected a typed approval, got \(approval.body)")
            return
          }
          #expect(await approval.respond(["choice": "once"]))
          try await live.waitForEvent("the turn to finish once answered") {
            $0.type == "message.complete" && $0.sessionID == sessionID
          }

          // A clarify, raised from outside the process.
          try await gateway.raiseRequest("clarify", params: ["question": "Which branch?", "choices": ["main", "next"]])
          let clarifies = try await live.requests.wait("the clarify") { $0.contains { $0.request.method == "clarify" } }
          let clarify = try #require(clarifies.first { $0.request.method == "clarify" })
          guard case .clarify = clarify.body else {
            Issue.record("expected a typed clarify, got \(clarify.body)")
            return
          }
          #expect(await clarify.respond(["answer": "main"]))

          // A round trip on the same socket: the gateway reads frames in order,
          // so once this is answered it has read the clarify's answer too.
          _ = try await live.connection.request("profiles.list")
          let answers = try await gateway.state().serverRequestAnswers
          #expect(answers.contains { $0["method"] == "approval" && $0["result"] == ["choice": "once"] })
          #expect(answers.contains { $0["method"] == "clarify" && $0["result"] == ["answer": "main"] })
        }
      }
    }

    // MARK: Reconnect and replay

    @Test("redials after a drop mid-turn and replays what it missed exactly once")
    func reconnectAndReplay() async throws {
      // Nothing here races a timer against the stream. The client is kept away
      // (its ladder is half a minute) from the drop until the gateway says the
      // turn is over, and only then told to redial, so everything after the
      // drop can only come back through the replay, however fast or slow the
      // machine. The stream is slowed so the drop lands mid-turn.
      var options = Auth.token.options
      options.streamDelayMs = 25

      try await FakeGateway.with(options) { gateway in
        try await LiveConnection.with(
          gateway,
          credentials: SessionTokenCredentials(token: connectionToken),
          configure: { $0.backoff = { _ in .seconds(30) } }
        ) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          let (sessionID, resumed) = try await resumeCanonicalChat(live)
          let storedID = try #require(resumed.result["stored_session_id"]?.stringValue)

          _ = try await live.connection.request(
            "prompt.submit",
            params: ["session_id": .string(sessionID), "text": "Give me the long version"]
          )
          try await live.waitForEvent("the turn to start") {
            $0.type == "message.start" && $0.sessionID == sessionID
          }

          try await gateway.dropSockets()
          try await live.waitFor(.reconnecting)
          // What the client had when its socket went: frames can still land
          // between seeing message.start and the drop taking effect.
          let before = events(of: sessionID, in: live)
          let lastSeen = try #require(before.compactMap(\.event.seq).max())
          #expect(!before.contains { $0.event.type == "message.complete" })

          try await within(LiveConnection.deadline, "the turn to finish on the gateway") {
            while try await gateway.state().runningSessions.contains(storedID) {
              // The gateway is in another process; asking again is the only
              // way to hear from it. Not a wait for time to pass.
              try await Task.sleep(for: .milliseconds(20))
            }
          }

          await live.connection.retryNow()
          try await live.waitFor(.ready)
          try await live.waitForEvent("the turn's end, through the replay") {
            $0.type == "message.complete" && $0.sessionID == sessionID
          }

          let turn = events(of: sessionID, in: live)
          let seqs = turn.compactMap(\.event.seq)
          #expect(seqs.count == turn.count)
          #expect(Set(seqs).count == seqs.count, "a duplicate: \(seqs)")
          #expect(zip(seqs, seqs.dropFirst()).allSatisfy { $1 == $0 + 1 }, "a gap: \(seqs)")
          #expect(turn.first?.event.type == "message.start")
          #expect(turn.last?.event.type == "message.complete")

          // Everything after what the client had came back as one batch,
          // carrying the wire index of the replay's answer.
          let replayed = turn.filter { ($0.event.seq ?? 0) > lastSeen }
          #expect(replayed.count >= 2)
          #expect(Set(replayed.map(\.index)).count == 1, "\(turn.map(\.index))")
          #expect(replayed.first?.event.seq == lastSeen + 1)

          let state = try await gateway.state()
          #expect(state.connections == 2)
          let replay = try #require(state.eventsSinceCalls.first)
          #expect(replay["session_id"] == .string(sessionID))
          #expect(replay["last_seen"]?.doubleValue == Double(lastSeen))
        }
      }
    }

    @Test("an approval left open across a reconnect is re-delivered, and the copy is the one answered")
    func approvalAcrossAReconnect() async throws {
      try await FakeGateway.with(Auth.token.options) { gateway in
        try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: connectionToken)) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          let (sessionID, _) = try await resumeCanonicalChat(live)

          _ = try await live.connection.request(
            "prompt.submit",
            params: ["session_id": .string(sessionID), "text": "Please approve the cleanup"]
          )
          let live1 = try await live.requests.wait("the approval") { $0.contains { $0.request.method == "approval" } }
          let first = try #require(live1.first { $0.request.method == "approval" })

          try await gateway.dropSockets()
          try await live.waitFor(.reconnecting)
          try await live.waitFor(.ready)

          // The replay after the redial carries the request still open on the
          // gateway, under the same id.
          let all = try await live.requests.wait("the re-delivered approval") { $0.count >= 2 }
          let copy = all[1]
          #expect(copy.replayed)
          #expect(copy.request.id == first.request.id)

          #expect(await first.respond(["choice": "once"]) == false)
          #expect(await copy.respond(["choice": "once"]))
          try await live.waitForEvent("the turn to finish once answered") {
            $0.type == "message.complete" && $0.sessionID == sessionID
          }
        }
      }
    }

    // MARK: Close codes

    @Test("a refused ticket is answered with a fresh one, and no rotation")
    func fourFourOhOneOnce() async throws {
      var options = Auth.native.options
      options.closeCode = 4401

      try await FakeGateway.with(options) { gateway in
        let credentials = try await Auth.native.credentials(for: gateway)
        try await gateway.rejectUpgrades(1)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.ready)

          let state = try await gateway.state()
          #expect(state.rejectedUpgrades == 1)
          #expect(state.ticketsMinted == 2)
          #expect(state.refreshCalls == 0)
          #expect(!live.statuses.values.contains { $0.phase == .needsSignin })
        }
      }
    }

    @Test("a second refusal rotates the credential, and a third asks for a sign-in")
    func fourFourOhOneTwiceAndThrice() async throws {
      var options = Auth.native.options
      options.closeCode = 4401

      try await FakeGateway.with(options) { gateway in
        let credentials = try await Auth.native.credentials(for: gateway)
        try await gateway.rejectUpgrades(2)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.ready)

          let state = try await gateway.state()
          #expect(state.rejectedUpgrades == 2)
          #expect(state.refreshCalls == 1)
        }

        try await gateway.rejectUpgrades(3)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.needsSignin)

          #expect(await live.connection.lastError?.kind == .auth)
          #expect(try await gateway.state().rejectedUpgrades == 5)
        }
      }
    }

    @Test("4403 stops the loop with a configuration error, at the upgrade and on a live socket")
    func fourFourOhThree() async throws {
      var options = Auth.token.options
      options.closeCode = 4403

      try await FakeGateway.with(options) { gateway in
        let credentials = SessionTokenCredentials(token: connectionToken)
        try await gateway.rejectUpgrades(1)

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.disconnected)

          let error = await live.connection.lastError
          #expect(error?.kind == .config)
          #expect(error?.closeCode == 4403)
          #expect(try await gateway.state().connections == 0)
        }

        try await LiveConnection.with(gateway, credentials: credentials) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          try await gateway.dropSockets(code: 4403, reason: "host not allowed")
          try await live.waitFor(.disconnected)

          #expect(await live.connection.lastError?.closeCode == 4403)
          #expect(await live.connection.lastError?.kind == .config)
        }
      }
    }

    // MARK: Heartbeat, frame size, no plugin

    @Test("keeps the heartbeat the gateway advertises, and stays up on its answers")
    func heartbeat() async throws {
      try await FakeGateway.with(Auth.token.options) { gateway in
        try await LiveConnection.with(
          gateway,
          credentials: SessionTokenCredentials(token: connectionToken),
          configure: { options in
            // A deadline forty intervals long: a pause of nearly two seconds
            // between two answers (a slow or loaded runner) is not a dead
            // socket, and forty-five intervals still outlast it, so only the
            // gateway's answers can have kept the socket up.
            options.heartbeatInterval = .milliseconds(50)
            options.heartbeatDeadline = .seconds(2)
          }
        ) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          let firedAtReady = live.clock.fired.values.count

          try await live.clock.fired.wait("forty-five heartbeat intervals") { $0.count >= firedAtReady + 45 }
          #expect(await live.connection.phase == .ready)

          _ = try await live.connection.request("profiles.list")
          let pings = try await gateway.state().methodLog.filter { $0 == "gateway.ping" }.count
          #expect(pings >= 45)
          #expect(!live.statuses.values.contains { $0.phase == .reconnecting })
        }
      }
    }

    @Test("a session.resume larger than 1 MiB arrives intact")
    func largeFrame() async throws {
      var options = Auth.token.options
      options.extraArguments = ["--history-rows", "8000"]

      try await FakeGateway.with(options) { gateway in
        try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: connectionToken)) { live in
          await live.connection.start()
          try await live.waitFor(.ready)

          let (_, reply) = try await resumeCanonicalChat(live, omitMessages: false)
          let messages = reply.result["messages"]?.arrayValue ?? []

          #expect(messages.count >= 8000)
          #expect(reply.result["message_count"]?.intValue == messages.count)
          #expect(try reply.result.canonicalData().count > 1_048_576)
          #expect(await live.connection.phase == .ready)
        }
      }
    }

    @Test("works against a gateway with no Hermie plugin")
    func noPlugin() async throws {
      var options = Auth.token.options
      options.plugin = false

      try await FakeGateway.with(options) { gateway in
        try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: connectionToken)) { live in
          await live.connection.start()
          try await live.waitFor(.ready)

          let profiles = try await live.connection.request("profiles.list")
          #expect(profiles["profiles"]?.arrayValue?.compactMap { $0["name"]?.stringValue } == ["researcher", "writer"])
        }
      }
    }
  }
}
#endif
