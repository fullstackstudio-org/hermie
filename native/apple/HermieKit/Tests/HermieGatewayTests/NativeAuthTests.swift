import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The port of `native-auth.test.ts`: the two token endpoints, the refresh
/// window, and the token coordinator on a test clock.
@Suite struct NativeAuthTests {
  static let base = "https://gateway.test"

  /// `respondWith`: every call answers this status and body.
  static func respond(_ status: Int, _ body: String) -> NativeAuth.Options {
    NativeAuth.Options(transport: StubServer { _ in .json(body, status: status) }.transport())
  }

  static func exchange(_ options: NativeAuth.Options) async throws -> TokenSet {
    try await NativeAuth.exchangeCode(baseURL: base, code: "c", verifier: "v", options: options)
  }

  static func refresh(_ status: Int, _ body: String = "{}") async -> GatewayError? {
    await gatewayError {
      try await NativeAuth.refreshTokens(baseURL: base, refreshToken: "rt", provider: "p", options: respond(status, body))
    }
  }

  // MARK: exchangeCode

  @Test("maps the bearer payload onto a TokenSet")
  func exchangeMaps() async throws {
    let tokens = try await Self.exchange(
      Self.respond(
        200,
        "{\"access_token\":\"at\",\"refresh_token\":\"rt\",\"expires_at\":123,\"provider\":\"self-hosted\",\"user_id\":\"tester\"}"
      )
    )

    #expect(tokens == TokenSet(accessToken: "at", refreshToken: "rt", expiresAt: 123, provider: "self-hosted", userID: "tester"))
  }

