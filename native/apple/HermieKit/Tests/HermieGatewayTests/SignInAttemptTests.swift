import Foundation
import Testing

@testable import HermieGateway

/// An attempt ends on any failure, and a gateway on this device signs in.
@Suite struct SignInAttemptTests {
  static func credentials(baseURL: String = "https://gateway.test", _ server: StubServer) -> NativePKCECredentials {
    NativePKCECredentials(
      baseURL: baseURL,
      coordinator: TokenCoordinator(store: MemoryTokenStore(), refresh: { _ in tokens() }, nowSeconds: { 0 }),
      transport: server.transport()
    )
  }

  @Test("a navigation that fails ends the attempt, so a later callback is not exchanged")
  func failEndsAttempt() async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at-1\"}") }
    let credentials = Self.credentials(server)
    let url = try await credentials.beginSignIn().authorizeURL

    #expect(await credentials.decision(for: "file:///etc/passwd") == .fail(.blockedNavigation))
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeSignIn(redirectURL: "http://127.0.0.1:38007/callback?code=c&state=\(query(url, "state")!)")
    }
    #expect(server.requests.isEmpty)
  }

  @Test("a cancelled attempt cannot be completed")
  func cancel() async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at-1\"}") }
    let credentials = Self.credentials(server)
    let url = try await credentials.beginSignIn().authorizeURL

    await credentials.cancelSignIn()

    #expect(await credentials.decision(for: "http://127.0.0.1:38007/callback?code=c&state=\(query(url, "state")!)") == .fail(.stateMismatch))
    #expect(server.requests.isEmpty)
  }

  @Test("a gateway on 127.0.0.1 or [::1] loads its own pages and completes", arguments: ["http://127.0.0.1:9119", "http://[::1]:9119"])
  func loopbackGateway(_ base: String) async throws {
    let server = StubServer { _ in .json("{\"access_token\":\"at-1\",\"refresh_token\":\"rt-1\"}") }
    let credentials = Self.credentials(baseURL: base, server)
    let url = try await credentials.beginSignIn().authorizeURL
    let callback = "http://127.0.0.1:38007/callback?code=c&state=\(query(url, "state")!)"

    #expect(await credentials.decision(for: url) == .allow)
    #expect(await credentials.decision(for: "\(base)/login?next=/auth/native/authorize") == .allow)
    #expect(await credentials.decision(for: callback) == .callback)
    #expect(try await credentials.completeSignIn(redirectURL: callback).accessToken == "at-1")
    #expect(server.requests.first?.path == "/auth/native/token")
  }
}
