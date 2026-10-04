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
private func ownChatsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with the researcher's shared chat open, who the reader is read, and a body on
/// the main actor, where the models live; the session is shut down after it, however it ends.
private func withOwnChatsSession(
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await MainActor.run { () throws -> GatewaySession in
      var options = GatewaySession.Options()
      options.connection.backoff = { _ in .milliseconds(100) }
      let record = GatewayRecord(
        id: "g-own-chats", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)

      return try GatewaySession(
        record: record,
        credentials: SessionTokenCredentials(token: ""),
        database: try SQLiteStore(.inMemory),
        options: options
      )
    }

    await session.start()

    do {
      try await ownChatsWait("the socket, the roster and the reader's identity") {
        session.status.phase == .ready && session.chatList.rows[researcher] != nil && session.ownChatsAvailable
      }
      try await session.open(researcher)
      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension Integration {
  /// A reader's own chats against the real fake gateway, over a real socket: the switch between the
  /// shared Bot Chat and a chat of their own, another one beside it, and what the Conversations page
  /// makes of them (`GatewaySession.chooseChat`, `startOwnChat`, `ConversationService`).
  ///
  /// The fake gateway runs without accounts, so the reader is `owner` (`Chat · owner`).
  @Suite("Own chats") @MainActor
  struct OwnChatsIntegrationTests {
    private func titles(_ session: GatewaySession) async throws -> [String: String] {
      let groups = try await session.conversationService.list(bot: researcher)

      return Dictionary(uniqueKeysWithValues: groups.all.map { ($0.id, $0.title) })
    }

    @Test("my chat is made under the Bot Chat, opened, and told apart from the shared chat in a listing")
    func choosesMyChat() async throws {
      try await withOwnChatsSession { session in
        let shared = try #require(await session.store.sessionIDs()[researcher]?.stored)
        #expect(session.ownChatLead == "Chat · owner")

        try await session.chooseChat(researcher, mine: true)

        let mine = try #require(await session.store.ownChatStoredID(researcher))
        #expect(mine != shared)
        #expect(session.arrangement.target(of: researcher) == .shared, "no ui_meta sync is attached to remember it")
        #expect(await session.store.isOwnChat(researcher))

        let groups = try await session.conversationService.list(bot: researcher)
        #expect(groups.canonical?.id == shared)
        #expect(groups.mine.map(\.id) == [mine])
        #expect(groups.mine.first?.title.hasPrefix("Chat · owner") == true)
      }
    }

    @Test("what is said in my chat stays in it, and the shared chat is as it was")
    func theTwoChatsAreSeparate() async throws {
      try await withOwnChatsSession { session in
        let before = try #require(await session.store.state(of: researcher)).orderedItems.count

        try await session.chooseChat(researcher, mine: true)
        try await ownChatsWait("my chat to be live") { session.chat(researcher).canSend }
        try await session.store.send(researcher, text: "only for me")
        try await ownChatsWait("the reply") {
          let state = await session.store.state(of: researcher)

          return state?.turn.active == false
            && state?.orderedItems.compactMap(\.asUser).map(\.text).contains("only for me") == true
            && state?.orderedItems.compactMap(\.asAssistant).isEmpty == false
        }

        try await session.chooseChat(researcher, mine: false)
        try await ownChatsWait("the shared chat to be live") { session.chat(researcher).canSend }

        let shared = try #require(await session.store.state(of: researcher))
        #expect(shared.orderedItems.count == before)
        #expect(!shared.orderedItems.compactMap(\.asUser).map(\.text).contains("only for me"))

        try await session.chooseChat(researcher, mine: true)
        try await ownChatsWait("my chat to be read again") {
          await session.store.state(of: researcher)?.orderedItems.compactMap(\.asUser).map(\.text)
            .contains("only for me") == true
        }
      }
    }

    @Test("another chat of my own is made, named and opened, and the first one is kept")
    func startsAnotherChat() async throws {
      try await withOwnChatsSession { session in
        try await session.chooseChat(researcher, mine: true)
        let first = try #require(await session.store.ownChatStoredID(researcher))

        let made = try await session.startOwnChat(researcher, label: "Ideas")

        #expect(made.title == "Chat · owner · Ideas")
        #expect(await session.store.ownChatStoredID(researcher) == made.chat.id)
        #expect(made.chat.id != first)

        let titles = try await titles(session)
        #expect(titles[first]?.hasPrefix("Chat · owner") == true, "the one the reader was in is still theirs")
        #expect(titles[made.chat.id] == "Chat · owner · Ideas")
      }
    }

    @Test("an own chat picked on the page becomes the bot's chat, and /new there does not retire it")
    func usesAChatFromThePage() async throws {
      try await withOwnChatsSession { session in
        try await session.chooseChat(researcher, mine: true)
        let first = try #require(await session.store.ownChatStoredID(researcher))
        let second = try await session.startOwnChat(researcher, label: "Ideas").chat.id

        try await session.conversationService.useHere(
          bot: researcher, conversation: Conversation(id: first, title: "Chat · owner", kind: .mine))
        #expect(await session.store.ownChatStoredID(researcher) == first)

        let before = try await titles(session)
        try await session.store.startNewConversation(researcher, argument: "Third", command: "/new")
        try await ownChatsWait("the third chat") {
          await session.store.ownChatStoredID(researcher).map { $0 != first && $0 != second } == true
        }

        let after = try await titles(session)
        #expect(after[first] == before[first], "the chat /new was typed in is exactly as it was")
        #expect(after[second] == before[second])
        #expect(after.values.contains("Chat · owner · Third"))
        #expect(!after.values.contains { ConversationClassifier.isRetiredTitle($0) })
      }
    }

    @Test("the shared chat is found again by the page's new conversation, whichever chat the reader was in")
    func aNewConversationIsAlwaysTheSharedOne() async throws {
      try await withOwnChatsSession { session in
        let shared = try #require(await session.store.sessionIDs()[researcher]?.stored)
        try await session.chooseChat(researcher, mine: true)
        let mine = try #require(await session.store.ownChatStoredID(researcher))

        try await session.conversationService.startNew(bot: researcher)

        #expect(!(await session.store.isOwnChat(researcher)))
        let titles = try await titles(session)
        #expect(titles[mine]?.hasPrefix("Chat · owner") == true, "the reader's own chat was not retired")
        #expect(titles[shared].map(ConversationClassifier.isRetiredTitle) == true, "the Bot Chat was")
      }
    }
  }
}
#endif
