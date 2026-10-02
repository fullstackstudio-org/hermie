import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// Behaviour of the connection the TypeScript suite leaves to real sockets or
// does not exercise: the two dial timeouts, the other close codes, the
// `reauth` verdict, the auth timeline, the streams, and that nothing outlives
// `stop()`.

@Suite("the connection's lifecycle")
struct LifecycleTests {
  @Test("a socket that opens but never sends gateway.ready fails the dial after the ready timeout")
  func readyTimeout() async throws {
    try await withHarness { h in
      h.gateway.with { $0.silent = true }
      await h.connection.start()
      try await h.waitFor(.connecting)
      // Open on the actor's side, not only the fake's: the connect timeout falls
      // due at the same moment, and a socket the actor has not seen open yet
      // would fail that way instead.
      try await eventually("the socket to open") { (await h.connection.clientState) == .open }

      await h.clock.advance(by: .milliseconds(1999))
      #expect(await h.connection.phase == .connecting)

      await h.clock.advance(by: .milliseconds(1))
      try await h.waitFor(.reconnecting)

      let error = await h.connection.lastError
      #expect(error?.kind == .timeout)
      #expect(error?.message == "The gateway accepted the socket but sent no gateway.ready within 2 seconds.")
    }
  }

  @Test("an upgrade that never completes fails the dial after the connect timeout, and the dial is cancelled")
  func connectTimeout() async throws {
    try await withHarness { h in
      h.gateway.with { $0.hangConnect = true }
      await h.connection.start()
      try await h.waitFor(.connecting)
      try await eventually("the dial to reach the transport") { h.gateway.with { $0.dials.count } == 1 }

      await h.clock.advance(by: .milliseconds(2000))
      try await h.waitFor(.reconnecting)

      let error = await h.connection.lastError
      #expect(error == GatewayError(.network, "WebSocket connection failed"))

      // The transport's connect was cancelled rather than left hanging.
      h.gateway.with { $0.hangConnect = false }
      await h.connection.stop()
      try await eventually("every task to finish") { await h.connection.liveTaskCount == 0 }
    }
  }

  @Test("a redirect on the upgrade fails the dial as a redirect, and nothing else is dialled")
  func upgradeRedirect() async throws {
    try await withHarness { h in
      let redirect = GatewayError(
        .redirect,
        "gateway.test redirected to elsewhere.test, which is a different host. "
          + "Nothing was read from it. Change the gateway address to the one you meant.",
        status: 301,
        redirectedTo: "elsewhere.test",
        redirectedOrigin: "ws://elsewhere.test"
      )
      h.gateway.with { $0.redirectUpgrade = redirect }

      await h.connection.start()
      try await h.waitFor(.reconnecting)

      #expect(await h.connection.lastError == redirect)
      #expect(h.gateway.with { $0.dials.map { URL(string: $0.url)?.host } } == ["gateway.test"])
    }
  }

  @Test("retryNow on a live connection leaves the socket alone")
  func retryNowWhileLive() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      await h.connection.retryNow()
      await h.settle()
      // Past the ready timeout a second dial would have waited out.
      await h.clock.advance(by: .seconds(3))
      await h.settle()

