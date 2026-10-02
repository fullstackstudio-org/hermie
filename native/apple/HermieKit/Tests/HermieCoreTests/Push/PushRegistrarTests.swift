import Foundation
import HermieStore
import Testing

@testable import HermieCore

/// The effectful shell: `PushPlan` carried out against a scripted relay and a real registration
/// store (in-memory database, in-memory keychain), with a hand-moved clock.
@Suite("Push registrar")
struct PushRegistrarTests {
  typealias F = PushFixtures

  struct Rig {
    let relay = ScriptedRelay()
    let clock = PushClock()
    let secrets: LockableSecretStore
    let store: PushRegistrationStore
    let registrar: PushRegistrar

    init() throws {
      secrets = LockableSecretStore()
      store = try makePushStore(secrets: secrets)
      registrar = PushRegistrar(client: relay, store: store, clock: clock.read)
    }

    func context(
      token: APNsDeviceToken? = F.tokenA,
      environment: APNsEnvironment = .sandbox,
      wanted: Bool = true,
      gateways: [String] = ["g1"]
    ) -> PushContext {
      PushContext(token: token, environment: environment, topic: F.topic, wanted: wanted, gatewayIds: gateways)
    }
  }

  @Test("first launch registers, keeps the secrets in the keychain and the rest in the store")
  func registers() async throws {
    let rig = try Rig()
    let report = await rig.registrar.reconcile(rig.context())

    #expect(rig.relay.calls == [.register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic)])
    #expect(report.addressChanged == ["g1"])
    #expect(report.failures.isEmpty)

    let stored = try await rig.store.registrations()
    #expect(stored == [F.registration("g1", handle: F.handle(1), refreshedAt: rig.clock.now)])

    let keys = try SecretKeys.gateway("g1")
    // The manage secret's item names what it manages, so it alone can revoke the registration.
    let held = try #require(try rig.secrets.inner.get(keys.pushManage))
    #expect(
      PushHeldCapability(gatewayId: "g1", stored: held)
        == PushHeldCapability(gatewayId: "g1", handle: F.handle(1), relay: F.relay, manageSecret: F.secret("manage", 1))
    )
    #expect(try rig.secrets.inner.get(keys.pushSend) == F.secret("send", 1))