  @Test("sends the code and verifier as snake_case JSON")
  func exchangeSendsSnakeCase() async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at\"}") }

    _ = try await NativeAuth.exchangeCode(
      baseURL: Self.base,
      code: "the-code",
      verifier: "the-verifier",
      options: NativeAuth.Options(transport: server.transport())
    )

    let request = try #require(server.requests.first)
    #expect(request.url == "https://gateway.test/auth/native/token")
    #expect(request.method == "POST")
    #expect(try JSONValue(parsing: request.bodyText) == ["code": "the-code", "code_verifier": "the-verifier"])
  }

  @Test("turns a used or expired code (400) into an auth error")
  func exchange400() async {
    let error = await gatewayError { try await Self.exchange(Self.respond(400, "{}")) }

    #expect(error?.kind == .auth)
    #expect(error?.status == 400)
  }

  @Test("turns a 503 into a server error")
  func exchange503() async {
    #expect(await gatewayError { try await Self.exchange(Self.respond(503, "{}")) }?.kind == .server)
  }

  @Test("records a sign-in that cannot be refreshed, and still returns the tokens")
  func exchangeNoRefresh() async throws {
    let timeline = RecordingTimeline()
    var options = Self.respond(200, "{\"access_token\":\"at\",\"provider\":\"self-hosted\"}")
    options.timeline = timeline

    let tokens = try await Self.exchange(options)

    #expect(tokens.accessToken == "at")
    #expect(tokens.refreshToken == "")
    #expect(timeline.names == ["signin.no_refresh"])
  }

  @Test("says nothing when the exchange did produce a refresh token")
  func exchangeWithRefreshIsQuiet() async throws {
    let timeline = RecordingTimeline()
    var options = Self.respond(200, "{\"access_token\":\"at\",\"refresh_token\":\"rt\"}")
    options.timeline = timeline

    _ = try await Self.exchange(options)

    #expect(timeline.events.isEmpty)
  }

  @Test("rejects a 200 without an access token")
  func exchangeWithoutAccessToken() async {
    #expect(await gatewayError { try await Self.exchange(Self.respond(200, "{\"ok\":true}")) }?.kind == .protocol)
  }

  // MARK: refreshTokens

  @Test("rotates and returns the new set")
  func refreshRotates() async throws {
    let rotated = try await NativeAuth.refreshTokens(
      baseURL: Self.base,
      refreshToken: "rt-1",
      provider: "self-hosted",
      options: Self.respond(200, "{\"access_token\":\"at-2\",\"refresh_token\":\"rt-2\",\"expires_at\":9}")
    )

    #expect(rotated.accessToken == "at-2")
    #expect(rotated.refreshToken == "rt-2")
  }

  @Test("maps 401 session_expired onto auth")
  func refresh401() async {
    let error = await Self.refresh(401, "{\"error\":\"session_expired\"}")

    #expect(error?.kind == .auth)
    #expect(error?.status == 401)
  }

  @Test("maps 503 onto server, because the same refresh token is still worth retrying")
  func refresh503() async {
    let error = await Self.refresh(503)

    #expect(error?.kind == .server)
    #expect(error?.status == 503)
  }

  @Test("maps 429 onto server, so a throttled refresh is retried rather than signed out")
  func refresh429() async {
    let error = await Self.refresh(429)

    #expect(error?.kind == .server)
    #expect(error?.status == 429)
  }

  @Test("maps 408 onto server, because a request timeout says nothing about the grant")
  func refresh408() async {
    let error = await Self.refresh(408)

    #expect(error?.kind == .server)
    #expect(error?.status == 408)
  }

  @Test("keeps %i as a definitive auth rejection", arguments: [400, 401, 403])
  func refreshDefinitive(_ status: Int) async {
    let error = await Self.refresh(status)

    #expect(error?.kind == .auth)
    #expect(error?.status == status)
  }

  @Test("refuses to call the gateway without a refresh token")
  func refreshWithoutToken() async {
    let server = StubServer { _ in .json("{}") }
    let error = await gatewayError {
      try await NativeAuth.refreshTokens(
        baseURL: Self.base,
        refreshToken: "",
        provider: "p",
        options: NativeAuth.Options(transport: server.transport())
      )
    }

    #expect(error?.kind == .auth)
    #expect(server.requests.isEmpty)
  }

  // MARK: tokenNeedsRefresh

  @Test("is true inside the 60 second window and false outside it")
  func refreshWindow() {
    #expect(NativeAuth.tokenNeedsRefresh(tokens(expiresAt: 1000), nowSeconds: 950))
    #expect(!NativeAuth.tokenNeedsRefresh(tokens(expiresAt: 1000), nowSeconds: 939))
    #expect(NativeAuth.tokenNeedsRefresh(tokens(expiresAt: 1000), nowSeconds: 1200))
  }

  @Test("never refreshes a set without an expiry")
  func noExpiry() {
    #expect(!NativeAuth.tokenNeedsRefresh(tokens(expiresAt: 0), nowSeconds: 1_000_000))
  }
}

/// The `TokenCoordinator` half of `native-auth.test.ts`.
@Suite struct TokenCoordinatorTests {
  @Test("hands back the stored token while it is comfortably valid")
  func servesStored() async throws {
    let calls = Counter()
    let (coordinator, _) = coordinator(tokens(expiresAt: 1000)) { _ in
      calls.increment()
      return tokens()
    }

    #expect(try await coordinator.accessToken() == "at-1")
    #expect(calls.count == 0)
  }

  @Test("refreshes proactively inside the skew window")
  func refreshesInWindow() async throws {
    let calls = Counter()
    let (coordinator, _) = coordinator(tokens(expiresAt: 1000), now: 960) { _ in
      calls.increment()
      return tokens(accessToken: "at-2", expiresAt: 2000)
    }

    #expect(try await coordinator.accessToken() == "at-2")
    #expect(calls.count == 1)
  }

  @Test("runs one refresh for concurrent callers")
  func singleFlight() async throws {
    let gate = Gate()
    let started = Gate()
    let calls = Counter()
    let (coordinator, _) = coordinator(tokens(expiresAt: 10)) { _ in
      calls.increment()
      await started.open()
      await gate.wait()
      return tokens(accessToken: "at-2", expiresAt: 5000)
    }

    let first = Task { try await coordinator.accessToken(AccessTokenOptions(forceRefresh: true)) }
    await started.wait()
    let second = Task { try await coordinator.accessToken(AccessTokenOptions(forceRefresh: true)) }
    await waitForJoins(coordinator, 1)
    await gate.open()

    #expect(try await first.value == "at-2")
    #expect(try await second.value == "at-2")
    #expect(calls.count == 1)
  }

