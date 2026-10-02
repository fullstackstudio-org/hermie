import Foundation
import HermieProtocol
import Synchronization
import Testing

@testable import HermieGateway

// The port of `packages/gateway-client/src/connection.test.ts`, one test per
// case and under the same name. The TypeScript runs against the fake gateway
// on real timers; these run against `FakeGateway` on `TestClock`, so where the
// reference waits a few real milliseconds for a timer, these advance the clock.

@Suite("GatewayConnection against the fake gateway")
struct GatewayConnectionTests {
  @Test("dials, waits for gateway.ready and answers the heartbeat")
  func dialsAndAnswersTheHeartbeat() async throws {
    try await withHarness(HarnessOptions(auth: .token, heartbeatInterval: .milliseconds(25))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      #expect(h.phases == [.disconnected, .authenticating, .connecting, .ready])
      #expect(await h.connection.replayEpoch == h.gateway.replayEpoch)
      #expect(await h.connection.lastReadyAt != nil)

      await h.clock.advance(by: .milliseconds(120))
      // The channel announces itself once per connection generation, and then
      // keeps the socket honest with `gateway.ping`.
      try await eventually("a ping") { h.gateway.methodLog.contains("gateway.ping") }
      #expect(h.gateway.methodLog.contains("client.capabilities"))
      #expect(await h.connection.phase == .ready)

      var params = ProfilesListParams()
      params.includeSessions = true
      let profiles = try await h.connection.request(RPC.ProfilesList.self, params)
      #expect(profiles.profiles?.map(\.name) == ["researcher", "writer"])
    }
  }

