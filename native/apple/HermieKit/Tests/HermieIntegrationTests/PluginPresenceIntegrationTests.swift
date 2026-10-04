#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// A session on the fake gateway, started, with the body on the main actor; shut down after it.
private func withPluginSession(
  _ options: FakeGateway.Options,
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in
    let session = try await MainActor.run { () throws -> GatewaySession in
      var sessionOptions = GatewaySession.Options()
      sessionOptions.connection.backoff = { _ in .milliseconds(100) }
      let record = GatewayRecord(
        id: "g-plugin", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)

      return try GatewaySession(
        record: record,
        credentials: SessionTokenCredentials(token: ""),
        database: try SQLiteStore(.inMemory),
        options: sessionOptions
      )
    }

    await session.start()

    do {
      let deadline = ContinuousClock.now + .seconds(40)

      while await !MainActor.run(body: { session.chatList.refreshed }) {
        guard ContinuousClock.now < deadline else {
          Issue.record("Timed out waiting for the roster")
          throw CancellationError()
        }

        try await Task.sleep(for: .milliseconds(10))
      }

      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension Integration {
  /// Whether the gateway's plugin is there, read off the roster the fake gateway answers over a real
  /// socket: its `hermie-plugin` advert is in the `ui_meta` of the profiles.
  @Suite("Plugin presence") @MainActor
  struct PluginPresenceIntegrationTests {
    @Test("a gateway with the Hermie plugin says so, with its version")
    func installed() async throws {
      try await withPluginSession(FakeGateway.Options()) { session in
        guard case .installed(let version) = session.pluginPresence else {
          Issue.record("expected the plugin, got \(session.pluginPresence)")
          return
        }

        #expect(!version.isEmpty)
      }
    }

    @Test("a gateway without it says so, once the roster has been read")
    func absent() async throws {
      try await withPluginSession(FakeGateway.Options(plugin: false)) { session in
        #expect(session.pluginPresence == .absent)
      }
    }
  }
}
#endif
