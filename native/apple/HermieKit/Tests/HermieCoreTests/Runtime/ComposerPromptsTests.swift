import Foundation
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A session over a scripted link, opened, with prompts attached to a ui_meta sync and a composer on its chat.
@MainActor
private struct PromptHarness {
  let harness: SessionHarness
  let composer: ComposerModel
  let sync: UIMetaSync

  static func opened(catalog: JSONValue? = SlashFixture.catalog) async throws -> PromptHarness {
    let harness = SessionHarness()
    try await harness.start()

    let sync = UIMetaSync.device(HoldingGateway().gateway)
    harness.session.prompts.attach(sync)

    let composer = ComposerModel(
      chat: harness.session.chat(bot),
      gatewayID: harness.session.gatewayID,
      session: harness.session,
      drafts: nil,
      debounce: .zero
    )
    try await harness.open()
    try await harness.frame()

    if let catalog {
      harness.link.respond(to: RPC.CommandsCatalog.name, with: catalog)
    }

    return PromptHarness(harness: harness, composer: composer, sync: sync)
  }

  var prompts: PromptsModel { harness.session.prompts }

  @discardableResult
  func add(_ title: String, _ text: String, scope: PromptScope = .global) -> String {
    prompts.add(title: title, text: text, scope: scope)!
  }

  /// Type a slash and wait until the command list has arrived.
  func loadCommands() async throws {
    composer.draft = "/"
    let composer = self.composer
    try await eventually("the command list") { await composer.commands != nil }
    composer.draft = ""
  }

  func userTexts() async -> [String] {
    await harness.session.store.state(of: bot)?.orderedItems.compactMap(\.asUser).map(\.text) ?? []
  }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct ComposerPromptsTests {
  // MARK: Insertion

  @Test func aPromptWithNoFieldsGoesIntoAnEmptyFieldAtOnceAndTakesTheCaret() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Standup", "What did you do yesterday?")

    let before = composer.focusRequests
    let sent = await opened.userTexts()

    composer.use(try #require(opened.prompts.prompts.first))
    #expect(composer.draft == "What did you do yesterday?")
    #expect(composer.promptToFill == nil)
    #expect(composer.focusRequests == before + 1)
    #expect(!composer.suggestionsOpen, "set from outside: the command list stays shut")
    #expect(await opened.userTexts() == sent, "a prompt is text for the field, never a send")
    await opened.shutdown()
  }

  @Test func aPromptIsAddedAfterWhatIsAlreadyTypedAndNeverReplacesIt() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Tone", "Keep it friendly.")
    let prompt = try #require(opened.prompts.prompts.first)

    composer.draft = "Draft the reply"
    composer.use(prompt)
    #expect(composer.draft == "Draft the reply\nKeep it friendly.")

    composer.draft = "Ends with a break\n"
    composer.use(prompt)
    #expect(composer.draft == "Ends with a break\nKeep it friendly.", "one line break, not two")

    composer.draft = "   "
    composer.use(prompt)
    #expect(composer.draft == "Keep it friendly.", "only space: the field is empty")
    await opened.shutdown()
  }

  @Test func aPromptWithFieldsAsksForThemFirstAndThenFillsThem() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Mail", "Dear {{who}}, about {{topic}}. Thanks, {{who}}")
    let prompt = try #require(opened.prompts.prompts.first)

    composer.draft = "Start:"
    composer.use(prompt)
    #expect(composer.promptToFill == prompt)
    #expect(composer.draft == "Start:", "nothing goes in before the form is filled")

    composer.completePrompt(with: ["who": "Sam", "topic": "the call"])
    #expect(composer.promptToFill == nil)
    #expect(composer.draft == "Start:\nDear Sam, about the call. Thanks, Sam")

