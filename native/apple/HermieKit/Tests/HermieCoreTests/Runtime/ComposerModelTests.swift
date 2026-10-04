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
    let title = try await link.pendingCall(RPC.SessionTitle.name)
    link.fail(title, GatewayRPCError(.rejected, "no"))
    // The stamp's name is tried once more with the seconds in it (a name worn in the same minute).
    let again = try await link.pendingCall(RPC.SessionTitle.name) { $0.id != title.id }
    link.fail(again, GatewayRPCError(.rejected, "no"))
    link.respond(to: RPC.SessionSetHidden.name, with: [:])
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