  @Test("mints one ticket per dial and never reuses one")
  func mintsOneTicketPerDial() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)
      #expect(h.gateway.with { $0.ticketsMinted } == 1)
      #expect(h.gateway.with { $0.ticketsConsumed } == 1)

      await h.connection.pause()
      try await h.waitFor(.paused)
      await h.connection.resume()
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.ticketsMinted } == 2)
      #expect(h.gateway.with { $0.ticketsConsumed } == 2)
      #expect(h.gateway.connections == 2)
    }
  }

  /// A 4401 is the gateway refusing the TICKET; upstream verifies no access
  /// token on the upgrade path. A fresh ticket fixes all three real causes
  /// (expired, consumed, unknown) for one round trip, and spends no rotation.
  @Test("answers a 4401 with a fresh ticket, not a token rotation")
  func answersA4401WithAFreshTicket() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 1 }

      await h.connection.start()
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.rejectedUpgrades } == 1)
      #expect(h.gateway.with { $0.ticketsMinted } == 2)
      #expect(h.gateway.with { $0.refreshCalls } == 0)
      #expect(!h.phases.contains(.needsSignin))
    }
  }

  /// A second refusal of a ticket minted seconds earlier is no longer a ticket
  /// story, so the credential the mint authenticated with becomes the suspect.
  @Test("escalates to a rotation only when a freshly minted ticket is refused too")
  func escalatesToARotation() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.rejectedUpgrades } == 2)
      #expect(h.gateway.with { $0.refreshCalls } == 1)
      #expect(await h.connection.phase == .ready)
    }
  }

  @Test("stops at needs_signin once a rotated credential is refused as well")
  func stopsAtNeedsSignin() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 3 }

      await h.connection.start()
      try await h.waitFor(.needsSignin)

      #expect(await h.connection.lastError?.kind == .auth)
      #expect(h.gateway.with { $0.rejectedUpgrades } == 3)
      #expect(h.gateway.with { $0.refreshCalls } == 1)

      // Terminal: no further dials.
      await h.clock.advance(by: .milliseconds(150))
      await h.settle()
      #expect(h.gateway.with { $0.rejectedUpgrades } == 3)
      #expect(await h.connection.phase == .needsSignin)
    }
  }

  /// The tally is called "consecutive" and has to mean it: two auth failures
  /// with an ordinary outage between them are not "twice in a row".
  @Test("does not count auth failures either side of an outage as consecutive")
  func authFailuresAcrossAnOutageAreNotConsecutive() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 2 }
      await h.connection.start()
      try await h.waitFor(.ready)
      #expect(h.gateway.with { $0.refreshCalls } == 1)

      h.gateway.with { state in
        state.failNextTicketMints = 1
        state.rejectNextUpgrades = 2
      }
      h.gateway.dropSockets()

      try await h.advanceUntil("the mint to fail") { h.gateway.with { $0.ticketMintsFailed } == 1 }
      try await h.advanceUntil("the connection to come back") {
        let phase = await h.connection.phase
        return h.gateway.connections == 2 && phase == .ready
      }
      try await h.waitFor(.ready)

      #expect(!h.phases.contains(.needsSignin))
    }
  }

  /// Rotation is destructive at the identity provider, so a spent refresh token
  /// must never go out twice.
  @Test("never presents a refresh token it has already rotated away")
  func neverReplaysARotatedRefreshToken() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 2 }
      await h.connection.start()
      try await h.waitFor(.ready)

      h.gateway.with { $0.rejectNextUpgrades = 2 }
      h.gateway.dropSockets()
      try await h.advanceUntil("a second rotation") { h.gateway.with { $0.refreshCalls } == 2 }
      try await h.advanceUntil("the connection to come back") {
        let phase = await h.connection.phase
        return h.gateway.connections == 2 && phase == .ready
      }
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.refreshReuseAttempts } == 0)
    }
  }

  @Test("treats a 4403 as a configuration problem and does not loop")
  func treatsA4403AsConfiguration() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)
      #expect(h.gateway.connections == 1)

      h.gateway.closeSockets(code: 4403, reason: "host not allowed")
      try await h.waitFor(.disconnected)

      let error = await h.connection.lastError
      #expect(error?.kind == .config)
      #expect(error?.closeCode == 4403)
      #expect(error?.message.contains("dashboard.public_url") == true)

      await h.clock.advance(by: .milliseconds(200))
      await h.settle()
      #expect(h.gateway.connections == 1)
      #expect(await h.connection.phase == .disconnected)
    }
  }

  @Test("reconnects after an abrupt drop and replays the events it missed")
  func reconnectsAndReplays() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      var params = ProfilesListParams()
      params.includeSessions = true
      let profiles = try await h.connection.request(RPC.ProfilesList.self, params)
      let sessionID = try #require(profiles.profiles?.first?.canonicalSession?.json["id"]?.stringValue)

      _ = try await h.connection.request(RPC.SessionResume.self, SessionResumeParams(sessionID: sessionID))

      let complete = firstEvent(of: "message.complete", on: h.connection)
      _ = try await h.connection.request(RPC.PromptSubmit.self, PromptSubmitParams(sessionID: sessionID, text: "hello"))
      #expect(await complete.value != nil)

      // The gateway goes away without a close frame; the client sees 1006.
      h.gateway.dropSockets()
      try await h.waitFor(.reconnecting)
      try await h.advanceUntil(phase: .ready)

      #expect(h.phases.filter { $0 == .ready }.count == 2)
      #expect(h.gateway.connections == 2)

      try await eventually("the replay request") { !h.gateway.with { $0.eventsSinceCalls }.isEmpty }
      #expect((h.gateway.with { $0.eventsSinceCalls.first?.lastSeen } ?? 0) > 0)
    }
  }

  @Test(
    "runs a single refresh for two concurrent 401s",
    .disabled("REST through GatewayHttp and the token coordinator; not part of the connection actor")
  )
  func runsASingleRefreshForTwoConcurrent401s() async throws {}

  @Test("pauses without reconnecting and resumes immediately")
  func pausesAndResumes() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.pause()
      try await h.waitFor(.paused)
      await h.clock.advance(by: .milliseconds(150))
      await h.settle()

      #expect(h.gateway.connections == 1)
      #expect(!h.phases.contains(.reconnecting))

      await h.connection.resume()
      try await h.waitFor(.ready)
      #expect(h.gateway.connections == 2)
    }
  }

  @Test("says offline when the device does, and keeps dialling anyway")
  func saysOfflineAndKeepsDialling() async throws {
    try await withHarness(HarnessOptions(auth: .token, offlineGrace: .milliseconds(10))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      // The report is wrong (this gateway is reachable), which is the whole
      // reason it is not allowed to stop the loop.
      await h.connection.setOnline(false)
      try await h.advanceUntil("the socket to be rebuilt") { h.gateway.connections == 2 }
      try await h.advanceUntil(phase: .ready)

      // Said out loud on the way past, so a reader is told which of the two it is.
      #expect(h.phases.contains(.offline))
    }
  }

  /// A tailnet interface goes away, the connectivity API reports "no network",
  /// and then never reports anything again. Every dial here would succeed.
  @Test("recovers from a connectivity report that never comes back")
  func recoversFromAReportThatNeverComesBack() async throws {
    try await withHarness(HarnessOptions(auth: .token, offlineGrace: .milliseconds(10))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let socketsBefore = h.gateway.connections
      await h.connection.setOnline(false)

      try await h.advanceUntil("a dial the report was supposed to have stopped") {
        h.gateway.connections > socketsBefore
      }
      try await h.advanceUntil(phase: .ready)

      let profiles = try await h.connection.request("profiles.list")
      #expect(profiles["profiles"] != nil)
    }
  }

  /// Offline arrives while the socket is live, so the grace starts; the socket
  /// then dies for real, and online arrives inside the grace. The connection
  /// must not sit on `ready` over a dead socket.
  @Test("redials when the socket dies inside the offline grace and the report flaps back")
  func redialsWhenTheSocketDiesInsideTheGrace() async throws {
    try await withHarness(HarnessOptions(auth: .token, offlineGrace: .milliseconds(400))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.setOnline(false)
      await h.clock.advance(by: .milliseconds(20))
      h.gateway.dropSockets()
      try await h.waitFor(.offline)
      await h.clock.advance(by: .milliseconds(60))
      await h.connection.setOnline(true)

      try await h.advanceUntil("the redial") { h.gateway.connections > 1 }
      try await h.advanceUntil(phase: .ready)
      // A round trip is what the dead socket actually costs, not the status.
      let profiles = try await h.connection.request("profiles.list")
      #expect(profiles["profiles"] != nil)
    }
  }

  @Test("retryNow() skips the pending backoff, and leaves a stopped connection stopped")
  func retryNowSkipsTheBackoff() async throws {
    let delays = Recorded<Int>()
    let options = HarnessOptions(
      auth: .token,
      backoff: { attempt in
        delays.append(attempt)
        return .seconds(30)
      }
    )

    try await withHarness(options) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      h.gateway.shutDown()
      try await h.waitFor(.reconnecting)
      #expect(delays.values.count == 1)

      // Half a minute of backoff is pending; "Try now" must not wait it out.
      h.gateway.restart()
      await h.connection.retryNow()
      try await h.waitFor(.ready)

      await h.connection.stop()
      await h.connection.retryNow()
      await h.settle()
      #expect(await h.connection.phase == .disconnected)
    }
  }

  @Test("keeps a terminal status when the app goes to the background")
  func keepsATerminalStatusOnPause() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      // A fresh ticket for the first refusal, a rotation for the second, and the
      // third concludes the credential is genuinely not accepted.
      h.gateway.with { $0.rejectNextUpgrades = 3 }

      await h.connection.start()
      try await h.waitFor(.needsSignin)

      await h.connection.pause()
      await h.settle()

      #expect(await h.connection.phase == .needsSignin)
      #expect(await h.connection.lastError?.kind == .auth)
    }
  }

  @Test("gives a new credential a full attempt after a resume")
  func givesANewCredentialAFullAttempt() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      // One rejection, absorbed by a fresh ticket. The tally it left behind must
      // not outlive the sign-in that follows.
      h.gateway.with { $0.rejectNextUpgrades = 1 }
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.resume()
      h.gateway.with { $0.rejectNextUpgrades = 1 }
      h.gateway.dropSockets()
      try await h.advanceUntil("the connection to come back") {
        let phase = await h.connection.phase
        return h.gateway.connections == 2 && phase == .ready
      }
      try await h.waitFor(.ready)

      #expect(await h.connection.phase == .ready)
    }
  }

  @Test("answers a server-to-client approval request")
  func answersAnApprovalRequest() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let seen = Recorded<String>()
      let requests = h.connection.serverRequests
      let answering = Task {
        for await delivery in requests {
          seen.append(delivery.request.method ?? "")
          await delivery.respond(["choice": "once"])
          return
        }
      }

      let answer = try await h.gateway.requestApproval([
        "session_id": "stored-researcher",
        "request_id": "ap-1",
        "command": "rm -rf build",
        "description": "Remove the build directory",
        "choices": ["once", "session", "always", "deny"]
      ])

      await answering.value
      #expect(seen.values == ["approval"])
      #expect(answer == ["choice": "once"])
    }
  }

  @Test("declines a server request nobody handles, so the backend is not left waiting")
  func declinesAnUnhandledServerRequest() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await #expect {
        _ = try await h.gateway.requestApproval(["session_id": "s", "request_id": "ap-2"])
      } throws: { error in
        String(describing: error).contains("-32601")
      }
    }
  }

  @Test("delivers a pushed gateway event to a typed subscriber")
  func deliversAPushedEvent() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let changed = firstEvent(of: "sessions.changed", on: h.connection)
      h.gateway.emit("sessions.changed")

      let event = await changed.value
      guard case .sessionsChanged? = event?.body else {
        Issue.record("expected a typed sessions.changed, got \(String(describing: event))")
        return
      }
    }
  }

  @Test("lets a caller shorten the prompt.submit timeout")
  func letsACallerShortenThePromptTimeout() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      var params = ProfilesListParams()
      params.includeSessions = true
      let profiles = try await h.connection.request(RPC.ProfilesList.self, params)
      let sessionID = try #require(profiles.profiles?.first?.canonicalSession?.json["id"]?.stringValue)

      h.gateway.with { _ = $0.hangMethods.insert("prompt.submit") }

      let call = Task {
        try await h.connection.request(
          RPC.PromptSubmit.self,
          PromptSubmitParams(sessionID: sessionID, text: "hello"),
          timeout: .milliseconds(80)
        )
      }

      try await eventually("the prompt to be sent") { h.gateway.methodLog.contains("prompt.submit") }

      // The default for this method is half an hour; 80 ms of clock is all it gets.
      await h.clock.advance(by: .milliseconds(80))

      await #expect {
        _ = try await call.value
      } throws: { error in
        (error as? GatewayRPCError)?.kind == .timeout
          && (error as? GatewayRPCError)?.message.contains("timed out") == true
      }
    }
  }
}