  @Test("does not rotate again for a 401 about a token that was already replaced")
  func lateRejection() async throws {
    let calls = Counter()
    let (coordinator, _) = coordinator(tokens(accessToken: "at-2", expiresAt: 10_000)) { _ in
      calls.increment()
      return tokens(accessToken: "at-3")
    }

    #expect(try await coordinator.accessToken(AccessTokenOptions(forceRefresh: true, rejectedAccessToken: "at-1")) == "at-2")
    #expect(calls.count == 0)
  }

  @Test("clears the tokens when the refresh is rejected as expired")
  func clearsOnRejection() async throws {
    let (coordinator, store) = coordinator(tokens(expiresAt: 10)) { _ in
      throw GatewayError(.auth, "expired", status: 401)
    }

    #expect(try await coordinator.accessToken() == nil)
    #expect(store.load() == nil)
  }

  @Test("propagates a transport failure instead of signing the user out")
  func keepsOnTransportFailure() async throws {
    let (coordinator, store) = coordinator(tokens(expiresAt: 10)) { _ in
      throw GatewayError(.server, "idp down", status: 503)
    }

    let error = await gatewayError { try await coordinator.accessToken() }

    #expect(error?.kind == .server)
    #expect(store.load() != nil)
  }

  @Test("fences a rotation that a sign-out raced")
  func fencesRotation() async throws {
    let gate = Gate()
    let started = Gate()
    let (coordinator, store) = coordinator(tokens(expiresAt: 10)) { _ in
      await started.open()
      await gate.wait()
      return tokens(accessToken: "at-late")
    }

    let pending = Task { try await coordinator.accessToken() }
    await started.wait()
    try await coordinator.clear()
    await gate.open()

    await #expect(throws: AuthChangedError.self) { try await pending.value }
    #expect(store.load() == nil)
  }

  /// The reference fences an async read with the auth epoch. Here the store is
  /// synchronous and called on the coordinator's actor, so a sign-in cannot
  /// land inside a slow read at all: it waits for it, and then wins.
  @Test("fences a store read that a sign-in raced")
  func fencesRead() async throws {
    let reading = Counter()
    let store = ScriptedTokenStore(onLoad: {
      reading.increment()
      Thread.sleep(forTimeInterval: 0.03)
      return tokens(accessToken: "at-old")
    })
    let coordinator = TokenCoordinator(store: store, refresh: { _ in tokens() }, nowSeconds: { 0 })

    let pending = Task { try await coordinator.current() }
    await waitUntil { reading.count == 1 }
    try await coordinator.save(tokens(accessToken: "at-new"))
    #expect(try await pending.value?.accessToken == "at-old")

    #expect(try await coordinator.current()?.accessToken == "at-new")
  }

  @Test("forgets a set with no refresh token rather than looping on it")
  func forgetsWithoutRefreshToken() async throws {
    let (coordinator, store) = coordinator(tokens(refreshToken: "", expiresAt: 10))

    #expect(try await coordinator.accessToken() == nil)
    #expect(store.load() == nil)
  }

  @Test("retries a store read that failed instead of memoising the failure")
  func retriesFailedRead() async throws {
    let attempts = Counter()
    let store = ScriptedTokenStore(onLoad: {
      if attempts.increment() == 1 {
        throw PlainFailure(description: "keychain unavailable")
      }

      return tokens(expiresAt: 10_000)
    })
    let coordinator = TokenCoordinator(store: store, refresh: { _ in tokens() }, nowSeconds: { 0 })

    await #expect(throws: PlainFailure.self) { try await coordinator.current() }
    #expect(try await coordinator.current()?.accessToken == "at-1")
    #expect(attempts.count == 2)
  }

