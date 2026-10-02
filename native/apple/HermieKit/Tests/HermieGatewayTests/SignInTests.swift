import CryptoKit
import Foundation
import HermieProtocol
import Synchronization
import Testing

@_spi(GatewaySync) @testable import HermieGateway

/// A wall clock a test sets.
final class TestWallClock: Sendable {
  private let seconds: Mutex<Double>

  init(_ start: Double) {
    seconds = Mutex(start)
  }

  var now: Double { seconds.withLock { $0 } }

  func set(_ value: Double) {
    seconds.withLock { $0 = value }
  }
}

/// Deterministic randomness: every byte of the n-th call is n.
final class CountingRandom: Sendable {
  private let calls = Mutex<UInt8>(0)

  func bytes(_ count: Int) -> [UInt8] {
    let call = calls.withLock {
      $0 &+= 1
      return $0
    }

    return [UInt8](repeating: call, count: count)
  }
}

func query(_ url: String, _ name: String) -> String? {
  URLComponents(string: url)?.queryItems?.first { $0.name == name }?.value
}

/// The pure navigation rule the sign-in web view follows.
@Suite struct SignInNavigationTests {
  static let gateway = "https://gateway.test"
  static let state = "the-state"

  static func decide(_ url: String, gateway: String = gateway) -> SignInNavigation {
    SignInNavigation.decide(url, expectedState: state, gatewayBaseURL: gateway)
  }

  @Test("loads the gateway's pages and the identity provider's")
  func allowsOrdinaryPages() {
    #expect(Self.decide("https://gateway.test/auth/native/authorize?state=x") == .allow)
    #expect(Self.decide("https://idp.example.com/login") == .allow)
    #expect(Self.decide("about:blank") == .allow)
    #expect(Self.decide("about:srcdoc") == .allow)
  }

  @Test("hands this attempt's callback over instead of loading it, however its port is spelled")
  func callback() {
    #expect(Self.decide("http://127.0.0.1:38007/callback?code=c1&state=the-state") == .callback)
    // The URL parser reads all of these as the callback, and so does the web view.
    #expect(Self.decide("http://127.0.0.1:038007/callback?code=c1&state=the-state") == .callback)
    #expect(Self.decide("HTTP://127.0.0.1:0000038007/callback?code=c1&state=the-state") == .callback)
    #expect(Self.decide("http://2130706433:38007/callback?code=c1&state=the-state") == .callback)
  }

  @Test("drops a code from another attempt, and says what the provider said")
  func failures() {
    #expect(Self.decide("http://127.0.0.1:38007/callback?code=c1&state=someone-else") == .fail(.stateMismatch))
    #expect(SignInNavigation.decide("http://127.0.0.1:38007/callback?code=c1&state=x", expectedState: "", gatewayBaseURL: Self.gateway) == .fail(.stateMismatch))
    #expect(Self.decide("http://127.0.0.1:38007/callback") == .fail(.noCode))
    #expect(
      Self.decide("http://127.0.0.1:38007/callback?error=access_denied&error_description=No")
        == .fail(.provider(error: "access_denied", description: "No"))
    )
  }

  @Test(
    "never loads anything on this device that is not the callback",
    arguments: [
      // Out of range: not a URL the web view would load, refused rather than guessed at.
      "http://127.0.0.1:65536/callback?code=c1&state=the-state",
      "http://127.0.0.1:99999999/callback",
      "http://127.0.0.1:38007",
      "http://127.0.0.1:38007/callback/extra?code=c1&state=the-state",
      "http://127.0.0.1:38008/callback?code=c1&state=the-state",
      "http://[::1]:38007/callback?code=c1&state=the-state",
      "http://127.0.0.2:38007/callback?code=c1&state=the-state",
      "http://localhost:38007/callback?code=c1&state=the-state",
      "http://LOCALHOST:38007/callback",
      "http://localhost./",
      "http://evil.localhost:38007/callback",
      "http://0x7f.1:38008/",
      "http://0177.0.0.1:38008/",
      "http://0.0.0.0:38007/callback",
      "http://[::]:38007/callback",
      "http://[::ffff:127.0.0.1]:38007/callback",
      "http://[::ffff:0:0]:38007/callback",
      "http://[0:0:0:0:0:0:0:1]:38007/callback",
      "https://127.0.0.1:38007/callback?code=c1&state=the-state",
      "https://localhost:1234/",
      "https://[::1]/"
    ]
  )
  func blocksLoopback(_ url: String) {
    #expect(Self.decide(url) == .fail(.blockedNavigation))
  }

  @Test(
    "loads nothing but http and https",
    arguments: [
      "ws://127.0.0.1:38007/", "wss://gateway.test/api/ws", "myapp://callback?code=c1", "file:///etc/passwd",
      "data:text/html,hi", "javascript:alert(1)", "intent://scan#Intent;end", "about:config", "ftp://gateway.test/"
    ]
  )
  func blocksOtherSchemes(_ url: String) {
    #expect(Self.decide(url) == .fail(.blockedNavigation))
  }

  @Test(
    "lets a gateway that runs on this device serve its own pages, and nothing else on loopback",
    arguments: ["http://localhost:9119", "http://127.0.0.1:9119", "http://[::1]:9119"]
  )
  func localGateway(_ gateway: String) {
    #expect(Self.decide("\(gateway)/auth/native/authorize?state=x", gateway: gateway) == .allow)
    #expect(Self.decide("\(gateway)/login", gateway: gateway) == .allow)
    #expect(Self.decide("http://127.0.0.1:38007/callback?code=c&state=the-state", gateway: gateway) == .callback)
    #expect(Self.decide("http://localhost:9120/", gateway: gateway) == .fail(.blockedNavigation))
    #expect(Self.decide("http://127.0.0.1:9120/", gateway: gateway) == .fail(.blockedNavigation))
  }
}

