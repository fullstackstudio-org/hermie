import Foundation
import Testing

@testable import HermieGateway

/// The redirect rule on real sockets, as the reference's `probe-redirect.test.ts`
/// runs it against two real servers: "did URLSession follow it" is exactly the
/// kind of question a stub answers whichever way it was written.
@Suite(.serialized) struct RealListenerRedirectTests {
  static func reply(status: String, headers: [String] = [], body: String = "") -> String {
    (["HTTP/1.1 \(status)", "Content-Length: \(body.utf8.count)", "Connection: close"] + headers).joined(separator: "\r\n")
      + "\r\n\r\n" + body
  }

  @Test("an authenticated call redirected to another listener never reaches it, and its bearer stays home")
  func authenticatedRedirect() async throws {
    let elsewhere = try LoopbackHTTPServer { _ in Self.reply(status: "200 OK", body: "{\"stolen\":true}") }
    let elsewherePort = try await elsewhere.start()
    let gateway = try LoopbackHTTPServer { _ in
      Self.reply(status: "307 Temporary Redirect", headers: ["Location: http://localhost:\(elsewherePort)/api/thing"])
    }
    let gatewayPort = try await gateway.start()
    defer {
      gateway.stop()
      elsewhere.stop()
    }

    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(gatewayPort)",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      transport: HTTPTransport()
    )
    let error = await gatewayError { try await http.get("/api/thing") }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedOrigin == "http://localhost:\(elsewherePort)")
    #expect(gateway.requests.count == 1)
    #expect(gateway.requests.first?.lowercased().contains("authorization: bearer at-1") == true)
    #expect(elsewhere.requests.isEmpty)
  }

  @Test("the probe follows a redirect on its own origin over a real socket")
  func probeSameOrigin() async throws {
    let gateway = try LoopbackHTTPServer { head in
      head.hasPrefix("GET /hermes/api/status ")
        ? Self.reply(status: "308 Permanent Redirect", headers: ["Location: /api/status"])
        : Self.reply(status: "200 OK", body: "{\"auth_required\":false,\"version\":\"1\"}")
    }
    let port = try await gateway.start()
    defer { gateway.stop() }

    let probe = try await Probe.probeGateway("http://127.0.0.1:\(port)/hermes")

    #expect(probe.version == "1")
    #expect(gateway.requests.count == 2)
  }
}