  @Test("serves a rotated token whose write failed, and records the failed write")
  func servesAfterFailedWrite() async throws {
    let timeline = RecordingTimeline()
    let store = ScriptedTokenStore(
      onLoad: { tokens(expiresAt: 10) },
      onSave: { _ in throw PlainFailure(description: "keychain write refused") }
    )
    let coordinator = TokenCoordinator(
      store: store,
      refresh: { _ in tokens(accessToken: "at-2", refreshToken: "rt-2", expiresAt: 5000) },
      nowSeconds: { 0 },
      timeline: timeline
    )

    #expect(try await coordinator.accessToken() == "at-2")
    #expect(timeline.names == ["refresh.start", "refresh.ok", "token.write_failed"])
    // Still usable for the rest of this process, without another rotation.
    #expect(try await coordinator.accessToken() == "at-2")
  }

  @Test("records a rotation that reached the store")
  func recordsRotation() async throws {
    let timeline = RecordingTimeline()
    let (coordinator, _) = coordinator(tokens(expiresAt: 10), timeline: timeline) { _ in tokens(accessToken: "at-2", expiresAt: 5000) }

    _ = try await coordinator.accessToken()

    #expect(timeline.names == ["refresh.start", "refresh.ok", "token.write_ok"])
  }

  @Test("records a definitive rejection as the reason the tokens were cleared")
  func recordsRejection() async throws {
    let timeline = RecordingTimeline()
    let (coordinator, _) = coordinator(tokens(expiresAt: 10), timeline: timeline) { _ in
      throw GatewayError(.auth, "expired", status: 401)
    }

    #expect(try await coordinator.accessToken() == nil)
    #expect(timeline.names == ["refresh.start", "refresh.failed", "token.cleared"])
    #expect(timeline.events[1] == AuthEvent(.refreshFailed, status: 401, kind: .auth))
  }

  @Test("records the remaining lifetime it read when it served a stored token")
  func recordsLifetime() async throws {
    let timeline = RecordingTimeline()
    let (coordinator, _) = coordinator(tokens(expiresAt: 1000), now: 400, timeline: timeline)

    _ = try await coordinator.accessToken()

    #expect(timeline.events == [AuthEvent(.tokenServed, expiresIn: 600)])
  }
}

/// What the Swift coordinator must hold beyond the reference's cases.
@Suite struct TokenCoordinatorConcurrencyTests {
  @Test("many callers racing into an expiring token share exactly one refresh")
  func manyCallersOneRefresh() async throws {
    let calls = Counter()
    let gate = Gate()
    let (coordinator, store) = coordinator(tokens(expiresAt: 10)) { _ in
      calls.increment()
      await gate.wait()
      return tokens(accessToken: "at-2", refreshToken: "rt-2", expiresAt: 5000)
    }

    try await withThrowingTaskGroup(of: String?.self) { group in
      for _ in 0..<50 {
        group.addTask { try await coordinator.accessToken() }
      }

      try await Task.sleep(for: .milliseconds(10))
      await gate.open()

      for try await token in group {
        #expect(token == "at-2")
      }
    }

    #expect(calls.count == 1)
    #expect(store.load()?.refreshToken == "rt-2")
  }

  @Test("a 401 for the token a rotation just replaced joins that rotation instead of starting another")
  func lateRejectionJoinsFlight() async throws {
    let calls = Counter()
    let gate = Gate()
    let started = Gate()
    let (coordinator, _) = coordinator(tokens(expiresAt: 10)) { _ in
      calls.increment()
      await started.open()
      await gate.wait()
      return tokens(accessToken: "at-2", expiresAt: 5000)
    }

    let first = Task { try await coordinator.accessToken() }
    await started.wait()
    let late = Task { try await coordinator.accessToken(AccessTokenOptions(forceRefresh: true, rejectedAccessToken: "at-1")) }
    await waitForJoins(coordinator, 1)
    await gate.open()

    #expect(try await first.value == "at-2")
    #expect(try await late.value == "at-2")
    #expect(calls.count == 1)
  }
}
