#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func settingsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, ready, as the app holds one.
@MainActor
private func readySession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-bot-settings", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await settingsWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.rows[researcher] != nil
  }
  return session
}

/// `FakeGateway.with`, with a session ready and a body on the main actor, where the models live.
private func withBotSettingsSession(
  _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    try await body(gateway, try await readySession(gateway))
  }
}

/// What another device of the same person reads of the bot's label and colour, over a socket of
/// its own.
private func arrangementOnAnotherDevice(_ gateway: FakeGateway) async throws -> ChatListArrangement {
  try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: "")) { other in
    await other.connection.start()
    try await other.waitFor(.ready)

    var options = UIMetaSync.Options()
    options.debounce = nil
    let desktop = UIMetaSync(gateway: .connection(other.connection), options: options)
    desktop.setUser("owner")
    await desktop.reconcile()

    return ChatListArrangement(documents: desktop.documents)
  }
}

extension Integration {
  /// The bot settings against the real fake gateway, over a real socket: `BotSettingsModel` on a
  /// `GatewaySession`, reading `profiles.describe` and writing `profiles.configure`,
  /// `profiles.set_asset` and `reload.mcp`; and the bot's label and colour through `ui_meta`.
  @Suite("Bot settings") @MainActor
  struct BotSettingsIntegrationTests {
    private func withSession(
      _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
    ) async throws {
      try await withBotSettingsSession { gateway, session in
        do {
          try await body(gateway, session)
        } catch {
          await session.shutdown()
          throw error
        }

        await session.shutdown()
      }
    }

    @Test("a profile is read from the gateway: text, model pin, toolsets, skills and MCP servers")
    func readsTheProfile() async throws {
      try await withSession { _, session in
        let model = session.botSettings(for: researcher)

        await model.load()

        #expect(model.phase == .loaded)
        let details = try #require(model.details)
        #expect(details.name == researcher)
        #expect(details.description == "Finds things out.")
        #expect(details.soul == "")
        #expect(details.model.isPinned)
        #expect(details.skills.map(\.name) == ["pdf", "docx", "web-search"])
        let everySkillOn = details.skills.allSatisfy { $0.enabled }
        #expect(everySkillOn)
        // The gateway lists the toolsets a bot can be given; the default-off one is not offered.
        #expect(details.toolsets.map(\.name) == ["files", "web", "terminal", "memory"])
        #expect(!details.toolsetsPinned)
        #expect(!details.mcpServers.isEmpty)
        #expect(model.descriptionDraft == "Finds things out.")
      }
    }

    @Test("the personality and the description are written, and read back by a model that starts fresh")
    func writesTheText() async throws {
      try await withSession { _, session in
        let model = session.botSettings(for: researcher)
        await model.load()

        model.soulDraft = "You are terse.\n\nNo emoji."
        model.descriptionDraft = "  Reads slowly. "
        await model.saveSoul()
        await model.saveDescription()

        #expect(model.failures.isEmpty)
        #expect(!model.soulIsDirty)
        #expect(!model.descriptionIsDirty)

        let fresh = session.botSettings(for: researcher)
        await fresh.load()

        #expect(fresh.details?.soul == "You are terse.\n\nNo emoji.")
        #expect(fresh.details?.description == "Reads slowly.")

        // The roster is told to reread after the description: the chat list shows the new line.
        try await settingsWait("the roster to show the new description") {
          session.chatList.rows[researcher]?.bot.description == "Reads slowly."
        }
      }
    }

    @Test("switches are written the way the gateway stores them, and read back")
    func writesTheSwitches() async throws {
      try await withSession { _, session in
        let model = session.botSettings(for: researcher)
        await model.load()

        await model.setToolset("web", enabled: false)
        await model.setSkill("docx", enabled: false)

        #expect(model.failures.isEmpty)
        #expect(model.details?.toolsetsPinned == true)

        let fresh = session.botSettings(for: researcher)
        await fresh.load()

        #expect(fresh.details?.toolsetsPinned == true)
        #expect(fresh.details?.toolsets.first { $0.name == "web" }?.enabled == false)
        #expect(fresh.details?.toolsets.first { $0.name == "files" }?.enabled == true)
        #expect(fresh.details?.skills.first { $0.name == "docx" }?.enabled == false)
        #expect(fresh.details?.skills.first { $0.name == "pdf" }?.enabled == true)

        // Switching it back on leaves the pin as it is on screen; the way back to the gateway's
        // own defaults is a request of its own, and what it shows afterwards is the gateway's.
        await fresh.setToolset("web", enabled: true)
        let pinned = session.botSettings(for: researcher)
        await pinned.load()
        #expect(pinned.details?.toolsetsPinned == true)
        #expect(pinned.details?.toolsets.first { $0.name == "web" }?.enabled == true)

        await pinned.useDefaultToolsets()
        #expect(pinned.details?.toolsetsPinned == false)
        let again = session.botSettings(for: researcher)
        await again.load()
        #expect(again.details?.toolsetsPinned == false)
        #expect(again.details?.toolsets.first { $0.name == "memory" }?.enabled == false)
      }
    }