@Suite("the offline grace period")
struct OfflineGraceTests {
  @Test("rides out a NetInfo flap without rebuilding anything")
  func ridesOutAFlap() async throws {
    try await withHarness(HarnessOptions(auth: .token, offlineGrace: .milliseconds(200))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)
      #expect(h.gateway.connections == 1)

      // A Wi-Fi/cellular handover: offline and back inside the grace.
      await h.connection.setOnline(false)
      await h.connection.setOnline(true)
      await h.clock.advance(by: .milliseconds(300))
      await h.settle()

      // The socket never came down: no ticket to mint, no session to rebuild,
      // and the user never saw the connection blink.
      #expect(await h.connection.phase == .ready)
      #expect(h.gateway.connections == 1)
      #expect(!h.phases.contains(.offline))
    }
  }

  @Test("tears the socket down once the gap outlasts the grace")
  func tearsDownAfterTheGrace() async throws {
    try await withHarness(HarnessOptions(auth: .token, offlineGrace: .milliseconds(20))) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.setOnline(false)
      try await h.advanceUntil(phase: .offline)
      #expect(h.gateway.connections == 1)

      await h.connection.setOnline(true)
      try await h.advanceUntil(phase: .ready)
      #expect(h.gateway.connections == 2)
    }
  }

  @Test("waits the full grace before giving up on a live socket")
  func waitsTheFullGrace() async throws {
    try await withHarness(
      HarnessOptions(auth: .token, offlineGrace: .milliseconds(GatewayTimeouts.offlineGraceMs))
    ) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.setOnline(false)
      await h.clock.advance(by: .milliseconds(GatewayTimeouts.offlineGraceMs - 1))

      #expect(await h.connection.phase == .ready)

      await h.clock.advance(by: .milliseconds(2))

      #expect(await h.connection.phase == .offline)
    }
  }

  @Test("keeps the backoff it had earned when the gateway itself is unreachable")
  func keepsTheEarnedBackoff() async throws {
    let attempts = Recorded<Int>()
    let options = HarnessOptions(
      auth: .token,
      offlineGrace: .milliseconds(5),
      backoff: { attempt in
        attempts.append(attempt)
        return .milliseconds(30)
      }
    )

    try await withHarness(options) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      // The gateway is gone, so the ladder climbs: this is not a radio problem.
      h.gateway.shutDown()
      try await h.waitFor(.reconnecting)
      try await h.advanceUntil("the ladder to climb") { attempts.values.count > 1 }

      await h.connection.setOnline(false)
      try await h.waitFor(.offline)

      let mark = attempts.values.count
      await h.connection.setOnline(true)
      try await h.advanceUntil("the next rung") { attempts.values.count > mark }

      // Starting from zero again would hammer an unreachable gateway once per
      // flap, which is exactly what the ladder exists to prevent.
      #expect(attempts.values[mark] > 0)
    }
  }
}

