#if os(macOS)
import HermieGateway
import HermieProtocol
import Testing

private let sessionToken = "integration-session-token"

extension Integration {
  /// REST with the shared session token of an ungated gateway: the header
  /// goes out, the gateway reads it, and a wrong one is an `auth` failure.
  @Suite("Session token REST", .fakeGateway(FakeGateway.Options(auth: .token, token: sessionToken)))
  struct SessionTokenIntegrationTests {
    static let token = sessionToken

    func client(token: String = sessionToken) throws -> HTTPClient {
      try HTTPClient(baseURL: try FakeGateway.shared.baseURL, credentials: SessionTokenCredentials(token: token))
    }

    @Test("/api/auth/me answers the single tester of an ungated gateway")
    func authMe() async throws {
      let me = try await client().authMe()

      #expect(me.userID == "tester@example.invalid")
      #expect(me.email == "tester@example.invalid")
      #expect(me.displayName == "Fake Tester")
      #expect(me.provider == "none")
      #expect(me.expiresAt > 0)
    }

    @Test("/api/profiles lists the fake's two profiles")
    func profiles() async throws {
      let body = try #require(try await client().get(RESTPath.profiles)?.objectValue)
      let names = ProfilesResponse(json: body).profiles?.compactMap(\.name)

      #expect(names == ["researcher", "writer"])
    }

    @Test("a wrong token is an auth failure with the gateway's 401, after no retry")
    func wrongToken() async throws {
      let error = await #expect(throws: GatewayError.self) {
        try await client(token: "not-the-token").authMe()
      }

      #expect(error?.kind == .auth)
      #expect(error?.status == 401)
    }

    @Test("no token at all is the same auth failure")
    func emptyToken() async throws {
      let error = await #expect(throws: GatewayError.self) {
        try await client(token: "").get(RESTPath.profiles)
      }

      #expect(error?.kind == .auth)
      #expect(error?.status == 401)
    }

    @Test("an unknown route is a protocol failure, not an auth one")
    func unknownRoute() async throws {
      let error = await #expect(throws: GatewayError.self) {
        try await client().get("/api/no-such-route")
      }

      #expect(error?.kind == .protocol)
      #expect(error?.status == 404)
    }

    @Test("the WebSocket needs no ticket here: the token rides on the URL")
    func dialPlan() async throws {
      let gateway = try FakeGateway.shared
      let wsURL = try GatewayAddress.webSocketURL(for: gateway.baseURL)
      let plan = try await SessionTokenCredentials(token: Self.token).dialPlan(wsURL: wsURL, extraHeaders: [:])

      #expect(wsURL == gateway.wsURL)
      #expect(plan.url == "\(gateway.wsURL)?token=\(Self.token)")
      #expect(plan.protocols.isEmpty)
    }

    @Test("the gateway still mints a ticket for a token caller, and refuses a wrong token")
    func ticket() async throws {
      let ticket = try await client().wsTicket()
      #expect(ticket.ticket.hasPrefix("tk-"))
      #expect(ticket.ttlSeconds == 30)

      let error = await #expect(throws: GatewayError.self) {
        try await client(token: "not-the-token").wsTicket()
      }
      #expect(error?.kind == .auth)
    }
  }

  @Suite("Ungated REST", .fakeGateway())
  struct UngatedRESTIntegrationTests {
    @Test("a gateway with no auth at all answers without a token")
    func noAuth() async throws {
      let http = try HTTPClient(baseURL: try FakeGateway.shared.baseURL, credentials: SessionTokenCredentials(token: ""))
      let me = try await http.authMe()

      #expect(me.userID == "tester@example.invalid")
      #expect(me.provider == "none")
    }
  }
}
#endif
