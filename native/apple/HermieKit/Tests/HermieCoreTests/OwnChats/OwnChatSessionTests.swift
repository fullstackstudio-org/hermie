import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A gateway that opens any chat by its stored id (`stored-x` runs as `rt-x`), reads each one's own
/// history (the shared chat's rows say `row 1…`, an own chat's `row 50…`), and answers the calls
/// that title, create, hide and close a session.
private func answerEverything(_ link: ScriptedLink) {
  link.respond(to: RPC.SessionResume.name) { params in
    let stored = params["session_id"]?.stringValue ?? ""

    return Fixture.resume(runtime: "rt-\(stored.dropFirst("stored-".count))", stored: stored)
  }
  link.respond(to: RPC.SessionHistory.name) { params in
    let own = params["session_id"]?.stringValue != Fixture.runtime
    let rows = own ? Fixture.rows(2, from: 50) : Fixture.rows(2)

    return ["count": 2, "messages": .array(rows)]
  }
  link.respond(to: RPC.SessionEventsSince.name, with: Fixture.since(latest: 0))
  link.respond(to: RPC.SessionActiveList.name, with: ["sessions": []])

  for method in [RPC.SessionSetHidden.name, RPC.SessionClose.name] {
    link.respond(to: method, with: [:])
  }

  link.respond(to: RPC.SessionTitle.name) { params in ["title": params["title"] ?? .null] }
}

/// A listing with the shared chat and, when `own` is given, the reader's own chat.
private func listing(own: [(id: String, title: String)] = []) -> JSONValue {
  var rows: [JSONValue] = [["id": "stored-1", "title": "Bot Chat"]]

  for chat in own {
    rows.append(["id": .string(chat.id), "title": .string(chat.title)])
  }

  return ["sessions": .array(rows)]
}

fileprivate extension SessionHarness {
  /// Let the store take in what was sent and apply the frames.
  func settle() async {
    try? await frame()
  }

  func state() async -> ChatState {
    await session.store.state(of: bot)!
  }
}

// MARK: - The store

