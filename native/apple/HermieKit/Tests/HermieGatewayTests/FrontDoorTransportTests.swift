import Foundation
import Testing

@testable import HermieGateway

/// The port of `front-door-transport.test.ts`: the headers a front door
/// produces reach every request the app makes, and none on a cleartext gateway.
@Suite struct FrontDoorTransportTests {
  static let secret = "cf-secret-value-nobody-may-print"
  static let access = FrontDoor.cloudflareAccess(
    .init(clientID: "abc123.access", clientSecret: secret, origin: "https://gateway.example.com")
  )
  static let base = "https://gateway.example.com"
  static let headers = access.headers(for: base)

  /// What the probe's two calls answer on a gateway that is happy.
  static func okGateway() -> StubServer {
    StubServer { request in
      request.path.hasSuffix("/api/status")
        ? .json("{\"auth_required\":false,\"auth_flows\":[],\"version\":\"1.2.3\"}")
        : .json("{\"providers\":[]}")
    }
  }

  // MARK: a REST call

  @Test("carries the front door beside the credential")
  func restCarriesFrontDoor() async throws {
    let server = StubServer { _ in .json("{}") }
    let http = try HTTPClient(
      baseURL: Self.base,
      credentials: SessionTokenCredentials(token: "st-1"),
      extraHeaders: Self.headers,
      transport: server.transport()
    )

    _ = try await http.get("/api/status")

    let sent = try #require(server.requests.first)
    #expect(sent.header(FrontDoor.clientIDHeader) == "abc123.access")
    #expect(sent.header(FrontDoor.clientSecretHeader) == Self.secret)
  }

  @Test("hands them to the loader that fetches images the client does not fetch itself")
  func requestHeaders() async throws {
    let http = try HTTPClient(baseURL: Self.base, credentials: SessionTokenCredentials(token: "st-1"), extraHeaders: Self.headers)
    let headers = try await http.requestHeaders()

    for (name, value) in Self.headers {
      #expect(headers[name] == value)
    }
  }

  // MARK: the WebSocket dial

  @Test("puts them on the upgrade, where React Native can set headers")
  func upgradeHeaders() async throws {
    let plan = try await SessionTokenCredentials(token: "st-1").dialPlan(wsURL: "wss://gateway.example.com/api/ws", extraHeaders: Self.headers)

    #expect(plan.headers == Self.headers)
  }

  @Test("puts them on the ticket mint the dial makes first")
  func ticketMintHeaders() async throws {
    let server = StubServer { _ in .json("{\"ticket\":\"tk-1\",\"ttl_seconds\":30}") }
    let store = MemoryTokenStore(TokenSet(accessToken: "at-1", refreshToken: "rt-1", expiresAt: 10_000, provider: "p", userID: "u"))
    let credentials = NativePKCECredentials(
      baseURL: Self.base,
      coordinator: TokenCoordinator(store: store, refresh: { _ in throw PlainFailure(description: "not reached") }, nowSeconds: { 0 }),
      extraHeaders: Self.headers,
      transport: server.transport()
    )

    let plan = try await credentials.dialPlan(wsURL: "wss://gateway.example.com/api/ws", extraHeaders: Self.headers)

    #expect(plan.headers == Self.headers)

    let minted = try #require(server.requests.first)
    #expect(minted.header(FrontDoor.clientIDHeader) == "abc123.access")
    #expect(minted.header(FrontDoor.clientSecretHeader) == Self.secret)
  }

  // MARK: the probe

  @Test("carries the front door on /api/status, which runs before any credential exists")
  func probeStatus() async throws {
    let server = Self.okGateway()

    _ = try await Probe.probeGateway(Self.base, extraHeaders: Self.headers, transport: server.transport())

    let sent = try #require(server.requests.first)
    #expect(sent.header(FrontDoor.clientIDHeader) == "abc123.access")
    #expect(sent.header(FrontDoor.clientSecretHeader) == Self.secret)
  }

  @Test("carries it onto the provider scan as well, which is a second request to the same edge")
  func probeProviders() async throws {
    let server = StubServer { request in
      request.path.hasSuffix("/api/status")
        ? .json("{\"auth_required\":true,\"auth_flows\":[\"native_pkce\"],\"version\":\"1.2.3\"}")
        : .json("{\"providers\":[{\"name\":\"oidc\",\"display_name\":\"OIDC\"}]}")
    }

    _ = try await Probe.probeGateway(Self.base, extraHeaders: Self.headers, transport: server.transport())

    #expect(server.requests.count == 2)
    #expect(server.requests[1].header(FrontDoor.clientSecretHeader) == Self.secret)
  }

  @Test("sends nothing extra when no front door is configured")
  func probeNothingExtra() async throws {
    let server = Self.okGateway()

    _ = try await Probe.probeGateway(Self.base, transport: server.transport())

    // URLSession adds its own transport headers (Accept-Encoding and the like) past the
    // protocol stub; what this client set is `accept` and nothing else.
    let sent = try #require(server.requests.first)
    #expect(sent.headers.keys.filter { !["accept-encoding", "accept-language", "user-agent", "connection"].contains($0) } == ["accept"])
  }

  // MARK: a cleartext gateway

  @Test("reaches the transport with nothing to send, because the headers were never built")
  func cleartextWithheld() async throws {
    let server = Self.okGateway()
    let withheld = Self.access.headers(for: "http://gateway.example.com")

    _ = try await Probe.probeGateway("http://gateway.example.com", extraHeaders: withheld, transport: server.transport())

    let sent = try #require(server.requests.first)
    #expect(!sent.headers.values.contains(Self.secret))
    #expect(!sent.headers.values.contains("abc123.access"))
  }
}
