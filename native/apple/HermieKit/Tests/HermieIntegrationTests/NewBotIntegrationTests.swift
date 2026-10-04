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
private func newBotWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a session ready and a body on the main actor, where the models live.
private func withNewBotSession(_ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await MainActor.run { () throws -> GatewaySession in
      var options = GatewaySession.Options()
      options.connection.backoff = { _ in .milliseconds(100) }
      let record = GatewayRecord(
        id: "g-new-bot", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)

      return try GatewaySession(
        record: record,
        credentials: SessionTokenCredentials(token: ""),
        database: try SQLiteStore(.inMemory),
        options: options
      )
    }

    await session.start()
    try await newBotWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }

    do {
      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension Integration {
  /// Making a bot against the real fake gateway, over a real socket: `NewBotModel` on a
  /// `GatewaySession`, calling `profiles.create`, reading the roster again and resolving the chat.
  @Suite("New bot") @MainActor
  struct NewBotIntegrationTests {
    private func withSession(
      _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
    ) async throws {
      try await withNewBotSession(body)
    }

    @Test("a new bot is made, listed, and has a chat to open")
    func makesTheBot() async throws {
      try await withSession { session in
        let form = session.newBot()

        #expect(form.existing.contains(researcher))

        form.handleText = "  Scout "
        form.botDescription = "Looks ahead."

        let created = await form.create()

        #expect(form.failure == nil)
        #expect(created?.name == "scout")
        #expect(created?.chat.id.isEmpty == false)
        // The roster was read again: the list has the row, with the description the gateway stored.
        let row = try #require(session.chatList.rows["scout"])
        #expect(row.bot.description == "Looks ahead.")
      }
    }

    @Test("a bot copied from another one is made too")
    func clonesTheBot() async throws {
      try await withSession { session in
        let form = session.newBot()

        form.handleText = "scout-two"
        form.cloneFrom = researcher

        let created = await form.create()

        #expect(form.failure == nil)
        #expect(created?.name == "scout-two")
        #expect(session.chatList.rows["scout-two"] != nil)
      }
    }

    @Test("a name the gateway refuses is read as a refusal and nothing is made")
    func refusesATakenName() async throws {
      try await withSession { session in
        // A form that does not know the bot exists (a roster that was out of date): the gateway says no.
        let roster = session.roster
        let form = NewBotModel(
          gateway: .link(session.link),
          roster: NewBotRoster(
            refresh: { try await roster.refresh() },
            resolveCanonical: { try await roster.resolveCanonical($0) }
          ),
          existing: []
        )

        form.handleText = researcher
        #expect(form.canCreate)

        #expect(await form.create() == nil)

        guard case .request(.refused(let reason)) = form.failure else {
          Issue.record("expected the gateway's refusal, got \(String(describing: form.failure))")
          return
        }

        #expect(!reason.isEmpty)
        #expect(!form.creating)
      }
    }

    @Test("a name the form refuses is never sent")
    func neverSendsAReservedName() async throws {
      try await withSession { session in
        let form = session.newBot()

        form.handleText = "sudo"

        #expect(!form.canCreate)
        #expect(await form.create() == nil)
        #expect(session.chatList.rows["sudo"] == nil)
      }
    }

    @Test("the models the gateway offers are listed for the picker")
    func listsModels() async throws {
      try await withSession { session in
        let form = session.newBot()

        await form.loadModelChoices()

        guard case .loaded(let choices) = form.modelChoices else {
          Issue.record("the fake gateway lists models")
          return
        }

        #expect(!choices.isEmpty)
      }
    }
  }
}
#endif
