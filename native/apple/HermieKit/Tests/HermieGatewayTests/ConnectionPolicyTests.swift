import Testing

@testable import HermieGateway

/// The parts of the stateless gateway layer the contract vectors do not cover:
/// close codes, the timeout table, the protocol floor and the cleartext fallback.
@Suite struct ConnectionPolicyTests {
  @Test func closeCodesSplitIntoTicketConfigAndTransient() {
    #expect(CloseCodeVerdict.classify(4401) == .auth)
    #expect(CloseCodeVerdict.classify(4404) == .config(message: "Chat is switched off on this gateway."))
    #expect(
      CloseCodeVerdict.classify(4408)
        == .config(message: "Another client took this connection over. Reopen Hermie to reclaim it.")
    )

    guard case .config(let message) = CloseCodeVerdict.classify(4403) else {
      Issue.record("4403 is a configuration close")
      return
    }

    #expect(message.contains("dashboard.public_url"))

    for code in [nil, 1000, 1001, 1006, 1011, 4000, 4400, 4402, 4405, 4409, 4500] {
      #expect(CloseCodeVerdict.classify(code) == .transient, "\(String(describing: code))")
    }
  }

  @Test func aConfigCloseBecomesAConfigErrorCarryingItsCode() {
    let error = CloseCodeVerdict.configError(for: 4404)
    #expect(error == GatewayError(.config, "Chat is switched off on this gateway.", closeCode: 4404))
    #expect(CloseCodeVerdict.configError(for: 4401) == nil)
    #expect(CloseCodeVerdict.configError(for: nil) == nil)
  }

  @Test func timeoutTable() {
    #expect(GatewayTimeouts.readyMs == 10_000)
    #expect(GatewayTimeouts.handshakeMs == 15_000)
    #expect(GatewayTimeouts.defaultRPCMs == 30_000)
    #expect(GatewayTimeouts.promptSubmitMs == 30 * 60 * 1000)
    #expect(GatewayTimeouts.firstSessionMs == 60_000)
    #expect(GatewayTimeouts.restMs == 30_000)
    #expect(GatewayTimeouts.probeMs == 10_000)
    #expect(DesktopContract.minimum == 7)
  }

  @Test func aProtocolFailureStartsTheLadderAtTheFloor() {
    #expect(ReconnectBackoff.rung(attempt: 0, failure: .protocol) == 3)
    #expect(ReconnectBackoff.rung(attempt: 5, failure: .protocol) == 5)
    #expect(ReconnectBackoff.rung(attempt: 0, failure: .network) == 0)
    #expect(ReconnectBackoff.rung(attempt: 2, failure: .timeout) == 2)
  }

  @Test func theDefaultLadderNeverDropsBelowHalfItsRung() {
    for attempt in 0...12 {
      let ceiling = ReconnectBackoff.ceilingMs(attempt: Double(attempt))
      #expect(ReconnectBackoff.defaultDelayMs(attempt: Double(attempt)) { 0 } == ceiling / 2)
      #expect(ReconnectBackoff.defaultDelayMs(attempt: Double(attempt)) { 0.999_999 } < ceiling)
      #expect(ceiling <= 15_000)
    }
  }

  @Test func aNaNAttemptDoesNotTrap() {
    #expect(ReconnectBackoff.ceilingMs(attempt: .nan).isNaN)
  }

  @Test func onlyASchemelessAddressGetsACleartextFallback() throws {
    #expect(try GatewayAddress.cleartextFallback(for: "gateway.test:9119/hermes/") == "http://gateway.test:9119/hermes")
    #expect(try GatewayAddress.cleartextFallback(for: "192.0.2.10") == "http://192.0.2.10")
    #expect(try GatewayAddress.cleartextFallback(for: "https://gateway.test") == nil)
    #expect(try GatewayAddress.cleartextFallback(for: "http://gateway.test") == nil)
    #expect(throws: GatewayError(.config, "Enter a gateway address.")) {
      try GatewayAddress.cleartextFallback(for: "  ")
    }
  }

  @Test func systemRandomBytesHaveTheLengthAskedFor() {
    #expect(PKCE.systemRandomBytes(0).isEmpty)
    #expect(PKCE.systemRandomBytes(24).count == 24)

    let pkce = PKCE.create()
    #expect(pkce.verifier.count == 43)
    #expect(pkce.state.count == 32)
    #expect(pkce.challenge.count == 43)
  }
}

/// Parser details the vectors only touch indirectly.
@Suite struct WHATWGURLTests {
  @Test func punycodeMatchesTheRFC3492Samples() {
    #expect(Punycode.encode("bücher") == "bcher-kva")
    #expect(Punycode.encode("münchen") == "mnchen-3ya")
    #expect(Punycode.encode("ü") == "tda")
  }

  @Test func ipv6IsSerialisedCompressedAndLowercase() {
    #expect(WHATWGURL.parse("http://[2001:DB8:0:0:1:0:0:1]/")?.host == "[2001:db8::1:0:0:1]")
    #expect(WHATWGURL.parse("http://[::ffff:192.0.2.1]/")?.host == "[::ffff:c000:201]")
    #expect(WHATWGURL.parse("http://[0:0:0:0:0:0:0:0]/")?.host == "[::]")
    #expect(WHATWGURL.parse("http://[1::2::3]/") == nil)
    #expect(WHATWGURL.parse("http://[fe80::1%25eth0]/") == nil)
  }

  @Test func ipv4NumbersInEveryRadix() {
    #expect(WHATWGURL.parse("http://0300.0250.0.1/")?.host == "192.168.0.1")
    #expect(WHATWGURL.parse("http://192.0.2.1./")?.host == "192.0.2.1")
    #expect(WHATWGURL.parse("http://256.0.0.1/") == nil)
    #expect(WHATWGURL.parse("http://1.2.3.4.5/") == nil)
    #expect(WHATWGURL.parse("http://example.0x/")?.host == nil)
  }

  @Test func queryIsKeptAndFragmentDropped() {
    let url = WHATWGURL.parse("hermie://auth/callback?code=a b#frag")
    #expect(url?.query == "code=a%20b")
    #expect(url?.origin == "null")
  }
}
