import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A session over a scripted link, opened, with a composer on its chat.
@MainActor
private struct ComposerHarness {
  let harness: SessionHarness
  let keyValues: KeyValueStore
  let composer: ComposerModel

  static func opened(keyValues: KeyValueStore? = nil) async throws -> ComposerHarness {
    let keyValues = try keyValues ?? KeyValueStore(store: SQLiteStore(.inMemory))
    let harness = SessionHarness(keyValues: keyValues)
    try await harness.start()
    let composer = ComposerModel(
      chat: harness.session.chat(bot),
      gatewayID: harness.session.gatewayID,
      session: harness.session,
      drafts: keyValues,
      debounce: .zero
    )
    try await harness.open()
    try await harness.frame()
    return ComposerHarness(harness: harness, keyValues: keyValues, composer: composer)
  }

  var link: ScriptedLink { harness.link }

  func state() async -> ChatState? {
    await harness.session.store.state(of: bot)
  }

  /// A turn the bot started: the composer sees it once the frame is out.
  func startTurn(seq: Int = 1) async throws {
    link.emit("message.start", session: Fixture.runtime, seq: seq)
    try await harness.frame()
  }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct ComposerModelTests {
  // MARK: The draft

  @Test func theDraftIsKeptPerGatewayAndBotAndSurvivesARelaunch() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let first = try await ComposerHarness.opened(keyValues: keyValues)
    #expect(first.composer.draftStorageKey == "hermie.chat.draft.\(bot)@g1")

    first.composer.draft = "half a thought"
    try await eventually("the draft on disk") {
      (try? await keyValues.string(forKey: "hermie.chat.draft.\(bot)@g1")) == "half a thought"
    }
    await first.shutdown()

    // A fresh launch: a new session and composer over the same store.
    let second = try await ComposerHarness.opened(keyValues: keyValues)
    #expect(second.composer.draft.isEmpty)
    await second.composer.loadDraft()
    #expect(second.composer.draft == "half a thought")

    // Emptied, it is gone from the store rather than kept as "".
    second.composer.draft = "  "
    await second.composer.flushDraft()
    #expect(try await keyValues.string(forKey: "hermie.chat.draft.\(bot)@g1") == nil)
    await second.shutdown()
  }

  @Test func typingBeforeTheStoredDraftArrivesWins() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    try await keyValues.setString("old words", forKey: "hermie.chat.draft.\(bot)@g1")
    let opened = try await ComposerHarness.opened(keyValues: keyValues)

