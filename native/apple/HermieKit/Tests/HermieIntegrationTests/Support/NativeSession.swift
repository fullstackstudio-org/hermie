#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

/// Wall-clock seconds that a test can move forward, so an access token can be
/// made to look expired to the client without waiting an hour.
final class SkewableClock: Sendable {
  private let offset = Mutex<Double>(0)

  var nowSeconds: Double { Date().timeIntervalSince1970 + offset.withLock { $0 } }

  func advance(bySeconds seconds: Double) {
    offset.withLock { $0 += seconds }
  }
}

/// A native PKCE client for one fake gateway, wired the way the app wires it:
/// the probe decides whether sign-out may revoke, the tokens live in a
/// `GatewaySecretStorage` through `SecretTokenStore`, and one `TokenCoordinator`
/// owns rotation through `NativeAuth.refreshTokens`.
struct NativeSession: Sendable {
  let baseURL: String
  let probe: ProbeResult
  let storage: InMemorySecretStorage
  let keys: GatewaySecretKeys
  let clock: SkewableClock
  let coordinator: TokenCoordinator
  let credentials: NativePKCECredentials
  let http: HTTPClient

  init(gateway: FakeGateway) async throws {
    let baseURL = gateway.baseURL
    let transport = HTTPTransport()
    let probe = try await Probe.probeGateway(baseURL, transport: transport)
    let storage = InMemorySecretStorage()
    let keys = try GatewaySecretKeys(gatewayID: "fake_\(gateway.port)")
    let clock = SkewableClock()
    let coordinator = TokenCoordinator(
      store: SecretTokenStore(storage: storage, keys: keys),
      refresh: { held in
        try await NativeAuth.refreshTokens(
          baseURL: baseURL,
          refreshToken: held.refreshToken,
          provider: held.provider,
          options: NativeAuth.Options(transport: transport)
        )
      },
      nowSeconds: { clock.nowSeconds }
    )
    let credentials = NativePKCECredentials(
      baseURL: baseURL,
      coordinator: coordinator,
      canRevoke: probe.supportsNativeRevoke,
      transport: transport
    )

    self.baseURL = baseURL
    self.probe = probe
    self.storage = storage
    self.keys = keys
    self.clock = clock
    self.coordinator = coordinator
    self.credentials = credentials
    self.http = try HTTPClient(baseURL: baseURL, credentials: credentials, transport: transport)
  }

  /// The whole sign-in without a web view, as a web view would see it:
  ///
  /// 1. `beginSignIn` answers the authorize URL; the navigation is allowed.
  /// 2. The gateway answers it with its sign-in page (a form), as it would in
  ///    the web view. Submitting it is the same URL with `auto=1`, which the
  ///    fake answers with the 302 to the loopback callback.
  /// 3. `decision(for:)` on that redirect says `callback`, and
  ///    `completeSignIn(redirectURL:)` redeems it.
  @discardableResult
  func signIn() async throws -> TokenSet {
    let start = try await credentials.beginSignIn()
    #expect(await credentials.decision(for: start.authorizeURL) == .allow)

    let page = try await FakeGateway.plainResponse("GET", start.authorizeURL)
    #expect(page.status == 200)

    let callback = try await Self.authorize(start.authorizeURL)
    #expect(await credentials.decision(for: callback) == .callback)

    return try await credentials.completeSignIn(redirectURL: callback)
  }

  /// Approve an authorize URL the way the sign-in page's button does and
  /// answer where the gateway sent the browser (`location` of its 302).
  static func authorize(_ authorizeURL: String) async throws -> String {
    // The form's action: the same query plus `auto=1`.
    let response = try await FakeGateway.plainResponse("GET", authorizeURL + "&auto=1")
    #expect(response.status == 302, "authorize answered \(response.status): \(response.text)")
    return try #require(response.headers["location"])
  }
}
#endif