      #expect(await h.connection.phase == .ready)
      #expect(h.gateway.connections == 1)
      #expect(h.credentials.dialPlans == 1)
      #expect(h.phases == [.disconnected, .authenticating, .connecting, .ready])
    }
  }

  @Test("retryNow while a dial is in flight does not start a second one")
  func retryNowWhileDialling() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      await h.connection.start()
      await h.connection.retryNow()
      try await h.waitFor(.ready)
      await h.settle()

      #expect(h.credentials.dialPlans == 1)
      #expect(h.gateway.with { $0.ticketsMinted } == 1)
      #expect(h.gateway.connections == 1)
    }
  }

  @Test("4404 and 4408 stop the loop with their own sentence")
  func otherConfigCloseCodes() async throws {
    for (code, message) in [
      (4404, "Chat is switched off on this gateway."),
      (4408, "Another client took this connection over. Reopen Hermie to reclaim it.")
    ] {
      try await withHarness { h in
        await h.connection.start()
        try await h.waitFor(.ready)

        h.gateway.closeSockets(code: code)
        try await h.waitFor(.disconnected)

        #expect(await h.connection.lastError == GatewayError(.config, message, closeCode: code))
        #expect(h.clock.pendingCount == 0)
      }
    }
  }

  @Test("a provider with nothing left to offer ends at needs_signin, attributed in the timeline")
  func reauthVerdict() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      // A fresh dial for the first refusal; the second asks the provider, and a
      // session token has nothing to rotate.
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await h.waitFor(.needsSignin)

      #expect(await h.connection.lastError == GatewayError(.auth, "Your session has expired. Sign in again."))
      #expect(h.credentials.rejections == 1)
      #expect(h.timeline.signOutReason == .refreshRejected)
      #expect(h.clock.pendingCount == 0)
    }
  }

  @Test("the dial loop writes its account to the auth timeline, and nothing secret")
  func recordsTheAuthTimeline() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 3 }

      await h.connection.start()
      try await h.waitFor(.needsSignin)

      let events = h.timeline.snapshot().entries.map(\.event)
      #expect(
        events.map(\.event) == [
          .dialStart, .wsClosed, .dialStart, .wsClosed, .dialStart, .wsClosed, .signinRequired
        ]
      )
      #expect(events.filter { $0.event == .wsClosed }.allSatisfy { $0.closeCode == 4401 })
      #expect(h.timeline.signOutReason == .rejectedAfterRefresh)

      let error = try #require(await h.connection.lastError)
      #expect(error.message == "The gateway rejected the credentials twice in a row. Sign in again.")
      #expect(error.closeCode == 4401)
      #expect(!error.message.contains("tk-"))
    }
  }

  @Test("stop leaves no running task and no pending timer")
  func stopLeavesNothingRunning() async throws {
    try await withHarness(HarnessOptions(auth: .token, heartbeatInterval: .milliseconds(100))) { h in
      h.gateway.with { _ = $0.hangMethods.insert("b.wait") }
      await h.connection.start()
      try await h.waitFor(.ready)

      let waiting = Task { try await h.connection.request("b.wait") }
      try await eventually("the call on the wire") { h.gateway.methodLog.contains("b.wait") }
      #expect(h.clock.pendingCount > 0)

      await h.connection.stop()

      await #expect(throws: GatewayRPCError.self) { _ = try await waiting.value }
      try await eventually("every task to finish") { await h.connection.liveTaskCount == 0 }
      #expect(h.clock.pendingCount == 0)
      #expect(h.gateway.with { $0.sockets.isEmpty })
    }
  }

  @Test("stop in the middle of a dial cancels it and leaves nothing running")
  func stopDuringADial() async throws {
    try await withHarness { h in
      h.gateway.with { $0.hangConnect = true }
      await h.connection.start()
      try await eventually("the dial to reach the transport") { h.gateway.with { $0.dials.count } == 1 }

      await h.connection.stop()

      try await eventually("every task to finish") { await h.connection.liveTaskCount == 0 }
      #expect(h.clock.pendingCount == 0)
      #expect(await h.connection.phase == .disconnected)
      try await h.waitFor(.disconnected)
    }
  }

  @Test("a new status subscriber starts with the current status")
  func statusesStartWithTheCurrentOne() async throws {
    try await withHarness { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      var iterator = h.connection.statuses.makeAsyncIterator()
      #expect(await iterator.next() == ConnectionStatus(.ready))
    }
  }

  @Test("a call before the socket is open fails as not connected")
  func callsBeforeTheSocketOpens() async throws {
    try await withHarness { h in
      await #expect {
        _ = try await h.connection.request("profiles.list")
      } throws: { error in
        (error as? GatewayRPCError) == GatewayRPCError(.notConnected, "gateway not connected")
      }
    }
  }

  @Test("a typed call whose result has another shape fails instead of inventing one")
  func typedResultOfAnotherShape() async throws {
    try await withHarness { h in
      h.gateway.with { $0.scriptedResults["profiles.list"] = 5 }
      await h.connection.start()
      try await h.waitFor(.ready)

      await #expect {
        _ = try await h.connection.request(RPC.ProfilesList.self, ProfilesListParams())
      } throws: { error in
        (error as? GatewayRPCError)?.kind == .unexpectedResult
      }
    }
  }

  @Test("cancelling the calling task abandons the call and its timer")
  func cancellingACall() async throws {
    try await withHarness { h in
      h.gateway.with { _ = $0.hangMethods.insert("b.wait") }
      await h.connection.start()
      try await h.waitFor(.ready)
      // Once `client.capabilities` is answered, no timer is pending at all.
      try await eventually("the announcement answered") { h.clock.pendingCount == 0 }
      let timersBefore = h.clock.pendingCount

      let waiting = Task { try await h.connection.request("b.wait") }
      try await eventually("the call on the wire") { h.gateway.methodLog.contains("b.wait") }
      #expect(h.clock.pendingCount == timersBefore + 1)

      waiting.cancel()
      await #expect(throws: CancellationError.self) { _ = try await waiting.value }
      try await eventually("the call's timer to go") { h.clock.pendingCount == timersBefore }
    }
  }

  @Test("the first answer to a server request goes out, and later ones are dropped")
  func serverRequestAnswersAreIdempotent() async throws {
    try await withHarness { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let requests = h.connection.serverRequests
      let answering = Task {
        for await delivery in requests {
          await delivery.respond(["choice": "once"])
          await delivery.respond(["choice": "deny"])
          await delivery.fail(code: -32000, message: "too late")
          return
        }
      }

      let answer = try await h.gateway.requestApproval(["session_id": "s1"])
      await answering.value
      await h.settle()

      #expect(answer == ["choice": "once"])
      let socket = try #require(h.gateway.lastSocket)
      #expect(socket.sent.filter { $0["id"] == "srq-1" }.count == 1)
    }
  }

  @Test("an event reaches every subscriber")
  func eventsFanOut() async throws {
    try await withHarness { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let first = firstEvent(of: "cron.changed", on: h.connection)
      let second = firstEvent(of: "cron.changed", on: h.connection)
      h.gateway.emit("cron.changed")

      #expect(await first.value?.type == "cron.changed")
      #expect(await second.value?.type == "cron.changed")
    }
  }
}
