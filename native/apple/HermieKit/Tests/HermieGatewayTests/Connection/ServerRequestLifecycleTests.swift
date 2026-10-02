import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// How a server request lives: subscribed before `start()`, answered over the
// socket it came on, re-delivered after a reconnect, and the end of the
// streams on `shutdown()`.

@Suite("server requests across the connection's life")
struct ServerRequestLifecycleTests {
  @Test("a subscription made before start receives the first resume's open_requests")
  func subscribedBeforeStart() async throws {
    try await withHarness { h in
      h.gateway.with { state in
        state.scriptedResults["session.resume"] = [
          "session_id": "s1",
          "open_requests": [["id": "srq-waiting", "method": "approval", "params": ["session_id": "s1"]]]
        ]
      }
      let requests = Recorder(h.connection.serverRequests)
      defer { requests.cancel() }

      await h.connection.start()
      try await h.waitFor(.ready)
      _ = try await h.connection.request(RPC.SessionResume.self, SessionResumeParams(sessionID: "s1"))

      try await eventually("the re-delivered request") { requests.values.count == 1 }
      #expect(requests.values.first?.request.id == "srq-waiting")
      #expect(requests.values.first?.replayed == true)
    }
  }

  @Test("an answer for a socket that has gone is refused, and the re-delivered copy is answered")
  func answersFollowTheSocket() async throws {
    try await withHarness { h in
      let requests = Recorder(h.connection.serverRequests)
      defer { requests.cancel() }

      await h.connection.start()
      try await h.waitFor(.ready)

      let asked = Task { try await h.gateway.requestApproval(["session_id": "s1"]) }
      try await eventually("the live request") { requests.values.count == 1 }
      let live = try #require(requests.values.first)

      // The socket goes; the gateway still waits on the request, and re-delivers
      // it in the answer to the next resume.
      h.gateway.with { state in
        state.scriptedResults["session.resume"] = [
          "session_id": "s1",
          "open_requests": [["id": .string(live.request.id ?? ""), "method": "approval", "params": ["session_id": "s1"]]]
        ]
      }
      h.gateway.dropSockets()
      try await h.waitFor(.reconnecting)
      try await h.advanceUntil(phase: .ready)

      #expect(await live.respond(["choice": "once"]) == false)

      _ = try await h.connection.request(RPC.SessionResume.self, SessionResumeParams(sessionID: "s1"))
      try await eventually("the re-delivered copy") { requests.values.count == 2 }
      let copy = requests.values[1]
      #expect(copy.replayed)
      #expect(copy.request.id == live.request.id)

      #expect(await copy.respond(["choice": "session"]) == true)
      #expect(try await asked.value == ["choice": "session"])
    }
  }

  @Test("shutdown ends every stream, and nothing dials afterwards")
  func shutdownEndsTheStreams() async throws {
    try await withHarness { h in
      let events = h.connection.events
      let requests = h.connection.serverRequests
      let statuses = h.connection.statuses

      await h.connection.start()
      try await h.waitFor(.ready)
      await h.connection.shutdown()

      var drained = 0
      for await _ in events { drained += 1 }
      for await _ in requests { drained += 1 }
      var last: ConnectionStatus?
      for await status in statuses { last = status }
      #expect(last?.phase == .disconnected)

      await h.connection.start()
      await h.connection.resume()
      await h.settle()
      #expect(await h.connection.phase == .disconnected)
      #expect(h.gateway.with { $0.dials.count } == 1)

      // A subscription after shutdown is already finished.
      var late = 0
      for await _ in h.connection.events { late += 1 }
      #expect(late == 0)
    }
  }
}