/// `beginSignIn` / `decision(for:)` / `completeSignIn(redirectURL:)` against a stub gateway.
@Suite struct SignInFlowTests {
  static func credentials(_ server: StubServer, store: MemoryTokenStore = MemoryTokenStore()) -> NativePKCECredentials {
    let random = CountingRandom()
    return NativePKCECredentials(
      baseURL: "https://gateway.test",
      coordinator: TokenCoordinator(store: store, refresh: { _ in tokens() }, nowSeconds: { 0 }),
      transport: server.transport(),
      randomBytes: { random.bytes($0) }
    )
  }

  @Test("opens the authorize URL with a challenge for the verifier it keeps, and a fresh state each time")
  func beginSignIn() async throws {
    let credentials = Self.credentials(StubServer { _ in .status(500) })

    let first = try await credentials.beginSignIn(provider: "self-hosted").authorizeURL
    let second = try await credentials.beginSignIn().authorizeURL

    #expect(first.hasPrefix("https://gateway.test/auth/native/authorize?provider=self-hosted&code_challenge="))
    #expect(query(first, "code_challenge_method") == "S256")
    #expect(query(first, "redirect_uri") == PKCE.redirectURI)
    #expect(query(first, "state") != query(second, "state"))
    #expect(query(second, "provider") == nil)
  }

  @Test("completes once, with the verifier that matches the challenge, and saves the tokens")
  func completes() async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at-1\",\"refresh_token\":\"rt-1\",\"expires_at\":5000}") }
    let store = MemoryTokenStore()
    let credentials = Self.credentials(server, store: store)
    let url = try await credentials.beginSignIn().authorizeURL
    let callback = "http://127.0.0.1:38007/callback?code=the-code&state=\(query(url, "state")!)"

    #expect(await credentials.decision(for: callback) == .callback)
    let saved = try await credentials.completeSignIn(redirectURL: callback)

    #expect(saved.accessToken == "at-1")
    #expect(store.load() == saved)

    let body = try JSONValue(parsing: try #require(server.requests.first).bodyText)
    let verifier = try #require(body["code_verifier"]?.stringValue)
    #expect(body["code"] == "the-code")
    #expect(Base64.encodeURL(Array(SHA256.hash(data: Data(verifier.utf8)))) == query(url, "code_challenge"))

    await #expect(throws: SignInFailure.noSignInPending) { try await credentials.completeSignIn(redirectURL: callback) }
  }

  @Test("drops a callback from another attempt without exchanging it, and the attempt is over")
  func stateMismatch() async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at-1\"}") }
    let credentials = Self.credentials(server)
    let url = try await credentials.beginSignIn().authorizeURL

    await #expect(throws: SignInFailure.stateMismatch) {
      try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=c&state=forged")
    }
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=c&state=\(query(url, "state")!)")
    }
    #expect(server.requests.isEmpty)
  }

  @Test("refuses what is not a callback, and a sign-in that never began")
  func notACallback() async throws {
    let credentials = Self.credentials(StubServer { _ in .status(500) })

    await #expect(throws: SignInFailure.noSignInPending) { try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=c&state=s") }

    _ = try await credentials.beginSignIn()
    await #expect(throws: SignInFailure.notACallback) { try await credentials.completeSignIn(redirectURL: "https://gateway.test/") }
  }

  @Test("a used or expired code is the exchange's auth error, and nothing is saved")
  func usedCode() async throws {
    let store = MemoryTokenStore()
    let credentials = Self.credentials(StubServer { _ in .status(400) }, store: store)
    let url = try await credentials.beginSignIn().authorizeURL

    let error = await gatewayError {
      try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=c&state=\(query(url, "state")!)")
    }

    #expect(error?.kind == .auth)
    #expect(error?.status == 400)
    #expect(store.load() == nil)
  }
}

