#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"
/// A harmless marker standing in for a password.
private let marker = "marker-vault-5d81"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func vaultWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

private func withVaultSession(
  _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(
      id: "g-vault", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try await MainActor.run {
      try GatewaySession(
        record: record,
        credentials: SessionTokenCredentials(token: ""),
        database: try SQLiteStore(.inMemory),
        options: options
      )
    }

    await session.start()

    do {
      try await vaultWait("the socket and the roster") {
        session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
      }
      try await body(gateway, session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension FakeGateway {
  /// `POST /__fake/vault`: stage the password manager (`managerPassword`, `managerItems`), `clear` or
  /// `unsupported`.
  @discardableResult
  fileprivate func stageVault(_ fields: JSONObject) async throws -> JSONValue {
    try await control("POST", "/__fake/vault", body: .object(fields))
  }

  /// `GET /__fake/vault`: one profile's items as the vault stores them (secrets included), the manager's state
  /// and every vault call's method, profile and keys.
  fileprivate func vaultContents(_ profile: String) async throws -> JSONValue {
    try await control("GET", "/__fake/vault?profile=\(profile)")
  }
}

extension Integration {
  /// A bot's vault against the real fake gateway, over a real socket: what reaches the bot's own vault and
  /// nobody else's, and that the app keeps no secret on the way, stored or refused.
  @Suite("Vault") @MainActor
  struct VaultIntegrationTests {
    @Test("a login typed into the form reaches the bot's own vault, and the app keeps nothing of the secret")
    func addsALogin() async throws {
      try await withVaultSession { gateway, session in
        let model = session.vault(for: researcher)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.items.isEmpty)
        #expect(model.sources.map(\.name) == ["local", "bitwarden"])

        let form = VaultAddForm()
        form.label = "Work"
        form.site = "example.com"
        form.identifierType = .username
        form.identifier = "me"
        form.setSecret("password", marker)

        #expect(await form.submit(to: model))
        #expect(form.secretsEmpty)
        #expect(model.items.map(\.label) == ["Work"])
        #expect(model.items.first?.origin == "https://example.com")
        #expect(model.items.first?.identifier == "me")
        #expect(model.items.first?.isLocal == true)

        let stored = try await gateway.vaultContents(researcher)
        #expect(stored["items"]?[0]?["secret"] == .object(["password": .string(marker)]))
        #expect(stored["items"]?[0]?["identifier"]?.stringValue == "me")
        // Every vault call named the bot's profile.
        let profiles = (stored["calls"]?.arrayValue ?? []).map { $0["profile"]?.stringValue }
        #expect(!profiles.isEmpty && profiles.allSatisfy { $0 == researcher })

        // Another bot's vault is another vault.
        let writer = try await gateway.vaultContents("writer")
        #expect(writer["items"]?.arrayValue?.isEmpty == true)
        let other = session.vault(for: "writer")
        await other.load()
        #expect(other.items.isEmpty)
      }
    }

    @Test("a refused add is said in the gateway's words and leaves no secret in the form or the model")
    func refusedAdd() async throws {
      try await withVaultSession { gateway, session in
        let model = session.vault(for: researcher)
        await model.load()

        let form = VaultAddForm()
        form.label = "Broken"
        form.site = "http://"
        form.identifier = "me@example.com"
        form.setSecret("password", marker)

        #expect(!(await form.submit(to: model)))
        #expect(form.secretsEmpty)
        #expect(form.label == "Broken")
        #expect(model.addFailure?.detail?.contains("origin") == true)
        #expect(model.addFailure?.detail?.contains(marker) == false)

        let stored = try await gateway.vaultContents(researcher)
        #expect(stored["items"]?.arrayValue?.isEmpty == true)
      }
    }

    @Test("an item is removed only after the confirmation")
    func removes() async throws {
      try await withVaultSession { gateway, session in
        let model = session.vault(for: researcher)
        await model.load()
        let form = VaultAddForm()
        form.label = "Work"
        form.site = "https://example.com"
        form.identifier = "me@example.com"
        form.setSecret("password", marker)
        #expect(await form.submit(to: model))
        let item = try #require(model.items.first)

        model.askRemoval(item)
        model.cancelRemoval()
        #expect(try await gateway.vaultContents(researcher)["items"]?.arrayValue?.count == 1)

        model.askRemoval(item)
        #expect(await model.confirmRemoval())
        #expect(model.items.isEmpty)
        #expect(try await gateway.vaultContents(researcher)["items"]?.arrayValue?.isEmpty == true)
      }
    }

    @Test("a password manager unlocks with its master password for this bot only, and locks again")
    func unlocksAndLocks() async throws {
      try await withVaultSession { gateway, session in
        try await gateway.stageVault([
          "managerPassword": .string(marker),
          "managerItems": .array([
            .object([
              "label": .string("Shop"), "kind": .string("login"), "origin": .string("https://shop.example"),
              "identifier": .string("me"), "identifier_type": .string("username")
            ])
          ])
        ])
        let model = session.vault(for: researcher)
        await model.load()
        let bitwarden = try #require(model.managers.first)
        #expect(bitwarden.name == "bitwarden" && !bitwarden.unlocked)

        // A wrong password: refused, its words scrubbed, nothing kept.
        let wrong = VaultUnlockForm(source: bitwarden)
        wrong.password = SecretValue("marker-wrong-0b7e")
        #expect(!(await wrong.submit(to: model)))
        #expect(wrong.password.isEmpty)
        #expect(model.unlockFailure?.detail?.contains("marker-wrong-0b7e") == false)

        let form = VaultUnlockForm(source: bitwarden)
        form.password = SecretValue(marker)
        #expect(await form.submit(to: model))
        #expect(form.password.isEmpty)
        #expect(model.managers.first?.unlocked == true)
        #expect(model.items.map(\.label) == ["Shop"])
        #expect(model.items.first?.isLocal == false)
        #expect(model.managerName(of: try #require(model.items.first)) == "Bitwarden")

        // Unlocked for this bot's profile, not for another's.
        let other = session.vault(for: "writer")
        await other.load()
        #expect(other.items.isEmpty)
        #expect(other.managers.first?.unlocked == false)

        #expect(await model.lock("bitwarden"))
        #expect(model.managers.first?.unlocked == false)
        #expect(model.items.isEmpty)

        #expect(await model.setEnabled("bitwarden", false))
        #expect(model.managers.first?.enabled == false)
        let contents = try await gateway.vaultContents(researcher)
        #expect(contents["managerEnabled"]?.boolValue == false)
      }
    }

    @Test("a gateway without the vault says so")
    func unsupported() async throws {
      try await withVaultSession { gateway, session in
        try await gateway.stageVault(["unsupported": .bool(true)])
        let model = session.vault(for: researcher)

        await model.load()

        #expect(model.phase == .failed(.unsupported))
      }
    }
  }
}
#endif
