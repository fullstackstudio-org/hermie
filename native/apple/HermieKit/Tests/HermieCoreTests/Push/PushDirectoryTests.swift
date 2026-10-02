import Foundation
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/**
 Push against the real gateway directory and the real relay client: removing a gateway, by any
 route, must revoke its registration at the relay, and a gateway list that cannot be read must
 revoke nothing.
 */
@MainActor
@Suite("Push and the gateway directory")
struct PushDirectoryTests {
  typealias F = PushFixtures

  static let one = "g00000000000000a1"
  static let two = "g00000000000000b2"

  /// A loopback relay that issues capabilities in order and answers every PUT and DELETE.
  static func relay() throws -> LoopbackRelay {
    let issued = Mutex(0)

    return try LoopbackRelay { request in
      switch request.method {
      case "POST":
        let n = issued.withLock { value -> Int in
          value += 1
          return value
        }

        return .json(
          201,
          #"{"handle":"\#(F.handle(n))","sendSecret":"\#(F.secret("send", n))","manageSecret":"\#(F.secret("manage", n))"}"#
        )
      case "PUT":
        return .json(200, #"{"ok":true}"#)
      default:
        return RelayAnswer(status: 204)
      }
    }
  }

  @MainActor
  struct Rig {
    let database: SQLiteStore
    let registry: GatewayRegistryStore
    let directory: GatewayDirectory
    let push: PushController
    let secrets: InMemorySecretStore

    init(relay origin: String) async throws {
      database = try SQLiteStore(.inMemory)
      registry = GatewayRegistryStore(store: database)
      secrets = InMemorySecretStore()

      for (id, n) in [(PushDirectoryTests.one, 1.0), (PushDirectoryTests.two, 2.0)] {
        try await registry.add(
          GatewayRecord(id: id, name: id, address: "https://\(id).example.test", authKind: .nativePKCE, addedAt: n))
      }

      directory = GatewayDirectory(store: registry, changes: KeyValueStore(store: database))

      let system = FakePushSystem()
      system.current = .granted

      push = PushController(
        system: system,
        registrar: PushRegistrar(
          client: try #require(HTTPPushRelayClient(origin: origin)),
          store: PushRegistrationStore(keyValues: KeyValueStore(store: database), secrets: secrets)
        ),
        settings: KeyValueStore(store: database),
        topic: F.topic,
        environment: .sandbox,
        environmentSource: .fallback
      )
    }

    /// What `PushLifecycle` does on every change of the directory.
    func follow() async throws {
      await push.setGateways(try #require(directory.pushGateways))
    }

    func registerBoth() async throws {
      await directory.load()
      try await follow()
      await push.start()
      await push.setEnabled(true)
      push.didRegister(deviceToken: PushControllerTests.Rig.tokenData())

      let push = push
      try await eventually("both registered") { await push.registrations.count == 2 }
    }
  }

  static func deletes(_ relay: LoopbackRelay) -> [RelayRequest] {
    relay.requests.filter { $0.method == "DELETE" }
  }

  @Test("removing a gateway in Settings revokes its registration at the relay and drops its secrets")
  func removeThroughDirectory() async throws {
    let relay = try Self.relay()
    defer { relay.stop() }
    let rig = try await Rig(relay: try await relay.start())
    try await rig.registerBoth()

    try await rig.directory.remove(id: Self.one)
    try await rig.follow()

    let deletes = Self.deletes(relay)
    #expect(deletes.count == 1)
    #expect(deletes.first.map { [F.handle(1), F.handle(2)].map { "/v1/registrations/\($0)" }.contains($0.path) } == true)
    #expect(rig.push.registrations.keys.sorted() == [Self.two])

    let gone = rig.push.registrations[Self.two] == nil ? Self.two : Self.one
    for key in try SecretKeys.gateway(gone).push {
      #expect(try rig.secrets.get(key) == nil)
    }
  }

  @Test("a removal that bypasses the directory (a sync purge) is revoked just the same")
  func removeThroughStore() async throws {
    let relay = try Self.relay()
    defer { relay.stop() }
    let rig = try await Rig(relay: try await relay.start())
    try await rig.registerBoth()

    try await rig.registry.remove(id: Self.two)

    let directory = rig.directory
    try await eventually("the directory followed the store") { await directory.entries.count == 1 }
    try await rig.follow()

    #expect(Self.deletes(relay).count == 1)
    #expect(rig.push.registrations.keys.sorted() == [Self.one])
  }

  @Test("an unreadable gateway list is unknown, not empty: push does not follow it and revokes nothing")
  func unreadableList() async throws {
    let relay = try Self.relay()
    defer { relay.stop() }
    let rig = try await Rig(relay: try await relay.start())
    try await rig.registerBoth()

    try await KeyValueStore(store: rig.database).setString("{not a registry", forKey: StoreKeys.gateways)

    let directory = rig.directory
    try await eventually("the directory saw the unreadable list") { await directory.loadFailed }

    #expect(rig.directory.entries.isEmpty)
    #expect(rig.directory.pushGateways == nil)
    #expect(Self.deletes(relay).isEmpty)
    #expect(rig.push.registrations.count == 2)
  }

  @Test("the push order is the registry's, the live gateway marked")
  func activeFirst() async throws {
    let relay = try Self.relay()
    defer { relay.stop() }
    let rig = try await Rig(relay: try await relay.start())

    await rig.directory.load()
    try await rig.directory.activate(id: Self.two)

    #expect(rig.directory.pushGateways?.map(\.id) == [Self.one, Self.two])
    #expect(rig.directory.pushGateways?.map(\.active) == [false, true])
  }
}
