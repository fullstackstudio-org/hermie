#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

extension Integration {
  /// `UIMetaSync` over real sockets against `packages/fake-gateway`: what
  /// `packages/gateway-client/src/ui-meta.test.ts` asks of the TypeScript
  /// client, asked of this one. Each device is its own connection.
  @Suite("ui_meta sync against the fake gateway")
  struct UIMetaIntegrationTests {
    private static let ownerKey = UIMeta.appKey(for: "owner")

    /// Two devices of one person on one fresh gateway, each on its own socket.
    private func withTwoDevices(
      _ body: (_ phone: UIMetaSync, _ desktop: UIMetaSync, _ roster: @Sendable () async throws -> [JSONValue]) async throws -> Void
    ) async throws {
      try await FakeGateway.with { gateway in
        try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: "")) { first in
          try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: "")) { second in
            await first.connection.start()
            await second.connection.start()
            try await first.waitFor(.ready)
            try await second.waitFor(.ready)

            var options = UIMetaSync.Options()
            options.debounce = nil

            let phone = UIMetaSync(gateway: .connection(first.connection), options: options)
            let desktop = UIMetaSync(gateway: .connection(second.connection), options: options)
            phone.setUser("owner")
            desktop.setUser("owner")

            let connection = first.connection
            try await body(phone, desktop) {
              try await connection.request("profiles.list")["profiles"]?.arrayValue ?? []
            }
          }
        }
      }
    }

    private static func meta(_ rows: [JSONValue], _ profile: String) -> JSONObject {
      rows.first { $0["name"] == .string(profile) }?["ui_meta"]?.objectValue ?? [:]
    }

    private static func defaultProfile(_ rows: [JSONValue]) throws -> String {
      try #require(rows.first { $0["is_default"] == true }?["name"]?.stringValue)
    }

    @Test("two devices writing the same section converge on the later write, the marker untouched")
    func twoDevicesConverge() async throws {
      try await withTwoDevices { phone, desktop, roster in
        await phone.reconcile()
        await desktop.reconcile()

        phone.updateApp { $0["themeChoice"] = ["kind": "preset", "name": "lime"] }
        phone.updateBot("researcher") { $0["colour"] = "teal" }
        await phone.flush()

        // The desktop read before the phone wrote: its revisions are stale.
        desktop.updateApp { $0["textSize"] = "large" }
        desktop.updateBot("researcher") { $0["colour"] = "lime" }
        await desktop.flush()

        #expect(!phone.pending)
        #expect(!desktop.pending)

        await phone.reconcile()
        await desktop.reconcile()

        let rows = try await roster()
        let home = try Self.defaultProfile(rows)
        let app = Self.meta(rows, home)[Self.ownerKey]

        #expect(phone.documents.bots == desktop.documents.bots)
        #expect(phone.bot("researcher")?["colour"] == "lime")
        #expect(phone.app?["textSize"] == "large")
        #expect(desktop.app?["textSize"] == "large")
        #expect(app?["textSize"] == "large")
        // The phone's choice survives the desktop's later write: the desktop
        // never chose a theme, so its retry carried the one it re-read.
        let lime: JSONValue = ["kind": "preset", "name": "lime"]
        #expect(app?["themeChoice"] == lime)
        #expect(phone.app?["themeChoice"] == lime)
        #expect(desktop.app?["themeChoice"] == lime)
        #expect(Self.meta(rows, "researcher")[UIMeta.botKey]?["colour"] == "lime")
        #expect(Self.meta(rows, "researcher")[UIMeta.botMarkerKey] != nil)
        #expect(phone.mode == .synced)
      }
    }

    @Test("a refused write is retried with the revision that won, and lands")
    func aConflictIsRetried() async throws {
      try await withTwoDevices { phone, desktop, roster in
        await phone.reconcile()
        await desktop.reconcile()

        desktop.updateBot("writer") { $0["archived"] = true }
        await desktop.flush()

        let before = try await roster()
        let revisionBefore = before.first { $0["name"] == "writer" }?["ui_meta_revisions"]?[UIMeta.botKey]?.doubleValue

        phone.updateBot("writer") { $0["colour"] = "teal" }
        await phone.flush()

        let after = try await roster()
        let revisionAfter = after.first { $0["name"] == "writer" }?["ui_meta_revisions"]?[UIMeta.botKey]?.doubleValue

        #expect(!phone.pending)
        #expect(Self.meta(after, "writer")[UIMeta.botKey] == ["v": 1, "colour": "teal"])
        // One landed write on top of the desktop's: the first attempt was refused.
        #expect(revisionAfter == (revisionBefore ?? 0) + 1)
      }
    }

    @Test("a section the device holds and the gateway lacks is seeded on the first reconcile")
    func seedsAnEmptyGateway() async throws {
      try await withTwoDevices { phone, desktop, roster in
        phone.updateApp(.baseline) { $0["textSize"] = "small" }
        await phone.reconcile()
        await desktop.reconcile()

        let rows = try await roster()
        #expect(Self.meta(rows, try Self.defaultProfile(rows))[Self.ownerKey]?["textSize"] == "small")
        #expect(desktop.app?["textSize"] == "small")
      }
    }
  }
}
#endif
