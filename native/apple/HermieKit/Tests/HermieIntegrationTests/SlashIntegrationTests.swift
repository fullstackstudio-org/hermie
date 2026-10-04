#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func slashWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a body on the main actor, where the models live.
private func withSlashGateway(
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with the researcher's chat open and the composer a chat screen holds.
@MainActor
private struct SlashChat {
  let session: GatewaySession
  let composer: ComposerModel

  static func open(_ gateway: FakeGateway) async throws -> SlashChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(
      id: "g-slash", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = SlashChat(session: session, composer: ComposerModel(session: session, bot: researcher))

    await session.start()
    try await slashWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    try await slashWait("the chat to accept a message") { chat.composer.canSend }
    return chat
  }

  /// The notice rows in the transcript, oldest first.
  func notices() async -> [NoticeItem] {
    await session.store.state(of: researcher)?.orderedItems.compactMap(\.asNotice) ?? []
  }

  func userTexts() async -> [String] {
    await session.store.state(of: researcher)?.orderedItems.compactMap(\.asUser).map(\.text) ?? []
  }
}

extension Integration {
  /// The composer's slash commands against the real fake gateway, over real sockets: the command list
  /// as `hermes serve` shapes it, completions, and each road a command takes (`slash.exec`,
  /// `command.dispatch`, a directive from either).
  @Suite("Slash commands") @MainActor
  struct SlashIntegrationTests {
    @Test("typing a slash lists the gateway's commands, narrows as the name is typed, and hints the argument")
    func completions() async throws {
      try await withSlashGateway { gateway in
        let chat = try await SlashChat.open(gateway)
        let composer = chat.composer

        composer.draft = "/"
        try await slashWait("the command list") { !composer.suggestions.isEmpty }
        #expect(composer.suggestions.map(\.label).contains("/status"))
        #expect(composer.suggestions.first { $0.label == "/release-notes" }?.kind == .skill)

        composer.draft = "/mo"
        #expect(composer.suggestions.map(\.label) == ["/model"])
        #expect(composer.suggestions.first?.hint == "[model]")

        // Taken, the command is in the field and the list says what it takes.
        #expect(composer.handle(.tab))
        #expect(composer.draft == "/model ")
        #expect(composer.argumentHint?.usage == "[model]")

        // An alias finds its command.
        composer.draft = "/q"
        #expect(composer.suggestions.map(\.label) == ["/queue"])

        // Escape closes it, and a send clears it.
        composer.draft = "/st"
        #expect(composer.suggestionsOpen)
        #expect(composer.handle(.escape))
        #expect(!composer.suggestionsOpen)
        await chat.session.shutdown()
      }
    }

    @Test("a worker command runs through slash.exec and its answer is a row in the transcript")
    func workerCommand() async throws {
      try await withSlashGateway { gateway in
        let chat = try await SlashChat.open(gateway)
        let composer = chat.composer
        let before = await chat.userTexts()

        composer.draft = "/status"
        try await slashWait("the command list") { composer.commands != nil }
        await composer.submit()
        #expect(composer.draft.isEmpty)
        #expect(composer.notice == nil)
        #expect(composer.lastEvent?.event == .commandRan)

        try await slashWait("the answer's row") {
          await chat.notices().contains { $0.title == "/status" }
        }
        let row = try #require(await chat.notices().last { $0.title == "/status" })
        #expect(row.body?.contains("Hermes TUI Status") == true)
        #expect(row.body?.split(separator: "\n").count ?? 0 > 3, "the whole block, not one line")
        #expect(await chat.userTexts() == before, "a command is not a message")
        await chat.session.shutdown()
      }
    }

    @Test("a skill goes through command.dispatch: the bubble shows the invocation, the bot gets the expansion")
    func skill() async throws {
      try await withSlashGateway { gateway in
        let chat = try await SlashChat.open(gateway)
        let composer = chat.composer

        composer.draft = "/release-notes for 1.2"
        try await slashWait("the command list") { composer.commands != nil }
        await composer.submit()
        #expect(composer.notice == nil, "slash.exec's refusal of a skill is never shown")

        try await slashWait("the invocation's bubble") {
          await chat.userTexts().contains("/release-notes for 1.2")
        }
        let texts = await chat.userTexts()
        #expect(!texts.contains { $0.contains("IMPORTANT") }, "the skill's expansion is never drawn")
        await chat.session.shutdown()
      }
    }

    @Test("a send directive from slash.exec goes to the bot and its word is not shown as the answer")
    func sendDirective() async throws {
      try await withSlashGateway { gateway in
        let chat = try await SlashChat.open(gateway)
        let composer = chat.composer

        composer.draft = "/queue write it up"
        try await slashWait("the command list") { composer.commands != nil }
        await composer.submit()

        try await slashWait("the bubble") { await chat.userTexts().contains("/queue write it up") }
        #expect(!(await chat.notices().contains { $0.body == "write it up" }))
        await chat.session.shutdown()
      }
    }

    @Test("a line that is no command of the gateway's goes to the bot as written")
    func notACommand() async throws {
      try await withSlashGateway { gateway in
        let chat = try await SlashChat.open(gateway)
        let composer = chat.composer

        composer.draft = "/usr/local/bin is where it lives"
        #expect(!composer.suggestionsOpen, "a path is not a command being written")
        await composer.submit()

        try await slashWait("the bubble") { await chat.userTexts().contains("/usr/local/bin is where it lives") }
        #expect(await chat.notices().filter { $0.title.hasPrefix("/usr") }.isEmpty)
        await chat.session.shutdown()
      }
    }
  }
}
#endif
