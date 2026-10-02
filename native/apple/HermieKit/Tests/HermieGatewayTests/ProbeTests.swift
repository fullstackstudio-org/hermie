import Foundation
import Testing

@testable import HermieGateway

/// The port of `probe.test.ts`.
@Suite struct ProbeTests {
  static let gatedStatus =
    "{\"version\":\"0.21.3\",\"auth_required\":true,\"auth_providers\":[\"self-hosted\"],\"auth_flows\":[\"cookie\",\"native_pkce\"]}"
  static let ungated = "{\"version\":\"0.21.3\",\"auth_required\":false,\"auth_flows\":[]}"

  static func probe(_ base: String, _ server: StubServer, headers: [String: String] = [:]) async throws -> ProbeResult {
    try await Probe.probeGateway(base, extraHeaders: headers, transport: server.transport())
  }

  // MARK: probeGateway

  @Test("reads an ungated gateway without asking for providers")
  func ungated() async throws {
    let server = StubServer { _ in .json(Self.ungated) }

    let result = try await Self.probe("http://localhost:9119", server)

    #expect(result == ProbeResult(version: "0.21.3", authRequired: false, authFlows: [], providers: [], supportsNativePKCE: false))
    #expect(!server.requests.contains { $0.path == "/api/auth/providers" })
  }

  @Test("reads a gated gateway and its providers")
  func gated() async throws {
    let server = StubServer(routes: [
      "/api/status": .json(Self.gatedStatus),
      "/api/auth/providers": .json(
        "{\"providers\":[{\"name\":\"self-hosted\",\"display_name\":\"Self-Hosted OIDC\",\"supports_password\":false}]}"
      )
    ])

    let result = try await Self.probe("https://gateway.test", server)

    #expect(result.authRequired)
    #expect(result.supportsNativePKCE)
    #expect(result.version == "0.21.3")
    #expect(result.providers == [AuthProvider(name: "self-hosted", displayName: "Self-Hosted OIDC", supportsPassword: false)])
  }

  @Test("treats a 503 from the provider scan as \"no providers\", not a failure")
  func providers503() async throws {
    let server = StubServer(routes: ["/api/status": .json(Self.gatedStatus), "/api/auth/providers": .json("{}", status: 503)])

    let result = try await Self.probe("https://gateway.test", server)

    #expect(result.authRequired)
    #expect(result.providers.isEmpty)
  }

  @Test("sends the extra headers on every call")
  func headersOnEveryCall() async throws {
    let server = StubServer { request in
      .json(request.path.contains("providers") ? "{\"providers\":[]}" : Self.gatedStatus)
    }

    _ = try await Self.probe("https://gateway.test", server, headers: ["CF-Access-Client-Id": "abc"])

    #expect(server.requests.count == 2)
    #expect(server.requests.allSatisfy { $0.header("CF-Access-Client-Id") == "abc" })
  }

  @Test(
    "classifies %s as not_hermes",
    arguments: [
      ("a 404", StubReply.text("nope", status: 404)),
      ("a non-JSON body", StubReply.text("<html>hello</html>")),
      ("JSON without auth_required", StubReply.json("{\"version\":\"1\"}"))
    ]
  )
  func notHermes(_ label: String, _ reply: StubReply) async {
    let error = await gatewayError { try await Self.probe("https://gateway.test", StubServer(routes: ["/api/status": reply])) }

    #expect(error?.kind == .notHermes, "\(label)")
  }

  @Test("classifies a 401 on /api/status as an access-proxy problem")
  func accessProxy() async {
    let error = await gatewayError { try await Self.probe("https://gateway.test", StubServer(routes: ["/api/status": .status(401)])) }

    #expect(error?.kind == .auth)
    #expect(error?.status == 401)
  }

  @Test("classifies a 5xx as a server problem")
  func serverError() async {
    let error = await gatewayError { try await Self.probe("https://gateway.test", StubServer(routes: ["/api/status": .status(502)])) }

    #expect(error?.kind == .server)
    #expect(error?.status == 502)
  }

  @Test("classifies a certificate failure as tls")
  func certificateFailure() async {
    let server = StubServer(routes: ["/api/status": .failing("unable to verify the first certificate")])

    #expect(await gatewayError { try await Self.probe("https://gateway.test", server) }?.kind == .tls)
  }

  @Test("classifies the iOS secure-connection error code as tls")
  func iOSCode() async {
    let server = StubServer(routes: ["/api/status": .failing("code=-1200")])

    #expect(await gatewayError { try await Self.probe("https://gateway.test", server) }?.kind == .tls)
  }

  @Test("classifies an unreachable host as network")
  func unreachable() async {
    let server = StubServer(routes: ["/api/status": .failing("getaddrinfo ENOTFOUND")])

    #expect(await gatewayError { try await Self.probe("https://gateway.test", server) }?.kind == .network)
  }

