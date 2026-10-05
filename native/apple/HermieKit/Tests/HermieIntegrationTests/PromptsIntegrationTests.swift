#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// Two devices of one person on one fresh gateway, each on its own socket, with the body on the main actor,
/// where the prompts models live.
private func withTwoDevicesOnMain(
  _ body: @escaping @MainActor @Sendable (
    _ phone: UIMetaSync, _ desktop: UIMetaSync, _ roster: @Sendable () async throws -> [JSONValue]
  ) async throws -> Void
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

extension Integration {
  /// The reusable prompts (NX-13) over real sockets against `packages/fake-gateway`: written through the
  /// ui_meta sync by one device, followed by the other, and edited back.
  @Suite("Reusable prompts against the fake gateway") @MainActor
  struct PromptsIntegrationTests {
    @Test("prompts reach the other device over the wire, in order, and its edits come back")
    func promptsRoundTrip() async throws {
      try await withTwoDevicesOnMain { phone, desktop, roster in
        let phonePrompts = PromptsModel()
        let desktopPrompts = PromptsModel()

        phonePrompts.attach(phone)
        desktopPrompts.attach(desktop)
        await phone.reconcile()
        await desktop.reconcile()

        let weekly = try #require(phonePrompts.add(title: "Weekly", text: "Summarise {{week}}", scope: .global))
        let review = try #require(phonePrompts.add(title: "Review", text: "Review this", scope: .bot("writer")))
        await phone.flush()
        await desktop.reconcile()

        let deadline = ContinuousClock.now + .seconds(20)
        while desktopPrompts.prompts.count < 2, ContinuousClock.now < deadline {
          try await Task.sleep(for: .milliseconds(10))
        }

        #expect(desktopPrompts.prompts.map(\.id) == [weekly, review])
        #expect(desktopPrompts.prompt(id: weekly)?.fields == ["week"])
        #expect(desktopPrompts.available(for: "writer").map(\.id) == [review, weekly])

        // The other device edits and adds; its choices go back through the same section.
        var edited = try #require(desktopPrompts.prompt(id: weekly))
        edited.title = "Weekly report"
        desktopPrompts.update(edited)
        desktopPrompts.add(title: "Mail", text: "Dear {{who}}", scope: .global)
        await desktop.flush()
        await phone.reconcile()

        let rows = try await roster()
        let home = try #require(rows.first { $0["is_default"] == true }?["name"]?.stringValue)
        let section = rows.first { $0["name"] == .string(home) }?["ui_meta"]?[UIMeta.appKey(for: "owner")]
        let written = section?["prompts"]?.arrayValue ?? []

        #expect(written.count == 3)
        #expect(written.first?["title"] == "Weekly report")
        #expect(section?["updatedAt"] != nil, "a choice dates the section")
      }
    }
  }
}
#endif
