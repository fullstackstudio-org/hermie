import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// A flag a test flips while a model holds a closure that reads it.
@MainActor
private final class Gate {
  var open = false
}

private let researcher = Fixture.profile
private let writer = "writer"

/// Two bots on a scripted gateway, the first one opened and live, and a quick ask over it. Nothing
/// is shown and no shortcut is registered: the model and the session are all there is.
@MainActor
private struct QuickAskHarness {
  let harness: SessionHarness
  let model: QuickAskModel
  let settings: QuickAskSettings
  let scratch: TemporaryDefaults
  let holds: HoldLog

  /// What the hold seam saw: which chats were taken and given back.
  final class HoldLog {
    var taken: [String] = []
    var released: [String] = []
  }

  static let roster: JSONValue = [
    "profiles": [
      [
        "name": .string(researcher),
        "canonical_session": ["id": .string(Fixture.stored), "message_count": 2, "preview": "row 2", "last_active": 100]
      ],
      [
        "name": .string(writer),
        "canonical_session": ["id": "stored-2", "message_count": 2, "preview": "row 2", "last_active": 90]
      ]
    ]
  ]

  /// - Parameters:
  ///   - lastBot: the bot the person last used, kept before the model is made.
  ///   - open: the first bot is opened and live before the model looks at it.
  static func make(lastBot: QuickAskTarget? = nil, open: Bool = true) async throws -> QuickAskHarness {
    let harness = SessionHarness()
    try await harness.start(roster: roster)

    if open {
      try await harness.open(researcher)
      try await harness.frame()
    }

    // The other bot is opened by whatever asks first, and the gateway answers at once.
    harness.link.respond(
      to: RPC.SessionResume.name, with: Fixture.resume(runtime: "rt-2", stored: "stored-2"))
    harness.link.respond(to: RPC.SessionHistory.name, with: ["count": 2, "messages": .array(Fixture.rows(2))])
    harness.link.respond(to: RPC.SessionEventsSince.name, with: Fixture.since(latest: 0))

    let scratch = TemporaryDefaults()
    let settings = QuickAskSettings(defaults: scratch.defaults)

    if let lastBot {
      settings.setLastBot(lastBot)
    }

    let holds = HoldLog()
    let session = harness.session
    let model = QuickAskModel(
      session: { session }, settings: settings,
      hold: { session, bot in
        holds.taken.append(bot)
        return (session.chat(bot), { holds.released.append(bot) })
      })

    return QuickAskHarness(harness: harness, model: model, settings: settings, scratch: scratch, holds: holds)
  }

  var link: ScriptedLink { harness.link }

  func shutdown() async {
    await harness.session.shutdown()
  }

  /// The chat is live and bound: what a send needs.
  func waitUntilSendable() async throws {
    for _ in 0..<1000 {
      try await harness.frame()

      if model.composer?.canSend == true {
        return
      }

      try await Task.sleep(for: .milliseconds(5))
    }

    throw TimedOut(what: "a chat that can be sent to")
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct QuickAskModelTests {
  // MARK: Which bot

  @Test func withNothingChosenYetTheFirstBotIsSelected() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()

    #expect(quick.model.selectedBot == researcher)
    #expect(quick.model.choices.map(\.id) == [researcher, writer])
    #expect(quick.model.composer?.bot == researcher)
    await quick.shutdown()
  }

  @Test func theLastUsedBotIsTheDefaultWhenItIsOnThisGateway() async throws {
    let quick = try await QuickAskHarness.make(lastBot: QuickAskTarget(gatewayID: "g1", bot: writer))
    quick.model.sync()

    #expect(quick.model.selectedBot == writer)
    #expect(quick.model.composer?.bot == writer)
    await quick.shutdown()
  }

  @Test func aLastBotOfAnotherGatewayOrOneThatIsGoneIsNotUsed() async throws {
    let other = try await QuickAskHarness.make(lastBot: QuickAskTarget(gatewayID: "g9", bot: writer))
    other.model.sync()
    #expect(other.model.selectedBot == researcher, "the bot of another gateway is not this gateway's")
    await other.shutdown()

    let gone = try await QuickAskHarness.make(lastBot: QuickAskTarget(gatewayID: "g1", bot: "retired"))
    gone.model.sync()
    #expect(gone.model.selectedBot == researcher)
    await gone.shutdown()
  }

  @Test func choosingABotRemembersItAndMovesTheWordsInTheFieldToIt() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    quick.model.composer?.type("half a thought")

    quick.model.select(writer)
    #expect(quick.model.selectedBot == writer)
    #expect(quick.model.composer?.bot == writer)
    #expect(quick.model.composer?.draft == "half a thought")
    #expect(quick.settings.lastBot == QuickAskTarget(gatewayID: "g1", bot: writer))
    #expect(quick.model.target == QuickAskTarget(gatewayID: "g1", bot: writer))

    // The next time the window is made it starts on the same bot.
    let again = QuickAskSettings(defaults: quick.scratch.defaults)
    #expect(again.lastBot?.bot == writer)

    quick.model.select("not-a-bot")
    #expect(quick.model.selectedBot == writer, "a bot that is not on the gateway is not chosen")
    await quick.shutdown()
  }

