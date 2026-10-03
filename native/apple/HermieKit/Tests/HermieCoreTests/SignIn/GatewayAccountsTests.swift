import Foundation
import HermieGateway
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// Signing out, forgetting a removed gateway, and reading who is signed in.
@MainActor
@Suite("Gateway accounts")
struct GatewayAccountsTests {
  static let id = "g0123456789abcdef"
  static let base = "https://gw.example.test"

  static let pushKey = "hermie.push.manage-\(id)"

  /// A native gateway as onboarding leaves it (added through the engine with its tokens and a custom
  /// header), and the push registrar's secret for it, which is not ours to delete.
  static func seeded(
    _ server: StubServer, synced: InMemorySyncedItemStore = InMemorySyncedItemStore()
  ) async throws -> OnboardingHarness {
    let harness = try OnboardingHarness(transport: server.transport(), synced: synced)

    try await harness.addGateway(
      NewGateway(
        id: id,
        name: "Work",
        address: base,
        authKind: .nativePKCE,
        provider: SyncProvider(name: "self-hosted"),
        user: "Tester",
        customHeaders: ["X-Proxy-Key": "proxy-secret"],
        tokens: TokenSet(accessToken: "at-1", refreshToken: "rt-1", expiresAt: 4_102_444_800, provider: "self-hosted", userID: "u")
      )
    )
    try harness.secrets.set(pushKey, "push-secret")

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

  @Test("who this client is on a stored gateway follows the live session's rule")
  func probeIdentity() async throws {
    let harness = try await Self.seeded(GatewayStub.gated())
    guard case .answered(let me) = await harness.accounts.probeIdentity(for: Self.id) else {
      Issue.record("a signed-in gateway was not asked")
      return
    }

    #expect(me.displayName == "Tester")
    guard case .failed = await harness.accounts.probeIdentity(for: "g-nobody") else {
      Issue.record("an unknown gateway answered an identity")
      return
    }
  }

  @Test("sign-out revokes when the gateway advertises it, then the engine deletes the sign-in items")
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
    #expect(try harness.credentialKeys().isEmpty)
    #expect(try harness.secrets.get(Self.pushKey) == "push-secret")
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

  @Test("removing a gateway revokes first, then the engine deletes its credentials; push's secret stays")
  func removeRevokesThenRemoves() async throws {
    let server = GatewayStub.gated()
    let harness = try await Self.seeded(server)

    harness.accounts.follow()
    await eventually { harness.accounts.status(for: Self.id) == .signedIn }

    try await harness.accounts.remove(Self.id)

    let revoke = try #require(server.requests.first { $0.path == "/auth/native/revoke" })
    #expect(revoke.bodyText.contains("rt-1"))
    #expect(try harness.credentialKeys().isEmpty)
    #expect(try harness.secrets.get(Self.pushKey) == "push-secret")
    #expect(await harness.config(Self.id) == nil)
    #expect(harness.accounts.status(for: Self.id) == .unknown)
  }

  @Test("signing out and removing end the live session first")
  func endsTheSession() async throws {
    let harness = try await Self.seeded(GatewayStub.gated())
    let ended = Box<[String]>([])

    harness.accounts.endSession = { id in ended.value.append(id) }

    await harness.accounts.signOut(Self.id)
    try await harness.accounts.remove(Self.id)

    #expect(ended.value == [Self.id, Self.id])
  }

  /// What a stub saw, from the thread it answers on.
  final class Noted: Sendable {
    let values = Mutex<[Bool]>([])
  }

  /// The gated stub, also noting whether the gateway's item in iCloud Keychain was still live when
  /// the revoke arrived.
  static func gatedNoting(liveAtRevoke: Noted, in cloud: FakeCloud) -> StubServer {
    let account = SyncedGatewayRecord.account(forKey: GatewayKey.of(base))

    return StubServer { request in
      switch request.path {
      case "/api/status": return .json(GatewayStub.gatedStatus)
      case "/api/auth/providers": return .json(GatewayStub.providers)
      case "/auth/native/revoke":
        let live = cloud.cloudItems().first { $0.account == account }
          .flatMap { SyncedGatewayRecord.decode(account: $0.account, value: $0.value) }?.isLive ?? false
        liveAtRevoke.values.withLock { $0.append(live) }
        return .json("{}")
      default: return .json("{}", status: 404)
      }
    }
  }

  @Test("removing from all devices checks the scope, hands the grant back, then leaves the tombstone")
  func removeFromAllDevicesRevokesThenTombstones() async throws {
    let cloud = FakeCloud()
    let liveAtRevoke = Noted()
    let server = Self.gatedNoting(liveAtRevoke: liveAtRevoke, in: cloud)
    let harness = try await Self.seeded(server, synced: cloud.replica("local"))
    let keys = try GatewaySecretKeys(gatewayID: Self.id)
    let ended = Box<[String]>([])

    harness.accounts.endSession = { id in ended.value.append(id) }
    try await harness.sync.disclose()
    await harness.sync.reconcileNow(.manual)
    await harness.sync.reconcileNow(.manual)
    let account = SyncedGatewayRecord.account(forKey: GatewayKey.of(Self.base))
    func record() -> SyncedGatewayRecord? {
      cloud.cloudItems().first { $0.account == account }.flatMap { SyncedGatewayRecord.decode(account: $0.account, value: $0.value) }
    }
    #expect(record()?.isLive == true)

    try await harness.accounts.remove(Self.id, scope: .allDevices)
    await harness.sync.reconcileNow(.manual)

    #expect(ended.value == [Self.id])
    #expect(liveAtRevoke.values.withLock { $0 } == [true], "the grant went back once, before anything was removed")
    #expect(try harness.secrets.get(keys.refreshToken) == nil)
    #expect(try await harness.registry().gateway(id: Self.id) == nil)
    #expect(record() != nil && record()?.isLive == false, "a tombstone tells the other devices")
  }

  @Test("a removal the engine refuses leaves the session and the grant alone")
  func refusedRemovalTouchesNothing() async throws {
    let server = GatewayStub.gated()
    let harness = try await Self.seeded(server)
    let keys = try GatewaySecretKeys(gatewayID: Self.id)
    let ended = Box<[String]>([])

    harness.accounts.endSession = { id in ended.value.append(id) }

    // Never synced (the disclosure is unanswered here): "Remove from All Devices" is refused.
    await #expect(throws: SyncEngineError.notAttached) {
      try await harness.accounts.remove(Self.id, scope: .allDevices)
    }

    #expect(ended.value.isEmpty, "the live session was not ended")
    #expect(server.requests.allSatisfy { $0.path != "/auth/native/revoke" }, "the grant was not handed back")
    #expect(try harness.secrets.get(keys.refreshToken) == "rt-1")
    #expect(try await harness.registry().gateway(id: Self.id) != nil)

    // An unknown gateway is refused the same way, before anything.
    await #expect(throws: SyncEngineError.unknownGateway) {
      try await harness.accounts.remove("g99aa99aa99aa99aa", scope: .thisDevice)
    }
    #expect(ended.value.isEmpty)
  }

  // MARK: Sign-in reaching iCloud Sync

  @Test("a sign-in saved by setup clears the gateway's sign-in mark in iCloud Sync")
  func aSavedSignInClearsTheMark() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.ungated().transport())
    let id = "g00aa11bb22cc77"
    let other = "g00aa11bb22cc88"
    let iCloud = harness.launch.iCloudSync

    try await harness.addGateway(NewGateway(id: id, name: "Work", address: Self.base, authKind: .sessionToken))
    try await harness.addGateway(NewGateway(id: other, name: "Lab", address: "https://lab.example.test", authKind: .sessionToken))
    iCloud.start()
    // As sync says of gateways it took from iCloud Keychain without a usable credential.
    iCloud.receive(.needsSignIn(gatewayId: id))
    iCloud.receive(.needsSignIn(gatewayId: other))
    #expect(iCloud.signInNeeded == [id, other])

    let model = harness.model(.signIn(gatewayId: id))
    await model.load()
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"

    #expect(await model.continueFromSignIn() == id)
    #expect(iCloud.signInNeeded == [other], "this one is signed in; the other still asks")
    #expect(!iCloud.notices.contains { $0.kind == .needsSignIn && $0.gatewayIds.contains(id) })
  }

  @Test("a sign-in that finishes for a gateway removed meanwhile reaches neither the accounts nor iCloud Sync")
  func aSignInForARemovedGatewayStopsShort() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.ungated().transport())
    let id = "g00aa11bb22cc99"
    let other = "g00aa11bb22ccaa"
    let iCloud = harness.launch.iCloudSync

    try await harness.addGateway(NewGateway(id: id, name: "Work", address: Self.base, authKind: .sessionToken))
    try await harness.addGateway(NewGateway(id: other, name: "Lab", address: "https://lab.example.test", authKind: .sessionToken))
    iCloud.start()
    iCloud.receive(.needsSignIn(gatewayId: other))

    let model = harness.model(.signIn(gatewayId: id))
    await model.load()
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"

    // Removed while the person was typing (which forgets it, and counts as a credentials change).
    try await harness.directory.remove(id: id)
    let revision = harness.accounts.credentialsRevision[id]

    #expect(await model.continueFromSignIn() == nil)
    #expect(model.saveState == .failed(.gatewayRemoved))
    // The finish (`credentialsChanged`, then `signedIn`) never ran for it.
    #expect(harness.accounts.credentialsRevision[id] == revision)
    #expect(harness.accounts.status(for: id) != .signedIn)
    #expect(iCloud.signInNeeded == [other])
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

}

/// A value a closure can change, for a test on the main actor.
@MainActor
final class Box<Value> {
  var value: Value

  init(_ value: Value) {
    self.value = value
  }
}
