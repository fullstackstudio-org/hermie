import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// The cases of `packages/hermes-shared/src/json-rpc-channel.test.ts` that
// describe behaviour the connection owns, run through the whole connection
// against the fake gateway. Two are not ported, because the connection does not
// have what they test: the `response` heartbeat liveness (the WebSocket client
// always uses `any-inbound`) and a throwing request handler answered `-32603`
// (server requests reach the app as a stream, not through handlers that throw).

@Suite("the JSON-RPC channel")
struct ChannelTests {
  @Test("routes responses to the pending call and keeps JSON-RPC code/data on errors")
  func routesResponsesAndKeepsErrorDetail() async throws {
    try await withHarness { h in
      h.gateway.with { state in
        state.scriptedResults["session.create"] = ["ok": true]
      }
      await h.connection.start()
      try await h.waitFor(.ready)

      let created = try await h.connection.request("session.create", params: ["cols": 80])
      #expect(created == ["ok": true])

      // Non-JSON and unknown ids are ignored, never thrown.
      let socket = try #require(h.gateway.lastSocket)
      socket.serverSendText("not json")
      socket.respond("never-sent", result: 1)

      await #expect {
        _ = try await h.connection.request("projects.create")
      } throws: { error in
        let error = error as? GatewayRPCError
        return error?.kind == .rejected && error?.code == -32601
          && error?.message == "unknown method: projects.create"
      }
      #expect(await h.connection.phase == .ready)
    }
  }

  @Test("ignores the non-object JSON lines null, 42, \"str\" and true without throwing")
  func ignoresNonObjectLines() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      await h.connection.start()
      try await h.waitFor(.ready)
      let readyEvents = events.values.count

      let socket = try #require(h.gateway.lastSocket)

      for text in ["null", "42", "\"str\"", "true"] {
        socket.serverSendText(text)
      }

      let profiles = try await h.connection.request("profiles.list")
      #expect(profiles["profiles"] != nil)
      #expect(events.values.count == readyEvents)
    }
  }

  @Test("detach fails every in-flight call and a per-call timeout names the method")
  func detachFailsCallsAndTimeoutsNameTheMethod() async throws {
    try await withHarness { h in
      h.gateway.with { state in
        state.hangMethods.formUnion(["a.slow", "b.wait"])
      }
      await h.connection.start()
      try await h.waitFor(.ready)

      let slow = Task { try await h.connection.request("a.slow", timeout: .seconds(1)) }
      let untilDetach = Task { try await h.connection.request("b.wait") }
      try await eventually("both calls on the wire") {
        h.gateway.methodLog.contains("a.slow") && h.gateway.methodLog.contains("b.wait")
      }

      await h.clock.advance(by: .seconds(1))
      await #expect {
        _ = try await slow.value
      } throws: { error in
        (error as? GatewayRPCError) == GatewayRPCError(.timeout, "request timed out after 1s: a.slow")
      }

      h.gateway.dropSockets()
      await #expect {
        _ = try await untilDetach.value
      } throws: { error in
        (error as? GatewayRPCError) == GatewayRPCError(.closed, "WebSocket closed")
      }

      try await h.waitFor(.reconnecting)
      await #expect {
        _ = try await h.connection.request("c.after")
      } throws: { error in
        (error as? GatewayRPCError) == GatewayRPCError(.notConnected, "gateway not connected")
      }
    }
  }

  @Test("'any-inbound' liveness (desktop/web): pings while frames keep arriving and reports a silent transport")
  func anyInboundLiveness() async throws {
    try await withHarness(HarnessOptions(heartbeatInterval: .milliseconds(100))) { h in
      h.gateway.with { $0.answerPings = false }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)

      // The harness deadline is five seconds; frames keep arriving, pings go
      // unanswered, and the socket stays up well past it. Each frame is read
      // by the actor before the clock moves on: liveness is the time the actor
      // READ a frame, so a clock that ran ahead of a starved reader would see a
      // silent socket that was not.
      for _ in 0..<60 {
        await h.clock.advance(by: .milliseconds(100))
        let read = await h.connection.wireIndex
        socket.serverSend(["jsonrpc": "2.0", "method": "event", "params": ["type": "status.update"]])
        try await eventually("the frame to be read") { await h.connection.wireIndex > read }
      }

      try await eventually("the pings") {
        socket.sent.filter { $0["method"] == "gateway.ping" }.count >= 50
      }
      #expect(await h.connection.phase == .ready)
      #expect(socket.isOpen)

      // Then silence: a full deadline later the socket is dropped and redialled.
      let silentFrom = h.clock.now
      try await h.advanceUntil("the drop", step: .milliseconds(100)) { (await h.connection.phase) == .reconnecting }
      #expect(!socket.isOpen)
      #expect(h.clock.now - silentFrom >= .milliseconds(4900))
      #expect(await h.connection.lastError?.message == "The gateway connection dropped.")

      // The failure stops the timer: no further pings on the dead socket.
      let pings = socket.sent.count
      await h.clock.advance(by: .milliseconds(5))
      #expect(socket.sent.count == pings)
    }
  }

  @Test(
    "'response' liveness (default, TUI): unanswered pings fail the heartbeat even while deltas stream",
    .disabled("the TUI's contract; the WebSocket connection counts any inbound frame as liveness")
  )
  func responseLiveness() {}

  @Test("advertises server-request support once per gateway.ready and shrugs off an older backend")
  func advertisesServerRequestSupport() async throws {
    try await withHarness { h in
      h.gateway.with { $0.refuseCapabilities = true }
      await h.connection.start()
      try await h.waitFor(.ready)

      let socket = try #require(h.gateway.lastSocket)
      try await eventually("the announcement") { socket.lastRequest("client.capabilities") != nil }
      #expect(socket.lastRequest("client.capabilities")?["params"] == ["server_requests": true])

      // An older backend answers -32601: nothing changes, and it is not re-sent.
      let profiles = try await h.connection.request("profiles.list")
      #expect(profiles["profiles"] != nil)
      #expect(socket.sent.filter { $0["method"] == "client.capabilities" }.count == 1)
      #expect(await h.connection.phase == .ready)
    }
  }

  @Test("routes a server request to the app and answers -32601 when it is not one the app answers")
  func routesServerRequests() async throws {
    try await withHarness { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let requests = h.connection.serverRequests
      let answering = Task {
        for await delivery in requests {
          if case .clarify = delivery.body {
            await delivery.respond(["answer": "yes"])
          }
        }
      }
      defer { answering.cancel() }

      let clarify = try await h.gateway.requestServerSide(method: "clarify", params: ["session_id": "s1"])
      #expect(clarify == ["answer": "yes"])

      // `tour` is a server request the app does not answer, listener or not.
      await #expect {
        _ = try await h.gateway.requestServerSide(method: "tour", params: ["session_id": "s1"])
      } throws: { error in
        String(describing: error).contains("-32601")
      }
    }
  }

  @Test("re-delivers open_requests from a response before the caller sees the result, tagged replayed")
  func redeliversOpenRequests() async throws {
    try await withHarness { h in
      h.gateway.with { state in
        state.scriptedResults["session.resume"] = [
          "session_id": "s1",
          "open_requests": [
            ["id": "srq-9", "method": "approval", "params": ["session_id": "s1"]],
            ["id": "srq-10", "method": "sudo", "params": ["session_id": "s1"]]
          ]
        ]
      }
      await h.connection.start()
      try await h.waitFor(.ready)

      let requests = h.connection.serverRequests
      let resumed = try await h.connection.request(RPC.SessionResume.self, SessionResumeParams(sessionID: "s1"))
      #expect(resumed.json["session_id"] == "s1")

      // Delivered in the same turn that resolved the call, so it is already
      // waiting when the caller sees the result.
      var iterator = requests.makeAsyncIterator()
      let delivered = await iterator.next()
      #expect(delivered?.request.id == "srq-9")
      #expect(delivered?.replayed == true)

      // `sudo` is not the app's to answer: the connection declined it.
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("the refusal") {
        socket.sent.contains { $0["id"] == "srq-10" && $0["error"]?["code"] == -32601 }
      }
    }
  }

  @Test(
    "answers -32603 when a handler throws, keeps later frames working, and still answers -32601 otherwise",
    .disabled("server requests reach the app as a stream; there is no handler that can throw")
  )
  func answersWhenAHandlerThrows() {}
}
