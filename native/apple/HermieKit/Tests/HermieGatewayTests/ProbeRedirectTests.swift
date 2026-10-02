import Foundation
import Testing

@testable import HermieGateway

/// The port of `probe-redirect.test.ts`. The reference runs its redirect cases
/// against two fake gateways; here the stubbed `URLProtocol` answers the 3xx
/// and records whether anything reached the second host
/// (`RealListenerRedirectTests` repeats one case on real sockets).
@Suite struct ProbeRedirectTests {
  static let ungated = "{\"version\":\"0.21.3\",\"auth_required\":false,\"auth_flows\":[]}"

  /// The old address, still answering, pointing at `location`; anything that
  /// reaches another host answers as a gateway.
  static func moved(to location: String, from host: String = "127.0.0.1") -> StubServer {
    StubServer { request in
      request.host == host ? .redirect(status: 301, location: location) : .json(Self.ungated)
    }
  }

  // MARK: an address that redirects somewhere else

  @Test("is refused, named, and nothing is read from it")
  func refusedAndNamed() async {
    let server = Self.moved(to: "http://localhost:9119/api/status")

    let error = await gatewayError { try await Probe.probeGateway("http://127.0.0.1:9119", transport: server.transport()) }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedTo == "http://localhost:9119")
    #expect(error?.message.contains("redirected to") == true)
    #expect(server.requests.map(\.host) == ["127.0.0.1"])
  }

  @Test("is still reported when the scheme-less fallback is what found it")
  func reportedThroughFallback() async {
    let server = StubServer { request in
      if request.scheme == "https" {
        return .failing("connect ECONNREFUSED")
      }

      return request.host == "127.0.0.1" ? .redirect(status: 301, location: "http://localhost:9119/api/status") : .json(Self.ungated)
    }

    let error = await gatewayError { try await Probe.resolveGatewayAddress("127.0.0.1:9119", transport: server.transport()) }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedTo == "http://localhost:9119")
  }

  @Test("is refused when the new address names the old host after an `@` in its path")
  func atInPath() async {
    let server = Self.moved(to: "http://localhost:9119/@127.0.0.1")

    let error = await gatewayError { try await Probe.probeGateway("http://127.0.0.1:9119", transport: server.transport()) }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedTo == "http://localhost:9119")
  }

  @Test("follows a redirect that stays on the same host without comment")
  func sameOriginFollowed() async throws {
    let server = StubServer { request in
      request.path == "/hermes/api/status" ? .redirect(status: 308, location: "/api/status") : .json(Self.ungated)
    }

    let probe = try await Probe.probeGateway("http://127.0.0.1:9119/hermes", transport: server.transport())

    #expect(!probe.authRequired)
    #expect(server.requests.map(\.path) == ["/hermes/api/status", "/api/status"])
  }

  // MARK: every request

  @Test("goes out with the platform cache switched off")
  func noStore() async throws {
    let server = StubServer { _ in .json("{}") }

    _ = try await server.transport().requestText("https://gateway.example/api/status")

    #expect(server.requests.first?.cachePolicy == .reloadIgnoringLocalCacheData)
    #expect(server.requests.first?.handlesCookies == false)
    #expect(HTTPTransport.sharedSession.configuration.urlCache == nil)
    #expect(HTTPTransport.sharedSession.configuration.httpCookieStorage == nil)
  }

  // MARK: "answered, but not like a Hermes gateway"

  static let landing = "<!doctype html><html><body><h1>It works</h1></body></html>"

  @Test("says so plainly for a public host that answered with JSON of its own")
  func publicJSON() {
    #expect(Probe.notHermesHint(baseURL: "https://api.example.com", body: "{\"ok\":true}") == "")
  }

  @Test("names the network when the host is only reachable on one")
  func privateNetwork() {
    for address in ["http://192.168.1.10:9120", "http://gateway.ts.net", "http://100.101.102.103", "nas.local"] {
      #expect(Probe.notHermesHint(baseURL: address, body: "{\"ok\":true}").contains("private network or tailnet"), "\(address)")
    }
  }

  @Test("does not ask whether this device is on its own loopback")
  func loopback() {
    #expect(Probe.notHermesHint(baseURL: "http://localhost:9119", body: "{\"ok\":true}") == "")
    #expect(
      Probe.notHermesHint(baseURL: "http://127.0.0.1:9119", body: Self.landing)
        == "This looks like a landing page, not a Hermes gateway."
    )
  }

  @Test("says only what it saw when a public host answered with a page")
  func publicLandingPage() {
    #expect(
      Probe.notHermesHint(baseURL: "https://hermes.example.com", body: Self.landing)
        == "This looks like a landing page, not a Hermes gateway."
    )
  }

  @Test("adds the network sentence behind it when the host is on a network of its own")
  func landingPlusNetwork() {
    let hint = Probe.notHermesHint(baseURL: "http://gateway.ts.net", body: Self.landing)

    #expect(hint.hasPrefix("This looks like a landing page, not a Hermes gateway."))
    #expect(hint.contains("private network or tailnet"))
  }

  @Test("reaches the failure the reader actually sees")
  func reachesTheFailure() async {
    let server = StubServer { _ in .text(Self.landing, headers: ["content-type": "text/html"]) }

    let error = await gatewayError { try await Probe.probeGateway("https://hermes.example.com", transport: server.transport()) }

    #expect(error?.kind == .notHermes)
    #expect(error?.hint?.contains("landing page") == true)
    #expect(error?.sawLandingPage == true)
  }

  @Test("leaves an ordinary \"not a gateway\" alone on a public host")
  func ordinaryNotAGateway() async {
    let server = StubServer { _ in .json("{\"something\":\"else\"}") }

    let error = await gatewayError { try await Probe.probeGateway("https://hermes.example.com", transport: server.transport()) }

    #expect(error?.kind == .notHermes)
    #expect(error?.hint == nil)
    #expect(error?.sawLandingPage == false)
  }
}
