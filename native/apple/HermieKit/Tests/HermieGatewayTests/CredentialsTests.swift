import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The port of `credentials.test.ts`.
@Suite struct CredentialsTests {
  /// `ticketFetch`: answers every call with a ticket.
  static func ticketServer(_ ticket: String = "tk-1") -> StubServer {
    StubServer { _ in .json("{\"ticket\":\"\(ticket)\",\"ttl_seconds\":30}") }
  }

  static func credentials(
    baseURL: String = "https://gateway.test",
    _ initial: TokenSet? = tokens(),
    server: StubServer = StubServer { _ in .status(500) },
    refresh: @escaping TokenCoordinator.Refresh = { _ in tokens() }
  ) -> NativePKCECredentials {
    NativePKCECredentials(
      baseURL: baseURL,
      coordinator: coordinator(initial, refresh: refresh).0,
      transport: server.transport()
    )
  }

  // MARK: bearerFrom

  @Test("reads the token back out of a header map")
  func bearerFrom() {
    #expect(GatewayCredentials.bearer(from: ["authorization": "Bearer abc"]) == "abc")
    #expect(GatewayCredentials.bearer(from: ["Authorization": "Bearer abc"]) == "abc")
    #expect(GatewayCredentials.bearer(from: ["authorization": "Basic abc"]) == nil)
    #expect(GatewayCredentials.bearer(from: [:]) == nil)
  }

  // MARK: NativePkceCredentials

  @Test("authenticates HTTP with a bearer token")
  func bearerHeaders() async throws {
    let credentials = Self.credentials()

    #expect(try await credentials.httpAuthHeaders(AuthHeaderOptions()) == ["authorization": "Bearer at-1"])
    #expect(credentials.mode == .nativePKCE)
  }

  @Test("refuses to build headers once the user is signed out")
  func signedOutHeaders() async {
    let error = await gatewayError { try await Self.credentials(nil).httpAuthHeaders(AuthHeaderOptions()) }

    #expect(error?.kind == .auth)
  }

  @Test("mints one ticket per dial and offers it as a subprotocol")
  func mintsTicket() async throws {
    let server = Self.ticketServer("tk-abc")
    let credentials = Self.credentials(server: server)

    let plan = try await credentials.dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: ["CF-Access-Client-Id": "x"])

    #expect(plan.url == "wss://gateway.test/api/ws")
    #expect(plan.protocols == [GatewayCredentials.webSocketProtocol, "\(GatewayCredentials.webSocketTicketPrefix)tk-abc"])
    #expect(plan.headers == ["CF-Access-Client-Id": "x"])

    let request = try #require(server.requests.first)
    #expect(request.url == "https://gateway.test/api/auth/ws-ticket")
    #expect(request.method == "POST")
    #expect(request.header("authorization") == "Bearer at-1")
    #expect(request.header("CF-Access-Client-Id") == "x")
  }

  @Test("reports a ticket-mint 401 as an auth failure")
  func mint401() async {
    let server = StubServer { _ in .json("{}", status: 401) }
    let error = await gatewayError {
      try await Self.credentials(server: server).dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: [:])
    }

    #expect(error?.kind == .auth)
  }

  @Test("reports a ticket-mint 502 as a server failure, which the dial loop retries")
  func mint502() async {
    let server = StubServer { _ in .json("{}", status: 502) }
    let error = await gatewayError {
      try await Self.credentials(server: server).dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: [:])
    }

    #expect(error?.kind == .server)
  }

  // MARK: an address that answered, but not as a gateway

  static func mint(_ reply: StubReply, baseURL: String = "https://hermes.example.com") async -> GatewayError? {
    await gatewayError {
      try await Self.credentials(baseURL: baseURL, server: StubServer { _ in reply })
        .dialPlan(wsURL: "wss://hermes.example.com/api/ws", extraHeaders: [:])
    }
  }

  @Test("says what it saw, and does not guess why")
  func notAGatewaySaysWhatItSaw() async {
    let error = await Self.mint(.text("<!doctype html><html></html>", status: 405))

    #expect(error?.kind == .protocol)
    #expect(error?.status == 405)
    #expect(
      error?.message
        == "The address answered HTTP 405, but not as a Hermes gateway. This looks like a landing page, not a Hermes gateway."
    )
    // A PUBLIC host answering with a page says nothing about a tailnet.
    #expect(error?.message.contains("private network or tailnet") == false)
  }

  @Test("names whoever answered, when the answer said so")
  func notAGatewayNamesServer() async {
    let error = await Self.mint(.text("nope", status: 405, headers: ["server": "nginx/1.27.0"]))

    #expect(error?.message == "The address answered HTTP 405, but not as a Hermes gateway. The answer came from nginx/1.27.0.")
  }

  @Test("says nothing about who answered when no header named them")
  func notAGatewayNoServer() async {
    let error = await Self.mint(.text("nope", status: 405))

    #expect(error?.message == "The address answered HTTP 405, but not as a Hermes gateway.")
  }

  @Test("carries the network sentence as a hint for a host that is on one")
  func notAGatewayNetworkHint() async {
    let error = await gatewayError {
      try await Self.credentials(baseURL: "http://gateway.ts.net", server: StubServer { _ in .text("nope", status: 405) })
        .dialPlan(wsURL: "ws://gateway.ts.net/api/ws", extraHeaders: [:])
    }

    #expect(error?.hint?.contains("private network or tailnet") == true)
    #expect(error?.message.contains("private network or tailnet") == true)
  }

  @Test("asks for a retry when a refresh succeeds and for a sign-in when it does not")
  func onRejected() async throws {
    let good = Self.credentials(tokens(expiresAt: 1)) { _ in tokens(accessToken: "at-2") }
    #expect(try await good.onRejected(rejectedToken: "at-1") == .retry)

    let gone = Self.credentials(nil)
    #expect(try await gone.onRejected(rejectedToken: nil) == .reauth)
  }

  @Test("signs out by clearing the coordinator")
  func signOutClears() async throws {
    let server = StubServer { _ in .status(204) }
    let credentials = Self.credentials(server: server)

    try await credentials.signOut()

    #expect(try await credentials.coordinator.current() == nil)
  }

  // MARK: SessionTokenCredentials

  static let session = SessionTokenCredentials(token: "sekrit")

  @Test("authenticates HTTP with the session-token header")
  func sessionHeader() async throws {
    #expect(try await Self.session.httpAuthHeaders(AuthHeaderOptions()) == [GatewayCredentials.sessionTokenHeader: "sekrit"])
    #expect(Self.session.mode == .sessionToken)
  }

  @Test("puts the token in the WebSocket query string and offers no subprotocol")
  func sessionDialPlan() async throws {
    let plan = try await Self.session.dialPlan(wsURL: "ws://127.0.0.1:9119/api/ws", extraHeaders: [:])

    #expect(plan.url == "ws://127.0.0.1:9119/api/ws?token=sekrit")
    #expect(plan.protocols.isEmpty)
  }

  @Test("always asks for a new sign-in, because a static token cannot be rotated")
  func sessionReauth() async throws {
    #expect(try await Self.session.onRejected(rejectedToken: nil) == .reauth)
  }
}

