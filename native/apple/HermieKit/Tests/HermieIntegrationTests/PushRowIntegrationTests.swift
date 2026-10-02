#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A notification system that grants and does nothing else.
@MainActor
private final class GrantingSystem: PushSystem {
  func permission() async -> PushPermission { .granted }
  func requestPermission() async -> PushPermission { .granted }
  func registerForRemoteNotifications() {}
  func setCategories(_ categories: [PushCategoryDescriptor]) {}
  func setBadgeCount(_ count: Int) async {}
  func openSettings() {}
}

extension Integration {
  /**
   The whole client chain against `packages/fake-gateway` and a loopback relay: the registrar gets
   a capability from the relay over HTTP, the row writer puts it in the gateway's `ui_meta` through
   a real socket, and the gateway's own copy of the push section holds a relay row a sender
   accepts, under this installation, with the handle the relay issued and without the manage
   secret. (Delivery itself is the notifier's: the plugin or Hermie Web reads that row and posts
   to the relay; the fake gateway stores rows and does not send.)
   */
  @Suite("push row against the fake gateway")
  struct PushRowIntegrationTests {
    static let handle = "h_" + String(repeating: "A", count: 22)
    static let sendSecret = String(repeating: "s", count: 43)
    static let manageSecret = String(repeating: "m", count: 43)

    @Test("the registered handle reaches the gateway's push section as this installation's relay row")
    func rowLands() async throws {
      let relay = try LoopbackListener { head in
        if head.hasPrefix("POST /v1/registrations ") {
          return LoopbackListener.reply(
            "201 Created",
            headers: ["Content-Type: application/json"],
            body: #"{"handle":"\#(Self.handle)","sendSecret":"\#(Self.sendSecret)","manageSecret":"\#(Self.manageSecret)"}"#
          )
        }

        return head.hasPrefix("DELETE") ? LoopbackListener.reply("204 No Content") : LoopbackListener.reply("200 OK")
      }

      try await relay.start()
      defer { relay.stop() }

      let origin = relay.origin

      try await FakeGateway.with { gateway in
        try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: "")) { live in
          await live.connection.start()
          try await live.waitFor(.ready)
          try await Self.check(live.connection, relay: origin)
        }
      }

      #expect(relay.requests.contains { $0.hasPrefix("POST /v1/registrations ") })
    }

    @MainActor
    private static func check(_ connection: GatewayConnection, relay origin: String) async throws {
          var options = UIMetaSync.Options()
          options.debounce = nil

          let sync = UIMetaSync(gateway: .connection(connection), options: options)
          sync.setUser("owner")
          await sync.reconcile()

          let database = try SQLiteStore(.inMemory)
          let keyValues = KeyValueStore(store: database)
          let installation = try await PushInstallation.id(in: keyValues)
          let push = PushController(
            system: GrantingSystem(),
            registrar: PushRegistrar(
              client: try #require(HTTPPushRelayClient(origin: origin)),
              store: PushRegistrationStore(keyValues: keyValues, secrets: InMemorySecretStore())
            ),
            settings: keyValues,
            topic: "dev.hermie.app",
            environment: .sandbox,
            environmentSource: .fallback
          )

          let key = "0123456789abcdef"
          let writer = PushRowWriter(sync: sync, gatewayId: "g0123456789abcdef", gatewayKey: key, installation: installation, push: push)
          sync.register(writer)

          await push.setGateways([PushGatewayRef(id: "g0123456789abcdef", key: key, active: true)])
          await push.start()
          await push.setEnabled(true)
          push.didRegister(deviceToken: Data(repeating: 0xAB, count: 32))

          let deadline = ContinuousClock.now + .seconds(30)
          while push.registrations.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
          }

          #expect(await writer.refresh())
          await sync.flush()
          #expect(!sync.pending)

          // The gateway's own copy, read back over the same socket: wherever this gateway's
          // notifier reads the rows (the per-person key, or the bare one on an older plugin).
          let rows = try await connection.request("profiles.list")["profiles"]?.arrayValue ?? []
          let home = rows.first { $0["is_default"] == true }?["ui_meta"]?.objectValue ?? [:]
          let sections = [home[UIMeta.appKey(for: "owner")], home[UIMeta.legacyAppKey]].compactMap { $0 }
          let row = sections.compactMap { $0["push"]?["registrations"]?[installation] }.first

          #expect(row?["handle"] == .string(Self.handle))
          #expect(row?["secret"] == .string(Self.sendSecret))
          #expect(row?["relay"] == .string(origin))
          #expect(row?["gatewayKey"] == .string(key))
          #expect(row.flatMap { try? $0.canonicalString() }?.contains(Self.manageSecret) == false)

          // The reader every sender applies accepts it, but for its origin, which is a loopback
          // address here and the https relay in the app.
          var asTheAppWritesIt = try #require(row?.objectValue)
          asTheAppWritesIt["relay"] = .string(PushRelay.defaultOrigin)
          #expect(PushRows.addressOf(.object(asTheAppWritesIt)) != nil)
    }
  }
}
#endif
