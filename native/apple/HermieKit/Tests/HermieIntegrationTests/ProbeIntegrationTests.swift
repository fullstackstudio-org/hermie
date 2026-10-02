#if os(macOS)
import Foundation
import HermieGateway
import Testing

extension Integration {
  /// `Probe.probeGateway` against each authentication mode the fake stages:
  /// what `/api/status` and `/api/auth/providers` say, read over a real socket.
  @Suite("Probe and address resolution")
  enum ProbeIntegrationTests {
    static let fakeVersion = "0.21.3-fake"
    static let selfHosted = AuthProvider(name: "self-hosted", displayName: "Self-Hosted OIDC", supportsPassword: false)

    @Suite("Probe: ungated gateway", .fakeGateway())
    struct Ungated {
      @Test("no auth, no flows, no providers: the session-token path")
      func probe() async throws {
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(probe.version == ProbeIntegrationTests.fakeVersion)
        #expect(!probe.authRequired)
        #expect(probe.authFlows.isEmpty)
        #expect(probe.providers.isEmpty)
        #expect(!probe.supportsNativePKCE)
        #expect(!probe.supportsNativeRevoke)
        #expect(probe.authMode == .sessionToken)
        #expect(probe.canSignIn)
      }
    }

    @Suite("Probe: token gateway", .fakeGateway(FakeGateway.Options(auth: .token, token: "probe-secret")))
    struct Token {
      @Test("the probe needs no token, and the gateway reads as ungated")
      func probe() async throws {
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(probe.version == ProbeIntegrationTests.fakeVersion)
        #expect(!probe.authRequired)
        #expect(probe.authFlows.isEmpty)
        #expect(probe.authMode == .sessionToken)
      }
    }

    @Suite("Probe: native gateway", .fakeGateway(FakeGateway.Options(auth: .native)))
    struct Native {
      @Test("gated, with native PKCE, native revoke and one provider")
      func probe() async throws {
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(probe.version == ProbeIntegrationTests.fakeVersion)
        #expect(probe.authRequired)
        #expect(probe.authFlows == ["cookie", "native_pkce", "native_revoke"])
        #expect(probe.providers == [ProbeIntegrationTests.selfHosted])
        #expect(probe.supportsNativePKCE)
        #expect(probe.supportsNativeRevoke)
        #expect(probe.authMode == .nativePKCE)
        #expect(probe.canSignIn)
      }
    }

    @Suite(
      "Probe: native gateway without the revoke route",
      .fakeGateway(FakeGateway.Options(auth: .native, nativeRevoke: false))
    )
    struct NativeWithoutRevoke {
      @Test("still signs in natively, but does not advertise native_revoke")
      func probe() async throws {
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(probe.authFlows == ["cookie", "native_pkce"])
        #expect(probe.supportsNativePKCE)
        #expect(!probe.supportsNativeRevoke)
        #expect(probe.canSignIn)
      }
    }

    @Suite("Probe: cookie-only gateway", .fakeGateway(FakeGateway.Options(auth: .cookie)))
    struct CookieOnly {
      @Test("gated without native PKCE: the app cannot sign in to it")
      func probe() async throws {
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(probe.authRequired)
        #expect(probe.authFlows == ["cookie", "native_revoke"])
        #expect(!probe.supportsNativePKCE)
        #expect(probe.authMode == .nativePKCE)
        #expect(!probe.canSignIn)
        #expect(probe.providers == [AuthProvider(name: "self-hosted", displayName: "Self-Hosted OIDC", supportsPassword: true)])
      }
    }

    /// ADR-0014: an address typed without a scheme is tried over https first
    /// and, when https gets no answer at all, over http.
    @Suite("Resolve: scheme-less addresses", .fakeGateway())
    struct Resolve {
      /// An http-only server answers the TLS ClientHello with an HTTP 400,
      /// which the TLS stack reports as -1200 with stream error -9836, the
      /// same code a TLS server refusing the version produces. The transport
      /// cannot tell them apart and falls back, as the reference does (see the
      /// table on `HTTPTransport.peerAlertCodes`).
      @Test("a scheme-less loopback address finds an http-only gateway, and says so")
      func cleartextFallback() async throws {
        let gateway = try FakeGateway.shared
        let resolved = try await Probe.resolveGatewayAddress("127.0.0.1:\(gateway.port)")

        #expect(resolved.baseURL == gateway.baseURL)
        #expect(resolved.foundOverHTTP)
        #expect(resolved.probe.version == ProbeIntegrationTests.fakeVersion)
      }