@Suite(.timeLimit(.minutes(1))) struct OwnChatStoreTests {
  private func opened(cache: (any ChatCaching)? = nil) async throws -> StoreHarness {
    let harness = StoreHarness(cache: cache)
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    harness.link.respond(to: RPC.ProfilesList.name, with: [
      "profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored)]]]
    ])
    _ = try await harness.roster.refresh()
    try await harness.open()
    answerEverything(harness.link)

    return harness
  }

  private let own = CanonicalSession(id: "stored-own", resolvedID: "stored-own")

  @Test func anOwnChatIsOpenedUnderTheBotsKeyAndTheRosterKeepsNamingTheBotChat() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))

    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()

    #expect(harness.link.calls(RPC.SessionResume.name).last?.params["session_id"] == "stored-own")
    let state = await harness.state()
    #expect(state.storedSessionID == "stored-own")
    #expect(state.runtimeSessionID == "rt-own")
    #expect(state.orderedItems.compactMap(\.asUser).map(\.text).contains("row 51"))
    #expect(await harness.store.isOwnChat(bot))
    #expect(await harness.store.ownChatStoredID(bot) == "stored-own")
    // Not a swap: the roster still says the bot's chat is the shared one, and so does its unread badge.
    #expect(await harness.roster.bot(named: bot)?.canonical?.id == Fixture.stored)
    await harness.shutdown()
  }

  @Test func theWayBackIsTheSharedChatOpenedAgain() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))
    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()

    try await harness.store.showChat(bot, bot: row, own: nil)
    await harness.settle()

    #expect(harness.link.calls(RPC.SessionResume.name).last?.params["session_id"] == .string(Fixture.stored))
    #expect(await harness.state().storedSessionID == Fixture.stored)
    #expect(!(await harness.store.isOwnChat(bot)))
    #expect(await harness.store.ownChatStoredID(bot) == nil)
    await harness.shutdown()
  }

  @Test func askingForTheChatTheBotIsOnChangesNothing() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))
    let before = harness.link.calls.count

    try await harness.store.showChat(bot, bot: row, own: nil)
    #expect(harness.link.calls.count == before, "already on the shared chat, and live")

    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()
    let opened = harness.link.calls.count

    try await harness.store.showChat(bot, bot: row, own: own)
    #expect(harness.link.calls.count == opened, "already on that own chat, and live")
    await harness.shutdown()
  }

  @Test func aReplyStreamingIntoTheChatRefusesTheSwitchBeforeAnythingMoves() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))
    harness.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    _ = try await harness.store.send(bot, text: "working on it")
    await harness.settle()
    let before = harness.link.calls.count

    await #expect(throws: ConversationBusyError.self) { try await harness.store.showChat(bot, bot: row, own: own) }
    await #expect(throws: ConversationBusyError.self) { try await harness.store.assertCanLeave(bot) }

    #expect(harness.link.calls.count == before, "the gateway heard nothing")
    #expect(!(await harness.store.isOwnChat(bot)))
    #expect(await harness.state().storedSessionID == Fixture.stored)
    await harness.shutdown()
  }

  /// The cache is keyed by bot and has no idea which conversation it holds: it must hold the shared chat
  /// only, or one chat would be painted as the other.
  @Test func anOwnChatIsNeverWrittenToTheTranscriptCache() async throws {
    let cache = MemoryChatCache()
    let harness = try await opened(cache: cache)
    let row = try #require(await harness.roster.bot(named: bot))
    await harness.store.persistAll()
    let shared = try #require(await cache.read(bot: bot)).itemsJSON
    #expect(shared.contains("row 2"))

    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()
    await harness.store.persistAll()

    let after = try #require(await cache.read(bot: bot)).itemsJSON
    #expect(after == shared, "what the cache holds is still the shared chat")
    #expect(!after.contains("row 51"))
    await harness.shutdown()
  }

  @Test func anOwnChatIsNeverPaintedFromTheTranscriptCache() async throws {
    let cache = MemoryChatCache()
    let first = try await opened(cache: cache)
    await first.store.persistAll()
    await first.shutdown()

    let harness = StoreHarness(cache: cache)
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    let row = Fixture.bot()

    // The reader's memory puts the bot on an own chat: the cache's shared transcript is not painted
    // under its ids while the gateway has not answered.
    let opening = Task { try await harness.store.showChat(bot, bot: row, own: own) }
    let resume = try await harness.link.pendingCall(RPC.SessionResume.name)
    #expect(await harness.store.state(of: bot)?.order.isEmpty != false)

    harness.link.answer(resume, Fixture.resume(runtime: "rt-own", stored: "stored-own"))
    try await harness.link.answerNext(
      RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2, from: 50))])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await opening.value
    await harness.settle()

    let texts = await harness.state().orderedItems.compactMap(\.asUser).map(\.text)
    #expect(texts.contains("row 51"))
    #expect(!texts.contains("row 1"))
    await harness.shutdown()
  }

  @Test func newInAnOwnChatStartsAnotherOneAndNeverRetiresIt() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))
    let started = Mutex<[String]>([])
    await harness.store.setOwnChatStarter { key, argument, command in
      started.withLock { $0.append("\(key)|\(argument)|\(command)") }
    }

    // On the shared chat `/new` is what it always was.
    harness.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-9", "stored_session_id": "stored-9"])
    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()
    let calls = harness.link.calls.count

    try await harness.store.startNewConversation(bot, argument: "Ideas", command: "/new")

    #expect(started.withLock { $0 } == ["researcher|Ideas|/new"])
    #expect(harness.link.calls.count == calls, "nothing was retired, hidden or renamed")
    await harness.shutdown()
  }

  @Test func anOwnChatCannotBeMadeTheBotChat() async throws {
    let harness = try await opened()
    let row = try #require(await harness.roster.bot(named: bot))
    try await harness.store.showChat(bot, bot: row, own: own)
    await harness.settle()
    let calls = harness.link.calls.count

    await #expect(throws: ChatRuntimeError.self) {
      try await harness.store.adoptAsCanonical(bot, as: CanonicalSession(id: "stored-2", resolvedID: "stored-2"))
    }

    #expect(harness.link.calls.count == calls)
    #expect(harness.link.calls(RPC.SessionTitle.name).isEmpty)
    await harness.shutdown()
  }
}