  @Test("classifies a silent gateway as a timeout")
  func silentGateway() async {
    let clock = ManualClock()
    let server = StubServer { _ in .hang }

    async let error = gatewayError { try await Probe.probeGateway("https://gateway.test", transport: server.transport(clock: clock)) }
    await clock.waitForSleepers()
    clock.advance(by: .milliseconds(Probe.timeoutMs + 1))

    #expect(await error?.kind == .timeout)
  }

  @Test("refuses an address that is not http(s) before it touches the network")
  func refusesWebSocketAddress() async {
    let server = StubServer { _ in .json(Self.ungated) }

    #expect(await gatewayError { try await Self.probe("ws://gateway.test", server) } != nil)
    #expect(server.requests.isEmpty)
  }

  // MARK: resolveGatewayAddress

  /// Answers as a gateway on ONE scheme and fails to connect on the other (`stubScheme`).
  static func stubScheme(_ answersOn: String, failure: String = "connect ECONNREFUSED") -> StubServer {
    StubServer { request in request.scheme == answersOn ? .json(Self.ungated) : .failing(failure) }
  }

  static func resolve(_ raw: String, _ server: StubServer, headers: [String: String] = [:]) async throws -> ResolvedAddress {
    try await Probe.resolveGatewayAddress(raw, customHeaders: headers, transport: server.transport())
  }

  @Test("keeps https when the address has no scheme and https answers")
  func keepsHTTPS() async throws {
    let result = try await Self.resolve("gateway.test", Self.stubScheme("https"))

    #expect(result.baseURL == "https://gateway.test")
    #expect(!result.foundOverHTTP)
    #expect(result.probe.version == "0.21.3")
  }

  @Test("falls back to http when the address has no scheme and nothing answers on https")
  func fallsBack() async throws {
    let result = try await Self.resolve("hermes.tail9f3c.ts.net", Self.stubScheme("http"))

    #expect(result.baseURL == "http://hermes.tail9f3c.ts.net")
    #expect(result.foundOverHTTP)
  }

  @Test("keeps a port and a path prefix across the fallback")
  func keepsPortAndPrefix() async throws {
    let result = try await Self.resolve("192.168.2.250:9119/hermes", Self.stubScheme("http"))

    #expect(result.baseURL == "http://192.168.2.250:9119/hermes")
    #expect(result.foundOverHTTP)
  }

  @Test("never downgrades an address the user typed https:// on")
  func neverDowngrades() async {
    let server = StubServer { _ in .failing("connect ECONNREFUSED") }

    #expect(await gatewayError { try await Self.resolve("https://gateway.test", server) }?.kind == .network)
    #expect(server.requests.map(\.scheme) == ["https"])
  }

  @Test("does not probe https at all when the user typed http://")
  func explicitHTTP() async throws {
    let server = StubServer { _ in .json(Self.ungated) }

    let result = try await Self.resolve("http://192.168.2.250:9119", server)

    #expect(result.baseURL == "http://192.168.2.250:9119")
    #expect(!result.foundOverHTTP)
    #expect(server.requests.map(\.scheme) == ["http"])
  }

  @Test("does not fall back when the certificate was rejected — that is a real https server")
  func noFallbackOnCertificate() async {
    let server = StubServer { _ in .failing("unable to verify the first certificate") }

    #expect(await gatewayError { try await Self.resolve("gateway.test", server) }?.kind == .tls)
    #expect(server.requests.map(\.scheme) == ["https"])
  }

  @Test(
    "does fall back when the %s TLS error is a peer that never spoke TLS",
    arguments: [
      ("iOS", "A TLS error caused the secure connection to fail."),
      ("Android", "javax.net.ssl.SSLException: Unable to parse TLS packet header"),
      ("Node", "write EPROTO ... wrong version number")
    ]
  )
  func fallsBackOnHandshake(_ platform: String, _ message: String) async throws {
    let result = try await Self.resolve("192.168.2.250:9119", Self.stubScheme("http", failure: message))

    #expect(result.baseURL == "http://192.168.2.250:9119", "\(platform)")
    #expect(result.foundOverHTTP)
  }

  @Test(
    "does not fall back when https answered with %s",
    arguments: [("a 404", 404, GatewayErrorKind.notHermes), ("an access proxy", 401, .auth), ("an unhealthy gateway", 502, .server)]
  )
  func noFallbackOnAnswer(_ label: String, _ status: Int, _ kind: GatewayErrorKind) async {
    let server = StubServer { _ in .status(status) }

    #expect(await gatewayError { try await Self.resolve("gateway.test", server) }?.kind == kind, "\(label)")
    #expect(server.requests.map(\.scheme) == ["https"])
  }

  @Test("reports the https failure when neither scheme answers")
  func reportsHTTPSFailure() async {
    let server = StubServer { request in .failing(request.scheme == "https" ? "getaddrinfo ENOTFOUND" : "connect ECONNREFUSED") }

    let error = await gatewayError { try await Self.resolve("gateway.test", server) }

    #expect(error?.kind == .network)
    #expect(error?.message.contains("https://gateway.test") == true)
  }

