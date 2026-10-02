import Foundation
import Testing

@testable import HermieGateway

// The port of `packages/gateway-client/src/socket-factory.test.ts`. The factory
// itself does not exist here: it carried the dial plan past a vendored client
// that only passed a URL, and the Swift dial loop hands the plan to the
// transport directly. So its cases become what the transport is given. Three
// cases test the arming mechanism itself (no plan armed, a plan armed for
// another URL, disarming), which has no counterpart, and are not ported.

@Suite("the dial plan reaches the transport")
struct DialPlanTests {
  @Test("passes protocols and headers through to the constructor")
  func passesProtocolsAndHeaders() async throws {
    try await withHarness(HarnessOptions(auth: .native, extraHeaders: ["CF-Access-Client-Id": "x"])) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let dial = try #require(h.gateway.with { $0.dials.first })
      #expect(dial.url == "ws://gateway.test/api/ws")
      #expect(dial.subprotocols == ["hermes-gateway-v1", "hermes-gateway-ticket.tk-1"])
      #expect(dial.headers == ["CF-Access-Client-Id": "x"])
    }
  }

  @Test("omits the options argument when there are no headers")
  func omitsEmptyHeaders() async throws {
    try await withHarness(HarnessOptions(auth: .token)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let dial = try #require(h.gateway.with { $0.dials.first })
      #expect(dial.headers.isEmpty)
      #expect(dial.subprotocols.isEmpty)

      let request = try #require(WebSocketDial.request(for: DialPlan(url: "ws://gateway.test/api/ws")))
      #expect(request.allHTTPHeaderFields?.isEmpty ?? true)
    }
  }

  @Test("consumes the plan so a single-use ticket cannot be dialled twice")
  func oneTicketPerDial() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      await h.connection.start()
      try await h.waitFor(.ready)
      await h.connection.pause()
      await h.connection.resume()
      try await h.waitFor(.ready)

      let tickets = h.gateway.with { $0.dials.map { $0.subprotocols.last ?? "" } }
      #expect(tickets == ["hermes-gateway-ticket.tk-1", "hermes-gateway-ticket.tk-2"])
      #expect(h.credentials.dialPlans == 2)
    }
  }

  @Test("forwards the close code and reason")
  func forwardsTheCloseCode() async throws {
    try await withHarness(HarnessOptions(auth: .native)) { h in
      h.gateway.with { $0.rejectNextUpgrades = 1 }
      await h.connection.start()
      try await h.waitFor(.ready)

      let closes = h.timeline.snapshot().entries.map(\.event).filter { $0.event == .wsClosed }
      #expect(closes.map(\.closeCode) == [4401])
    }
  }

  @Test("refuses anything but a ws:// or wss:// URL")
  func refusesOtherSchemes() {
    #expect(WebSocketDial.isWebSocketURL("ws://gateway.test/api/ws"))
    #expect(WebSocketDial.isWebSocketURL("wss://gateway.test/api/ws?token=t"))
    #expect(!WebSocketDial.isWebSocketURL("http://gateway.test/api/ws"))
    #expect(!WebSocketDial.isWebSocketURL("not a url"))
  }
}