      /// The stream errors the fallback rule is built on, read off real
      /// sockets, so an OS release that changes them fails here first.
      @Test("the TLS stack reports what the fallback rule assumes")
      func measuredStreamErrors() async throws {
        let gateway = try FakeGateway.shared
        let hangUp = try LoopbackListener(onTLS: .hangUp) { _ in LoopbackListener.reply("200 OK") }
        let alert = try LoopbackListener(onTLS: .handshakeFailureAlert) { _ in LoopbackListener.reply("200 OK") }
        let hangUpPort = try await hangUp.start()
        let alertPort = try await alert.start()
        defer {
          hangUp.stop()
          alert.stop()
        }

        func streamError(_ port: Int) async -> (Int, Int?) {
          do {
            _ = try await URLSession(configuration: .ephemeral).data(from: URL(string: "https://127.0.0.1:\(port)/")!)
            return (0, nil)
          } catch {
            let error = error as NSError
            return (error.code, error.userInfo["_kCFStreamErrorCodeKey"] as? Int)
          }
        }

        let plain = await streamError(gateway.port)
        let closed = await streamError(Int(hangUpPort))
        let alerted = await streamError(Int(alertPort))

        #expect(plain == (-1200, -9836))
        #expect(closed == (-1200, -9816))
        #expect(alerted == (-1200, -9824))
      }

      @Test("a server that answers the ClientHello with a TLS alert is an https server: no http fallback")
      func noFallbackAfterAlert() async throws {
        let tls = try LoopbackListener(onTLS: .handshakeFailureAlert) { _ in
          LoopbackListener.reply("200 OK", headers: ["Content-Type: application/json"], body: "{\"auth_required\":false}")
        }
        let port = try await tls.start()
        defer { tls.stop() }

        let error = await #expect(throws: GatewayError.self) {
          try await Probe.resolveGatewayAddress("127.0.0.1:\(port)")
        }

        #expect(error?.kind == .tls)
        #expect(tls.requests.isEmpty)
      }

      @Test("the fallback itself works on real sockets: a plain server that hangs up on TLS is found over http")
      func cleartextFallbackWhenTLSIsDropped() async throws {
        // Hangs up on a ClientHello without a byte, and answers `/api/status`
        // in the clear as an ungated gateway would.
        let plain = try LoopbackListener(hangUpOnTLS: true) { _ in
          LoopbackListener.reply(
            "200 OK",
            headers: ["Content-Type: application/json"],
            body: "{\"auth_required\":false,\"version\":\"plain-1\"}"
          )
        }
        let port = try await plain.start()
        defer { plain.stop() }

        let resolved = try await Probe.resolveGatewayAddress("127.0.0.1:\(port)")

        #expect(resolved.baseURL == "http://127.0.0.1:\(port)")
        #expect(resolved.foundOverHTTP)
        #expect(resolved.probe.version == "plain-1")
        #expect(plain.requests.map { $0.prefix(20) } == ["GET /api/status HTTP"])
      }

      @Test("an explicit http:// address is used as typed, not reported as a fallback")
      func explicitHTTP() async throws {
        let gateway = try FakeGateway.shared
        let resolved = try await Probe.resolveGatewayAddress(gateway.baseURL)

        #expect(resolved.baseURL == gateway.baseURL)
        #expect(!resolved.foundOverHTTP)
      }

      @Test("an explicit https:// address is never downgraded")
      func explicitHTTPS() async throws {
        let gateway = try FakeGateway.shared
        let error = await #expect(throws: GatewayError.self) {
          try await Probe.resolveGatewayAddress("https://127.0.0.1:\(gateway.port)")
        }

        #expect([.tls, .network].contains(error?.kind))
      }

      @Test("with a front door configured there is no cleartext fallback")
      func frontDoorBlocksFallback() async throws {
        let gateway = try FakeGateway.shared
        let frontDoor = FrontDoor.cloudflareAccess(
          FrontDoor.CloudflareAccess(
            clientID: "id.access",
            clientSecret: "service-token-secret",
            origin: "https://127.0.0.1:\(gateway.port)"
          )
        )

        let error = await #expect(throws: GatewayError.self) {
          try await Probe.resolveGatewayAddress("127.0.0.1:\(gateway.port)", frontDoor: frontDoor)
        }

        #expect([.tls, .network].contains(error?.kind))
        #expect(error?.message.contains("https://127.0.0.1:\(gateway.port)") == true)
      }
    }
  }
}
#endif
