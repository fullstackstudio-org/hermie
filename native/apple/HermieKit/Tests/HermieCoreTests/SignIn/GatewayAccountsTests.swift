import Foundation
import HermieGateway
import HermieStore
import Testing

@testable import HermieCore

/// Signing out, forgetting a removed gateway, and reading who is signed in.
@MainActor
@Suite("Gateway accounts")
struct GatewayAccountsTests {
  static let id = "g0123456789abcdef"
  static let base = "https://gw.example.test"

  /// A native gateway as onboarding leaves it: entry, config, tokens, a custom header, push secret.
  static func seeded(_ server: StubServer) async throws -> OnboardingHarness {
    let harness = try OnboardingHarness(transport: server.transport())
    let keys = try GatewaySecretKeys(gatewayID: id)

    try await GatewayRegistryStore(store: harness.store).add(
      GatewayRecord(id: id, name: "Work", address: base, authKind: .nativePKCE, signedInUser: "Tester", addedAt: 1)
    )
    try await KeyValueStore(store: harness.store).setString(
      try StoredGatewayConfig(baseUrl: base, authMode: .nativePKCE, provider: "self-hosted").encoded(),
      forKey: StoredGatewayConfig.key(gatewayId: id)
    )
    try GatewaySecrets.save(
      storage: harness.secrets,
      keys: keys,
      baseURL: base,
      customHeaders: ["X-Proxy-Key": "proxy-secret"],
      tokens: TokenSet(accessToken: "at-1", refreshToken: "rt-1", expiresAt: 4_102_444_800, provider: "self-hosted", userID: "u")
    )
    try harness.secrets.set(try SecretKeys.gateway(id).pushManage, "push-secret")
    await harness.directory.load()

    return harness
  }

  @Test("statuses follow what the keychain holds")
  func statuses() async throws {
    let harness = try await Self.seeded(GatewayStub.gated())

    #expect(harness.accounts.status(for: Self.id) == .unknown)
    await harness.accounts.refresh()
    #expect(harness.accounts.status(for: Self.id) == .signedIn)
  }

  @Test("who is signed in comes from /api/auth/me with the stored bearer and headers")
  func identity() async throws {
    let server = GatewayStub.gated()
    let harness = try await Self.seeded(server)
    let me = try await harness.accounts.identity(for: Self.id)

    #expect(me.displayName == "Tester")

    let request = try #require(server.requests.last { $0.path == "/api/auth/me" })
    #expect(request.header("authorization") == "Bearer at-1")
    #expect(request.header("x-proxy-key") == "proxy-secret")
  }

  @Test("sign-out revokes when the gateway advertises it, deletes the credential, keeps the way in")
  func signOutRevokes() async throws {
    let server = GatewayStub.gated()
    let harness = try await Self.seeded(server)
    let keys = try GatewaySecretKeys(gatewayID: Self.id)
    let before = harness.accounts.credentialsRevision[Self.id] ?? 0

    await harness.accounts.signOut(Self.id)

    let revoke = try #require(server.requests.first { $0.path == "/auth/native/revoke" })
    #expect(revoke.bodyText.contains("rt-1"))
    #expect(revoke.header("authorization") == nil)
    #expect(try harness.secrets.get(keys.accessToken) == nil)
    #expect(try harness.secrets.get(keys.refreshToken) == nil)
    #expect(try harness.secrets.get(keys.tokenMeta) == nil)
    #expect(try harness.secrets.get(keys.extraHeaders) != nil)
    #expect(try await harness.registry().gateway(id: Self.id)?.signedInUser == nil)
    #expect(try await harness.registry().gateway(id: Self.id) != nil)
    #expect(harness.accounts.status(for: Self.id) == .signedOut)
    #expect((harness.accounts.credentialsRevision[Self.id] ?? 0) > before)
  }

  @Test("without native_revoke, sign-out sends nothing and still wipes")
  func signOutWithoutRevoke() async throws {
    let server = StubServer { request in
      request.path == "/api/status"
        ? .json(#"{"auth_required":true,"auth_flows":["native_pkce"],"version":"1"}"#)
        : .json(GatewayStub.providers)
    }
    let harness = try await Self.seeded(server)
    let keys = try GatewaySecretKeys(gatewayID: Self.id)

    await harness.accounts.signOut(Self.id)

    #expect(server.requests.allSatisfy { $0.path != "/auth/native/revoke" })
    #expect(try harness.secrets.get(keys.refreshToken) == nil)
  }

  @Test("a gateway that cannot be reached is still signed out locally")
  func signOutOffline() async throws {
    let server = StubServer { _ in .fail(.cannotConnectToHost) }
    let harness = try await Self.seeded(server)
    let keys = try GatewaySecretKeys(gatewayID: Self.id)

    await harness.accounts.signOut(Self.id)

    #expect(try harness.secrets.get(keys.accessToken) == nil)
    #expect(harness.accounts.status(for: Self.id) == .signedOut)
  }

  @Test("removing a gateway revokes, then deletes every secret stored for it")
  func removeForgets() async throws {
    let server = GatewayStub.gated()
    let harness = try await Self.seeded(server)

    harness.directory.onRemoved = { [accounts = harness.accounts] id in await accounts.forget(id) }
    harness.accounts.follow()
    await eventually { harness.accounts.status(for: Self.id) == .signedIn }

    try await harness.directory.remove(id: Self.id)

    #expect(server.requests.contains { $0.path == "/auth/native/revoke" })
    #expect(harness.secrets.keys.isEmpty)
    #expect(await harness.config(Self.id) == nil)
    #expect(harness.accounts.status(for: Self.id) == .unknown)
  }

  @Test("one coordinator per gateway, dropped when its credentials change")
  func oneCoordinator() async throws {
    let harness = try await Self.seeded(GatewayStub.gated())
    let first = try harness.accounts.coordinator(for: Self.id, baseURL: Self.base, headers: [:])

    #expect(try harness.accounts.coordinator(for: Self.id, baseURL: Self.base, headers: [:]) === first)

    harness.accounts.credentialsChanged(Self.id)
    #expect(try harness.accounts.coordinator(for: Self.id, baseURL: Self.base, headers: [:]) !== first)
  }

  @Test("an unknown gateway is said to be unknown")
  func unknown() async throws {
    let harness = try OnboardingHarness(transport: HTTPTransport())

    await #expect(throws: GatewayAccessError.unknownGateway) {
      _ = try await harness.accounts.access(for: "g99")
    }
  }

  @Test("the keychain conforms, so the app can hand it to the gateway layer")
  func keychainConforms() {
    let storage: any GatewaySecretStorage = KeychainStore()

    #expect(storage is KeychainStore)
  }
}
