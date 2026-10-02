import Foundation
import Testing

@testable import HermieGateway

/// No credential crosses a redirect, and no redirect downgrades: every call
/// refuses a redirect to another origin before anything is sent there, and
/// only the unauthenticated probe follows one that stays on its origin.
@Suite struct RedirectSecurityTests {
  /// `gateway.test` points everything at `elsewhere`; `elsewhere.test` would answer anything.
  static func hijacked(to location: String = "https://elsewhere.test/steal") -> StubServer {
    StubServer { request in
      request.host == "gateway.test" ? .redirect(status: 307, location: location) : .json("{\"ticket\":\"tk\",\"access_token\":\"x\"}")
    }
  }

  @Test("an authenticated REST call is not followed to another host, and that host hears nothing")
  func authenticatedCall() async throws {
    let server = Self.hijacked()
    let http = try HTTPClient(
      baseURL: "https://gateway.test",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      extraHeaders: ["CF-Access-Client-Secret": "cf-secret"],
      transport: server.transport()
    )

    let error = await gatewayError { try await http.get("/api/sessions") }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedTo == "https://elsewhere.test")
    #expect(error?.status == 307)
    #expect(server.requests.map(\.host) == ["gateway.test"])
  }

  @Test("the ticket mint is not followed to another host")
  func ticketMint() async {
    let server = Self.hijacked()
    let credentials = NativePKCECredentials(
      baseURL: "https://gateway.test",
      coordinator: coordinator(tokens()).0,
      transport: server.transport()
    )

    let error = await gatewayError { try await credentials.dialPlan(wsURL: "wss://gateway.test/api/ws", extraHeaders: [:]) }

    #expect(error?.kind == .redirect)
    #expect(server.requests.map(\.host) == ["gateway.test"])
  }

  @Test("the refresh call is not followed to another host, and the redirect is not a sign-out")
  func refreshCall() async throws {
    let server = Self.hijacked()
    let options = NativeAuth.Options(transport: server.transport())
    let (tokenCoordinator, store) = coordinator(tokens(expiresAt: 10)) { held in
      try await NativeAuth.refreshTokens(baseURL: "https://gateway.test", refreshToken: held.refreshToken, provider: held.provider, options: options)
    }

    let error = await gatewayError { try await tokenCoordinator.accessToken() }

    #expect(error?.kind == .redirect)
    #expect(server.requests.map(\.host) == ["gateway.test"])
    #expect(server.requests.first?.path == "/auth/native/refresh")
    #expect(await store.load()?.refreshToken == "rt-1")
  }

  @Test("the code exchange is not followed to another host")
  func exchange() async {
    let server = Self.hijacked()

    let error = await gatewayError {
      try await NativeAuth.exchangeCode(
        baseURL: "https://gateway.test",
        code: "c",
        verifier: "v",
        options: NativeAuth.Options(transport: server.transport())
      )
    }

    #expect(error?.kind == .redirect)
    #expect(server.requests.count == 1)
  }

  @Test("https to http on the same host is refused, on the probe as everywhere else")
  func downgrade() async throws {
    let server = StubServer { request in
      request.scheme == "https" ? .redirect(status: 301, location: "http://gateway.test/api/status") : .json("{\"auth_required\":false}")
    }

    let probe = await gatewayError { try await Probe.probeGateway("https://gateway.test", transport: server.transport()) }
    let http = try HTTPClient(baseURL: "https://gateway.test", credentials: AnonymousCredentials(), transport: server.transport())
    let call = await gatewayError { try await http.get("/api/status") }

    #expect(probe?.kind == .redirect)
    #expect(probe?.redirectedTo == "http://gateway.test")
    #expect(call?.kind == .redirect)
    #expect(server.requests.allSatisfy { $0.scheme == "https" })
  }

  @Test("a change of port on the same host is another origin")
  func portChange() async {
    let server = StubServer { request in
      URL(string: request.url)?.port == 8443 ? .json("{\"auth_required\":false}") : .redirect(status: 302, location: "https://gateway.test:8443/api/status")
    }

    let error = await gatewayError { try await Probe.probeGateway("https://gateway.test", transport: server.transport()) }

    #expect(error?.redirectedTo == "https://gateway.test:8443")
    #expect(server.requests.count == 1)
  }

  @Test("an IPv6 origin is named with brackets")
  func ipv6Origin() async {
    let server = StubServer { request in
      request.host == "gateway.test" ? .redirect(status: 302, location: "http://[fd7a:115c:a1e0::1]:9119/api/status") : .json("{}")
    }

    let error = await gatewayError { try await Probe.probeGateway("https://gateway.test", transport: server.transport()) }

    #expect(error?.redirectedTo == "http://[fd7a:115c:a1e0::1]:9119")
  }

  @Test("an authenticated call follows no redirect at all, not even on its own origin")
  func authenticatedSameOrigin() async throws {
    let server = StubServer { request in
      request.path == "/api/old" ? .redirect(status: 308, location: "/api/new") : .json("{}")
    }
    let http = try HTTPClient(
      baseURL: "https://gateway.test",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      transport: server.transport()
    )

    let error = await gatewayError { try await http.get("/api/old") }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedTo == "https://gateway.test")
    #expect(server.requests.map(\.path) == ["/api/old"])
  }

  @Test("the probe's same-origin redirect may not turn into a cross-origin one on the next hop")
  func chainLeavesOrigin() async {
    let server = StubServer { request in
      switch (request.host, request.path) {
      case ("gateway.test", "/api/status"): .redirect(status: 301, location: "/api/status/")
      case ("gateway.test", _): .redirect(status: 301, location: "https://elsewhere.test/api/status")
      default: .json("{\"auth_required\":false}")
      }
    }

    let error = await gatewayError { try await Probe.probeGateway("https://gateway.test", transport: server.transport()) }

    #expect(error?.redirectedTo == "https://elsewhere.test")
    #expect(server.requests.allSatisfy { $0.host == "gateway.test" })
  }
}