    let address = await rig.registrar.address(gatewayId: "g1")
    #expect(
      address
        == PushRelayAddress(
          relay: F.relay, handle: F.handle(1), sendSecret: F.secret("send", 1),
          platform: PushRelayAddress.currentPlatform, updatedAt: rig.clock.now)
    )
  }

  @Test("a second launch the same day sends nothing; a day later it refreshes once")
  func dailyRefresh() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    rig.clock.advance(3_600)
    await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.count == 1)

    rig.clock.advance(PushPlan.refreshInterval)
    let report = await rig.registrar.reconcile(rig.context())

    #expect(
      rig.relay.calls.last
        == .update(handle: F.handle(1), manageSecret: F.secret("manage", 1), token: F.tokenA.hex, environment: .sandbox)
    )
    #expect(report.addressChanged.isEmpty)
    #expect(try await rig.store.registrations().first?.refreshedAt == rig.clock.now)

    await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.count == 2)
  }

  @Test("a new token is sent with a PUT and remembered by fingerprint")
  func tokenChange() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())
    await rig.registrar.reconcile(rig.context(token: F.tokenB, environment: .production))

    #expect(
      rig.relay.calls.last
        == .update(handle: F.handle(1), manageSecret: F.secret("manage", 1), token: F.tokenB.hex, environment: .production)
    )

    let stored = try #require(try await rig.store.registrations().first)
    #expect(stored.tokenFingerprint == F.tokenB.fingerprint)
    #expect(stored.environment == .production)
  }

  @Test("a 404 on refresh registers again for a new capability, and says the address changed")
  func notFoundReregisters() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    rig.relay.failUpdate(.notFound)
    let report = await rig.registrar.reconcile(rig.context(token: F.tokenB))

    #expect(
      Array(rig.relay.calls.suffix(2))
        == [
          .update(handle: F.handle(1), manageSecret: F.secret("manage", 1), token: F.tokenB.hex, environment: .sandbox),
          .register(token: F.tokenB.hex, environment: .sandbox, topic: F.topic)
        ]
    )
    #expect(report.addressChanged == ["g1"])
    #expect(try await rig.store.registrations().first?.handle == F.handle(2))
    #expect(try await rig.store.secrets(gatewayId: "g1").manageSecret == F.secret("manage", 2))
  }

  @Test("a refresh that fails on the network keeps the registration and is tried again next pass")
  func refreshFailureKept() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    rig.relay.failUpdate(.network)
    let report = await rig.registrar.reconcile(rig.context(token: F.tokenB))

    #expect(report.failures == ["g1": .relay(.network)])
    #expect(try await rig.store.registrations().first?.tokenFingerprint == F.tokenA.fingerprint)

    await rig.registrar.reconcile(rig.context(token: F.tokenB))
    #expect(try await rig.store.registrations().first?.tokenFingerprint == F.tokenB.fingerprint)
  }

  @Test("switching off deletes at the relay and forgets the secrets")
  func disableDeletes() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context(gateways: ["g1", "g2"]))
    let report = await rig.registrar.reconcile(rig.context(token: nil, wanted: false, gateways: ["g1", "g2"]))

    #expect(
      Array(rig.relay.calls.suffix(2))
        == [
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)),
          .delete(handle: F.handle(2), manageSecret: F.secret("manage", 2))
        ]
    )
    #expect(report.addressChanged == ["g1", "g2"])
    #expect(try await rig.store.registrations().isEmpty)
    #expect(rig.secrets.inner.count == 0)
  }

  @Test("a delete that fails is kept and retried; a 404 on delete counts as deleted")
  func deleteRetried() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context(gateways: ["g1"]))

    rig.relay.failDelete(.timeout)
    let failed = await rig.registrar.reconcile(rig.context(gateways: []))
    #expect(failed.failures == ["g1": .relay(.timeout)])
    #expect(try await rig.store.registrations().count == 1)

    rig.relay.failDelete(.notFound)
    let done = await rig.registrar.reconcile(rig.context(gateways: []))
    #expect(done.failures.isEmpty)
    #expect(try await rig.store.registrations().isEmpty)
  }

  @Test("a rate limit stops every further relay call in the same pass")
  func rateLimitHalts() async throws {
    let rig = try Rig()
    rig.relay.failRegister(.rateLimited(retryAfterSeconds: 60))

    let report = await rig.registrar.reconcile(rig.context(gateways: ["g1", "g2", "g3"]))

    #expect(rig.relay.calls.count == 1)
    #expect(
      report.failures
        == [
          "g1": .relay(.rateLimited(retryAfterSeconds: 60)),
          "g2": .relay(.rateLimited(retryAfterSeconds: 60)),
          "g3": .relay(.rateLimited(retryAfterSeconds: 60))
        ]
    )
  }

  @Test("a keychain that cannot be read leaves the registration alone instead of re-registering")
  func lockedKeychain() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    rig.secrets.lock(true)
    rig.clock.advance(2 * PushPlan.refreshInterval)
    let report = await rig.registrar.reconcile(rig.context(token: F.tokenB))

    #expect(rig.relay.calls.count == 1)
    #expect(report.failures == ["g1": .storage])
    #expect(try await rig.store.registrations().count == 1)

    rig.secrets.lock(false)
    await rig.registrar.reconcile(rig.context(token: F.tokenB))
    #expect(rig.relay.calls.count == 2)
  }

  @Test("a capability that cannot be stored is revoked at once, while the secret is still in hand")
  func unstorableRevoked() async throws {
    let rig = try Rig()
    rig.secrets.lock(true)

    let report = await rig.registrar.reconcile(rig.context())

    #expect(
      rig.relay.calls
        == [
          .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic),
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1))
        ]
    )
    #expect(report.failures == ["g1": .storage])
  }

  @Test("secrets lost (a restore onto another device): forget and register, the old one is not contacted")
  func secretsLost() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    let keys = try SecretKeys.gateway("g1")
    try rig.secrets.delete(keys.pushManage)

    let report = await rig.registrar.reconcile(rig.context())

    #expect(rig.relay.calls.last == .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic))
    #expect(!rig.relay.calls.contains { if case .delete = $0 { true } else { false } })
    #expect(report.addressChanged == ["g1"])
    #expect(try await rig.store.registrations().first?.handle == F.handle(2))
  }

  @Test("retire (sign-out) deletes now; a gateway never registered is nothing to retire")
  func retire() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    #expect(await rig.registrar.retire(gatewayId: "g1"))
    #expect(rig.relay.calls.last == .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)))
    #expect(await rig.registrar.address(gatewayId: "g1") == nil)
    #expect(await rig.registrar.retire(gatewayId: "g9"))
  }

  @Test("concurrent passes run one after another and converge on the last context")
  func serialised() async throws {
    let rig = try Rig()

    async let first = rig.registrar.reconcile(rig.context(gateways: ["g1"]))
    async let second = rig.registrar.reconcile(rig.context(gateways: ["g1"]))
    _ = await (first, second)

    // Two passes over the same gateway: one registration, never two.
    #expect(rig.relay.calls.count == 1)
  }

  @Test("the clock going backwards is corrected by one refresh, then the daily rhythm resumes")
  func clockBackwards() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    rig.clock.advance(-10 * PushPlan.refreshInterval)
    await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.count == 2)
    #expect(try await rig.store.registrations().first?.refreshedAt == rig.clock.now)

    rig.clock.advance(60)
    await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.count == 2)
  }

  @Test("after a failed store the gateway is left alone for a day, not re-registered every pass")
  func storeFailureBacksOff() async throws {
    let rig = try Rig()
    rig.secrets.lock(true)
    await rig.registrar.reconcile(rig.context())
    rig.secrets.lock(false)

    let again = await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.count == 2)
    #expect(again.failures == ["g1": .storage])

    rig.clock.advance(PushRegistrar.storeFailureBackoff)
    await rig.registrar.reconcile(rig.context())
    #expect(rig.relay.calls.last == .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic))
    #expect(try await rig.store.registrations().count == 1)
  }

  @Test("send secret lost, manage secret still here: the old registration is revoked before a new one")
  func sendSecretLost() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    try rig.secrets.delete(try SecretKeys.gateway("g1").pushSend)
    await rig.registrar.reconcile(rig.context())

    #expect(
      Array(rig.relay.calls.suffix(2))
        == [
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)),
          .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic)
        ]
    )
  }

  @Test("registrations that cannot be read: the pass is skipped and nothing is revoked or registered")
  func unreadableRegistrations() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())
    try await rig.store.keyValues.setString("{broken", forKey: StoreKeys.pushRegistrations)

    let report = await rig.registrar.reconcile(rig.context(wanted: false, gateways: []))

    #expect(report.skipped)
    #expect(rig.relay.calls.count == 1)
    #expect(await rig.registrar.registrations() == nil)
    #expect(await rig.registrar.retire(gatewayId: "g1") == false)
  }

  @Test("registrations live outside the gateway's namespace and secrets outside its own secrets")
  func ownedByTheRegistrar() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context())

    let keys = try await rig.store.keyValues.keys()
    #expect(keys.contains(StoreKeys.pushRegistrations))
    #expect(!keys.contains { GatewayNamespace.split($0)?.id == "g1" })

    let gateway = try SecretKeys.gateway("g1")
    for key in gateway.all {
      #expect(try rig.secrets.inner.get(key) == nil)
    }
    #expect(try gateway.push.allSatisfy { try rig.secrets.inner.get($0) != nil })
  }

  // MARK: Orphans, unknowns, undecodable entries

  @Test("a reinstall (empty database, keychain kept): each orphan is revoked, then registration goes on as usual")
  func reinstallRevokesOrphans() async throws {
    let first = try Rig()
    await first.registrar.reconcile(first.context(gateways: ["g1", "g2"]))

    // The database is gone; the keychain and the relay are not.
    let store = try makePushStore(secrets: first.secrets)
    let registrar = PushRegistrar(client: first.relay, store: store, clock: first.clock.read)
    let report = await registrar.reconcile(first.context(gateways: ["g1"]))

    #expect(report.orphansRevoked == 2)
    #expect(
      Set(first.relay.calls.dropFirst(2).prefix(2))
        == [
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)),
          .delete(handle: F.handle(2), manageSecret: F.secret("manage", 2))
        ]
    )
    #expect(first.relay.calls.last == .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic))
    #expect(try await store.registrations().map(\.handle) == [F.handle(3)])
    #expect(try first.secrets.inner.keys(prefix: "hermie.push.").sorted() == ["hermie.push.manage-g1", "hermie.push.send-g1"])

    // Once per launch.
    await registrar.reconcile(first.context(gateways: ["g1"]))
    #expect(first.relay.calls.count == 5)
  }

  @Test("an orphan the relay cannot be reached for is tried again on the next pass")
  func orphanRetried() async throws {
    let first = try Rig()
    await first.registrar.reconcile(first.context(gateways: ["g1"]))

    let registrar = PushRegistrar(client: first.relay, store: try makePushStore(secrets: first.secrets), clock: first.clock.read)
    first.relay.failDelete(.network)
    let failed = await registrar.reconcile(first.context(wanted: false, gateways: []))
    #expect(failed.orphansRevoked == 0)

    let done = await registrar.reconcile(first.context(wanted: false, gateways: []))
    #expect(done.orphansRevoked == 1)
  }

  @Test("an orphan from an older build (a bare secret, no handle) cannot be revoked: its secrets are dropped")
  func legacyOrphanDropped() async throws {
    let rig = try Rig()
    let keys = try SecretKeys.gateway("g7")
    try rig.secrets.set(keys.pushManage, F.secret("manage", 7))
    try rig.secrets.set(keys.pushSend, F.secret("send", 7))

    let report = await rig.registrar.reconcile(rig.context(wanted: false, gateways: []))

    #expect(report.orphansRevoked == 0)
    #expect(rig.relay.calls.isEmpty)
    #expect(try rig.secrets.inner.keys(prefix: "hermie.push.").isEmpty)
  }

  @Test("the address is registered, none, or unknown, and unknown is never none")
  func addressStates() async throws {
    let rig = try Rig()
    #expect(await rig.registrar.addressState(gatewayId: "g1") == PushAddressState.none)

    await rig.registrar.reconcile(rig.context())
    guard case .registered(let address) = await rig.registrar.addressState(gatewayId: "g1") else {
      Issue.record("not registered")
      return
    }
    #expect(address.handle == F.handle(1))

    rig.secrets.lock(true)
    #expect(await rig.registrar.addressState(gatewayId: "g1") == .unknown)
    rig.secrets.lock(false)

    try await rig.store.keyValues.setString("{broken", forKey: StoreKeys.pushRegistrations)
    #expect(await rig.registrar.addressState(gatewayId: "g1") == .unknown)
  }

  @Test("an entry this build cannot decode is kept through every write, skipped, reported, and never registered over")
  func undecodableEntry() async throws {
    let rig = try Rig()
    await rig.registrar.reconcile(rig.context(gateways: ["g1"]))

    // A newer build wrote g2's entry in a shape this one cannot read.
    let text = try #require(try await rig.store.keyValues.string(forKey: StoreKeys.pushRegistrations))
    var map = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    map["g2"] = ["gatewayId": "g2", "shape": 2]
    let data = try JSONSerialization.data(withJSONObject: map, options: [.sortedKeys])
    try await rig.store.keyValues.setString(String(decoding: data, as: UTF8.self), forKey: StoreKeys.pushRegistrations)

    let report = await rig.registrar.reconcile(rig.context(gateways: ["g1", "g2"]))

    #expect(report.undecodable == ["g2"])
    #expect(rig.relay.calls.count == 1)
    #expect(await rig.registrar.addressState(gatewayId: "g2") == .unknown)

    // Another write (a refresh of g1) carries it.
    rig.clock.advance(PushPlan.refreshInterval)
    await rig.registrar.reconcile(rig.context(gateways: ["g1", "g2"]))
    #expect(try await rig.store.undecodable() == ["g2"])
  }

  @Test("a gateway unreadable for one pass keeps its slot: the ninth is not registered in its place")
  func frozenKeepsItsSlot() async throws {
    let rig = try Rig()
    let ids = (1...9).map { "g\($0)" }
    await rig.registrar.reconcile(rig.context(gateways: ids))
    #expect(rig.relay.calls.count == 8)

    // g3's entry becomes unreadable for a pass.
    let text = try #require(try await rig.store.keyValues.string(forKey: StoreKeys.pushRegistrations))
    var map = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    let g3 = map["g3"]
    map["g3"] = ["broken": true]
    try await rig.store.keyValues.setString(
      String(decoding: try JSONSerialization.data(withJSONObject: map), as: UTF8.self), forKey: StoreKeys.pushRegistrations)

    await rig.registrar.reconcile(rig.context(gateways: ids))
    #expect(rig.relay.calls.count == 8)

    map["g3"] = g3
    try await rig.store.keyValues.setString(
      String(decoding: try JSONSerialization.data(withJSONObject: map), as: UTF8.self), forKey: StoreKeys.pushRegistrations)
    await rig.registrar.reconcile(rig.context(gateways: ids))
    #expect(rig.relay.calls.count == 8)
  }

  @Test("a reinstall whose orphan DELETE fails once: the gateway waits, no manage secret is lost, then it registers")
  func orphanDeleteFailsOnce() async throws {
    let first = try Rig()
    await first.registrar.reconcile(first.context(gateways: ["g1"]))
    let keys = try SecretKeys.gateway("g1")
    let old = try #require(try first.secrets.inner.get(keys.pushManage))

    // The database is gone; the keychain is not.
    let store = try makePushStore(secrets: first.secrets)
    let registrar = PushRegistrar(client: first.relay, store: store, clock: first.clock.read)

    first.relay.failDelete(.timeout)
    let waiting = await registrar.reconcile(first.context(gateways: ["g1"]))

    #expect(waiting.failures["g1"] == .storage)
    #expect(first.relay.calls.count == 2)
    #expect(!first.relay.calls.dropFirst().contains { if case .register = $0 { true } else { false } })
    #expect(try first.secrets.inner.get(keys.pushManage) == old)

    await registrar.reconcile(first.context(gateways: ["g1"]))

    #expect(
      Array(first.relay.calls.suffix(2))
        == [
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)),
          .register(token: F.tokenA.hex, environment: .sandbox, topic: F.topic)
        ]
    )
    #expect(try await store.registrations().map(\.handle) == [F.handle(2)])
  }

  @Test("a registration never overwrites an unrevoked manage secret: it is kept for revoking, then revoked")
  func unrevokedSecretKept() async throws {
    let rig = try Rig()
    let keys = try SecretKeys.gateway("g1")
    let old = PushHeldCapability(gatewayId: "g1", handle: F.handle(9), relay: F.relay, manageSecret: F.secret("manage", 9))
    try rig.secrets.set(keys.pushManage, old.stored)

    // Save a new registration over it, as a pass that could not list the keychain would.
    try await rig.store.save(
      F.registration("g1", handle: F.handle(1)),
      secrets: PushCapability(handle: F.handle(1), sendSecret: F.secret("send", 1), manageSecret: F.secret("manage", 1))
    )

    let held = try await rig.store.heldCapabilities()
    #expect(held.contains { $0.pendingRevoke && $0.handle == F.handle(9) && $0.manageSecret == F.secret("manage", 9) })
    #expect(held.contains { !$0.pendingRevoke && $0.handle == F.handle(1) })

    // A third over a pending one is refused rather than losing it.
    await #expect(throws: PushRegistrationStoreError.unrevokedCapability) {
      try await rig.store.save(
        F.registration("g1", handle: F.handle(5)),
        secrets: PushCapability(handle: F.handle(5), sendSecret: F.secret("send", 5), manageSecret: F.secret("manage", 5))
      )
    }

    // The next pass revokes the pending one and keeps the current one.
    await rig.registrar.reconcile(rig.context(gateways: ["g1"]))
    #expect(rig.relay.calls.contains(.delete(handle: F.handle(9), manageSecret: F.secret("manage", 9))))
    #expect(try await rig.store.heldCapabilities().map(\.pendingRevoke) == [false])
  }
}