/// How far up the ladder a failure starts, and how far down a wait may fall.
/// No gateway or socket is needed: a credential provider that throws is the
/// whole of the dial.
@Suite("the reconnect ladder")
struct ReconnectLadderTests {
  private func firstRung(_ error: GatewayError) async throws -> Int {
    let rungs = Recorded<Int>()
    var options = GatewayConnection.Options()
    // Long enough that the timer never fires: what is under test is which rung
    // was asked for, not the waiting.
    options.backoff = { attempt in
      rungs.append(attempt)
      return .seconds(60)
    }

    let connection = try GatewayConnection(
      baseURL: "http://gateway.invalid",
      credentials: FailingCredentials(error: error),
      transport: FakeGateway(auth: .none),
      clock: TestClock(),
      options: options
    )

    await connection.start()
    try await eventually("a rung") { !rungs.values.isEmpty }
    await connection.stop()

    return rungs.values[0]
  }

  @Test("starts an answer that is not a gateway part-way up, because a 405 will not change in 300 ms")
  func startsAProtocolFailurePartWayUp() async throws {
    let rung = try await firstRung(
      GatewayError(.protocol, "The address answered HTTP 405, but not as a Hermes gateway.")
    )
    #expect(rung == ReconnectBackoff.protocolLadderFloor)
  }

