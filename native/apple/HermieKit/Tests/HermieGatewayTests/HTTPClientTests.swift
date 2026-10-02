import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The port of `http.test.ts` (`authMe`'s `picture_url`, `fetchAuthenticatedPicture`).
@Suite struct HTTPTests {
  static let base = "http://gateway.test"

  static func http(_ server: StubServer, credentials: any CredentialProvider = AnonymousCredentials()) throws -> HTTPClient {
    try HTTPClient(baseURL: base, credentials: credentials, transport: server.transport())
  }

  // MARK: authMe

  @Test("parses picture_url when the gateway sends one")
  func parsesPictureURL() async throws {
    let server = StubServer { _ in
      .json(
        """
        {"user_id":"self-hosted:sam-sub","email":"sam@example.test","display_name":"Sam","org_id":"",\
        "provider":"self-hosted","expires_at":0,"picture_url":"/api/auth/picture?id=self-hosted%3Asam-sub"}
        """,
        headers: ["content-type": "application/json"]
      )
    }

    let identity = try await Self.http(server).authMe()

    #expect(identity.pictureURL == "/api/auth/picture?id=self-hosted%3Asam-sub")
    #expect(identity.email == "sam@example.test")
  }

  @Test("answers an empty pictureUrl from an upstream gateway that never sends the field")
  func emptyPictureURL() async throws {
    let server = StubServer { _ in
      .json("{\"user_id\":\"x\",\"email\":\"\",\"display_name\":\"\",\"org_id\":\"\",\"provider\":\"\",\"expires_at\":0}")
    }

    #expect(try await Self.http(server).authMe().pictureURL == "")
  }

  // MARK: fetchAuthenticatedPicture

  @Test("returns a data: URI for a 200 image, carrying the response content-type")
  func pictureDataURI() async throws {
    let server = StubServer { _ in
      .respond(status: 200, body: Data([0x89, 0x50, 0x4E, 0x47]), headers: ["content-type": "image/png"])
    }

    let outcome = try await Self.http(server).fetchAuthenticatedPicture("/api/auth/picture?id=self-hosted%3Asam-sub")

    guard case .ready(let uri) = outcome else {
      Issue.record("expected ready, got \(outcome)")
      return
    }

    #expect(uri.hasPrefix("data:image/png;base64,"))
  }

  @Test("answers \"missing\" on a 404 and never throws")
  func pictureMissing() async throws {
    let server = StubServer { _ in .text("not found", status: 404) }

    #expect(try await Self.http(server).fetchAuthenticatedPicture("/api/auth/picture?id=nobody") == .missing)
  }

  @Test("answers \"error\" on a 401 once the credential provider says reauth")
  func pictureReauth() async throws {
    let server = StubServer { _ in .text("nope", status: 401) }

    #expect(try await Self.http(server).fetchAuthenticatedPicture("/api/auth/picture?id=x") == .error)
  }

  @Test("retries once on 401 when the credential provider says retry, and succeeds")
  func pictureRetry() async throws {
    let calls = Counter()
    let server = StubServer { _ in
      calls.increment() == 1
        ? .text("nope", status: 401)
        : .respond(status: 200, body: Data([1, 2, 3]), headers: ["content-type": "image/jpeg"])
    }

    let outcome = try await Self.http(server, credentials: AnonymousCredentials(verdict: .retry))
      .fetchAuthenticatedPicture("/api/auth/picture?id=x")

    #expect(calls.count == 2)

    guard case .ready = outcome else {
      Issue.record("expected ready, got \(outcome)")
      return
    }
  }

  @Test("answers \"error\" rather than throwing when the network call rejects")
  func pictureNetworkDown() async throws {
    let server = StubServer { _ in .failing("network down") }

    #expect(try await Self.http(server).fetchAuthenticatedPicture("/api/auth/picture?id=x") == .error)
  }

  @Test("sends the credential provider auth headers on the picture request")
  func pictureSendsAuth() async throws {
    let server = StubServer { _ in .respond(status: 200, body: Data([1]), headers: ["content-type": "image/png"]) }

    _ = try await Self.http(server, credentials: AnonymousCredentials(headers: ["authorization": "Bearer tok"]))
      .fetchAuthenticatedPicture("/api/auth/picture?id=x")

    #expect(server.requests.first?.header("authorization") == "Bearer tok")
  }
}

/// What `GatewayHttp` does that `http.test.ts` does not pin: the 401 flow, the
/// status mapping and the transport rules every call goes through.
@Suite struct HTTPClientBehaviourTests {
  static let base = "https://gateway.test"

  /// A provider whose bearer rotates when it is rejected, counting both.
  actor RotatingCredentials: CredentialProvider {
    nonisolated let mode = GatewayAuthMode.nativePKCE
    private(set) var current = "at-1"
    private(set) var rejected: [String?] = []
    var verdict: RejectionVerdict

    init(verdict: RejectionVerdict) {
      self.verdict = verdict
    }

    func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] {
      ["authorization": "Bearer \(current)"]
    }

    func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan { DialPlan(url: wsURL) }

    func onRejected(rejectedToken: String?) async throws -> RejectionVerdict {
      rejected.append(rejectedToken)
      current = "at-2"
      return verdict
    }

    func signOut() async throws {}
  }

  @Test("a 401 asks the provider once, names the refused token, and retries once with the fresh one")
  func unauthorizedRetriesOnce() async throws {
    let timeline = RecordingTimeline()
    let credentials = RotatingCredentials(verdict: .retry)
    let server = StubServer { request in
      request.header("authorization") == "Bearer at-2" ? .json("{\"ok\":true}") : .text("", status: 401)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: credentials, transport: server.transport(), timeline: timeline)

    #expect(try await http.get("/api/thing") == ["ok": true])
    #expect(await credentials.rejected == ["at-1"])
    #expect(server.requests.map { $0.header("authorization") } == ["Bearer at-1", "Bearer at-2"])
    #expect(timeline.events == [AuthEvent(.restUnauthorized, status: 401, kind: .auth)])
  }

  @Test("a 401 the provider cannot answer is a sign-in-again auth error, and nothing is retried")
  func unauthorizedReauth() async throws {
    let server = StubServer { _ in .text("", status: 401) }
    let http = try HTTPClient(
      baseURL: Self.base,
      credentials: RotatingCredentials(verdict: .reauth),
      transport: server.transport()
    )
    let error = await gatewayError { try await http.post("/api/thing", body: ["a": 1]) }

    #expect(error == GatewayError(.auth, "The gateway rejected the credentials for POST /api/thing. Sign in again.", status: 401))
    #expect(server.requests.count == 1)
  }

  @Test("a second 401 after the retry is an auth error, not a loop")
  func secondUnauthorized() async throws {
    let server = StubServer { _ in .text("", status: 401) }
    let http = try HTTPClient(baseURL: Self.base, credentials: RotatingCredentials(verdict: .retry), transport: server.transport())
    let error = await gatewayError { try await http.get("/api/thing") }

    #expect(error == GatewayError(.auth, "The gateway refused GET /api/thing (HTTP 401).", status: 401))
    #expect(server.requests.count == 2)
  }

  @Test(
    "maps a status the way the reference does",
    arguments: [
      (403, GatewayError(.auth, "The gateway refused GET /api/x (HTTP 403).", status: 403)),
      (404, GatewayError(.protocol, "The gateway has no GET /api/x endpoint (HTTP 404).", status: 404)),
      (502, GatewayError(.server, "The gateway answered HTTP 502 on GET /api/x.", status: 502)),
      (409, GatewayError(.protocol, "GET /api/x failed with HTTP 409.", status: 409))
    ]
  )
  func statusMapping(_ status: Int, _ expected: GatewayError) async throws {
    let server = StubServer { _ in .text("<html>nope</html>", status: status) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    #expect(await gatewayError { try await http.get("/api/x") } == expected)
  }

  @Test("a refusal's own sentence rides on the hint, and only a string detail of an object counts")
  func detailHint() async throws {
    let server = StubServer { request in
      request.path == "/api/a" ? .json("{\"detail\":\"Card 7 is blocked by card 3.\"}", status: 409) : .json("{\"detail\":[1]}", status: 422)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    #expect(await gatewayError { try await http.post("/api/a") }?.hint == "Card 7 is blocked by card 3.")
    #expect(await gatewayError { try await http.post("/api/b") }?.hint == nil)
  }

  @Test("sends the extra headers beside the credential, JSON in and out, never cached")
  func sendsHeadersAndBody() async throws {
    let server = StubServer { _ in .json("{}") }
    let http = try HTTPClient(
      baseURL: Self.base + "/prefix",
      credentials: AnonymousCredentials(headers: ["X-Hermes-Session-Token": "st"]),
      extraHeaders: ["X-Extra": "1"],
      transport: server.transport()
    )

    _ = try await http.patch("/api/profiles/a", body: ["name": "b"])

    let request = try #require(server.requests.first)
    #expect(request.url == "https://gateway.test/prefix/api/profiles/a")
    #expect(request.method == "PATCH")
    #expect(request.header("x-extra") == "1")
    #expect(request.header("x-hermes-session-token") == "st")
    #expect(request.header("accept") == "application/json")
    #expect(request.header("content-type") == "application/json")
    #expect(try JSONValue(parsing: request.bodyText) == ["name": "b"])
    #expect(request.header("cookie") == nil)
  }

  @Test("refuses an extra header the transport owns, as the reference's constructor does")
  func refusesBlockedHeader() {
    #expect(throws: GatewayError.self) {
      try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), extraHeaders: ["Authorization": "x"])
    }
  }

  @Test("times a silent gateway out on the injected clock with the default REST window")
  func restTimeout() async throws {
    let clock = ManualClock()
    let server = StubServer { _ in .hang }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport(clock: clock))

    async let outcome = gatewayError { try await http.get("/api/slow") }
    await clock.waitForSleepers()
    clock.advance(by: .milliseconds(GatewayTimeouts.restMs - 1))
    #expect(clock.sleeperCount == 1)
    clock.advance(by: .milliseconds(1))

    #expect(await outcome == GatewayError(.timeout, "https://gateway.test/api/slow did not answer within 30 seconds."))
  }

  @Test("a cancelled call is a network error that says so")
  func cancelled() async throws {
    let server = StubServer { _ in .hang }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let task = Task { await gatewayError { try await http.get("/api/slow") } }

    try await Task.sleep(for: .milliseconds(20))
    task.cancel()

    #expect(await task.value == GatewayError(.network, "The request to https://gateway.test/api/slow was cancelled."))
  }

  @Test("a TLS failure is told apart by its URLError code, in any language")
  func tlsByCode() async {
    let handshake = StubServer { _ in .urlError(.secureConnectionFailed) }
    let certificate = StubServer { _ in .urlError(.serverCertificateHasBadDate) }
    let refused = StubServer { _ in .urlError(.cannotConnectToHost) }

    let first = await gatewayError { try await handshake.transport().requestText("https://gateway.test/api/status") }
    let second = await gatewayError { try await certificate.transport().requestText("https://gateway.test/api/status") }
    let third = await gatewayError { try await refused.transport().requestText("https://gateway.test/api/status") }

    #expect(first?.kind == .tls)
    #expect(first?.message.hasPrefix("The TLS handshake with https://gateway.test/api/status failed: ") == true)
    #expect(second?.kind == .tls)
    #expect(second?.message.hasPrefix("The TLS certificate for https://gateway.test/api/status was rejected: ") == true)
    #expect(third?.kind == .network)
    #expect(third?.message.hasPrefix("Could not reach https://gateway.test/api/status: ") == true)
  }

  @Test("drops a UTF-8 byte order mark the way Response.text() does")
  func dropsBOM() async throws {
    let server = StubServer { _ in .respond(status: 200, body: Data([0xEF, 0xBB, 0xBF]) + Data("{\"a\":1}".utf8), headers: [:]) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    #expect(try await http.get("/api/x") == ["a": 1])
  }
}