    @Test("an MCP switch asks before reloading running chats, and the answer goes back to the gateway")
    func reloadsMcpOnlyWhenTheGatewayIsTold() async throws {
      try await withSession { gateway, session in
        let model = session.botSettings(for: researcher)
        await model.load()
        let server = try #require(model.details?.mcpServers.first)

        await model.setMcpServer(server.name, enabled: !server.enabled)

        #expect(model.failures.isEmpty)
        // The gateway answered `confirm_required` with a 200: that is a question, not a reload.
        let prompt = try #require(model.mcpReloadPrompt)
        #expect(prompt.message.contains("prompt cache"))
        #expect(model.notice == nil)

        await model.reloadMcp(always: false)
        #expect(model.mcpReloadPrompt == nil)
        #expect(model.notice == .mcpReloaded)

        let state = try await gateway.control("GET", "/__fake/state")
        let log = state["methodLog"]?.arrayValue?.compactMap(\.stringValue) ?? []
        #expect(log.filter { $0 == "reload.mcp" }.count == 2)
      }
    }

    @Test("a model is pinned, and a guarded one writes nothing until it is confirmed")
    func pinsAModel() async throws {
      try await withSession { _, session in
        let model = session.botSettings(for: researcher)
        await model.load()
        await model.loadModelChoices()

        guard case .loaded(let choices) = model.modelChoices else {
          Issue.record("the gateway listed no models")
          return
        }

        let plain = try #require(choices.first { $0.provider == "second-provider" && $0.model == "reasoner-2" })
        let guarded = try #require(choices.first { $0.model == "expensive-model" })

        await model.chooseModel(plain)
        #expect(model.details?.model == BotModelPin(provider: "second-provider", model: "reasoner-2"))

        await model.chooseModel(guarded)
        let asked = try #require(model.modelConfirmation)
        #expect(asked.message.contains("expensive"))
        #expect(model.details?.model.model == "reasoner-2")

        await model.confirmModel()
        #expect(model.modelConfirmation == nil)
        #expect(model.details?.model == BotModelPin(provider: "example-provider", model: "expensive-model"))
      }
    }

    @Test("an account the gateway will not let write sees the settings read-only, and nothing changed")
    func aRefusedWritePutsTheScreenInReadOnly() async throws {
      try await withSession { gateway, session in
        let model = session.botSettings(for: researcher)
        await model.load()

        try await gateway.control(
          "POST", "/__fake/deny",
          body: .object([
            "methods": ["profiles.configure"], "code": 4030, "message": "Your account can view this bot only."
          ]))

        #expect(model.canWrite(connected: true))
        await model.setSkill("pdf", enabled: false)

        #expect(model.failures[.skills] == .forbidden("Your account can view this bot only."))
        #expect(model.refused)
        #expect(!model.canWrite(connected: true))
        // The switch is back where the gateway has it, and reading still works.
        #expect(model.details?.skills.first { $0.name == "pdf" }?.enabled == true)

        let reader = session.botSettings(for: researcher)
        await reader.load()
        #expect(reader.phase == .loaded)
        #expect(reader.details?.skills.first { $0.name == "pdf" }?.enabled == true)
      }
    }

    @Test("a picture is uploaded and taken away, and the roster rereads")
    func storesAPicture() async throws {
      try await withSession { _, session in
        let model = session.botSettings(for: researcher)
        await model.load()

        // One pixel of PNG.
        let png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        await model.setAvatar(base64: png)
        #expect(model.failures.isEmpty)

        try await settingsWait("the roster to show the picture") {
          session.chatList.rows[researcher]?.bot.hasAvatar == true
        }

        await model.clearAvatar()
        try await settingsWait("the roster to drop the picture") {
          session.chatList.rows[researcher]?.bot.hasAvatar == false
        }
      }
    }

    @Test("a label and a colour are written through ui_meta, and another device reads them")
    func writesTheIdentityThroughUiMeta() async throws {
      try await withSession { gateway, session in
        var options = UIMetaSync.Options()
        options.debounce = nil
        let sync = UIMetaSync(gateway: .link(session.link), options: options)
        sync.setUser("owner")
        session.arrangement.attach(sync)
        await sync.reconcile()

        session.arrangement.setLabel("writer", "  De Schrijver ")
        session.arrangement.setAccent("writer", .violet)
        #expect(session.arrangement.label("writer") == "De Schrijver")
        #expect(session.chatName("writer") == "De Schrijver")
        await sync.flush()

        let other = try await arrangementOnAnotherDevice(gateway)
        #expect(other.label("writer") == "De Schrijver")
        #expect(other.accent("writer") == .violet)

        // Taking them back removes the choices.
        session.arrangement.setLabel("writer", "")
        session.arrangement.setAccent("writer", .default)
        #expect(session.chatName("writer") != "De Schrijver")
        await sync.flush()

        let back = try await arrangementOnAnotherDevice(gateway)
        #expect(back.label("writer") == nil)
        #expect(back.accent("writer") == .default)
      }
    }
  }
}
#endif
