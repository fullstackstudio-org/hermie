import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// Events, server requests and RPC results leave the connection on different
// tasks, so the order a consumer drains them in says nothing about the wire.
// The wire index does: these send interleaved frames and read back exactly the
// indices they arrived with, whichever task happens to run first.

@Suite("wire order across events, server requests and replies")
struct WireOrderTests {
  @Test("event, server request, reply and event carry consecutive wire indices")
  func interleavedFramesKeepTheirIndices() async throws {
    try await withHarness { h in
      h.gateway.with { _ = $0.hangMethods.insert("x.wait") }
      let events = Recorder(h.connection.events)
      let requests = Recorder(h.connection.serverRequests)
      defer {
        events.cancel()
        requests.cancel()
      }

      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)

      for round in 0..<20 {
        let call = Task { try await h.connection.requestReply("x.wait") }
        try await eventually("the call on the wire") {
          socket.sent.filter { $0["method"] == "x.wait" }.count == round + 1
        }
        let request = socket.lastRequest("x.wait")

        let marker = JSONValue.number(Double(round))
        socket.serverSend([
          "jsonrpc": "2.0", "method": "event", "params": ["type": "status.update", "payload": ["before": marker]]
        ])
        socket.serverSend([
          "jsonrpc": "2.0", "id": .string("srq-live-\(round)"), "method": "approval", "params": ["session_id": "s1"]
        ])
        socket.serverSend([
          "jsonrpc": "2.0", "id": request?["id"] ?? .null,
          "result": [
            "ok": marker,
            "open_requests": [["id": .string("srq-open-\(round)"), "method": "clarify", "params": ["session_id": "s1"]]]
          ]
        ])
        socket.serverSend([
          "jsonrpc": "2.0", "method": "event", "params": ["type": "status.update", "payload": ["after": marker]]
        ])

        let reply = try await call.value
        #expect(reply.result["ok"] == marker)

        try await eventually("both events") {
          events.values.contains { $0.event.payload?["after"] == marker }
        }
        try await eventually("both server requests") {
          requests.values.contains { $0.request.id == "srq-open-\(round)" }
        }

        let before = try #require(events.values.first { $0.event.payload?["before"] == marker })
        let after = try #require(events.values.first { $0.event.payload?["after"] == marker })
        let live = try #require(requests.values.first { $0.request.id == "srq-live-\(round)" })
        let reopened = try #require(requests.values.first { $0.request.id == "srq-open-\(round)" })

        #expect(live.index == before.index + 1)
        #expect(reply.index == before.index + 2)
        #expect(reopened.index == reply.index)
        #expect(reopened.replayed)
        #expect(after.index == reply.index + 1)
      }
    }
  }

  @Test("indices keep counting across a reconnect")
  func indicesSurviveAReconnect() async throws {
    try await withHarness { h in
      let events = Recorder(h.connection.events)
      defer { events.cancel() }

      await h.connection.start()
      try await h.waitFor(.ready)
      h.gateway.dropSockets()
      try await h.waitFor(.reconnecting)
      try await h.advanceUntil(phase: .ready)

      try await eventually("two gateway.ready events") {
        events.values.filter { $0.event.type == "gateway.ready" }.count == 2
      }
      let indices = events.values.map(\.index)
      #expect(indices == indices.sorted())
      #expect(Set(indices).count == indices.count)
    }
  }
}