/// What the native port adds around the reference's providers.
@Suite struct CredentialsPortTests {
  @Test("a session token is form-encoded into the query, and an existing token parameter is replaced")
  func sessionTokenQuery() async throws {
    let credentials = SessionTokenCredentials(token: "a b&c=d/é")

    let fresh = try await credentials.dialPlan(wsURL: "wss://gateway.test/prefix/api/ws", extraHeaders: ["X": "1"])
    #expect(fresh.url == "wss://gateway.test/prefix/api/ws?token=a+b%26c%3Dd%2F%C3%A9")
    #expect(fresh.headers == ["X": "1"])

    let replaced = try await credentials.dialPlan(wsURL: "wss://gateway.test/api/ws?a=1&token=old&token=older", extraHeaders: [:])
    #expect(replaced.url == "wss://gateway.test/api/ws?a=1&token=a+b%26c%3Dd%2F%C3%A9")
  }

  @Test("a stored gateway naming the cookie flow gets a sign-in-again path, not a crash")
  func cookieModeSignsInAgain() async throws {
    let provider = GatewayCredentials.provider(
      mode: .cookie,
      baseURL: "https://gateway.test",
      sessionToken: nil,
      coordinator: nil
    )

    #expect(provider.mode == .cookie)
    #expect(await gatewayError { try await provider.httpAuthHeaders(AuthHeaderOptions()) }?.kind == .auth)
    #expect(await gatewayError { try await provider.dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: [:]) }?.status == 401)
    #expect(try await provider.onRejected(rejectedToken: nil) == .reauth)
    try await provider.signOut()
  }

  @Test("the factory picks the provider by mode")
  func factory() {
    let (tokenCoordinator, _) = coordinator(tokens())

    #expect(GatewayCredentials.provider(mode: .sessionToken, baseURL: "https://g.test", sessionToken: "t", coordinator: nil) is SessionTokenCredentials)
    #expect(GatewayCredentials.provider(mode: .nativePKCE, baseURL: "https://g.test", sessionToken: nil, coordinator: tokenCoordinator) is NativePKCECredentials)
    #expect(GatewayCredentials.provider(mode: .nativePKCE, baseURL: "https://g.test", sessionToken: nil, coordinator: nil) is SignInRequiredCredentials)
  }

  @Test("records the mint, and a failed mint with its status")
  func mintTimeline() async throws {
    let timeline = RecordingTimeline()
    let good = StubServer { _ in .json("{\"ticket\":\"tk\"}") }
    let refused = StubServer { _ in .status(401) }

    _ = try await WSTicketMint.mint(baseURL: "https://gateway.test", headers: [:], transport: good.transport(), timeline: timeline)
    _ = await gatewayError {
      try await WSTicketMint.mint(baseURL: "https://gateway.test", headers: [:], transport: refused.transport(), timeline: timeline)
    }

    #expect(timeline.events == [AuthEvent(.ticketMinted), AuthEvent(.ticketFailed, status: 401, kind: .auth)])
  }

  @Test("signing out wipes the tokens here and tells the gateway, best effort, with the bearer it held")
  func signOutTellsTheGateway() async throws {
    let server = StubServer { _ in .failing("offline") }
    let (tokenCoordinator, store) = coordinator(tokens())
    let credentials = NativePKCECredentials(baseURL: "https://gateway.test", coordinator: tokenCoordinator, transport: server.transport())

    try await credentials.signOut()

    #expect(await store.load() == nil)
    #expect(server.requests.map(\.path) == ["/auth/logout"])
    #expect(server.requests.first?.method == "POST")
    #expect(server.requests.first?.header("authorization") == "Bearer at-1")
  }
}
