import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// The port of `packages/hermes-shared/src/json-rpc-gateway-replay.test.ts`, the
// seq tracking and reconnect replay the connection owns. The reference drives
// a bare `JsonRpcGatewayClient` over a hand-opened socket; here the whole
// connection runs against the fake gateway, and a drop is a real drop followed
// by the connection's own redial. The fake leaves `session.events.since`
// unanswered so each test answers it by hand.

@Suite("event-seq tracking and replay resume")
struct ReplayTests {
  private func event(_ type: String, session: String? = nil, seq: Double? = nil, payload: JSONValue? = nil)
    -> JSONValue
  {
    var params: JSONObject = ["type": .string(type)]
    params["session_id"] = session.map(JSONValue.string)
    params["seq"] = seq.map(JSONValue.number)
    params["payload"] = payload
    return ["jsonrpc": "2.0", "method": "event", "params": .object(params)]
  }

  private func push(_ h: Harness, _ frames: JSONValue...) throws {
    let socket = try #require(h.gateway.lastSocket)

    for frame in frames {
      socket.serverSend(frame)
    }
  }

  private func connected(_ h: Harness) async throws {
    h.gateway.with { _ = $0.hangMethods.insert("session.events.since") }
    await h.connection.start()
    try await h.waitFor(.ready)
  }

  /// Drop the socket and let the connection redial; returns the new socket.
  private func reconnect(_ h: Harness) async throws -> FakeSocket {
    let before = h.gateway.connections
    h.gateway.dropSockets()
    try await h.advanceUntil("the redial") {
      let phase = await h.connection.phase
      return h.gateway.connections == before + 1 && phase == .ready
    }
    try await h.waitFor(.ready)
    return try #require(h.gateway.lastSocket)
  }

  private func replayRequest(on socket: FakeSocket) async throws -> JSONValue {
    var request: JSONValue?
    try await eventually("the replay request") {
      request = socket.lastRequest("session.events.since")
      return request != nil
    }
    return try #require(request)
  }

  private func answer(_ request: JSONValue, on socket: FakeSocket, _ result: JSONValue) {
    socket.respond(request["id"] ?? .null, result: result)
  }

  private func seqs(_ events: Recorder<WireEvent>, _ type: String) -> [Double] {
    events.values.map(\.event).filter { $0.type == type }.compactMap { $0.json["seq"]?.doubleValue }
  }

  @Test("records per-session seq watermarks from live events")
  func recordsWatermarks() async throws {
    try await withHarness { h in
      try await connected(h)

      try push(
        h,
        event("message.delta", session: "s1", seq: 4),
        event("message.delta", session: "s1", seq: 2),  // out of order / late
        event("tool.start", session: "s2", seq: 9),
        event("skin.changed")  // no session, no seq
      )

      try await eventually("the watermarks") { await h.connection.seqWatermarks == ["s1": 4, "s2": 9] }
    }
  }