    // Putting the form away puts nothing in.
    composer.draft = ""
    composer.use(prompt)
    composer.cancelPrompt()
    #expect(composer.promptToFill == nil && composer.draft.isEmpty)
    composer.completePrompt(with: ["who": "x"])
    #expect(composer.draft.isEmpty, "nothing waits to be completed")
    await opened.shutdown()
  }

  @Test func aFieldLeftEmptyFillsInAsNothing() async throws {
    let opened = try await PromptHarness.opened()
    opened.add("Mail", "Hi {{who}}!")

    opened.composer.use(try #require(opened.prompts.prompts.first))
    opened.composer.completePrompt(with: [:])
    #expect(opened.composer.draft == "Hi !")
    await opened.shutdown()
  }

  @Test func aRequestThatHasTheComposerRefusesAPrompt() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("A", "text")
    opened.add("B", "with {{x}}")

    composer.held = true
    composer.use(opened.prompts.prompts[0])
    composer.use(opened.prompts.prompts[1])
    #expect(composer.draft.isEmpty && composer.promptToFill == nil, "words must not reach a secure prompt's field")
    #expect(!composer.insertPromptText("x"))
    await opened.shutdown()
  }

  @Test func textThatIsOnlySpaceIsNotInserted() async throws {
    let opened = try await PromptHarness.opened()

    #expect(!opened.composer.insertPromptText(" \n "))
    #expect(opened.composer.draft.isEmpty)
    await opened.shutdown()
  }

  // MARK: The list `/` opens

  @Test func theListOffersThePromptsAfterTheCommands() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Weekly", "Summarise {{week}}")
    opened.add("Mail", "Dear {{who}}")
    try await opened.loadCommands()

    composer.draft = "/"
    let kinds = composer.suggestions.map(\.kind)

    #expect(composer.suggestions.count == 10)
    #expect(Array(kinds.prefix(8)).allSatisfy { $0 != .prompt }, "the commands come first, as they were")
    #expect(composer.suggestions.suffix(2).map(\.label) == ["Weekly", "Mail"], "then the prompts, in the person's order")
    #expect(composer.suggestions.suffix(2).allSatisfy { $0.kind == .prompt && $0.promptID != nil })
    #expect(composer.suggestions.last?.hint == "{who}", "the fields a prompt asks for are shown")
    #expect(composer.suggestions.last?.detail == "Dear {{who}}")
    #expect(Set(composer.suggestions.map(\.id)).count == 10, "every line has an id of its own")
    await opened.shutdown()
  }

  @Test func whatIsTypedNarrowsThePromptsByTitle() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Weekly report", "x")
    opened.add("Reasoning checklist", "y")
    opened.add("Mail", "z")
    try await opened.loadCommands()

    composer.draft = "/rea"
    #expect(composer.suggestions.map(\.label) == ["/reasoning", "Reasoning checklist"])

    composer.draft = "/port"
    #expect(composer.suggestions.map(\.label) == ["Weekly report"], "a title is found by a word inside it too")

    composer.draft = "/ZZZ"
    #expect(composer.suggestions.isEmpty)
    await opened.shutdown()
  }

  @Test func titlesThatBeginWithTheWordComeBeforeTitlesThatContainIt() async throws {
    let opened = try await PromptHarness.opened()
    opened.add("Weekly mail", "x")
    opened.add("Mail", "y")
    try await opened.loadCommands()

    opened.composer.draft = "/mail"
    #expect(opened.composer.suggestions.map(\.label) == ["Mail", "Weekly mail"])
    await opened.shutdown()
  }

  @Test func aBotSeesItsOwnPromptsFirstAndNoOtherBotsPrompts() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Everywhere", "g")
    opened.add("Mine", "m", scope: .bot(bot))
    opened.add("Theirs", "t", scope: .bot("someone-else"))
    try await opened.loadCommands()

    composer.draft = "/"
    #expect(composer.suggestions.suffix(2).map(\.label) == ["Mine", "Everywhere"])
    #expect(!composer.suggestions.contains { $0.label == "Theirs" })
    await opened.shutdown()
  }

  @Test func promptsAreListedWhileTheCommandListIsStillOnItsWay() async throws {
    let opened = try await PromptHarness.opened(catalog: nil)
    opened.add("Weekly", "Summarise")

    opened.composer.draft = "/"
    #expect(opened.composer.suggestions.map(\.label) == ["Weekly"])
    #expect(opened.composer.suggestionsOpen)
    await opened.shutdown()
  }

  @Test func takingAPromptLineReplacesTheSlashLineWithItsText() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Standup", "What did you do yesterday?")
    try await opened.loadCommands()
    let sent = await opened.userTexts()

    composer.draft = "/stand"
    #expect(composer.suggestions.map(\.label) == ["Standup"])
    composer.acceptSuggestion(at: 0)

    #expect(composer.draft == "What did you do yesterday?", "the words that found it are not part of the message")
    #expect(!composer.suggestionsOpen)
    #expect(await opened.userTexts() == sent)
    // Not run as a command either.
    #expect(opened.harness.link.calls(RPC.CommandDispatch.name).isEmpty)
    await opened.shutdown()
  }

  @Test func returnTakesAPromptLineWhateverTheFieldHolds() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Standup", "Report")
    try await opened.loadCommands()

    composer.draft = "/stand"
    #expect(composer.handle(.enter), "Return takes the line instead of sending '/stand'")
    #expect(composer.draft == "Report")

    composer.draft = "/Standup"
    #expect(composer.handle(.enter), "even when the field already says the title in full")
    #expect(composer.draft == "Report")
    await opened.shutdown()
  }

  @Test func tabAndTheArrowKeysWorkOnPromptLinesToo() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Two", "second")
    try await opened.loadCommands()

    composer.draft = "/two"
    #expect(composer.suggestions.map(\.label) == ["Two"])
    #expect(composer.handle(.down), "the arrows move, wrapping")
    #expect(composer.handle(.tab))
    #expect(composer.draft == "second")
    await opened.shutdown()
  }

  @Test func aPromptWithFieldsTakenFromTheListOpensItsFormAndLeavesTheFieldClean() async throws {
    let opened = try await PromptHarness.opened()
    let composer = opened.composer
    opened.add("Mail", "Dear {{who}}")
    try await opened.loadCommands()

    composer.draft = "/mail"
    composer.acceptSuggestion(at: 0)
    #expect(composer.promptToFill?.title == "Mail")
    #expect(composer.draft.isEmpty, "the slash line is gone while the form is up")

    composer.completePrompt(with: ["who": "Sam"])
    #expect(composer.draft == "Dear Sam")
    await opened.shutdown()
  }

  @Test func theCommandsAreUnchangedWhenThereAreNoPrompts() async throws {
    let opened = try await PromptHarness.opened()
    try await opened.loadCommands()

    opened.composer.draft = "/"
    #expect(opened.composer.suggestions.count == 8)
    #expect(opened.composer.suggestions.allSatisfy { $0.kind != .prompt })
    opened.composer.acceptSuggestion(at: 0)
    #expect(opened.composer.draft == "/model ", "a command is taken as before")
    await opened.shutdown()
  }

  @Test func aPromptIsNotOfferedOnceTheCommandNameIsDone() async throws {
    let opened = try await PromptHarness.opened()
    opened.add("Model notes", "x")
    try await opened.loadCommands()

    opened.composer.draft = "/model "
    #expect(!opened.composer.suggestions.contains { $0.kind == .prompt })
    await opened.shutdown()
  }
}
