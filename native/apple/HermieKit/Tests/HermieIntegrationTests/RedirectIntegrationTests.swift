#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

extension Integration {
  /// No credential crosses a redirect, on real sockets: the fake gateway and a
  /// second local listener, each pointing at the other.
  @Suite("Redirects between two local listeners")
  struct RedirectIntegrationTests {
    @Test("the gateway's redirect to another local port is not followed, and nothing reaches that port")
    func gatewayRedirectsElsewhere() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native)) { gateway in
        let elsewhere = try LoopbackListener { _ in LoopbackListener.reply("200 OK", body: "{\"stolen\":true}") }
        try await elsewhere.start()
        defer { elsewhere.stop() }

        // The authorize step answers a 302 to whatever loopback redirect_uri it was given.
        let authorize = try PKCE.authorizeURL(
          baseURL: gateway.baseURL,
          params: AuthorizeParams(
            challenge: PKCE.create().challenge,
            state: "s-1",
            redirectURI: "\(elsewhere.origin)/callback"
          )
        )
        let url = authorize + "&auto=1"

        for policy in [RedirectPolicy.refuseAll, .sameOrigin] {
          let error = await #expect(throws: GatewayError.self) {
            try await HTTPTransport().requestText(
              url,
              JSONRequest(headers: ["authorization": "Bearer at-must-stay-home"], redirects: policy)
            )
          }

          #expect(error?.kind == .redirect)
          #expect(error?.redirectedOrigin == elsewhere.origin)
          #expect(error?.redirectedTo == "127.0.0.1")
        }

        #expect(elsewhere.requests.isEmpty)
      }
    }

    @Test("a listener redirecting an authenticated POST to the gateway never delivers it")
    func listenerRedirectsToGateway() async throws {
      try await FakeGateway.with { gateway in
        let target = gateway.baseURL + "/__fake/push"
        let redirector = try LoopbackListener { _ in
          LoopbackListener.reply("307 Temporary Redirect", headers: ["Location: \(target)"])
        }
        try await redirector.start()
        defer { redirector.stop() }

        // A 307 keeps the method and the body: followed, this POST would
        // register a push device at the gateway, which the gateway would show.
        let body = JSONValue.object([
          "action": .string("registrations"),
          "registrations": .object(["leaked": .object(["token": .string("from-a-redirect")])])
        ])
        let http = try HTTPClient(baseURL: redirector.origin, credentials: SessionTokenCredentials(token: "secret"))

        let error = await #expect(throws: GatewayError.self) {
          try await http.post("/__fake/push", body: body)
        }
        #expect(error?.kind == .redirect)
        #expect(error?.redirectedOrigin == gateway.baseURL)
        #expect(redirector.requests.count == 1)
        #expect(redirector.requests.first?.contains("X-Hermes-Session-Token: secret") == true)

        let push = try await gateway.pushSection()
        #expect(push["registrations"]?["leaked"] == nil)

        // The same POST sent to the gateway directly does land: the check above can see a leak.
        _ = try await HTTPClient(baseURL: gateway.baseURL, credentials: SessionTokenCredentials(token: ""))
          .post("/__fake/push", body: body)
        #expect(try await gateway.pushSection()["registrations"]?["leaked"] != nil)
      }
    }

    @Test("the probe does not follow a redirect to another origin either")
    func probeRedirectsElsewhere() async throws {
      try await FakeGateway.with { gateway in
        let redirector = try LoopbackListener { _ in
          LoopbackListener.reply("308 Permanent Redirect", headers: ["Location: \(gateway.baseURL)\(RESTPath.status)"])
        }
        try await redirector.start()
        defer { redirector.stop() }

        let error = await #expect(throws: GatewayError.self) {
          try await Probe.probeGateway(redirector.origin)
        }

        #expect(error?.kind == .redirect)
        #expect(error?.redirectedOrigin == gateway.baseURL)
      }
    }
  }
}
#endif
