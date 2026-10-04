import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// The store's clock, which a test moves.
private final class TestNow: Sendable {
  private let value = Mutex<Double>(1_790_000_000_000)

  func read() -> Double { value.withLock { $0 } }
  func advance(minutes: Double) { value.withLock { $0 += minutes * 60_000 } }
}

/// A session over a scripted link, opened, with a composer on its chat. The gateway answers
/// `commands.catalog` by itself unless the test says otherwise.
@MainActor
private struct SlashHarness {
  let harness: SessionHarness
  let composer: ComposerModel
  let clock: TestNow

  static func opened(catalog: JSONValue? = SlashFixture.catalog, drafts: KeyValueStore? = nil) async throws
    -> SlashHarness
  {
    let clock = TestNow()
    let harness = SessionHarness(now: { clock.read() })
    try await harness.start()
    let composer = ComposerModel(
      chat: harness.session.chat(bot),
      gatewayID: harness.session.gatewayID,
      session: harness.session,
      drafts: drafts,
      debounce: .zero
    )
    try await harness.open()
    try await harness.frame()

    if let catalog {
      harness.link.respond(to: RPC.CommandsCatalog.name, with: catalog)
    }

    return SlashHarness(harness: harness, composer: composer, clock: clock)
  }

  var link: ScriptedLink { harness.link }

  /// Type a slash and wait until the command list has arrived.
  func loadCommands() async throws {
    composer.draft = "/"
    let composer = self.composer
    try await eventually("the command list") { await composer.commands != nil }
    composer.draft = ""
  }