  @Test("sends the extra headers on both attempts")
  func headersOnBothAttempts() async throws {
    let server = Self.stubScheme("http")
    _ = try await Self.resolve("192.168.2.250:9119", server, headers: ["CF-Access-Client-Id": "abc"])

    #expect(server.requests.map(\.scheme) == ["https", "http"])
    #expect(server.requests.allSatisfy { $0.header("CF-Access-Client-Id") == "abc" })
  }
}

/// What the native probe adds: the auth mode it implies, and the fallback
/// reading the URLError code where the reference reads a message.
@Suite struct ProbePortTests {
  @Test("names the auth mode the native app uses, and whether it can sign in at all")
  func authMode() {
    let ungated = ProbeResult(version: "", authRequired: false, authFlows: [], providers: [], supportsNativePKCE: false)
    let gated = ProbeResult(version: "", authRequired: true, authFlows: ["cookie", "native_pkce"], providers: [], supportsNativePKCE: true)
    let cookieOnly = ProbeResult(version: "", authRequired: true, authFlows: ["cookie"], providers: [], supportsNativePKCE: false)

    #expect(ungated.authMode == .sessionToken && ungated.canSignIn)
    #expect(gated.authMode == .nativePKCE && gated.canSignIn)
    #expect(cookieOnly.authMode == .nativePKCE && !cookieOnly.canSignIn)
  }

  @Test("falls back on NSURLErrorSecureConnectionFailed, never on a certificate code")
  func fallbackByCode() async throws {
    let handshake = StubServer { request in request.scheme == "https" ? .urlError(.secureConnectionFailed) : .json(ProbeTests.ungated) }
    let untrusted = StubServer { request in request.scheme == "https" ? .urlError(.serverCertificateUntrusted) : .json(ProbeTests.ungated) }

    #expect(try await ProbeTests.resolve("192.168.2.250:9119", handshake).foundOverHTTP)
    #expect(await gatewayError { try await ProbeTests.resolve("192.168.2.250:9119", untrusted) }?.kind == .tls)
    #expect(untrusted.requests.map(\.scheme) == ["https"])
  }

  /// The codes measured on real sockets (the table on `HTTPTransport.peerAlertCodes`):
  /// -9836 is what an http-only server's 400 (Node, uvicorn) produces, and also a TLS
  /// server refusing the version, so it falls back as the reference does; -9816 is a
  /// peer that hung up; -9824 only ever comes from a well-formed handshake_failure
  /// alert, so it is an https server and does not fall back.
  @Test(
    "falls back on every -1200 except one only a TLS server produces",
    arguments: [(-9836, true), (-9816, true), (-9824, false), (-9819, true), (-9840, true), (-9806, true), (0, true)]
  )
  func alertUnderSecureConnectionFailed(_ streamCode: Int, _ fallsBack: Bool) async throws {
    var info: [String: any Sendable] = [NSLocalizedDescriptionKey: "An SSL error has occurred."]

    if streamCode != 0 {
      info["_kCFStreamErrorCodeKey"] = streamCode
    }

    let failure = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: info)
    let server = StubServer { request in request.scheme == "https" ? .fail(failure) : .json(ProbeTests.ungated) }

    if fallsBack {
      #expect(try await ProbeTests.resolve("192.168.2.250:9119", server).foundOverHTTP)
    } else {
      #expect(await gatewayError { try await ProbeTests.resolve("192.168.2.250:9119", server) }?.kind == .tls)
      #expect(server.requests.map(\.scheme) == ["https"])
    }
  }

  @Test("finds the alert on an underlying OSStatus error too")
  func alertOnUnderlyingError() {
    let underlying = NSError(domain: NSOSStatusErrorDomain, code: -9824)
    let error = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [NSUnderlyingErrorKey: underlying])
    let plainHTTP = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [NSUnderlyingErrorKey: NSError(domain: NSOSStatusErrorDomain, code: -9836)])

    #expect(HTTPTransport.peerSentAlert(error))
    #expect(!HTTPTransport.peerSentAlert(plainHTTP))
    #expect(!HTTPTransport.peerSentAlert(NSError(domain: NSURLErrorDomain, code: -1200)))
  }

  @Test("a provider with no display name is shown by its name, and a nameless row is dropped")
  func providerRows() async throws {
    let server = StubServer(routes: [
      "/api/status": .json(ProbeTests.gatedStatus),
      "/api/auth/providers": .json("{\"providers\":[{\"name\":\"oidc\"},{\"display_name\":\"x\"},null,{\"name\":\"pw\",\"supports_password\":true}]}")
    ])

    let result = try await ProbeTests.probe("https://gateway.test", server)

    #expect(
      result.providers == [
        AuthProvider(name: "oidc", displayName: "oidc", supportsPassword: false),
        AuthProvider(name: "pw", displayName: "pw", supportsPassword: true)
      ]
    )
  }
}