    opened.composer.draft = "new words"
    await opened.composer.loadDraft()
    #expect(opened.composer.draft == "new words")
    await opened.shutdown()
  }

  @Test func theDraftWriteWaitsForAPauseInTyping() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let harness = SessionHarness(keyValues: keyValues)
    let composer = ComposerModel(
      chat: harness.session.chat(bot),
      gatewayID: "g1",
      session: harness.session,
      drafts: keyValues,
      debounce: .seconds(30)
    )

    composer.draft = "a"
    composer.draft = "ab"
    try await Task.sleep(for: .milliseconds(50))
    #expect(try await keyValues.string(forKey: composer.draftStorageKey) == nil, "nothing written mid-typing")

    await composer.flushDraft()
    #expect(try await keyValues.string(forKey: composer.draftStorageKey) == "ab")
    await harness.session.shutdown()
  }

  @Test func whileARequestHasTheScreenTypingIsRefusedAndNothingIsWritten() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let harness = SessionHarness(keyValues: keyValues)
    let composer = ComposerModel(
      chat: harness.session.chat(bot),
      gatewayID: "g1",
      session: harness.session,
      drafts: keyValues,
      debounce: .zero
    )

    composer.type("before")
    try await eventually("the draft written") { @MainActor in
      (try? await keyValues.string(forKey: composer.draftStorageKey)) == "before"
    }

    composer.held = true
    composer.type("a secret meant for the prompt")
    #expect(composer.draft == "before", "typing is refused while held")

    // Even a draft set from elsewhere while held is not written to disk.
    composer.draft = "set while held"
    try await Task.sleep(for: .milliseconds(50))
    #expect(try await keyValues.string(forKey: composer.draftStorageKey) == "before")
    #expect(!composer.canSubmit)

    composer.held = false
    composer.type("after")
    #expect(composer.draft == "after")
    await harness.session.shutdown()
  }

  // MARK: Sending

  @Test func aSendClearsTheFieldPaintsTheBubbleAndIsAnnounced() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    #expect(composer.availability == .ready)

    composer.draft = "hello there"
    #expect(composer.canSubmit)
    let sending = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(call.params["text"] == "hello there")
    #expect(composer.draft.isEmpty, "cleared once painted, before the gateway answers")
    #expect(composer.isSending)

    opened.link.answer(call, ["status": "streaming"])
    await sending.value
    #expect(composer.lastEvent?.event == .sent)
    #expect(composer.notice == nil)
    #expect(!composer.isSending)
    #expect(await opened.state()?.orderedItems.compactMap(\.asUser).last?.text == "hello there")
    await opened.shutdown()
  }

  @Test func everyAcceptedSendIsReportedOnceAndARefusedOneIsNot() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    var reported = 0
    composer.onSubmit = { reported += 1 }

    composer.draft = "   "
    await composer.submit()
    #expect(reported == 0, "nothing to send")

    composer.draft = "first"
    let sending = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(reported == 1, "reported when accepted, before the gateway answers")
    opened.link.answer(call, ["status": "streaming"])
    await sending.value
    #expect(reported == 1)
    await opened.shutdown()

    let harness = SessionHarness()
    try await harness.start()
    let unopened = ComposerModel(
      chat: harness.session.chat(bot), gatewayID: "g1", session: harness.session, drafts: nil, debounce: .zero)
    var refused = 0
    unopened.onSubmit = { refused += 1 }
    unopened.draft = "are you there?"
    await unopened.submit()
    #expect(refused == 0, "a send refused before anything was painted is not reported")
    await harness.session.shutdown()
  }

  @Test func aSendRefusedBeforeAnythingIsPaintedKeepsTheDraft() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let composer = ComposerModel(
      chat: harness.session.chat(bot), gatewayID: "g1", session: harness.session, drafts: nil, debounce: .zero)
    // Not opened: the socket is up, the chat is not bound to a session.
    #expect(composer.availability == .opening)

    composer.draft = "are you there?"
    #expect(!composer.canSubmit)
    await composer.submit()

    #expect(composer.draft == "are you there?")
    guard case .notSent? = composer.notice else {
      Issue.record("expected a not-sent notice, got \(String(describing: composer.notice))")
      return
    }
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asUser).isEmpty ?? true)
    await harness.session.shutdown()
  }

  @Test func aSendThatFailsAfterThePaintKeepsTheBubbleAndNotTheDraft() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer

    composer.draft = "do it"
    let sending = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    opened.link.fail(call, GatewayRPCError(.rejected, "busy", code: 4009))
    await sending.value

    #expect(composer.draft.isEmpty, "the words are on screen, in the bubble")
    #expect(composer.notice == .failed("busy"))
    let state = try #require(await opened.state())
    #expect(state.orderedItems.compactMap(\.asUser).last?.text == "do it")
    #expect(state.turn.interrupted == true)
    #expect(state.turn.active == false)
    await opened.shutdown()
  }

  // MARK: A chat open in another Hermes window or terminal

  /// The gateway's refusal of a turn while another live Hermes process holds the chat, word for
  /// word (the fork's `session_already_owned_message`, code 4090, `reason` SESSION_NOT_OWNED).
  static let ownedElsewhere = GatewayRPCError(
    .rejected,
    "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\n"
      + "Details: session 20260923_143304_1025bb opened by cli 4m ago.",
    code: 4090,
    data: ["reason": "SESSION_NOT_OWNED"])

  @Test func aChatOpenElsewhereIsItsOwnNoticeAndTheMessageIsNotTriedAgain() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer

    composer.draft = "hello"
    let sending = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    opened.link.fail(call, Self.ownedElsewhere)
    await sending.value

    #expect(composer.notice == .openElsewhere(details: "session 20260923_143304_1025bb opened by cli 4m ago."))
    try await Task.sleep(for: .milliseconds(100))
    #expect(opened.link.calls(RPC.PromptSubmit.name).count == 1, "nothing is sent again by itself")
    await opened.shutdown()
  }

  @Test func onlyThatRefusalIsTakenForIt() {
    #expect(SessionOwnership.details(of: Self.ownedElsewhere) == "session 20260923_143304_1025bb opened by cli 4m ago.")
    #expect(SessionOwnership.details(of: GatewayRPCError(.rejected, "busy", code: 4090)) == nil, "no reason")
    #expect(
      SessionOwnership.details(of: GatewayRPCError(.rejected, "full", code: 4090, data: ["reason": "MAX_CONCURRENT_SESSIONS"]))
        == nil)
    #expect(SessionOwnership.details(of: GatewayRPCError(.timeout, "late")) == nil)
    #expect(
      SessionOwnership.details(of: GatewayRPCError(.rejected, "Open elsewhere.", code: 4090, data: ["reason": "SESSION_NOT_OWNED"]))
        == "", "no details line")
  }

  @Test func aNewChatFromTheRefusalPutsTheWordsBackAndSendsNothing() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    let link = opened.link

    composer.draft = "hello"
    let sending = Task { await composer.submit() }
    let call = try await link.pendingCall(RPC.PromptSubmit.name)
    link.fail(call, Self.ownedElsewhere)
    await sending.value

    for method in [RPC.SessionSetHidden.name, RPC.SessionTitle.name, RPC.SessionClose.name] {
      link.respond(to: method, with: [:])
    }
    link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-new", "stored_session_id": "stored-new"])

    let starting = Task { await composer.startNewConversation() }
    try await link.answerNext(RPC.SessionResume.name, Fixture.resume(runtime: "rt-new", stored: "stored-new"))
    try await link.answerNext(RPC.SessionHistory.name, ["count": 0, "messages": []])
    try await link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    await starting.value

    #expect(composer.notice == nil)
    #expect(link.calls(RPC.SessionCreate.name).count == 1, "a new chat, as /new starts one")
    #expect(await opened.state()?.runtimeSessionID == "rt-new")
    #expect(composer.draft == "hello", "the refused words are back in the field")
    #expect(link.calls(RPC.PromptSubmit.name).count == 1, "and not sent")
    await opened.shutdown()
  }

  @Test func aNewChatFromTheRefusalLeavesWhatWasTypedSince() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    let link = opened.link

    composer.draft = "hello"
    let sending = Task { await composer.submit() }
    link.fail(try await link.pendingCall(RPC.PromptSubmit.name), Self.ownedElsewhere)
    await sending.value
    composer.draft = "something else"

    for method in [RPC.SessionSetHidden.name, RPC.SessionTitle.name, RPC.SessionClose.name] {
      link.respond(to: method, with: [:])
    }
    link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-new", "stored_session_id": "stored-new"])

    let starting = Task { await composer.startNewConversation() }
    try await link.answerNext(RPC.SessionResume.name, Fixture.resume(runtime: "rt-new", stored: "stored-new"))
    try await link.answerNext(RPC.SessionHistory.name, ["count": 0, "messages": []])
    try await link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    await starting.value

    #expect(await opened.state()?.runtimeSessionID == "rt-new")
    #expect(composer.draft == "something else", "what was typed since stays")
    #expect(link.calls(RPC.PromptSubmit.name).count == 1)
    await opened.shutdown()
  }

  @Test func availabilityFollowsTheSession() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer

    opened.link.status(.reconnecting)
    try await eventually("reconnecting") { await composer.availability == .connecting }
    #expect(!composer.canSubmit)

    opened.link.status(.needsSignin)
    try await eventually("signed out") { await composer.availability == .signedOut }
    await opened.shutdown()
  }

  // MARK: The queue

  @Test func sendsDuringATurnAreQueuedAndGoOutInOrderAsEachTurnEnds() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    let link = opened.link
    link.setREST { _, _ in [] }
    try await opened.startTurn()
    #expect(composer.running)

    for text in ["first", "second", "third"] {
      composer.draft = text
      await composer.submit()
      #expect(composer.lastEvent?.event == .queued)
    }

    try await opened.harness.frame()
    #expect(composer.queue.map(\.text) == ["first", "second", "third"])
    #expect(link.calls(RPC.PromptSubmit.name).isEmpty, "parked here, not on the gateway")

    // Removed from the strip: it never goes out.
    await composer.removeQueued(composer.queue[1].id)
    try await opened.harness.frame()
    #expect(composer.queue.map(\.text) == ["first", "third"])

    link.emit("message.complete", session: Fixture.runtime, seq: 2, payload: ["text": "done"])
    let first = try await link.pendingCall(RPC.PromptSubmit.name)
    #expect(first.params["text"] == "first")
    link.answer(first, ["status": "streaming"])

    link.emit("message.start", session: Fixture.runtime, seq: 3)
    link.emit("message.complete", session: Fixture.runtime, seq: 4, payload: ["text": "done again"])
    try await eventually("the next send") { link.calls(RPC.PromptSubmit.name).count == 2 }
    #expect(link.calls(RPC.PromptSubmit.name).map { $0.params["text"] } == ["first", "third"])
    await opened.shutdown()
  }

  @Test func editTakesAQueuedMessageBackIntoTheField() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    try await opened.startTurn()

    composer.draft = "parked"
    await composer.submit()
    try await opened.harness.frame()

    composer.draft = "typed meanwhile"
    await composer.editQueued(try #require(composer.queue.first).id)
    #expect(composer.draft == "typed meanwhile\nparked")
    try await opened.harness.frame()
    #expect(composer.queue.isEmpty)
    await opened.shutdown()
  }

  // MARK: Stop

  @Test func stopInterruptsTheTurnAndIsAnnounced() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    try await opened.startTurn()

    let stopping = Task { await composer.stop() }
    let call = try await opened.link.pendingCall(RPC.SessionInterrupt.name)
    #expect(composer.isStopping)
    opened.link.answer(call, ["status": "interrupted"])
    await stopping.value

    #expect(composer.lastEvent?.event == .stopped)
    #expect(await opened.state()?.turn.active == false)
    await opened.shutdown()
  }

  @Test func aStopThatFailsSaysSo() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    try await opened.startTurn()

    let stopping = Task { await composer.stop() }
    let call = try await opened.link.pendingCall(RPC.SessionInterrupt.name)
    opened.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await stopping.value

    #expect(composer.notice == .stopFailed("WebSocket closed"))
    #expect(composer.lastEvent == nil)
    await opened.shutdown()
  }

  // MARK: Commands

  @Test func newWhileMessagesAreQueuedIsRefusedWithAShortMessage() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    try await opened.startTurn()

    composer.draft = "after this"
    await composer.submit()

    // Stopped: the turn is over, the parked message is still waiting.
    let stopping = Task { await composer.stop() }
    try await opened.link.answerNext(RPC.SessionInterrupt.name, ["status": "interrupted"])
    await stopping.value
    try await opened.harness.frame()
    #expect(composer.queue.map(\.text) == ["after this"])

    composer.draft = "/new"
    await composer.submit()
    #expect(composer.notice == .busy)
    #expect(composer.draft == "/new", "the command goes back in the field")
    #expect(opened.link.calls(RPC.SessionTitle.name).isEmpty, "nothing was put away")
    await opened.shutdown()
  }

  @Test func aSendWhileNewRunsIsRefusedBeforeThePaintAndKeepsTheDraft() async throws {
    let opened = try await ComposerHarness.opened()
    let composer = opened.composer
    let link = opened.link

    composer.draft = "/new"
    let starting = Task { await composer.submit() }
    // Parked on its first step: the conversation is being put away.
    let hide = try await link.pendingCall(RPC.SessionSetHidden.name)

    composer.draft = "one more thing"
    await composer.submit()
    #expect(composer.draft == "one more thing")
    guard case .notSent? = composer.notice else {
      Issue.record("expected a not-sent notice, got \(String(describing: composer.notice))")
      return
    }
    #expect(link.calls(RPC.PromptSubmit.name).isEmpty)

    // Let `/new` fail its way back to where it started.
    link.fail(hide, GatewayRPCError(.rejected, "no"))
    // The put-back hides the chat again the moment the last title is refused, on the store's own
    // thread. Its answer is in place before anything can refuse that title, not after: a call made
    // with no one to answer it waits out the whole call timeout.
    link.respond(to: RPC.SessionSetHidden.name, with: [:])
    let title = try await link.pendingCall(RPC.SessionTitle.name)
    link.fail(title, GatewayRPCError(.rejected, "no"))
    // The stamp's name is tried once more with the seconds in it (a name worn in the same minute).
    let again = try await link.pendingCall(RPC.SessionTitle.name) { $0.id != title.id }
    link.fail(again, GatewayRPCError(.rejected, "no"))
    await starting.value
    await opened.shutdown()
  }

  @Test func onlyTheNewConversationCommandsAreTakenForCommands() {
    #expect(ComposerModel.conversationCommand("/new") == .init(name: "/new", argument: ""))
    #expect(ComposerModel.conversationCommand("/RESET  Old plans ") == .init(name: "/reset", argument: "Old plans"))
    #expect(ComposerModel.conversationCommand("/clear") == .init(name: "/clear", argument: ""))
    #expect(ComposerModel.conversationCommand("/newsletter") == nil)
    #expect(ComposerModel.conversationCommand("say /new") == nil)
  }
}