  func notices() async -> [NoticeItem] {
    await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asNotice) ?? []
  }

  func userTexts() async -> [String] {
    await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asUser).map(\.text) ?? []
  }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct ComposerSlashTests {
  // MARK: The command list

  @Test func typingASlashFetchesTheCommandListForThisChatAndListsEveryCommand() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/"
    let call = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    #expect(call.params["session_id"] == "rt-1")
    #expect(call.params["profile"] == .string(bot))
    #expect(composer.suggestionsOpen)
    #expect(composer.suggestionsLoading)
    #expect(composer.suggestions.isEmpty)

    opened.link.answer(call, SlashFixture.catalog)
    try await eventually("the list") { await composer.suggestions.count == 8 }
    #expect(!composer.suggestionsLoading)
    #expect(composer.suggestions.first?.label == "/model")
    #expect(composer.selectedSuggestion == 0)
    #expect(opened.link.calls(RPC.CompleteSlash.name).isEmpty, "a name is completed from the list, not the wire")
    await opened.shutdown()
  }

  @Test func moreKeystrokesNarrowTheListAtOnceAndAskNothingMore() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/"
    #expect(composer.suggestions.count == 8)
    composer.draft = "/re"
    #expect(composer.suggestions.map(\.label) == ["/reasoning", "/release-notes"])
    composer.draft = "/rea"
    #expect(composer.suggestions.map(\.label) == ["/reasoning"])
    composer.draft = "/zzz"
    #expect(composer.suggestions.isEmpty)
    #expect(!composer.suggestionsOpen, "nothing to say, nothing shown")

    #expect(opened.link.calls(RPC.CommandsCatalog.name).count == 1, "the same list serves the whole run")
    #expect(opened.link.calls(RPC.CompleteSlash.name).isEmpty)
    await opened.shutdown()
  }

  @Test func keystrokesWhileTheListIsInTheAirShareOneFetch() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/"
    composer.draft = "/m"
    composer.draft = "/mo"
    let call = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.answer(call, SlashFixture.catalog)
    try await eventually("the narrowed list") { await composer.suggestions.map(\.label) == ["/model"] }

    #expect(opened.link.calls(RPC.CommandsCatalog.name).count == 1)
    await opened.shutdown()
  }

  @Test func aSlashIsNotAListWhenTheLineIsProseOrAPastedParagraph() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    for text in ["hello", "/usr/local/bin", "/goal one\ntwo", "/ words"] {
      composer.draft = text
      #expect(!composer.suggestionsOpen, "\(text)")
    }

    composer.draft = "/mo"
    #expect(composer.suggestionsOpen)
    composer.draft = ""
    #expect(!composer.suggestionsOpen)
    await opened.shutdown()
  }

  @Test func aStoredDraftThatBeginsWithASlashDoesNotOpenTheListWhenItIsPutBack() async throws {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let opened = try await SlashHarness.opened(drafts: keyValues)
    try await keyValues.setString("/mo", forKey: opened.composer.draftStorageKey)

    await opened.composer.loadDraft()
    #expect(opened.composer.draft == "/mo")
    #expect(!opened.composer.suggestionsOpen)
    #expect(opened.link.calls(RPC.CommandsCatalog.name).isEmpty)

    // Typing on does open it.
    opened.composer.draft = "/mod"
    #expect(opened.composer.suggestionsOpen)
    await opened.shutdown()
  }

  // MARK: The keys

  @Test func theArrowKeysMoveTheSelectionAndWrapAround() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/"
    #expect(composer.selectedSuggestion == 0)
    #expect(composer.handle(.down))
    #expect(composer.selectedSuggestion == 1)
    #expect(composer.handle(.up))
    #expect(composer.handle(.up))
    #expect(composer.selectedSuggestion == composer.suggestions.count - 1, "up from the first wraps to the last")
    #expect(composer.handle(.down))
    #expect(composer.selectedSuggestion == 0)
    await opened.shutdown()
  }

  @Test func narrowingTheListStartsTheSelectionOverAndANoOpRefreshKeepsIt() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/"
    composer.handle(.down)
    composer.handle(.down)
    #expect(composer.selectedSuggestion == 2)
    composer.draft = "/re"
    #expect(composer.selectedSuggestion == 0)
    await opened.shutdown()
  }

  @Test func tabTakesTheSelectedLineAndTheListMovesOnToWhatFollowsIt() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/re"
    composer.handle(.down)
    #expect(composer.suggestions[composer.selectedSuggestion].label == "/release-notes")
    #expect(composer.handle(.tab))
    #expect(composer.draft == "/release-notes ")

    composer.draft = "/m"
    #expect(composer.handle(.tab))
    #expect(composer.draft == "/model ")
    // The name is done: what the command takes is said under the (now empty) list, and the gateway is
    // asked what could follow.
    #expect(composer.argumentHint?.usage == "[model]")
    #expect(composer.suggestionsOpen)
    let ask = try await opened.link.pendingCall(RPC.CompleteSlash.name)
    #expect(ask.params["text"] == "/model ")
    #expect(ask.params["session_id"] == "rt-1")
    await opened.shutdown()
  }

  @Test func returnTakesAPartialLineButSendsALineThatIsAlreadyComplete() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/mo"
    #expect(composer.handle(.enter), "taken: the field now holds the command")
    #expect(composer.draft == "/model ")

    composer.draft = "/status"
    #expect(!composer.handle(.enter), "already the line it would insert: Return is a send")
    composer.draft = "/status  "
    #expect(!composer.handle(.enter), "trailing space does not change that")
    await opened.shutdown()
  }

  @Test func escapeClosesTheListAndItStaysClosedUntilTheReaderTypesAgain() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/mo"
    #expect(composer.suggestionsOpen)
    #expect(composer.handle(.escape))
    #expect(!composer.suggestionsOpen)
    #expect(composer.draft == "/mo", "Escape never touches the words")
    #expect(!composer.handle(.down), "a closed list uses no keys")
    #expect(!composer.handle(.escape), "and a second Escape is the field's")

    composer.draft = "/mod"
    #expect(composer.suggestionsOpen)
    await opened.shutdown()
  }

  @Test func theKeysAreTheFieldsWhileNoListIsOpen() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    composer.draft = "plain words"

    for key in [CompletionKey.up, .down, .tab, .enter, .escape] {
      #expect(!composer.handle(key))
    }

    // A list that only waits has nothing to move on either.
    let waiting = try await SlashHarness.opened(catalog: nil)
    waiting.composer.draft = "/"
    #expect(waiting.composer.suggestionsOpen)
    #expect(!waiting.composer.handle(.down))
    #expect(!waiting.composer.handle(.tab))
    #expect(!waiting.composer.handle(.enter))
    await opened.shutdown()
    await waiting.shutdown()
  }

  @Test func aTapTakesTheLineItIsOn() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/"
    composer.acceptSuggestion(at: 2)
    #expect(composer.draft == "/status ")
    composer.draft = "/"
    composer.acceptSuggestion(at: 99)
    #expect(composer.draft == "/", "a line that is not there takes nothing")
    await opened.shutdown()
  }

  // MARK: Arguments

  @Test func theGatewayCompletesTheArgumentAndAnAcceptedItemRebuildsTheLine() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/reasoning "
    let ask = try await opened.link.pendingCall(RPC.CompleteSlash.name)
    #expect(ask.params["text"] == "/reasoning ")
    opened.link.answer(
      ask,
      [
        "items": [
          ["text": "low", "display": "low", "meta": "Think briefly"],
          ["text": "medium", "display": "medium", "meta": "The default"],
          ["text": "high", "display": "high", "meta": "Think at length"]
        ],
        "replace_from": 11
      ])
    try await eventually("the options") { await composer.suggestions.count == 3 }

    #expect(composer.suggestions.map(\.label) == ["low", "medium", "high"])
    #expect(composer.suggestions.map(\.kind) == [.argument, .argument, .argument])
    #expect(composer.suggestions[0].detail == "Think briefly")
    #expect(composer.argumentHint?.usage == "[low|medium|high]")

    composer.handle(.down)
    #expect(composer.handle(.tab))
    #expect(composer.draft == "/reasoning medium", "the command is kept, the argument put after it")
    await opened.shutdown()
  }

  @Test func aCommandsOwnSubcommandsAreOfferedAtOnceBeforeTheGatewayAnswers() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/queue l"
    #expect(composer.suggestions.map(\.label) == ["list"])
    #expect(composer.suggestions.first?.insert == "/queue list ")
    #expect(composer.argumentHint?.mode == .text)
    await opened.shutdown()
  }

  @Test func aCommandThatTakesNothingHasNoArgumentListAndAsksNothing() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/status "
    #expect(!composer.suggestionsOpen)
    #expect(opened.link.calls(RPC.CompleteSlash.name).isEmpty)
    await opened.shutdown()
  }

  @Test func onlyTheNewestQuestionMayPaint() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/model "
    let first = try await opened.link.pendingCall(RPC.CompleteSlash.name) { $0.params["text"] == "/model " }
    composer.draft = "/model g"
    let second = try await opened.link.pendingCall(RPC.CompleteSlash.name) { $0.params["text"] == "/model g" }

    // The newer answer arrives first; the older one, late, is not painted over it.
    opened.link.answer(
      second, ["items": [["text": "gpt-5", "display": "gpt-5", "meta": ""]], "replace_from": 7])
    try await eventually("the newer answer") { await composer.suggestions.map(\.label) == ["gpt-5"] }
    opened.link.answer(
      first, ["items": [["text": "stale-1", "display": "stale-1", "meta": ""]], "replace_from": 7])
    try await Task.sleep(for: .milliseconds(50))
    #expect(composer.suggestions.map(\.label) == ["gpt-5"])
    await opened.shutdown()
  }

  @Test func aGatewayThatRefusesTheSessionFieldIsAskedWithoutItFromThenOn() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/model "
    let first = try await opened.link.pendingCall(RPC.CompleteSlash.name)
    #expect(first.params["session_id"] == "rt-1")
    opened.link.fail(first, GatewayRPCError(.rejected, "session_id: Extra inputs are not permitted", code: 4002))

    let retry = try await opened.link.pendingCall(RPC.CompleteSlash.name) { $0.params["session_id"] == nil }
    opened.link.answer(retry, ["items": [["text": "gpt-5", "display": "gpt-5", "meta": ""]], "replace_from": 7])
    try await eventually("the answer") { await composer.suggestions.map(\.label) == ["gpt-5"] }

    composer.draft = "/model x"
    let next = try await opened.link.pendingCall(RPC.CompleteSlash.name) { $0.params["text"] == "/model x" }
    #expect(next.params["session_id"] == nil, "the field is left out for good")
    await opened.shutdown()
  }

  // MARK: When the list cannot be had

  @Test func aListThatWillNotLoadFallsBackToTheGatewaysOwnCompletions() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/mo"
    let catalog = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.fail(catalog, GatewayRPCError(.rejected, "unknown method", code: -32601))

    let ask = try await opened.link.pendingCall(RPC.CompleteSlash.name)
    #expect(ask.params["text"] == "/mo")
    opened.link.answer(
      ask, ["items": [["text": "model", "display": "/model", "meta": "Switch model", "kind": "command"]], "replace_from": 1])
    try await eventually("the gateway's list") { await composer.suggestions.count == 1 }

    #expect(composer.suggestions.first?.label == "/model")
    #expect(composer.suggestions.first?.insert == "/model", "the typed slash kept, the item's text after it")
    #expect(composer.suggestions.first?.detail == "Switch model")

    // The refusal is not repeated for every keystroke of this run.
    composer.draft = "/mod"
    #expect(opened.link.calls(RPC.CommandsCatalog.name).count == 1)
    await opened.shutdown()
  }

  @Test func whenNothingCanBeAskedTheListSaysSoInsteadOfStayingBlank() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/"
    let catalog = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.fail(catalog, GatewayRPCError(.rejected, "unknown method", code: -32601))
    let ask = try await opened.link.pendingCall(RPC.CompleteSlash.name)
    opened.link.fail(ask, GatewayRPCError(.rejected, "unknown method", code: -32601))

    try await eventually("the refusal") { await composer.suggestionsFailure != nil }
    #expect(composer.suggestionsFailure == "complete.slash")
    #expect(composer.suggestionsOpen)
    await opened.shutdown()
  }

  @Test func aStaleListIsShownAtOnceAndFetchedAgainAndAFailedRefreshKeepsIt() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()
    #expect(opened.link.calls(RPC.CommandsCatalog.name).count == 1)

    // Within its age the list is not asked for again.
    opened.clock.advance(minutes: 4)
    composer.draft = "/"
    composer.draft = ""
    try await Task.sleep(for: .milliseconds(30))
    #expect(opened.link.calls(RPC.CommandsCatalog.name).count == 1)

    // Past it: the old list answers the keystroke at once, and a fresh one is asked for. A skill the
    // gateway got meanwhile turns up.
    opened.clock.advance(minutes: 2)
    var fresher = SlashFixture.catalog
    fresher = .object(
      fresher.objectValue!.merging([
        "pairs": .array((fresher["pairs"]?.arrayValue ?? []) + [["/newskill", "Brand new"]]),
        "skills": .object((fresher["skills"]?.objectValue ?? [:]).merging(["/newskill": ["usage": 0]]) { $1 })
      ]) { $1 })
    opened.link.unrespond(RPC.CommandsCatalog.name)
    composer.draft = "/"
    #expect(composer.suggestions.count == 8, "the old list, at once")
    let refetch = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.answer(refetch, fresher)
    try await eventually("the fresher list") { await composer.suggestions.count == 9 }
    #expect(composer.suggestions.contains { $0.label == "/newskill" })

    // Stale again, and the refresh fails: the list that was there stays.
    composer.draft = ""
    opened.clock.advance(minutes: 6)
    composer.draft = "/"
    let failing = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.fail(failing, GatewayRPCError(.timeout, "request timed out: commands.catalog"))
    try await Task.sleep(for: .milliseconds(50))
    #expect(composer.suggestions.count == 9)
    await opened.shutdown()
  }

  // MARK: Running a command

  @Test func aWorkerCommandRunsThroughSlashExecAndItsAnswerLandsInTheTranscript() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()
    var submitted = 0
    composer.onSubmit = { submitted += 1 }

    let userTextsBefore = await opened.userTexts()
    composer.draft = "/model gpt-5"
    let running = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.SlashExec.name)
    #expect(call.params["command"] == "/model gpt-5")
    #expect(call.params["session_id"] == "rt-1")
    #expect(call.params["profile"] == .string(bot))
    #expect(composer.draft.isEmpty, "emptied first: a second Return finds nothing")
    #expect(composer.isSending)
    opened.link.answer(call, ["output": "  ✓ Model set to 'gpt-5' (this session)"])
    await running.value

    #expect(submitted == 1)
    #expect(composer.lastEvent?.event == .commandRan)
    #expect(composer.notice == nil)
    #expect(!composer.isSending)
    try await opened.harness.frame()
    let rows = await opened.notices()
    #expect(rows.last?.title == "/model gpt-5")
    #expect(rows.last?.body == "  ✓ Model set to 'gpt-5' (this session)")
    #expect(await opened.userTexts() == userTextsBefore, "a command is not a message")
    #expect(opened.link.calls(RPC.PromptSubmit.name).isEmpty)
    await opened.shutdown()
  }

  @Test func aCommandWithNoOutputSaysSoAndAMultiLineAnswerIsKeptWhole() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/yolo"
    let quiet = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["output": "  "])
    await quiet.value

    composer.draft = "/status"
    let report = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["output": "Hermes TUI Status\n\nModel: example\n  indented"])
    await report.value
    try await opened.harness.frame()

    let rows = await opened.notices()
    #expect(rows.suffix(2).map(\.body) == ["Ran, with no output.", "Hermes TUI Status\n\nModel: example\n  indented"])
    await opened.shutdown()
  }

  @Test func aWarningGetsARowOfItsOwn() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/yolo"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["output": "on", "warning": "Careful with this."])
    await running.value
    try await opened.harness.frame()

    #expect(await opened.notices().suffix(2).map(\.body) == ["Careful with this.", "on"])
    await opened.shutdown()
  }

  @Test func aSkillGoesToCommandDispatchAndTheBubbleShowsTheInvocationNotTheExpansion() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/docx fix the table"
    let running = Task { await composer.submit() }
    let dispatch = try await opened.link.pendingCall(RPC.CommandDispatch.name)
    #expect(dispatch.params["name"] == "docx")
    #expect(dispatch.params["arg"] == "fix the table")
    #expect(opened.link.calls(RPC.SlashExec.name).isEmpty, "slash.exec refuses a skill")
    opened.link.answer(
      dispatch,
      [
        "type": "skill", "name": "docx", "display": "/docx fix the table",
        "message": "[IMPORTANT: the user invoked the docx skill]\n\nFix the table."
      ])

    let submit = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "[IMPORTANT: the user invoked the docx skill]\n\nFix the table.")
    opened.link.answer(submit, ["status": "streaming"])
    await running.value

    #expect(composer.notice == nil)
    #expect(await opened.userTexts().last == "/docx fix the table", "the expansion is never drawn")
    await opened.shutdown()
  }

  @Test func aSendDirectiveFromSlashExecIsSentToTheModelAndNotShownAsTheAnswer() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/queue write it up"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["type": "send", "message": "write it up", "notice": ""])
    let submit = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "write it up")
    opened.link.answer(submit, ["status": "streaming"])
    await running.value
    try await opened.harness.frame()

    #expect(await opened.userTexts().last == "/queue write it up")
    #expect(await opened.notices().isEmpty, "the word in `message` is not the command's result")
    await opened.shutdown()
  }

  @Test func aSendDirectiveWithNothingToSendSaysWhy() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/queue"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(
      RPC.SlashExec.name, ["type": "send", "message": "", "notice": "Nothing queued."])
    await running.value
    try await opened.harness.frame()

    #expect(await opened.notices().suffix(2).map(\.body) == ["Nothing queued.", "Nothing to send."])
    #expect(opened.link.calls(RPC.PromptSubmit.name).isEmpty)
    await opened.shutdown()
  }

  @Test func aSkillIsRefusedWhileATurnRunsRatherThanQueuedAsItsWholeBody() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()
    opened.link.emit("message.start", session: Fixture.runtime, seq: 1)
    try await opened.harness.frame()
    #expect(composer.turnActive)

    composer.draft = "/docx fix"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(
      RPC.CommandDispatch.name,
      ["type": "skill", "name": "docx", "display": "/docx fix", "message": "THE WHOLE SKILL BODY"])
    await running.value
    try await opened.harness.frame()

    #expect(composer.queue.isEmpty)
    #expect(opened.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(await opened.notices().last?.body?.contains("still working") == true)
    await opened.shutdown()
  }

  @Test func aPrefillIsHandedToTheFieldAndItsNoticeGetsARow() async throws {
    let catalog: JSONValue = [
      "pairs": [["/undo", "Take back the last message"]], "commands": ["/undo": ["argument_mode": nil]]
    ]
    let opened = try await SlashHarness.opened(catalog: catalog)
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/undo"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(
      RPC.SlashExec.name, ["type": "prefill", "message": "the message being taken back", "notice": "↶ rewound one turn"])
    await running.value
    try await opened.harness.frame()

    #expect(composer.draft == "the message being taken back")
    #expect(!composer.suggestionsOpen)
    #expect(await opened.notices().last?.body == "↶ rewound one turn")
    await opened.shutdown()
  }

  @Test func anAliasDirectiveIsFollowedOnceWithTheArgumentCarriedOver() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/help models"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["type": "alias", "target": "queue"])
    let second = try await opened.link.pendingCall(RPC.SlashExec.name) { $0.params["command"] == "/queue models" }
    opened.link.answer(second, ["output": "followed"])
    await running.value
    try await opened.harness.frame()

    #expect(await opened.notices().last?.body == "followed")
    #expect(opened.link.calls(RPC.SlashExec.name).count == 2)
    await opened.shutdown()
  }

  @Test func anAliasThatPointsBackIsNotFollowedForever() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/help"
    let running = Task { await composer.submit() }
    try await opened.link.answerNext(RPC.SlashExec.name, ["type": "alias", "target": "/help"])
    try await opened.link.answerNext(RPC.SlashExec.name, ["type": "alias", "target": "/help"])
    await running.value
    try await opened.harness.frame()

    #expect(opened.link.calls(RPC.SlashExec.name).count == 2, "one hop, then it stops")
    #expect(await opened.notices().last?.body?.contains("alias the gateway could not follow") == true)
    await opened.shutdown()
  }

  @Test func aGatewayThatSaysUseDispatchIsBelievedOverTheCatalogue() async throws {
    // The catalogue lists it as a plain command; the gateway knows it is a skill.
    let catalog: JSONValue = ["pairs": [["/mystery", "Does a thing"]]]
    let opened = try await SlashHarness.opened(catalog: catalog)
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/mystery now"
    let running = Task { await composer.submit() }
    let exec = try await opened.link.pendingCall(RPC.SlashExec.name)
    opened.link.fail(exec, GatewayRPCError(.rejected, "skill command: use command.dispatch for /mystery", code: 4018))
    try await opened.link.answerNext(RPC.CommandDispatch.name, ["type": "exec", "output": "done by dispatch"])
    await running.value
    try await opened.harness.frame()

    #expect(await opened.notices().last?.body == "done by dispatch")
    #expect(composer.notice == nil)
    await opened.shutdown()
  }

  @Test func statusFallsBackToSessionStatusWhereTheCatalogueDoesNotListIt() async throws {
    let opened = try await SlashHarness.opened(catalog: [:])
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/status"
    let running = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.SessionStatus.name)
    #expect(call.params["session_id"] == "rt-1")
    opened.link.answer(call, ["output": "Session: rt-1\nTokens: 0"])
    await running.value
    try await opened.harness.frame()

    #expect(opened.link.calls(RPC.SlashExec.name).isEmpty)
    #expect(opened.link.calls(RPC.PromptSubmit.name).isEmpty, "never a prompt to the bot")
    #expect(await opened.notices().last?.body == "Session: rt-1\nTokens: 0")
    await opened.shutdown()
  }

  @Test func aRefusedCommandPutsTheWordsBackAndSaysSoAndLeavesNoRow() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/model nope"
    let running = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.SlashExec.name)
    opened.link.fail(call, GatewayRPCError(.rejected, "unknown model", code: 4002))
    await running.value

    #expect(composer.draft == "/model nope")
    #expect(composer.notice == .commandFailed("unknown model"))
    #expect(composer.lastEvent == nil)
    #expect(!composer.isSending)
    #expect(await opened.notices().isEmpty)
    await opened.shutdown()
  }

  @Test func theWordsComeBackAheadOfWhatWasTypedMeanwhile() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    composer.draft = "/model nope"
    let running = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.SlashExec.name)
    composer.draft = "next thought"
    opened.link.fail(call, GatewayRPCError(.rejected, "unknown model", code: 4002))
    await running.value

    #expect(composer.draft == "/model nope\nnext thought")
    await opened.shutdown()
  }

  @Test func aLineThatIsNotAKnownCommandGoesToTheBotAsWritten() async throws {
    let opened = try await SlashHarness.opened()
    let composer = opened.composer
    try await opened.loadCommands()

    // The first goes out; the turn it starts parks the others, which shows what each was taken for.
    composer.draft = "/usr/local/bin is on the path"
    let sending = Task { await composer.submit() }
    let call = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(call.params["text"] == "/usr/local/bin is on the path")
    opened.link.answer(call, ["status": "streaming"])
    await sending.value

    let parked = ["/nonsense", "//model", "/ words"]

    for text in parked {
      composer.draft = text
      await composer.submit()
      #expect(composer.lastEvent?.event == .queued, "\(text) is a message, queued behind the turn")
    }

    try await opened.harness.frame()
    #expect(composer.queue.map(\.text) == parked)
    #expect(opened.link.calls(RPC.SlashExec.name).isEmpty)
    #expect(opened.link.calls(RPC.CommandDispatch.name).isEmpty)
    await opened.shutdown()
  }

  @Test func aCommandTypedBeforeTheListArrivedWaitsForItAndSendsOnce() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/status"
    let first = Task { await composer.submit() }
    let catalog = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    // A second Return while the first waits does nothing.
    await composer.submit()
    #expect(composer.draft == "/status")
    #expect(opened.link.calls(RPC.SlashExec.name).isEmpty)

    opened.link.answer(catalog, SlashFixture.catalog)
    let exec = try await opened.link.pendingCall(RPC.SlashExec.name)
    #expect(composer.draft.isEmpty)
    opened.link.answer(exec, ["output": "ok"])
    await first.value

    #expect(opened.link.calls(RPC.SlashExec.name).count == 1)
    #expect(opened.link.calls(RPC.PromptSubmit.name).isEmpty, "not sent to the bot as prose")
    await opened.shutdown()
  }

  @Test func aCommandListThatCannotBeReadLeavesTheLineToGoOutAsAPrompt() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/model gpt-5"
    let sending = Task { await composer.submit() }
    let catalog = try await opened.link.pendingCall(RPC.CommandsCatalog.name)
    opened.link.fail(catalog, GatewayRPCError(.rejected, "unknown method", code: -32601))
    let submit = try await opened.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "/model gpt-5", "the gateway understands a leading slash")
    opened.link.answer(submit, ["status": "streaming"])
    await sending.value
    await opened.shutdown()
  }

  @Test func theConversationCommandsDoNotWaitForTheListNorGoThroughTheGateway() async throws {
    let opened = try await SlashHarness.opened(catalog: nil)
    let composer = opened.composer

    composer.draft = "/new"
    let running = Task { await composer.submit() }
    // Parked on its first step: the conversation is being put away, here, not by the gateway's worker.
    let hide = try await opened.link.pendingCall(RPC.SessionSetHidden.name)
    #expect(opened.link.calls(RPC.SlashExec.name).isEmpty)
    #expect(opened.link.calls(RPC.CommandDispatch.name).isEmpty)

    // Let it fail its way back to where it started.
    opened.link.fail(hide, GatewayRPCError(.rejected, "no"))
    // Answered before the last title is refused: the put-back hides the chat again at once, on the
    // store's own thread, and a call made with no one to answer it waits out the call timeout.
    opened.link.respond(to: RPC.SessionSetHidden.name, with: [:])
    let title = try await opened.link.pendingCall(RPC.SessionTitle.name)
    opened.link.fail(title, GatewayRPCError(.rejected, "no"))
    // The stamp's name is tried once more with the seconds in it (a name worn in the same minute).
    let again = try await opened.link.pendingCall(RPC.SessionTitle.name) { $0.id != title.id }
    opened.link.fail(again, GatewayRPCError(.rejected, "no"))
    await running.value
    await opened.shutdown()
  }
}