  @Test func eachChatIsHeldWhileItIsTheSelectedOneAndGivenBackWhenAnotherIs() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    #expect(quick.holds.taken == [researcher])
    #expect(quick.holds.released.isEmpty)

    quick.model.sync()
    #expect(quick.holds.taken == [researcher], "syncing again holds nothing more")

    quick.model.select(writer)
    #expect(quick.holds.taken == [researcher, writer])
    #expect(quick.holds.released == [researcher])
    await quick.shutdown()
  }

  @Test func aChatThatIsNotLiveIsOpenedOnceTheConnectionIsUp() async throws {
    let quick = try await QuickAskHarness.make(lastBot: QuickAskTarget(gatewayID: "g1", bot: writer))
    let before = quick.link.calls(RPC.SessionResume.name).count
    quick.model.sync()

    try await eventually("the chat is opened") { @MainActor in quick.link.calls(RPC.SessionResume.name).count == before + 1 }
    quick.model.sync()
    #expect(quick.link.calls(RPC.SessionResume.name).count == before + 1, "not opened twice while it is opening")
    await quick.shutdown()
  }

  // MARK: Sending

  @Test func aQuickAskIsAMessageInTheBotsOwnChatThroughItsComposer() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()
    let composer = try #require(quick.model.composer)

    #expect(quick.model.stage == .composing)
    #expect(quick.model.exchange.isEmpty)

    composer.type("what is two and two?")
    let sending = Task { await quick.model.send() }
    let call = try await quick.link.pendingCall(RPC.PromptSubmit.name)

    #expect(call.params["text"] == "what is two and two?")
    #expect(quick.model.stage == .sending)

    try await quick.harness.frame()
    #expect(quick.model.exchange.compactMap(\.item.asUser).map(\.text) == ["what is two and two?"], "the bubble, painted")

    quick.link.answer(call, ["status": "streaming"])
    await sending.value
    #expect(composer.lastEvent?.event == .sent)
    #expect(composer.draft.isEmpty)
    #expect(quick.model.stage == .waiting, "sent, and the bot has not said anything")
    #expect(quick.settings.lastBot == QuickAskTarget(gatewayID: "g1", bot: researcher))
    await quick.shutdown()
  }

  @Test func theAnswerStreamsIntoTheExchangeAndTheStageFollowsIt() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()
    quick.model.composer?.type("hello")

    let sending = Task { await quick.model.send() }
    quick.link.answer(try await quick.link.pendingCall(RPC.PromptSubmit.name), ["status": "streaming"])
    await sending.value

    quick.link.emit("message.start", session: Fixture.runtime, seq: 1)
    quick.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Four"])
    try await quick.harness.frame()
    #expect(quick.model.stage == .streaming)
    #expect(quick.model.exchange.last?.item.asAssistant?.text == "Four")

    quick.link.emit("message.delta", session: Fixture.runtime, seq: 3, payload: ["text": ", of course."])
    try await quick.harness.frame()
    #expect(quick.model.exchange.last?.item.asAssistant?.text == "Four, of course.", "the same row, grown")
    #expect(quick.model.stage == .streaming)

    quick.link.emit("message.complete", session: Fixture.runtime, seq: 4, payload: ["text": "Four, of course."])
    try await quick.harness.frame()
    #expect(quick.model.stage == .done)
    #expect(quick.model.exchange.count == 2, "what was asked and what was answered, none of the history")
    #expect(quick.model.stage.isWorking == false)
    await quick.shutdown()
  }

  @Test func onlyTheLastExchangeIsShownAndAskingAgainStartsANewOne() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()

    for (seq, words) in [(1, "first"), (3, "second")] {
      quick.model.composer?.type(words)
      let sending = Task { await quick.model.send() }
      quick.link.answer(try await quick.link.pendingCall(RPC.PromptSubmit.name), ["status": "streaming"])
      await sending.value
      quick.link.emit("message.start", session: Fixture.runtime, seq: seq)
      quick.link.emit("message.complete", session: Fixture.runtime, seq: seq + 1, payload: ["text": .string("re: \(words)")])
      try await quick.harness.frame()
    }

    #expect(quick.model.exchange.compactMap(\.item.asUser).map(\.text) == ["second"])
    #expect(quick.model.exchange.compactMap(\.item.asAssistant).map(\.text) == ["re: second"])

    quick.model.clearExchange()
    #expect(quick.model.stage == .composing)
    #expect(quick.model.exchange.isEmpty)
    await quick.shutdown()
  }

  @Test func aSendThatIsRefusedBeforeAnythingIsPaintedShowsNoExchangeAndKeepsTheWords() async throws {
    // The chat is not opened: the socket is up and nothing is bound to send through.
    let quick = try await QuickAskHarness.make(open: false)
    quick.link.unrespond(RPC.SessionResume.name)
    quick.model.sync()
    let composer = try #require(quick.model.composer)

    composer.type("are you there?")
    composer.dismissNotice()
    await composer.submit()
    #expect(composer.draft == "are you there?", "the composer refuses a chat that is not open")

    await quick.model.send()
    #expect(quick.model.stage == .composing)
    #expect(quick.model.exchange.isEmpty)
    #expect(composer.draft == "are you there?")
    #expect(quick.link.calls(RPC.PromptSubmit.name).isEmpty)
    await quick.shutdown()
  }

  @Test func aSendThatFailsAfterThePaintKeepsTheBubbleInTheExchange() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()
    quick.model.composer?.type("do it")

    let sending = Task { await quick.model.send() }
    quick.link.fail(
      try await quick.link.pendingCall(RPC.PromptSubmit.name), GatewayRPCError(.rejected, "busy", code: 4009))
    await sending.value
    try await quick.harness.frame()

    #expect(quick.model.composer?.notice == .failed("busy"), "the composer's own words about it")
    #expect(quick.model.exchange.compactMap(\.item.asUser).map(\.text) == ["do it"])
    await quick.shutdown()
  }

  @Test func nothingIsSentFromAnEmptyField() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()

    await quick.model.send()
    #expect(quick.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(quick.model.stage == .composing)
    await quick.shutdown()
  }

  // MARK: Open in Hermie

  @Test func openInHermieNamesTheChatOfTheSelectedBotOnThisGateway() async throws {
    let quick = try await QuickAskHarness.make()
    var opened: [QuickAskTarget] = []
    quick.model.onOpenChat = { opened.append($0) }

    quick.model.openInApp()
    #expect(opened.isEmpty, "no session yet: nowhere to go")

    quick.model.sync()
    quick.model.openInApp()
    quick.model.select(writer)
    quick.model.openInApp()

    #expect(
      opened == [QuickAskTarget(gatewayID: "g1", bot: researcher), QuickAskTarget(gatewayID: "g1", bot: writer)])
    await quick.shutdown()
  }

  // MARK: What comes from outside

  @Test func wordsFromTheServicesMenuAreInTheFieldAndTheBotPickerHasTheKeyboard() async throws {
    let quick = try await QuickAskHarness.make()
    let serial = quick.model.focusSerial

    let handoff = try #require(QuickAskHandoff.service(text: "  the selected sentence \n", files: []))
    quick.model.accept(handoff)

    #expect(quick.model.composer?.draft == "the selected sentence")
    #expect(quick.model.focus == .botPicker)
    #expect(quick.model.focusSerial == serial + 1)
    await quick.shutdown()
  }

  @Test func wordsHandedOverBeforeThereIsASessionWaitForOne() async throws {
    let quick = try await QuickAskHarness.make()
    let gate = Gate()
    let session = quick.harness.session
    let held = QuickAskModel(session: { gate.open ? session : nil }, settings: quick.settings)

    held.accept(QuickAskHandoff(text: "first", focus: .botPicker))
    held.accept(QuickAskHandoff(text: "second", focus: .botPicker))
    #expect(held.composer == nil)

    gate.open = true
    held.sync()
    #expect(held.composer?.draft == "first\n\nsecond", "in the order they came")
    await quick.shutdown()
  }

  @Test func wordsHandedOverAreAddedToWhatIsAlreadyInTheField() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    quick.model.composer?.type("my question:")

    quick.model.accept(QuickAskHandoff(text: "the quoted part"))
    #expect(quick.model.composer?.draft == "my question:\n\nthe quoted part")
    await quick.shutdown()
  }

  @Test func nothingIsHandedOverFromBlankWordsAndNoFiles() {
    #expect(QuickAskHandoff.service(text: nil, files: []) == nil)
    #expect(QuickAskHandoff.service(text: " \n\t ", files: []) == nil)
    #expect(QuickAskHandoff.service(text: "x", files: [])?.focus == .botPicker)
    #expect(
      QuickAskHandoff.service(text: nil, files: [URL(string: "https://example.com/a")!]) == nil,
      "a web address is not a file")
  }

  @Test func aLongTextBecomesAFileInTheTrayAndNotWordsInTheField() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    let composer = try #require(quick.model.composer)
    let long = String(repeating: "a long page of words. ", count: 400)
    #expect(long.count > QuickAskModel.inlineTextLimit)

    quick.model.acceptText(long)

    #expect(composer.draft.isEmpty)
    #expect(composer.tray.items.count == 1)
    #expect(composer.tray.items.first?.name == QuickAskModel.textAttachmentName)
    #expect(composer.tray.items.first?.kind == .file)

    quick.model.acceptText("a short one")
    #expect(composer.draft == "a short one", "short words stay in the field")
    #expect(composer.tray.items.count == 1)
    await quick.shutdown()
  }

  @Test func filesAreStagedInTheTrayOfTheSelectedBotsChat() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    let composer = try #require(quick.model.composer)
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("quick-ask-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let notes = folder.appendingPathComponent("notes.txt")
    let report = folder.appendingPathComponent("report.pdf")
    try Data("one".utf8).write(to: notes)
    try Data("two".utf8).write(to: report)

    quick.model.acceptFiles([notes, report])

    #expect(composer.tray.items.map(\.name) == ["notes.txt", "report.pdf"], "one chip each, at once, in order")
    try await eventually("both are staged") { @MainActor in composer.tray.items.allSatisfy { !$0.preparing } }
    #expect(!composer.canSubmit, "a send waits for what is staged")
    composer.tray.clear()
    await quick.shutdown()
  }

  @Test func aHandoverPutsAwayAnAnswerThatIsDoneButNotOneThatIsStillComing() async throws {
    let quick = try await QuickAskHarness.make()
    quick.model.sync()
    try await quick.waitUntilSendable()
    quick.model.composer?.type("hello")
    let sending = Task { await quick.model.send() }
    quick.link.answer(try await quick.link.pendingCall(RPC.PromptSubmit.name), ["status": "streaming"])
    await sending.value
    quick.link.emit("message.start", session: Fixture.runtime, seq: 1)
    quick.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Hi"])
    try await quick.harness.frame()
    #expect(quick.model.stage == .streaming)

    quick.model.accept(QuickAskHandoff(text: "more words"))
    #expect(quick.model.stage == .streaming, "the bot is still answering: its answer stays")

    quick.link.emit("message.complete", session: Fixture.runtime, seq: 3, payload: ["text": "Hi"])
    try await quick.harness.frame()
    #expect(quick.model.stage == .done)

    quick.model.accept(QuickAskHandoff(text: "and now this"))
    #expect(quick.model.stage == .composing, "a new thing to say: the finished answer goes")
    await quick.shutdown()
  }
}
