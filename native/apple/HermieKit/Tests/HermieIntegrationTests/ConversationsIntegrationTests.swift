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
private func conversationsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway with the researcher's chat open, as the app holds one.
@MainActor
private func openedSession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-conversations", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await conversationsWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
  }
  try await session.open(researcher)

  return session
}

/// Branch the researcher's live chat the way the web client's chat menu does (`session.branch` on
/// the RUNTIME id), answering the child's stored id.
@MainActor
private func branch(_ session: GatewaySession, name: String, count: Int? = nil) async throws -> String {
  let runtime = try #require(await session.store.sessionIDs()[researcher]?.runtime)
  let reply = try await session.link.requestReply(
    RPC.SessionBranch.name,
    params: .object(SessionBranchParams(sessionID: runtime, profile: researcher, name: name, count: count).json)
  )
  let result = SessionBranchResult(json: reply.result.objectValue ?? [:])

  return try #require(result.storedSessionID)
}

/// `FakeGateway.with`, with the researcher's chat open and a body on the main actor, where the
/// models live; the session is shut down after it, however it ends.
private func withOpenedSession(
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await openedSession(gateway)

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
  /// A bot's Conversations page against the real fake gateway, over a real socket: the list of its
  /// sessions, a branch made with `session.branch`, rename, delete, the swap that makes a past
  /// conversation the Bot Chat again, a new conversation, and the read-only viewer.
  @Suite("Conversations") @MainActor
  struct ConversationsIntegrationTests {
    private func withSession(
      _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
    ) async throws {
      try await withOpenedSession(body)
    }

    @Test("the bot's chat is the current conversation and a branch is listed under Branches")
    func listsTheCurrentConversationAndABranch() async throws {
      try await withSession { session in
        let child = try await branch(session, name: "Branch · the first idea", count: 2)
        let model = session.conversations(for: researcher)

        await model.load()

        let groups = try #require(model.groups)
        #expect(groups.canonical?.kind == .canonical)
        #expect(groups.canonical?.id == session.chatList.rows[researcher]?.bot.canonical?.id)
        #expect(groups.canonical?.actions == [])
        #expect(groups.branches.map(\.id) == [child])
        #expect(groups.branches.first?.title == "Branch · the first idea")
        #expect(groups.branches.first?.messageCount == 2)
        // The Bot Chat is listed once, and not among the rows Delete is offered on.
        #expect(groups.all.filter { $0.title == "Bot Chat" }.count == 1)
      }
    }

    @Test("a branch is renamed (and moves to the past conversations) and then deleted")
    func renamesAndDeletes() async throws {
      try await withSession { session in
        let child = try await branch(session, name: "Branch · to be renamed", count: 2)
        let model = session.conversations(for: researcher)
        await model.load()

        model.beginRename(try #require(model.groups?.conversation(id: child)))
        model.setDraft("Lisbon trip")
        await model.commitRename()

        #expect(model.notice == .renamed)
        let renamed = try #require(model.groups?.conversation(id: child))
        #expect(renamed.title == "Lisbon trip")
        #expect(renamed.kind == .past, "renamed out of its prefix, it is an ordinary past conversation")

        // An empty title is the gateway's refusal, reported, with the field left open.
        model.beginRename(renamed)
        model.setDraft("")
        await model.commitRename()
        guard case .failed? = model.notice else {
          Issue.record("an empty title should be refused, got \(String(describing: model.notice))")
          return
        }
        model.cancel()

        model.beginDelete(renamed)
        await model.confirmDelete()

        #expect(model.notice == .deleted)
        #expect(model.groups?.conversation(id: child) == nil)
      }
    }

    @Test("a new conversation puts the chat away as a past conversation and starts the next one")
    func startsANewConversation() async throws {
      try await withSession { session in
        let model = session.conversations(for: researcher)
        await model.load()
        let before = try #require(model.groups?.canonical)

        model.beginNew()
        await model.confirmNew()

        #expect(model.startedNew == 1)
        let groups = try #require(model.groups)
        #expect(groups.canonical?.id != before.id, "a different conversation is the Bot Chat now")
        let retired = try #require(groups.conversation(id: before.id))
        #expect(retired.kind == .past)
        #expect(ConversationClassifier.isRetiredTitle(retired.title))
        #expect(await session.store.state(of: researcher)?.storedSessionID == groups.canonical?.id)
      }
    }

    @Test("a past conversation is made the Bot Chat again, and the one it replaced is put away")
    func makesAPastConversationTheBotChat() async throws {
      try await withSession { session in
        let model = session.conversations(for: researcher)
        await model.load()
        let original = try #require(model.groups?.canonical)

        model.beginNew()
        await model.confirmNew()
        let successor = try #require(model.groups?.canonical)
        let retired = try #require(model.groups?.conversation(id: original.id))

        await model.adopt(retired)

        #expect(model.notice == .adopted)
        let groups = try #require(model.groups)
        #expect(groups.canonical?.id == original.id, "the first conversation is the Bot Chat again")
        #expect(groups.canonical?.title == "Bot Chat")
        let away = try #require(groups.conversation(id: successor.id))
        #expect(away.kind == .past)
        #expect(ConversationClassifier.isRetiredTitle(away.title))

        // The chat itself moved with it, and the roster agrees.
        #expect(await session.store.state(of: researcher)?.storedSessionID == original.id)
        #expect(session.chatList.rows[researcher]?.bot.canonical?.id == original.id)
        #expect(groups.all.filter { $0.title == "Bot Chat" }.count == 1)
      }
    }

    @Test("a conversation put away can be renamed and then deleted (the real gateway refuses to delete one that is live)")
    func aPutAwayConversationIsNotLive() async throws {
      try await withSession { session in
        let model = session.conversations(for: researcher)
        await model.load()
        let original = try #require(model.groups?.canonical)

        model.beginNew()
        await model.confirmNew()
        // Renamed, which resumes it: it must not stay live afterwards.
        model.beginRename(try #require(model.groups?.conversation(id: original.id)))
        model.setDraft("The old one")
        await model.commitRename()
        #expect(model.notice == .renamed)

        await model.delete(try #require(model.groups?.conversation(id: original.id)))

        #expect(model.notice == .deleted)
        #expect(model.groups?.conversation(id: original.id) == nil)
      }
    }

    @Test("a conversation put away is read in the viewer, oldest first, and the chat is left alone")
    func readsAPastConversation() async throws {
      try await withSession { session in
        let model = session.conversations(for: researcher)
        await model.load()
        let original = try #require(model.groups?.canonical)
        let chatBefore = try #require(await session.store.state(of: researcher)).orderedItems.count
        #expect(chatBefore > 0)

        model.beginNew()
        await model.confirmNew()

        let viewer = session.conversationViewer(
          bot: researcher, conversation: try #require(model.groups?.conversation(id: original.id)))
        await viewer.load()

        #expect(viewer.phase == .ready)
        #expect(viewer.items.contains { $0.item.asUser != nil })
        #expect(viewer.items.contains { $0.item.asAssistant != nil })
        let ids = viewer.items.map(\.item.id)
        #expect(Set(ids).count == ids.count)

        // Reading it moved nothing in the chat: it is the new, empty conversation.
        let chat = try #require(await session.store.state(of: researcher))
        #expect(chat.storedSessionID != original.id)
      }
    }
  }
}
#endif
