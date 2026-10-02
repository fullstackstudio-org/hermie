#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

extension Integration {
  /// Native PKCE end to end against a gated gateway, without a web view. Every
  /// test signs in, rotates or revokes, so each takes a gateway of its own.
  @Suite("Native PKCE sign-in")
  struct NativeSignInIntegrationTests {
    static let gated = FakeGateway.Options(auth: .native)

    @Test("sign in, call REST, rotate on expiry, and revoke on sign-out")
    func fullLifecycle() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        #expect(session.probe.supportsNativeRevoke)

        // Sign-in, and what landed in the secret store.
        let signedIn = try await session.signIn()
        #expect(signedIn.accessToken.hasPrefix("at-"))
        #expect(signedIn.refreshToken.hasPrefix("rt-"))
        #expect(signedIn.provider == "self-hosted")
        #expect(signedIn.userID == "tester@example.invalid")
        #expect(try session.storage.get(session.keys.accessToken) == signedIn.accessToken)
        #expect(try session.storage.get(session.keys.refreshToken) == signedIn.refreshToken)

        // An authenticated call with the bearer.
        let me = try await session.http.authMe()
        #expect(me.userID == "tester@example.invalid")
        #expect(me.provider == "self-hosted")
        #expect(try await session.coordinator.current() == signedIn)

        // The access token runs out (the client's clock moves an hour on):
        // the next call rotates first, and the gateway takes the new token.
        session.clock.advance(bySeconds: 3_600)
        let profiles = try #require(try await session.http.get(RESTPath.profiles)?.objectValue)
        #expect(ProfilesResponse(json: profiles).profiles?.isEmpty == false)

        let rotated = try #require(try await session.coordinator.current())
        #expect(rotated.accessToken != signedIn.accessToken)
        #expect(rotated.refreshToken != signedIn.refreshToken)
        #expect(try session.storage.get(session.keys.refreshToken) == rotated.refreshToken)

        // The refresh token just spent is dead at the gateway.
        let spent = await #expect(throws: GatewayError.self) {
          try await NativeAuth.refreshTokens(
            baseURL: gateway.baseURL,
            refreshToken: signedIn.refreshToken,
            provider: signedIn.provider
          )
        }
        #expect(spent?.kind == .auth)
        #expect(spent?.status == 401)

        // Sign-out hands the live grant back, then wipes.
        try await session.credentials.signOut()
        #expect(try await session.coordinator.current() == nil)
        #expect(session.storage.keys.isEmpty)

