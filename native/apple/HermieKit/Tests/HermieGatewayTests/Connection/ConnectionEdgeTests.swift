import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

// Edges of the dial loop the TypeScript suite did not reach: a refresh or a
// close that belongs to a dial the loop has moved past, a status whose reason
// changes without its phase, and `stop()` while the credential provider is
// still working. The ones marked "(both)" exist in `connection.test.ts` too.

@Suite("edges of the dial loop")
struct ConnectionEdgeTests {
  /// (both) The refresh was asked for by a dial that a pause and a resume have
  /// since replaced. When it fails, that failure is no longer the loop's.
  @Test("a refresh that fails after the dial it served was replaced does not tear down the new socket")
  func aSupersededRefreshFailureIsIgnored() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      let gate = ConnectionGate()
      h.credentials.hold { holds in
        holds.rejection = gate
        holds.rejectionFailure = GatewayError(.network, "Refreshing the credentials failed.")
      }
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await eventually("the refresh to be asked for") { gate.waiting == 1 }

      await h.connection.pause()
      await h.connection.resume()
      try await h.waitFor(.ready)
      let seen = h.statuses.values.count

      gate.open()
      await h.settle()
      await h.clock.advance(by: .milliseconds(50))
      await h.settle()

      #expect(await h.connection.phase == .ready)
      #expect(h.gateway.connections == 1)
      #expect(h.statuses.values.count == seen)
    }
  }

  /// (both) The same, when the refresh succeeds: the replaced dial must not
  /// start a second one beside the live socket.
  @Test("a refresh that succeeds after the dial it served was replaced starts no second dial")
  func aSupersededRefreshSuccessIsIgnored() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      let gate = ConnectionGate()
      h.credentials.hold { $0.rejection = gate }
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await eventually("the refresh to be asked for") { gate.waiting == 1 }

      await h.connection.pause()
      await h.connection.resume()
      try await h.waitFor(.ready)
      let plans = h.credentials.dialPlans

      gate.open()
      await h.settle()
      await h.clock.advance(by: .seconds(3))
      await h.settle()

      #expect(await h.connection.phase == .ready)
      #expect(h.credentials.dialPlans == plans)
      #expect(h.gateway.connections == 1)
    }
  }

  /// (both) A socket this side closed can report its close code late. A 4403
  /// from it used to be read as the verdict on the next dial.
  @Test("a late close from a replaced socket does not decide the next dial")
  func aStaleCloseCodeIsIgnored() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)
      let first = try #require(h.gateway.lastSocket)
      first.reportOnClientClose(code: 4403)

      // Hold the next dial at its credential until the old socket's close is in.
      let gate = ConnectionGate()
      h.credentials.hold { $0.dialPlan = gate }
      h.gateway.with { $0.down = true }

      await h.connection.pause()
      await h.connection.resume()
      try await eventually("the old socket's close to be read") {
        let tasks = await h.connection.liveTaskCount
        return !first.isOpen && tasks == 1 && gate.waiting == 1
      }

      gate.open()
      try await h.waitFor(.reconnecting)

      let error = await h.connection.lastError
      #expect(error?.kind == .network)
      #expect(error?.closeCode == nil)
    }
  }

  /// (both) The device went offline while the ticket was being minted, so the
  /// phase already reads `offline` when the mint fails. The failure is the
  /// reason, and a header that shows it has to hear about it although the phase
  /// is the same.
  @Test("a new reason for the same phase is published")
  func errorOnlyChangesArePublished() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      let gate = ConnectionGate()
      h.credentials.hold { $0.dialPlan = gate }
      h.gateway.with { $0.failNextTicketMints = 1 }

      await h.connection.start()
      try await eventually("the dial to start") { gate.waiting == 1 }
      await h.connection.setOnline(false)
      try await h.waitFor(.offline)
      #expect(h.statuses.values.last?.error == nil)

      gate.open()
      try await eventually("the dial's failure to be published") {
        h.statuses.values.last?.error?.status == 503 && h.statuses.values.last?.phase == .offline
      }
    }
  }

  @Test("stop while the credential is being minted: nothing happens when the mint returns")
  func stopDuringDialPlan() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      let gate = ConnectionGate()
      h.credentials.hold { $0.dialPlan = gate }

      await h.connection.start()
      try await eventually("the mint to start") { gate.waiting == 1 }

      await h.connection.stop()
      try await h.waitFor(.disconnected)
      let seen = h.statuses.values.count

      gate.open()
      try await eventually("every task to finish") { await h.connection.liveTaskCount == 0 }
      await h.settle()

      #expect(h.statuses.values.count == seen)
      #expect(await h.connection.phase == .disconnected)
      #expect(h.gateway.with { $0.dials.isEmpty })
      #expect(h.clock.pendingCount == 0)
    }
  }

  @Test("stop while the credential is being refreshed: nothing happens when the refresh returns")
  func stopDuringOnRejected() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      let gate = ConnectionGate()
      h.credentials.hold { $0.rejection = gate }
      h.gateway.with { $0.rejectNextUpgrades = 2 }

      await h.connection.start()
      try await eventually("the refresh to start") { gate.waiting == 1 }

      await h.connection.stop()
      try await h.waitFor(.disconnected)
      let seen = h.statuses.values.count
      let dials = h.gateway.with { $0.dials.count }

      gate.open()
      try await eventually("every task to finish") { await h.connection.liveTaskCount == 0 }
      await h.settle()

      #expect(h.statuses.values.count == seen)
      #expect(await h.connection.phase == .disconnected)
      #expect(h.gateway.with { $0.dials.count } == dials)
      #expect(h.clock.pendingCount == 0)
    }
  }
}
