import Foundation
import Testing

@testable import HermieGateway

// `gateway.ready` resolves the dial's waiter, and the dial resumes one hop
// later. A close that reaches the actor inside that hop used to find no waiter
// and a phase that was not `ready` yet, and was dropped; the dial then
// published `ready` over a socket that no longer existed, with no timer left to
// notice. These run the race many times, because which side wins is up to the
// scheduler.

@Suite("a socket that closes right after gateway.ready")
struct ReadyRaceTests {
  private func settledPhase(closingWith closed: WebSocketClosed) async throws -> (ConnectionPhase, GatewayError?) {
    var phase = ConnectionPhase.disconnected
    var error: GatewayError?

    // A long ladder, so nothing redials while the outcome is read.
    try await withHarness(HarnessOptions(backoff: { _ in .seconds(30) })) { h in
      h.gateway.with { $0.closeAfterReady = closed }
      await h.connection.start()

      try await eventually("the dial to settle") {
        let current = await h.connection.phase
        return current != .authenticating && current != .connecting
      }
      await h.settle()

      phase = await h.connection.phase
      error = await h.connection.lastError
    }

    return (phase, error)
  }

  @Test("never ends ready without a socket")
  func neverReadyWithoutASocket() async throws {
    for _ in 0..<250 {
      let (phase, error) = try await settledPhase(closingWith: WebSocketClosed(code: 1006))
      #expect(phase == .reconnecting)
      #expect(error?.kind == .network)

      if phase != .reconnecting {
        return
      }
    }
  }

  @Test("a 4403 right after ready still stops the loop as a configuration problem")
  func configCloseRightAfterReady() async throws {
    for _ in 0..<100 {
      let (phase, error) = try await settledPhase(closingWith: WebSocketClosed(code: 4403, reason: "host not allowed"))
      #expect(phase == .disconnected)
      #expect(error?.kind == .config)
      #expect(error?.closeCode == 4403)

      if phase != .disconnected {
        return
      }
    }
  }
}