/// A gateway that does native PKCE the way `dashboard_auth` does: one-time
/// codes, rotating refresh tokens with reuse detection, bearer-checked REST,
/// tickets, logout.
final class FakePKCEGateway: Sendable {
  struct State {
    var codes: [String: String] = [:]
    var generation = 0
    var liveAccess: Set<String> = []
    var liveRefresh: String?
    var refreshesSeen: [String] = []
    var revoked = false
  }

  let state = Mutex(State())
  let wall: TestWallClock

  init(wall: TestWallClock) {
    self.wall = wall
  }

  func expectCode(_ code: String, challenge: String) {
    state.withLock { $0.codes[code] = challenge }
  }

  private func mint(_ state: inout State) -> StubReply {
    state.generation += 1
    let access = "at-\(state.generation)"
    let refresh = "rt-\(state.generation)"
    state.liveAccess = [access]
    state.liveRefresh = refresh
    return .json(
      "{\"access_token\":\"\(access)\",\"refresh_token\":\"\(refresh)\",\"expires_at\":\(Int(wall.now) + 3600),"
        + "\"provider\":\"self-hosted\",\"user_id\":\"self-hosted:sam\"}"
    )
  }

  func handle(_ request: StubRequest) -> StubReply {
    state.withLock { state in
      let body = (try? JSONValue(parsing: request.bodyText)) ?? .null
      let bearer = request.header("authorization").flatMap { $0.hasPrefix("Bearer ") ? String($0.dropFirst(7)) : nil }

      switch request.path {
      case "/auth/native/token":
        guard let code = body["code"]?.stringValue, let challenge = state.codes.removeValue(forKey: code),
          let verifier = body["code_verifier"]?.stringValue,
          Base64.encodeURL(Array(SHA256.hash(data: Data(verifier.utf8)))) == challenge
        else {
          return .json("{\"error\":\"invalid_grant\"}", status: 400)
        }

        return mint(&state)
      case "/auth/native/refresh":
        let presented = body["refresh_token"]?.stringValue ?? ""
        state.refreshesSeen.append(presented)

        guard presented == state.liveRefresh else {
          // Reuse detection: a spent refresh token ends the whole grant.
          state.liveRefresh = nil
          state.liveAccess = []
          return .json("{\"error\":\"session_expired\"}", status: 401)
        }

        return mint(&state)
      case "/api/auth/ws-ticket":
        return bearer.map { state.liveAccess.contains($0) } == true ? .json("{\"ticket\":\"tk-\(state.generation)\",\"ttl_seconds\":30}") : .status(401)
      case "/api/thing":
        return bearer.map { state.liveAccess.contains($0) } == true ? .json("{\"ok\":true}") : .status(401)
      case "/auth/native/revoke":
        // Public: a bearer here would be a mistake, and the provider is required.
        guard bearer == nil, body["provider"]?.stringValue?.isEmpty == false else {
          return .status(400)
        }

        if body["refresh_token"]?.stringValue == state.liveRefresh {
          state.revoked = true
          state.liveAccess = []
          state.liveRefresh = nil
        }

        return .status(200)
      default:
        return .status(404)
      }
    }
  }
}

