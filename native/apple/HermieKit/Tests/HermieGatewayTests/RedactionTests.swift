import Foundation
import Testing

@testable import HermieGateway

/// No token, ticket, secret or header value in any error, description or dump.
@Suite struct RedactionTests {
  static let secrets = [
    "ACCESS-SECRET-1", "REFRESH-SECRET-1", "SESSION-SECRET-1", "TICKET-SECRET-1", "CF-SECRET-1", "CODE-SECRET-1",
    "USER-SECRET-1"
  ]

  /// Every way a value can end up in a log or a failed expectation.
  static func renderings(_ value: Any) -> [String] {
    var dumped = ""
    dump(value, to: &dumped)
    var out = [String(describing: value), String(reflecting: value), dumped]

    if let error = value as? any Error {
      out.append(error.localizedDescription)
      out.append((error as NSError).description)
    }

    return out
  }

  static func assertClean(_ values: [Any], sourceLocation: SourceLocation = #_sourceLocation) {
    for value in values {
      for text in renderings(value) {
        for secret in secrets where text.contains(secret) {
          // Name the type and the secret's label, never the text that carried it.
          Issue.record("a \(type(of: value)) rendering carries secret #\(secrets.firstIndex(of: secret)!)", sourceLocation: sourceLocation)
        }
      }
    }
  }

  @Test("the value types that hold a credential describe themselves without it")
  func valueTypes() {
    let set = TokenSet(accessToken: "ACCESS-SECRET-1", refreshToken: "REFRESH-SECRET-1", expiresAt: 1, provider: "p", userID: "USER-SECRET-1")
    let ticketPlan = DialPlan(
      url: "wss://gateway.test/api/ws",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.TICKET-SECRET-1"],
      headers: ["CF-Access-Client-Secret": "CF-SECRET-1"]
    )
    let tokenPlan = DialPlan(url: "wss://gateway.test/api/ws?token=SESSION-SECRET-1")
    let stored = StoredGatewaySecrets(
      extraHeaders: ["CF-Access-Client-Secret": "CF-SECRET-1"],
      customHeaders: [:],
      frontDoor: .cloudflareAccess(.init(clientID: "id", clientSecret: "CF-SECRET-1", origin: "https://gateway.test")),
      sessionToken: "SESSION-SECRET-1",
      hasCredentials: true,
      canRefresh: true
    )

    let access = FrontDoor.CloudflareAccess(clientID: "USER-SECRET-1", clientSecret: "CF-SECRET-1", origin: "https://gateway.test")
    let request = JSONRequest(
      method: "POST",
      headers: ["authorization": "Bearer ACCESS-SECRET-1", "CF-Access-Client-Secret": "CF-SECRET-1"],
      body: ["refresh_token": "REFRESH-SECRET-1"]
    )

    Self.assertClean([
      set, [set], Optional(set) as Any, ticketPlan, tokenPlan, SessionTokenCredentials(token: "SESSION-SECRET-1"),
      WSTicket(ticket: "TICKET-SECRET-1", ttlSeconds: 30), stored, access, FrontDoor.cloudflareAccess(access), request,
      AuthHeaderOptions(forceRefresh: true, rejectedAccessToken: "ACCESS-SECRET-1"),
      AccessTokenOptions(forceRefresh: true, rejectedAccessToken: "ACCESS-SECRET-1"),
      PKCE(verifier: "CODE-SECRET-1", challenge: "challenge", state: "TICKET-SECRET-1"),
      LoopbackRedirect.code(code: "CODE-SECRET-1", state: "TICKET-SECRET-1"),
      [LoopbackRedirect.code(code: "CODE-SECRET-1", state: "s")]
    ])
    #expect(String(describing: set).contains("expiresAt: 1"))
    #expect(String(describing: ticketPlan).contains("hermes-gateway-v1"))
  }

  @Test("no failure along any credential path quotes a credential")
  func failures() async throws {
    let bearer = AnonymousCredentials(headers: ["authorization": "Bearer ACCESS-SECRET-1"])
    let extra = ["CF-Access-Client-Secret": "CF-SECRET-1"]
    var errors: [any Error] = []

    func collect(_ work: () async throws -> Void) async {
      do {
        try await work()
      } catch {
        errors.append(error)
      }
    }

    for reply in [
      StubReply.status(401), .status(403), .status(404), .status(409), .status(503), .text("<html>x</html>"), .json("[]"),
      .failing("unable to verify the first certificate"), .urlError(.secureConnectionFailed), .urlError(.cannotConnectToHost),
      .redirect(status: 302, location: "https://elsewhere.test/x?token=SESSION-SECRET-1")
    ] {
      let transport = StubServer { _ in reply }.transport()
      let http = try HTTPClient(baseURL: "https://gateway.test", credentials: bearer, extraHeaders: extra, transport: transport)
      let (tokenCoordinator, _) = coordinator(tokens(accessToken: "ACCESS-SECRET-1", refreshToken: "REFRESH-SECRET-1", expiresAt: 10)) { held in
        try await NativeAuth.refreshTokens(
          baseURL: "https://gateway.test",
          refreshToken: held.refreshToken,
          provider: held.provider,
          options: NativeAuth.Options(transport: transport, extraHeaders: extra)
        )
      }
      let pkce = NativePKCECredentials(baseURL: "https://gateway.test", coordinator: tokenCoordinator, extraHeaders: extra, transport: transport)

      await collect { _ = try await http.post("/api/x", body: ["password": "SESSION-SECRET-1"]) }
      await collect { _ = try await http.wsTicket() }
      await collect { _ = try await tokenCoordinator.accessToken() }
      await collect { _ = try await pkce.dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: extra) }
      await collect {
        _ = try await NativeAuth.exchangeCode(
          baseURL: "https://gateway.test",
          code: "CODE-SECRET-1",
          verifier: "CODE-SECRET-1",
          options: NativeAuth.Options(transport: transport, extraHeaders: extra)
        )
      }
      await collect { _ = try await WSTicketMint.mint(baseURL: "https://gateway.test", headers: ["authorization": "Bearer ACCESS-SECRET-1"], transport: transport) }
      await collect { _ = try await Probe.resolveGatewayAddress("gateway.test", customHeaders: extra, transport: transport) }
    }

    let clock = ManualClock()
    let silent = try HTTPClient(
      baseURL: "https://gateway.test",
      credentials: bearer,
      extraHeaders: extra,
      transport: StubServer { _ in .hang }.transport(clock: clock)
    )
    async let timedOut: Void = collect { _ = try await silent.get("/api/x") }
    await clock.waitForSleepers()
    clock.advance(by: .seconds(60))
    await timedOut

    #expect(errors.count > 50)
    Self.assertClean(errors)
  }

  @Test("a sign-in failure carries neither the code nor the verifier")
  func signInFailures() async throws {
    let credentials = NativePKCECredentials(
      baseURL: "https://gateway.test",
      coordinator: coordinator(nil).0,
      transport: StubServer { _ in .status(400) }.transport()
    )
    var errors: [any Error] = []

    _ = try await credentials.beginSignIn()

    do {
      try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=CODE-SECRET-1&state=wrong")
    } catch {
      errors.append(error)
    }

    Self.assertClean(errors + [SignInNavigation.fail(.stateMismatch)])
  }
}