        let revoked = await #expect(throws: GatewayError.self) {
          try await NativeAuth.refreshTokens(
            baseURL: gateway.baseURL,
            refreshToken: rotated.refreshToken,
            provider: rotated.provider
          )
        }
        #expect(revoked?.kind == .auth)
        #expect(revoked?.status == 401)

        // Signed out: nothing goes out with a credential any more.
        let after = await #expect(throws: GatewayError.self) { try await session.http.authMe() }
        #expect(after?.kind == .auth)
      }
    }

    @Test("a 401 for a token the gateway does not know rotates once and retries")
    func rejectedAccessTokenRotates() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        let signedIn = try await session.signIn()

        // Still in date as far as the client knows, but not a token the gateway issued.
        var stale = signedIn
        stale.accessToken = "at-the-gateway-never-issued-this"
        try await session.coordinator.save(stale)

        let me = try await session.http.authMe()
        #expect(me.userID == "tester@example.invalid")

        let current = try #require(try await session.coordinator.current())
        #expect(current.accessToken != stale.accessToken)
        #expect(current.refreshToken != signedIn.refreshToken)
      }
    }

    @Test("without the revoke route, sign-out still wipes, and sends nothing the gateway cannot take")
    func signOutWithoutRevoke() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native, nativeRevoke: false)) { gateway in
        let session = try await NativeSession(gateway: gateway)
        #expect(!session.probe.supportsNativeRevoke)

        let signedIn = try await session.signIn()
        try await session.credentials.signOut()

        #expect(try await session.coordinator.current() == nil)
        #expect(session.storage.keys.isEmpty)

        // Nothing was revoked: the grant still rotates at the gateway.
        let rotated = try await NativeAuth.refreshTokens(
          baseURL: gateway.baseURL,
          refreshToken: signedIn.refreshToken,
          provider: signedIn.provider
        )
        #expect(rotated.accessToken.hasPrefix("at-"))
      }
    }

    @Test("a refresh the gateway refuses signs the client out")
    func refusedRefreshSignsOut() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        let signedIn = try await session.signIn()

        // Somebody else spends the refresh token first.
        _ = try await NativeAuth.refreshTokens(
          baseURL: gateway.baseURL,
          refreshToken: signedIn.refreshToken,
          provider: signedIn.provider
        )

        session.clock.advance(bySeconds: 3_600)
        let error = await #expect(throws: GatewayError.self) { try await session.http.authMe() }

        #expect(error?.kind == .auth)
        #expect(try await session.coordinator.current() == nil)
        #expect(session.storage.keys.isEmpty)
      }
    }

    @Test("a code is redeemed once, and only with its own verifier")
    func codeIsSingleUse() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        let start = try await session.credentials.beginSignIn()
        let callback = try await NativeSession.authorize(start.authorizeURL)
        let code = try #require(URLComponents(string: callback)?.queryItems?.first { $0.name == "code" }?.value)

        // The wrong verifier burns the code at the gateway...
        let wrong = await #expect(throws: GatewayError.self) {
          try await NativeAuth.exchangeCode(baseURL: gateway.baseURL, code: code, verifier: String(repeating: "v", count: 64))
        }
        #expect(wrong?.kind == .auth)
        #expect(wrong?.status == 400)

        // ...so the attempt that owned it cannot redeem it either, and is over.
        let burnt = await #expect(throws: GatewayError.self) {
          try await session.credentials.completeSignIn(redirectURL: callback)
        }
        #expect(burnt?.status == 400)
        await #expect(throws: SignInFailure.noSignInPending) {
          try await session.credentials.completeSignIn(redirectURL: callback)
        }
        #expect(try await session.coordinator.current() == nil)
      }
    }

    @Test("a callback carrying another attempt's state is refused and never redeemed")
    func stateMismatch() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        let first = try await session.credentials.beginSignIn()
        let firstCallback = try await NativeSession.authorize(first.authorizeURL)

        // A second attempt replaces the first; the first one's callback is now somebody else's.
        _ = try await session.credentials.beginSignIn()
        #expect(await session.credentials.decision(for: firstCallback) == .fail(.stateMismatch))

        // The refusal ended the attempt, and nothing was redeemed.
        await #expect(throws: SignInFailure.noSignInPending) {
          try await session.credentials.completeSignIn(redirectURL: firstCallback)
        }
        #expect(try await session.coordinator.current() == nil)
      }
    }

    @Test("the dial plan carries a fresh single-use ticket for every dial")
    func ticketPerDial() async throws {
      try await FakeGateway.with(Self.gated) { gateway in
        let session = try await NativeSession(gateway: gateway)
        try await session.signIn()

        let wsURL = try GatewayAddress.webSocketURL(for: gateway.baseURL)
        let first = try await session.credentials.dialPlan(wsURL: wsURL, extraHeaders: [:])
        let second = try await session.credentials.dialPlan(wsURL: wsURL, extraHeaders: [:])

        #expect(first.url == gateway.wsURL)
        #expect(first.protocols.count == 2)
        #expect(first.protocols.first == GatewayCredentials.webSocketProtocol)
        #expect(first.protocols.last?.hasPrefix(GatewayCredentials.webSocketTicketPrefix + "tk-") == true)
        #expect(first.protocols.last != second.protocols.last)
        #expect(first.headers.isEmpty)

        let ticket = try await session.http.wsTicket()
        #expect(ticket.ticket.hasPrefix("tk-"))
        #expect(ticket.ttlSeconds == 30)

        let refused = await #expect(throws: GatewayError.self) {
          try await WSTicketMint.mint(
            baseURL: gateway.baseURL,
            headers: ["authorization": "Bearer at-not-issued"],
            transport: HTTPTransport()
          )
        }
        #expect(refused?.kind == .auth)
        #expect(refused?.status == 401)
      }
    }
  }
}
#endif