@Suite struct PKCEScenarioTests {
  @Test("sign in, refresh before expiry, survive a rotation and a revoked token, dial, sign out")
  func fullScenario() async throws {
    let wall = TestWallClock(1_000_000)
    let gateway = FakePKCEGateway(wall: wall)
    let server = StubServer { gateway.handle($0) }
    let transport = server.transport()
    let keychain = InMemorySecretStorage()
    let keys = try! GatewaySecretKeys(gatewayID: "g0123abcd")
    let timeline = RecordingTimeline()
    let base = "https://gateway.test"
    let coordinator = TokenCoordinator(
      store: SecretTokenStore(storage: keychain, keys: keys),
      refresh: { held in
        try await NativeAuth.refreshTokens(
          baseURL: base,
          refreshToken: held.refreshToken,
          provider: held.provider,
          options: NativeAuth.Options(transport: transport, timeline: timeline)
        )
      },
      nowSeconds: { wall.now },
      timeline: timeline
    )
    let random = CountingRandom()
    let credentials = NativePKCECredentials(
      baseURL: base,
      coordinator: coordinator,
      canRevoke: true,
      transport: transport,
      timeline: timeline,
      randomBytes: { random.bytes($0) }
    )
    let http = try HTTPClient(baseURL: base, credentials: credentials, transport: transport, timeline: timeline)

    // Sign in: the identity provider sends the browser to the loopback callback.
    let authorize = try await credentials.beginSignIn(provider: "self-hosted").authorizeURL
    gateway.expectCode("code-1", challenge: query(authorize, "code_challenge")!)
    let callback = "http://127.0.0.1:38007/callback?code=code-1&state=\(query(authorize, "state")!)"
    #expect(await credentials.decision(for: callback) == .callback)
    try await credentials.completeSignIn(redirectURL: callback)

    #expect(try keychain.get(keys.accessToken) == "at-1")
    #expect(try keychain.get(keys.refreshToken) == "rt-1")
    #expect(try await http.get("/api/thing") == ["ok": true])

    // Inside the 60 s window: one proactive refresh, and the keychain holds the rotated pair.
    wall.set(1_000_000 + 3600 - 59)
    #expect(try await http.get("/api/thing") == ["ok": true])
    #expect(try keychain.get(keys.refreshToken) == "rt-2")
    #expect(try keychain.get(keys.accessToken) == "at-2")
    #expect(GatewaySecrets.decodeTokenMeta(try keychain.get(keys.tokenMeta)).expiresAt == 1_000_000 + 3600 - 59 + 3600)

    // A second rotation presents the NEW refresh token, never the spent one.
    wall.set(1_000_000 + 2 * 3600)
    #expect(try await http.get("/api/thing") == ["ok": true])
    #expect(gateway.state.withLock { $0.refreshesSeen } == ["rt-1", "rt-2"])

    // The gateway drops the access token: a 401, one refresh, one retry.
    gateway.state.withLock { $0.liveAccess = [] }
    #expect(try await http.get("/api/thing") == ["ok": true])
    #expect(try keychain.get(keys.accessToken) == "at-4")

    // One ticket per dial.
    let plan = try await credentials.dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: [:])
    #expect(plan.protocols == ["hermes-gateway-v1", "hermes-gateway-ticket.tk-4"])

    // Sign out: the gateway hears it, the keychain forgets, and nothing authenticates afterwards.
    try await credentials.signOut()
    #expect(gateway.state.withLock { $0.revoked })
    #expect(try keychain.get(keys.accessToken) == nil)
    #expect(try keychain.get(keys.refreshToken) == nil)
    #expect(try keychain.get(keys.tokenMeta) == nil)
    #expect(await gatewayError { try await http.get("/api/thing") }?.kind == .auth)
    #expect(timeline.names.contains("rest.unauthorized"))
    #expect(timeline.names.filter { $0 == "refresh.ok" }.count == 3)
  }

  @Test("a refresh token the gateway already saw spent ends the session and asks for a sign-in")
  func reuseDetected() async throws {
    let wall = TestWallClock(0)
    let gateway = FakePKCEGateway(wall: wall)
    let server = StubServer { gateway.handle($0) }
    let transport = server.transport()
    let keychain = InMemorySecretStorage()
    let keys = try! GatewaySecretKeys(gatewayID: "g9")
    // A stale pair, as a restore from an old backup would leave it.
    try SecretTokenStore(storage: keychain, keys: keys).save(tokens(accessToken: "at-0", refreshToken: "rt-0", expiresAt: 10))
    let coordinator = TokenCoordinator(
      store: SecretTokenStore(storage: keychain, keys: keys),
      refresh: { held in
        try await NativeAuth.refreshTokens(
          baseURL: "https://gateway.test",
          refreshToken: held.refreshToken,
          provider: held.provider,
          options: NativeAuth.Options(transport: transport)
        )
      },
      nowSeconds: { wall.now }
    )
    let credentials = NativePKCECredentials(baseURL: "https://gateway.test", coordinator: coordinator, transport: transport)

    #expect(try await credentials.onRejected(rejectedToken: "at-0") == .reauth)
    #expect(keychain.keys.isEmpty)
  }
}