  @Test("fetches replay on reconnect for sessions it has watermarks for")
  func fetchesReplayOnReconnect() async throws {
    try await withHarness { h in
      try await connected(h)
      try push(h, event("message.start", session: "s1", seq: 1), event("message.delta", session: "s1", seq: 5))
      try await eventually("the watermark") { await h.connection.seqWatermarks["s1"] == 5 }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)

      #expect(request["params"]?["session_id"] == "s1")
      #expect(request["params"]?["last_seen"] == 5)
    }
  }

  @Test("dispatches replayed events through the normal handler path")
  func dispatchesReplayedEvents() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 3))
      try await eventually("the watermark") { await h.connection.seqWatermarks["s1"] == 3 }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      // Answer the replay request with two missed events.
      answer(
        request,
        on: socket,
        [
          "events": [
            ["type": "tool.complete", "session_id": "s1", "seq": 4, "payload": ["n": 1]],
            ["type": "tool.complete", "session_id": "s1", "seq": 5, "payload": ["n": 2]]
          ],
          "latest_seq": 5, "truncated": false, "count": 2
        ]
      )

      try await eventually("the replayed events") {
        events.values.map(\.event).filter { $0.type == "tool.complete" }.compactMap { $0.payload?["n"] } == [1, 2]
      }
      #expect(await h.connection.seqWatermarks["s1"] == 5)
    }
  }

  @Test("does not attempt replay when nothing was ever observed")
  func noReplayWithoutWatermarks() async throws {
    try await withHarness { h in
      try await connected(h)

      // No events ever seen: a drop and reconnect must not fire a replay RPC.
      let socket = try await reconnect(h)
      await h.settle()

      #expect(socket.lastRequest("session.events.since") == nil)
      #expect(!h.gateway.methodLog.contains("session.events.since"))
    }
  }

  @Test("replayed seqs advance watermarks but never regress them")
  func replayNeverRegresses() async throws {
    try await withHarness { h in
      try await connected(h)
      try push(h, event("status.update", session: "s1", seq: 10))
      try await eventually("the watermark") { await h.connection.seqWatermarks["s1"] == 10 }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      // The replay returns a STALE frame (seq 2 < watermark 10): the watermark holds.
      answer(
        request,
        on: socket,
        [
          "events": [["type": "status.update", "session_id": "s1", "seq": 2]],
          "latest_seq": 10, "truncated": false, "count": 1
        ]
      )
      await h.settle()

      #expect(await h.connection.seqWatermarks["s1"] == 10)
    }
  }

  @Test("rejects envelope-shaped replay elements (the #94219 server-shape bug)")
  func rejectsEnvelopeShapedElements() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 1))
      try await eventually("the pre-drop live frame") { seqs(events, "message.delta") == [1] }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      // Pre-fix servers returned full JSON-RPC envelopes; those are not dispatched.
      answer(
        request,
        on: socket,
        [
          "events": [
            ["jsonrpc": "2.0", "method": "event", "params": ["type": "message.delta", "session_id": "s1", "seq": 2]]
          ],
          "latest_seq": 2, "truncated": false, "count": 1
        ]
      )
      await h.settle()

      #expect(seqs(events, "message.delta") == [1])
    }
  }

  @Test("holds live frames racing the replay fetch — no double dispatch, no skipped gap")
  func holdsLiveFramesRacingTheReplay() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 2))
      try await eventually("the pre-drop live frame") { seqs(events, "message.delta") == [2] }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)

      // LIVE frames 5 and 6 arrive while the replay (which carries 3, 4, 5) is
      // still in flight. They are parked, not dispatched ahead of the gap.
      socket.serverSend(event("message.delta", session: "s1", seq: 5))
      socket.serverSend(event("message.delta", session: "s1", seq: 6))
      await h.settle()
      #expect(seqs(events, "message.delta") == [2])

      answer(
        request,
        on: socket,
        [
          "events": [
            ["type": "message.delta", "session_id": "s1", "seq": 3],
            ["type": "message.delta", "session_id": "s1", "seq": 4],
            ["type": "message.delta", "session_id": "s1", "seq": 5]
          ],
          "latest_seq": 5, "truncated": false, "count": 3
        ]
      )

      // In order, exactly once: replayed 3, 4, 5, then the parked live 6; the
      // parked duplicate of 5 is seq-gated out.
      try await eventually("the gap and the parked frame") { seqs(events, "message.delta") == [2, 3, 4, 5, 6] }
      #expect(await h.connection.seqWatermarks["s1"] == 6)
    }
  }

  @Test("restarts replay after its socket is invalidated before rejected cleanup runs")
  func restartsReplayAfterAnInterruptedOne() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 1))
      try await eventually("the live frame") { seqs(events, "message.delta") == [1] }

      let second = try await reconnect(h)
      _ = try await replayRequest(on: second)

      // The old request is failed by the drop; the replacement opens before
      // anything else happens and must own a fresh replay.
      let third = try await reconnect(h)
      let request = try await replayRequest(on: third)
      #expect(request["params"] == ["session_id": "s1", "last_seen": 1])

      // A live frame racing the new replay is parked by the NEW hold; the stale
      // replay's cleanup must neither flush it nor advance the watermark past
      // the gap it never recovered.
      third.serverSend(event("message.delta", session: "s1", seq: 3))
      await h.settle()
      #expect(seqs(events, "message.delta") == [1])
      #expect(await h.connection.seqWatermarks == ["s1": 1])

      answer(
        request,
        on: third,
        [
          "events": [["type": "message.delta", "session_id": "s1", "seq": 2]],
          "latest_seq": 2, "truncated": false, "count": 1
        ]
      )

      try await eventually("the gap and the parked frame") { seqs(events, "message.delta") == [1, 2, 3] }
      #expect(await h.connection.seqWatermarks == ["s1": 3])
    }
  }

  @Test("clears stale watermarks when the backend epoch changes (restart poisoning)")
  func clearsWatermarksOnANewEpoch() async throws {
    try await withHarness { h in
      h.gateway.with { $0.replayEpoch = "epoch-A" }
      try await connected(h)
      // Epoch A came with gateway.ready; now a high watermark.
      try push(h, event("message.delta", session: "s1", seq: 97))
      try await eventually("the watermark") { await h.connection.seqWatermarks == ["s1": 97] }

      // The backend restarted: the replay under a NEW epoch returns nothing
      // (fresh process, empty ring). Keeping 97 would mean believing, forever,
      // that nothing was missed.
      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      answer(
        request,
        on: socket,
        ["events": [], "latest_seq": 0, "truncated": false, "count": 0, "epoch": "epoch-B"]
      )

      try await eventually("the watermarks to clear") { await h.connection.seqWatermarks.isEmpty }

      // New-epoch events build fresh watermarks from scratch.
      socket.serverSend(event("message.delta", session: "s1", seq: 3))
      try await eventually("a fresh watermark") { await h.connection.seqWatermarks == ["s1": 3] }
    }
  }

  @Test("reports a truncated replay as a gap, after dispatching what the ring still held")
  func reportsATruncatedReplay() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      let gaps = Recorder(h.connection.replayGaps)
      defer {
        events.cancel()
        gaps.cancel()
      }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 3), event("message.delta", session: "s2", seq: 4))
      try await eventually("the watermarks") { await h.connection.seqWatermarks == ["s1": 3, "s2": 4] }

      let socket = try await reconnect(h)
      var requests: [JSONValue] = []
      try await eventually("both replay requests") {
        requests = socket.sent.filter { $0["method"]?.stringValue == "session.events.since" }
        return requests.count == 2
      }

      for request in requests {
        let truncated = request["params"]?["session_id"] == "s1"
        answer(
          request,
          on: socket,
          [
            "events": truncated ? [["type": "message.delta", "session_id": "s1", "seq": 900]] : [],
            "latest_seq": truncated ? 900 : 4, "truncated": .bool(truncated), "count": truncated ? 1 : 0
          ]
        )
      }

      try await eventually("the gap") { gaps.values.count == 1 }
      let gap = try #require(gaps.values.first)
      #expect(gap.sessionID == "s1")
      #expect(gap.reason == .truncated)
      #expect(seqs(events, "message.delta").contains(900), "the ring's tail is dispatched before the gap is reported")
      #expect(await h.connection.seqWatermarks["s1"] == 900)
    }
  }

  @Test("reports a replay from another gateway process as a gap")
  func reportsAnEpochChange() async throws {
    try await withHarness { h in
      let gaps = Recorder(h.connection.replayGaps)
      defer { gaps.cancel() }

      h.gateway.with { $0.replayEpoch = "epoch-A" }
      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 97))
      try await eventually("the watermark") { await h.connection.seqWatermarks == ["s1": 97] }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      answer(request, on: socket, ["events": [], "latest_seq": 0, "truncated": false, "count": 0, "epoch": "epoch-B"])

      try await eventually("the gap") { gaps.values.count == 1 }
      #expect(gaps.values.first == ReplayGap(sessionID: "s1", reason: .epochChanged, index: gaps.values[0].index))
    }
  }

  @Test("a whole replay reports no gap")
  func aWholeReplayReportsNothing() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      let gaps = Recorder(h.connection.replayGaps)
      defer {
        events.cancel()
        gaps.cancel()
      }

      try await connected(h)
      try push(h, event("message.delta", session: "s1", seq: 3))
      try await eventually("the watermark") { await h.connection.seqWatermarks["s1"] == 3 }

      let socket = try await reconnect(h)
      let request = try await replayRequest(on: socket)
      answer(
        request,
        on: socket,
        ["events": [["type": "message.delta", "session_id": "s1", "seq": 4]], "latest_seq": 4, "truncated": false, "count": 1]
      )

      try await eventually("the replayed event") { seqs(events, "message.delta") == [3, 4] }
      // A gap would have been published in the same actor turn as the last replayed event.
      await h.settle()
      #expect(gaps.values.isEmpty)
    }
  }
}