  @Test("keeps the fast first retries for a failure to reach anything at all")
  func keepsTheFastRetriesForANetworkFailure() async throws {
    #expect(try await firstRung(GatewayError(.network, "Could not reach the gateway.")) == 0)
  }

  @Test("never waits anywhere near zero, whatever the jitter draws")
  func neverWaitsNearZero() {
    for attempt in 0..<8 {
      let ceiling = min(ReconnectBackoff.capMs, 300 * pow(2, Double(attempt)))

      for _ in 0..<200 {
        let delay = GatewayConnection.defaultBackoffDelay(attempt: attempt) { Double.random(in: 0..<1) }.milliseconds
        #expect(delay >= ceiling / 2)
        #expect(delay <= ceiling)
      }
    }
  }

  @Test("still spreads the draws out, so a fleet does not redial in lockstep")
  func stillSpreadsTheDraws() {
    let draws = Set(
      (0..<200).map { _ in GatewayConnection.defaultBackoffDelay(attempt: 5) { Double.random(in: 0..<1) } }
    )
    #expect(draws.count > 100)
  }
}

@Suite("rpcTimeoutMs")
struct RPCTimeoutTests {
  private func timeout(_ method: String, firstSessionCallDone: Bool) -> Int {
    GatewayTimeouts.rpcTimeoutMs(method: method, firstSessionCallDone: firstSessionCallDone)
  }

  @Test("gives a prompt half an hour")
  func givesAPromptHalfAnHour() {
    #expect(timeout("prompt.submit", firstSessionCallDone: true) == GatewayTimeouts.promptSubmitMs)
  }

  @Test("gives the first session call after a connect a minute, and later ones the default")
  func givesTheFirstSessionCallAMinute() {
    #expect(timeout("session.resume", firstSessionCallDone: false) == GatewayTimeouts.firstSessionMs)
    #expect(timeout("session.create", firstSessionCallDone: false) == GatewayTimeouts.firstSessionMs)
    #expect(timeout("session.resume", firstSessionCallDone: true) == GatewayTimeouts.defaultRPCMs)
  }

