import Foundation
import Synchronization
import Testing

@testable import HermieGateway

/// A secret store that takes real time over every write, as a keychain IPC
/// does, and can be told to refuse writes.
final class SlowSecretStorage: GatewaySecretStorage {
  struct Refused: Error {}

  private let inner: InMemorySecretStorage
  private let delay: TimeInterval
  private let state = Mutex((writesStarted: 0, writesFinished: 0, refusals: 0))

  init(_ initial: [String: String] = [:], delay: TimeInterval = 0.02) {
    inner = InMemorySecretStorage(initial)
    self.delay = delay
  }

  var writesStarted: Int { state.withLock { $0.writesStarted } }
  /// No write is in progress.
  var isIdle: Bool { state.withLock { $0.writesStarted == $0.writesFinished } }
  var keys: Set<String> { inner.keys }

  /// Refuse the next `count` writes.
  func refuse(_ count: Int) {
    state.withLock { $0.refusals = count }
  }

  func get(_ key: String) throws -> String? { try inner.get(key) }

  func set(_ key: String, _ value: String) throws {
    let refused = state.withLock { state in
      state.writesStarted += 1
      defer { state.refusals = max(0, state.refusals - 1) }
      return state.refusals > 0
    }

    defer { state.withLock { $0.writesFinished += 1 } }

    if refused {
      throw Refused()
    }

    Thread.sleep(forTimeInterval: delay)
    try inner.set(key, value)
  }

  func delete(_ key: String) throws { try inner.delete(key) }
}

/// The coordinator over a store whose writes take time: a sign-out or a
/// sign-in can never land between a rotation's writes.
@Suite struct TokenCoordinatorStoreTests {
  static let keys = try! GatewaySecretKeys(gatewayID: "g1a2b")

  /// A keychain holding an expiring set, and a coordinator whose refresh waits for `gate`.
  static func rig(gate: Gate, started: Gate = Gate()) throws -> (TokenCoordinator, SlowSecretStorage) {
    let seed = InMemorySecretStorage()
    try SecretTokenStore(storage: seed, keys: keys).save(tokens(expiresAt: 10))
    let storage = SlowSecretStorage(
      Dictionary(uniqueKeysWithValues: try seed.keys.map { ($0, try seed.get($0) ?? "") })
    )
    let coordinator = TokenCoordinator(
      store: SecretTokenStore(storage: storage, keys: keys),
      refresh: { _ in
        await started.open()
        await gate.wait()
        return tokens(accessToken: "at-2", refreshToken: "rt-2", expiresAt: 5000)
      },
      nowSeconds: { 0 }
    )

    return (coordinator, storage)
  }

  @Test("a sign-out during a rotation's writes leaves nothing behind, and nothing signed in")
  func signOutDuringWrites() async throws {
    let gate = Gate()
    let (coordinator, storage) = try Self.rig(gate: gate)

    let rotation = Task { try await coordinator.accessToken() }
    await gate.open()
    await waitUntil { storage.writesStarted >= 1 }
    try await coordinator.clear()

    // The rotation finished first or was fenced; either way it did not outlive the sign-out.
    let outcome = await Result { try await rotation.value }
    try await Task.sleep(for: .milliseconds(100))
    await waitUntil { storage.isIdle }
    if case .failure(let error) = outcome {
      #expect(error is AuthChangedError)
    }

    #expect(storage.keys.isEmpty)
    #expect(try await coordinator.current() == nil)
    #expect(try SecretTokenStore(storage: storage, keys: Self.keys).load() == nil)
  }

  @Test("signing in as someone else during a rotation's writes leaves exactly the new account")
  func signInDuringWrites() async throws {
    let gate = Gate()
    let (coordinator, storage) = try Self.rig(gate: gate)
    let other = tokens(accessToken: "at-B", refreshToken: "rt-B", expiresAt: 9000, provider: "other", userID: "someone-else")

    let rotation = Task { try await coordinator.accessToken() }
    await gate.open()
    await waitUntil { storage.writesStarted >= 1 }
    try await coordinator.save(other)
    _ = await Result { try await rotation.value }
    try await Task.sleep(for: .milliseconds(100))
    await waitUntil { storage.isIdle }

    #expect(try SecretTokenStore(storage: storage, keys: Self.keys).load() == other)
    #expect(try await coordinator.current() == other)
  }

  @Test("a sign-out while the refresh is still out means the rotation writes nothing")
  func signOutDuringRefresh() async throws {
    let gate = Gate()
    let started = Gate()
    let (coordinator, storage) = try Self.rig(gate: gate, started: started)

    let rotation = Task { try await coordinator.accessToken() }
    await started.wait()
    try await coordinator.clear()
    await gate.open()

    await #expect(throws: AuthChangedError.self) { try await rotation.value }
    #expect(storage.writesStarted == 0)
    #expect(storage.keys.isEmpty)
  }

  @Test("a rotated set whose write failed is written again on the next call")
  func retriesUnsavedRotation() async throws {
    let timeline = RecordingTimeline()
    let storage = SlowSecretStorage(delay: 0)
    try SecretTokenStore(storage: storage, keys: Self.keys).save(tokens(expiresAt: 10))
    let coordinator = TokenCoordinator(
      store: SecretTokenStore(storage: storage, keys: Self.keys),
      refresh: { _ in tokens(accessToken: "at-2", refreshToken: "rt-2", expiresAt: 5000) },
      nowSeconds: { 0 },
      timeline: timeline
    )

    storage.refuse(1)
    #expect(try await coordinator.accessToken() == "at-2")
    #expect(try storage.get(Self.keys.refreshToken) == "rt-1")
    #expect(timeline.names == ["refresh.start", "refresh.ok", "token.write_failed"])

    #expect(try await coordinator.current()?.accessToken == "at-2")
    #expect(try SecretTokenStore(storage: storage, keys: Self.keys).load()?.refreshToken == "rt-2")
    #expect(timeline.names.last == "token.write_ok")
  }

  @Test("a sign-in the store refused hands out nothing and leaves no half-written set")
  func refusedSave() async throws {
    let storage = SlowSecretStorage(delay: 0)
    try SecretTokenStore(storage: storage, keys: Self.keys).save(tokens(accessToken: "at-old", refreshToken: "rt-old"))
    let coordinator = TokenCoordinator(store: SecretTokenStore(storage: storage, keys: Self.keys), refresh: { _ in tokens() }, nowSeconds: { 0 })

    storage.refuse(2)
    await #expect(throws: SlowSecretStorage.Refused.self) { try await coordinator.save(tokens(accessToken: "at-new", refreshToken: "rt-new")) }

    #expect(try await coordinator.current() == nil)
    #expect(try await coordinator.accessToken() == nil)
    #expect(storage.keys.isEmpty)
  }
}
