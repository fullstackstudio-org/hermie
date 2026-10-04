import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// What a bot's Conversations page does when the reader is in one of their own chats: a new conversation
/// and a swap are about the SHARED chat, an own chat picked on the page becomes the bot's chat, and the
/// list tells the reader's chats from the rest.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct OwnChatConversationsTests {
  private struct Rig {
    let harness: SessionHarness
    var session: GatewaySession { harness.session }
    var link: ScriptedLink { harness.link }

    func settle() async {
      try? await harness.frame()
    }

    func state() async -> ChatState {
      await session.store.state(of: bot)!
    }
  }

  /// A gateway that opens any chat by its stored id (`stored-x` runs as `rt-x`) and makes an own chat
  /// (`stored-own`), or, when asked for the hidden Bot Chat, a new one (`stored-9`).
  private func rig(listed: [(id: String, title: String)] = []) async throws -> Rig {
    let harness = SessionHarness()
    let link = harness.link

    link.setIdentity(.answered(AuthIdentity(userID: "u-1", displayName: "Ada", provider: "oidc")))
    link.respond(to: RPC.SessionResume.name) { params in
      let stored = params["session_id"]?.stringValue ?? ""

      return Fixture.resume(runtime: "rt-\(stored.dropFirst("stored-".count))", stored: stored)
    }
    link.respond(to: RPC.SessionHistory.name, with: ["count": 0, "messages": []])
    link.respond(to: RPC.SessionEventsSince.name, with: Fixture.since(latest: 0))
    link.respond(to: RPC.SessionActiveList.name, with: ["sessions": []])
    link.respond(to: RPC.SessionSetHidden.name, with: [:])
    link.respond(to: RPC.SessionClose.name, with: [:])
    link.respond(to: RPC.SessionTitle.name) { params in ["title": params["title"] ?? .null] }
    link.respond(to: RPC.SessionCreate.name) { params in
      params["hidden"] == true
        ? ["session_id": "rt-9", "stored_session_id": "stored-9"]
        : ["session_id": "rt-own", "stored_session_id": "stored-own"]
    }

    var rows: [JSONValue] = [["id": "stored-1", "title": "Bot Chat"]]

    for chat in listed {
      rows.append(["id": .string(chat.id), "title": .string(chat.title)])
    }

    link.respond(to: RPC.SessionList.name, with: ["sessions": .array(rows)])

    try await harness.start()
    await harness.session.refreshIdentity()
    harness.session.arrangement.attach(UIMetaSync.device(HoldingGateway().gateway))
    try await harness.session.open(bot)
    try await harness.frame()

    return Rig(harness: harness)
  }

  @Test func aNewConversationFromThePagePutsTheSharedChatAwayWhicheverChatTheReaderIsIn() async throws {
    let rig = try await rig()
    try await rig.session.chooseChat(bot, mine: true)
    await rig.settle()

    try await rig.session.conversationService.startNew(bot: bot)
    await rig.settle()

    // The reader was taken back to the shared chat first, and the choice forgotten.
    #expect(rig.session.arrangement.target(of: bot) == .shared)
    #expect(!(await rig.session.store.isOwnChat(bot)))
    // The chat put away is the Bot Chat, never the reader's own.
    let retired = rig.link.calls(RPC.SessionTitle.name).filter {
      ConversationClassifier.isRetiredTitle($0.params["title"]?.stringValue ?? "")
    }
    #expect(retired.map { $0.params["session_id"] } == [.string(Fixture.runtime)])
    #expect(await rig.state().storedSessionID == "stored-9")
    await rig.session.shutdown()
  }

  @Test func makingAConversationTheBotChatFromThePageLeavesTheOwnChatFirst() async throws {
    let rig = try await rig()
    try await rig.session.chooseChat(bot, mine: true)
    await rig.settle()

    try await rig.session.conversationService.adopt(
      bot: bot, conversation: Conversation(id: "stored-2", title: "Trip planning", kind: .past))
    await rig.settle()

    #expect(rig.session.arrangement.target(of: bot) == .shared)
    #expect(!(await rig.session.store.isOwnChat(bot)))
    #expect(await rig.state().storedSessionID == "stored-2")
    // The own chat was not retitled `Bot Chat · …`: only the shared chat was put away.
    let retired = rig.link.calls(RPC.SessionTitle.name).filter {
      ConversationClassifier.isRetiredTitle($0.params["title"]?.stringValue ?? "")
    }
    #expect(retired.map { $0.params["session_id"] } == [.string(Fixture.runtime)])
    await rig.session.shutdown()
  }

  @Test func anOwnChatPickedOnThePageBecomesTheBotsChat() async throws {
    let rig = try await rig(listed: [("stored-own", "Chat · Ada · Trip")])
    let chat = Conversation(id: "stored-own", title: "Chat · Ada · Trip", kind: .mine)

    try await rig.session.conversationService.useHere(bot: bot, conversation: chat)
    await rig.settle()

    #expect(rig.session.arrangement.target(of: bot) == .chat("stored-own"))
    #expect(await rig.session.store.ownChatStoredID(bot) == "stored-own")
    await rig.session.shutdown()
  }

  @Test func thePagesListNamesTheReadersOwnChatsByTheirLead() async throws {
    let rig = try await rig(listed: [("stored-own", "Chat · Ada · Trip"), ("stored-adam", "Chat · Adam")])

    let groups = try await rig.session.conversationService.list(bot: bot)

    #expect(groups.mine.map(\.id) == ["stored-own"])
    #expect(groups.past.map(\.id) == ["stored-adam"])
    await rig.session.shutdown()
  }

  @Test func aBackendWithNoOwnChatsCannotOpenOne() async throws {
    let harness = StoreHarness()
    let service = ConversationService(link: harness.link, store: harness.store, roster: harness.roster)

    await #expect(throws: ChatRuntimeError.self) {
      try await service.useHere(bot: bot, conversation: Conversation(id: "s", title: "t", kind: .mine))
    }
    await harness.shutdown()
  }
}