  @Test("gives everything else thirty seconds")
  func givesEverythingElseThirtySeconds() {
    #expect(timeout("profiles.list", firstSessionCallDone: false) == GatewayTimeouts.defaultRPCMs)
  }
}

/// A gateway on a tailnet is reached over `http://` and `ws://`; nothing in the
/// flow may upgrade a scheme behind the caller's back.
@Suite("a gateway served in the clear")
struct CleartextTests {
  @Test("signs in with PKCE and dials over http/ws, forcing no scheme anywhere")
  func dialsOverHTTPAndWS() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      #expect(testBaseURL.hasPrefix("http://"))
      #expect(try GatewayAddress.webSocketURL(for: testBaseURL).hasPrefix("ws://"))
      #expect(
        try PKCE.authorizeURL(baseURL: testBaseURL, params: AuthorizeParams(challenge: "c", state: "s"))
          .hasPrefix("http://")
      )
      // The redirect the web view intercepts is loopback http by RFC 8252.
      #expect(PKCE.redirectURI.hasPrefix("http://127.0.0.1"))

      await h.connection.start()
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.ticketsConsumed } == 1)
      #expect(h.gateway.with { $0.dials.first?.url }?.hasPrefix("ws://") == true)

      var params = ProfilesListParams()
      params.includeSessions = true
      let profiles = try await h.connection.request(RPC.ProfilesList.self, params)
      #expect(profiles.profiles?.map(\.name) == ["researcher", "writer"])
    }
  }

  @Test("refreshes its tokens over http as well")
  func refreshesOverHTTP() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      // Two refusals in a row: one is a stale ticket and only re-mints.
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await h.waitFor(.ready)

      #expect(h.gateway.with { $0.refreshCalls } == 1)
    }
  }
}

@Suite("assertDesktopContract")
struct DesktopContractTests {
  @Test("accepts contract 7 and above, as a number or a string")
  func acceptsSevenAndAbove() throws {
    #expect(try DesktopContract.check(.init(desktopContract: .number(7))) == 7)
    #expect(try DesktopContract.check(.init(desktopContract: .string("9"))) == 9)
  }

  @Test("refuses an older contract")
  func refusesAnOlderContract() {
    #expect { try DesktopContract.check(.init(desktopContract: .number(6))) } throws: { error in
      (error as? GatewayError)?.message.contains("needs at least 7") == true
    }
  }

  @Test("refuses a gateway that reports no contract at all")
  func refusesNoContract() {
    for info: DesktopContract.Info? in [.init(), nil] {
      #expect { try DesktopContract.check(info) } throws: { error in
        (error as? GatewayError)?.message.contains("does not report a desktop contract") == true
      }
    }
  }

  @Test("lets a lazy resume through on the contract this gateway reported before")
  func letsALazyResumeThroughOnTheKnownContract() throws {
    #expect(try DesktopContract.check(.init(lazy: true), known: 7) == 7)
    #expect(try DesktopContract.check(.init(lazy: true), known: 9) == 9)
  }

  @Test("lets a lazy resume through on trust when nothing is known yet")
  func letsALazyResumeThroughOnTrust() throws {
    #expect(try DesktopContract.check(.init(lazy: true)) == nil)
    #expect(try DesktopContract.check(.init(lazy: true), known: nil) == nil)
  }

  @Test("still refuses a lazy resume when the contract seen before was too old")
  func refusesALazyResumeOnAnOldKnownContract() {
    #expect { try DesktopContract.check(.init(lazy: true), known: 6) } throws: { error in
      (error as? GatewayError)?.message.contains("needs at least 7") == true
    }
  }

  @Test("does not let `lazy` excuse a resume that carries an old contract")
  func lazyDoesNotExcuseAnOldContract() {
    #expect { try DesktopContract.check(.init(desktopContract: .number(5), lazy: true), known: 7) } throws: { error in
      (error as? GatewayError)?.message.contains("desktop contract 5") == true
    }
  }
}

/// A thread-safe list a test and a closure the connection calls can both use.
final class Recorded<Element: Sendable>: Sendable {
  private let storage = Mutex([Element]())

  func append(_ element: Element) {
    storage.withLock { $0.append(element) }
  }

  var values: [Element] { storage.withLock { $0 } }
}