// MARK: - The session

@MainActor
@Suite(.timeLimit(.minutes(1))) struct OwnChatSessionTests {
  private struct Rig {
    let harness: SessionHarness
    var session: GatewaySession { harness.session }
    var link: ScriptedLink { harness.link }
  }

  /// A session with the shared chat open. `named` is whether the gateway names the reader; `remembered`
  /// is the own chat their memory puts the bot on, which the gateway lists as `listed`.
  private func rig(named: Bool = true, remembered: String? = nil, listed: [(id: String, title: String)] = [])
    async throws -> Rig
  {
    let harness = SessionHarness()
    harness.link.setIdentity(
      named
        ? .answered(AuthIdentity(userID: "u-1", displayName: "Ada", provider: "oidc")) : .failed("not asked"))
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionList.name, with: listing(own: listed))
    try await harness.start()
    await harness.session.refreshIdentity()

    let sync = UIMetaSync.device(HoldingGateway().gateway)
    harness.session.arrangement.attach(sync)

    if let remembered {
      harness.session.arrangement.setCurrent(bot, remembered)
    }

    try await harness.session.open(bot)
    try await harness.frame()

    return Rig(harness: harness)
  }

  @Test func theReadersOwnChatsAreOfferedOnlyWhereTheGatewayNamedThem() async throws {
    let anonymous = try await rig(named: false)

    #expect(!anonymous.session.ownChatsAvailable)
    #expect(anonymous.session.chatTarget(bot) == .shared)
    await #expect(throws: ChatResolver.ResolutionError.self) { try await anonymous.session.chooseChat(bot, mine: true) }
    await #expect(throws: ChatResolver.ResolutionError.self) { try await anonymous.session.startOwnChat(bot) }
    #expect(anonymous.link.calls(RPC.SessionCreate.name).isEmpty)

    let named = try await rig()
    #expect(named.session.ownChatsAvailable)
    #expect(named.session.ownChatLead == "Chat · Ada")
    await anonymous.session.shutdown()
    await named.session.shutdown()
  }

  @Test func theIdentityTheGatewayAnswersNamesTheLead() async throws {
    let harness = SessionHarness()
    harness.link.setIdentity(
      .answered(AuthIdentity(userID: "sam-sub", email: "sam@example.test", displayName: "Sam", provider: "oidc")))
    await harness.session.refreshIdentity()
    #expect(harness.session.ownChatLead == "Chat · Sam")

    harness.link.setIdentity(.answered(AuthIdentity(userID: "", email: "sam@example.test", provider: "oidc")))
    await harness.session.refreshIdentity()
    #expect(harness.session.ownChatLead == "Chat · sam@example.test")

    harness.link.setIdentity(.sessionToken)
    await harness.session.refreshIdentity()
    #expect(harness.session.ownChatLead == "Chat · owner")

    harness.link.setIdentity(.failed("503"))
    await harness.session.refreshIdentity()
    #expect(!harness.session.ownChatsAvailable)
    await harness.session.shutdown()
  }

  @Test func choosingMyChatForTheFirstTimeMakesItOpensItAndRemembersIt() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.SessionList.name, with: listing())
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-own", "stored_session_id": "stored-own"])

    try await rig.session.chooseChat(bot, mine: true)
    await rig.harness.settle()

    let create = try #require(rig.link.calls(RPC.SessionCreate.name).first)
    #expect(create.params["parent_session_id"] == .string(Fixture.stored), "under the Bot Chat")
    #expect(create.params["hidden"] == false)
    #expect(rig.link.calls(RPC.SessionResume.name).last?.params["session_id"] == "stored-own")
    #expect(rig.session.arrangement.target(of: bot) == .chat("stored-own"))
    #expect(rig.session.chatTarget(bot) == .chat("stored-own"))
    #expect(await rig.session.store.isOwnChat(bot))
    #expect(await rig.session.roster.bot(named: bot)?.canonical?.id == Fixture.stored)
    await rig.session.shutdown()
  }

  @Test func choosingMyChatAgainFindsTheOneThatIsRememberedAndMakesNothing() async throws {
    let rig = try await rig(listed: [("stored-own", "Chat · Ada · Trip")])
    // The memory names the chat and the screen is on the shared one (another device chose).
    rig.session.arrangement.setCurrent(bot, "stored-own")

    try await rig.session.chooseChat(bot, mine: true)
    await rig.harness.settle()

    #expect(rig.link.calls(RPC.SessionCreate.name).isEmpty)
    #expect(rig.link.calls(RPC.SessionResume.name).last?.params["session_id"] == "stored-own")
    #expect(await rig.session.store.ownChatStoredID(bot) == "stored-own")
    await rig.session.shutdown()
  }

  @Test func choosingTheSharedChatGoesBackAndForgetsTheChoice() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.SessionList.name, with: listing())
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-own", "stored_session_id": "stored-own"])
    try await rig.session.chooseChat(bot, mine: true)

    try await rig.session.chooseChat(bot, mine: false)
    await rig.harness.settle()

    #expect(rig.link.calls(RPC.SessionResume.name).last?.params["session_id"] == .string(Fixture.stored))
    #expect(rig.session.arrangement.target(of: bot) == .shared)
    #expect(!(await rig.session.store.isOwnChat(bot)))
    await rig.session.shutdown()
  }

  @Test func aSwitchThatDidNotHappenIsNotRemembered() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.SessionList.name, with: listing())
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-own", "stored_session_id": "stored-own"])
    rig.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    _ = try await rig.session.store.send(bot, text: "working on it")
    await rig.harness.settle()

    await #expect(throws: ConversationBusyError.self) { try await rig.session.chooseChat(bot, mine: true) }

    #expect(rig.session.arrangement.target(of: bot) == .shared)
    #expect(rig.link.calls(RPC.SessionCreate.name).isEmpty, "refused before anything was made")
    await rig.session.shutdown()
  }

  @Test func aNewChatOfMyOwnIsMadeUnderTheBotChatNamedAndOpened() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-two", "stored_session_id": "stored-two"])

    let made = try await rig.session.startOwnChat(bot, label: "Ideas")
    await rig.harness.settle()

    #expect(made.title == "Chat · Ada · Ideas")
    #expect(made.chat.id == "stored-two")
    let create = try #require(rig.link.calls(RPC.SessionCreate.name).first)
    #expect(create.params["title"] == "Chat · Ada · Ideas")
    #expect(create.params["parent_session_id"] == .string(Fixture.stored))
    #expect(rig.session.arrangement.target(of: bot) == .chat("stored-two"))
    #expect(await rig.session.store.ownChatStoredID(bot) == "stored-two")
    await rig.session.shutdown()
  }

  @Test func aNewChatIsRefusedBeforeItIsMadeWhileTheChatOnScreenCannotBeLeft() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    _ = try await rig.session.store.send(bot, text: "working on it")
    await rig.harness.settle()

    await #expect(throws: ConversationBusyError.self) { try await rig.session.startOwnChat(bot) }

    #expect(rig.link.calls(RPC.SessionCreate.name).isEmpty)
    await rig.session.shutdown()
  }

  @Test func theChatOpensOnTheOneTheMemoryNames() async throws {
    let rig = try await rig(remembered: "stored-own", listed: [("stored-own", "Chat · Ada")])

    #expect(rig.link.calls(RPC.SessionResume.name).map { $0.params["session_id"]?.stringValue } == ["stored-own"])
    #expect(await rig.session.store.ownChatStoredID(bot) == "stored-own")
    #expect(await rig.session.roster.bot(named: bot)?.canonical?.id == Fixture.stored)
    await rig.session.shutdown()
  }

  @Test func aChatTheMemoryNamesThatIsGoneIsForgottenAndTheSharedChatOpens() async throws {
    let rig = try await rig(remembered: "stored-gone")

    #expect(rig.link.calls(RPC.SessionResume.name).map { $0.params["session_id"]?.stringValue } == ["stored-1"])
    #expect(rig.session.arrangement.target(of: bot) == .shared)
    await rig.session.shutdown()
  }

  @Test func aLegacyChoiceIsFoundByTheBareLeadAndGivenItsID() async throws {
    let harness = SessionHarness()
    harness.link.setIdentity(.answered(AuthIdentity(userID: "u-1", displayName: "Ada", provider: "oidc")))
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionList.name, with: listing(own: [("stored-first", "Chat · Ada")]))
    try await harness.start()
    await harness.session.refreshIdentity()
    let sync = UIMetaSync.device(HoldingGateway().gateway, app: ["v": 1, "myChats": [.string(bot)]])
    harness.session.arrangement.attach(sync)
    #expect(harness.session.arrangement.target(of: bot) == .legacy)

    try await harness.session.open(bot)

    #expect(harness.link.calls(RPC.SessionResume.name).map { $0.params["session_id"]?.stringValue } == ["stored-first"])
    #expect(harness.session.arrangement.target(of: bot) == .chat("stored-first"))
    #expect(harness.link.calls(RPC.SessionList.name).first?.params["title"] == "Chat · Ada")
    await harness.session.shutdown()
  }

  @Test func aListingThatFailsLeavesTheMemoryAloneAndTheOpenFails() async throws {
    let harness = SessionHarness()
    harness.link.setIdentity(.answered(AuthIdentity(userID: "u-1", displayName: "Ada", provider: "oidc")))
    answerEverything(harness.link)
    try await harness.start()
    await harness.session.refreshIdentity()
    let sync = UIMetaSync.device(HoldingGateway().gateway)
    harness.session.arrangement.attach(sync)
    harness.session.arrangement.setCurrent(bot, "stored-own")
    harness.link.refuse(RPC.SessionList.name) { _ in GatewayRPCError(.timeout, "slow") }

    await #expect(throws: ChatResolver.ResolutionError.self) { try await harness.session.open(bot) }

    #expect(harness.session.arrangement.target(of: bot) == .chat("stored-own"), "a gateway that is slow has deleted nothing")
    await harness.session.shutdown()
  }

  @Test func aBotWithNoChoiceOpensTheSharedChatAsItAlwaysDid() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.session.ownChatIdentity = OwnChatIdentity(userID: "u-1", displayName: "Ada")

    try await harness.open()

    #expect(harness.link.calls(RPC.SessionList.name).isEmpty, "no lookup for a bot nobody switched")
    #expect(!(await harness.session.store.isOwnChat(bot)))
    await harness.session.shutdown()
  }

  @Test func newInAnOwnChatStartsAnotherAndSaysSoInTheChatTheReaderIsLeftIn() async throws {
    let rig = try await rig()
    rig.link.respond(to: RPC.SessionList.name, with: listing())
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-own", "stored_session_id": "stored-own"])
    try await rig.session.chooseChat(bot, mine: true)
    await rig.harness.settle()
    rig.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-two", "stored_session_id": "stored-two"])
    let hidden = rig.link.calls(RPC.SessionSetHidden.name).count

    try await rig.session.store.startNewConversation(bot, argument: "Ideas", command: "/new")
    await rig.harness.settle()

    #expect(rig.link.calls(RPC.SessionCreate.name).last?.params["title"] == "Chat · Ada · Ideas")
    #expect(rig.link.calls(RPC.SessionSetHidden.name).count == hidden, "nothing was retired")
    #expect(await rig.session.store.ownChatStoredID(bot) == "stored-two")

    let state = await rig.harness.state()
    let notice = state.orderedItems.compactMap(\.asNotice).last
    #expect(notice?.body?.contains("New chat started: “Ideas”") == true)
    await rig.session.shutdown()
  }
}
