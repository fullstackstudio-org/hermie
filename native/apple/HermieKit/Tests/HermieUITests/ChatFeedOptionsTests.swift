import Foundation
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// The per-chat options on the chat screen's feed: what it shows comes from the snapshot and only
/// changes when the snapshot's options do, an expensive model waits for the reader, and a switch
/// that cannot be made says so over the chat until it is dismissed.
@MainActor
@Suite struct ChatFeedOptionsTests {
  let session = GatewaySession(gatewayID: "feed-options", link: UnreachableLink())

  private func makeFeed(_ owner: ChatFeedOwner<ChatFeed>) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-options", bot: "writer"), session: session) { _ in .none }
    }
    return owner.feed
  }

  private func snapshot(
    key: String, attached: Bool, options: ChatSessionOptions, items: [VisibleItem] = [], revision: Int = 1
  ) -> ChatSnapshot {
    ChatSnapshot(
      key: key, items: items, hydration: .live, busy: false, turnActive: false, activity: .idle,
      openRequests: [], queue: [], attached: attached, canLoadOlder: false, revision: revision, options: options)
  }

  private let usage = ContextUsage(used: 160_000, limit: 200_000, fraction: 0.8, percent: 80, estimated: false)

  @Test func aChatStartsWithNothingOfferedAndNothingAsked() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    #expect(feed.sessionOptions == ChatSessionOptions())
    #expect(feed.optionsAvailable == false)
    #expect(feed.showingModelPicker == false)
    #expect(feed.modelList == .idle)
    #expect(feed.pendingModel == nil)
    #expect(feed.optionNotice == nil)
  }

  @Test func theOptionsAndTheAttachmentFollowTheSnapshot() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    let options = ChatSessionOptions(
      fast: true, reasoningEffort: "high", model: "example-model", provider: "example-provider", contextUsage: usage)

    feed.model.apply(snapshot(key: "writer", attached: true, options: options))
    await eventually("the options") { feed.sessionOptions == options && feed.optionsAvailable }

    feed.model.apply(snapshot(key: "writer", attached: false, options: options, revision: 2))
    await eventually("the detach") { !feed.optionsAvailable }
    #expect(feed.sessionOptions == options, "what was last said stays; the menu simply stops offering it")
  }

  @Test func switchingWhileDetachedSaysSoAndNothingChanges() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.setFast(true)
    await eventually("the failure") { feed.optionNotice != nil }
    guard case .failed(let reason)? = feed.optionNotice else {
      Issue.record("expected a failure, got \(String(describing: feed.optionNotice))")
      return
    }

    #expect(ChatActionNotices.text(attachment: nil, retry: nil, option: feed.optionNotice) == NativeStrings.Chat.Options.failed(reason))
    #expect(feed.sessionOptions.fast == false)

    feed.dismissActionNotices()
    #expect(feed.optionNotice == nil)
  }

  @Test func settingWhatIsAlreadySetSendsNothing() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    feed.model.apply(snapshot(key: "writer", attached: true, options: ChatSessionOptions(fast: true, reasoningEffort: "low")))
    await eventually("the options") { feed.sessionOptions.fast }

    feed.setFast(true)
    feed.setReasoningEffort("low")
    try await Task.sleep(for: .milliseconds(50))
    #expect(feed.optionNotice == nil, "a call that was never made cannot have failed")
  }

  // MARK: The model

  @Test func openingTheListShowsItAndReadsTheModels() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.openModelPicker()
    #expect(feed.showingModelPicker)

    // The link never connects, so the read fails and says why; Try again asks once more.
    await eventually("the failure") { if case .failed = feed.modelList { true } else { false } }
    feed.loadModels()
    #expect(feed.modelList == .loading)
  }

  @Test func choosingTheCurrentModelOnlyClosesTheList() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    feed.model.apply(
      snapshot(key: "writer", attached: true, options: ChatSessionOptions(model: "example-model", provider: "example-provider")))
    await eventually("the options") { feed.sessionOptions.model != nil }

    feed.showingModelPicker = true
    feed.chooseModel(BotModelChoice(provider: "example-provider", model: "example-model"))
    #expect(feed.showingModelPicker == false)
    try await Task.sleep(for: .milliseconds(50))
    #expect(feed.optionNotice == nil)
    #expect(feed.pendingModel == nil)
  }

  @Test func anExpensiveModelWaitsForTheReaderAndNothingGoesOutUntilTheyConfirm() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    let choice = BotModelChoice(provider: "example-provider", model: "expensive-model")

    feed.noted(.needsConfirmation(message: "It is pricey."), choice: choice)
    let pending = try #require(feed.pendingModel)
    #expect(pending == PendingModelSwitch(choice: choice, message: "It is pricey."))
    #expect(feed.optionNotice == nil)

    feed.cancelPendingModel()
    #expect(feed.pendingModel == nil)

    // Confirmed: the switch is sent again (here it cannot be made, and says so).
    feed.noted(.needsConfirmation(message: nil), choice: choice)
    let again = try #require(feed.pendingModel)
    feed.confirmModel(again)
    #expect(feed.pendingModel == nil)
    await eventually("the confirmed switch") { feed.optionNotice != nil }
  }

  @Test func theOutcomesBecomeTheLineOverTheChat() {
    let owner = ChatFeedOwner<ChatFeed>()
    guard let feed = makeFeed(owner) else {
      Issue.record("no feed")
      return
    }

    feed.noted(.applied(warning: "Context shrinks."))
    #expect(ChatActionNotices.text(attachment: nil, retry: nil, option: feed.optionNotice) == "Context shrinks.")

    feed.noted(.applied(warning: nil))
    #expect(feed.optionNotice == nil, "a switch that went through clears an earlier line")

    feed.noted(.failed("no"))
    #expect(ChatActionNotices.text(attachment: nil, retry: nil, option: feed.optionNotice) == NativeStrings.Chat.Options.failed("no"))
  }

  // MARK: Export

  @Test func exportingTakesTheLoadedConversationAndHandsItToTheExporter() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    let base = ItemBase(id: "u1", seq: 1, ts: 1_790_000_000, origin: .history, version: 1)
    let items = [
      VisibleItem(item: .user(UserItem(base: base, text: "Hello there")), presentation: .full),
      VisibleItem(
        item: .assistant(
          AssistantItem(
            base: ItemBase(id: "a1", seq: 2, ts: 1_790_000_060, origin: .history, version: 1), text: "Hi!", streaming: false,
            interim: false)),
        presentation: .full)
    ]
    feed.model.apply(snapshot(key: "writer", attached: true, options: ChatSessionOptions(), items: items))

    feed.export(.markdown, now: Date(timeIntervalSince1970: 1_790_000_100))
    #expect(feed.exporting)
    let file = try #require(feed.exportFile)
    #expect(file.format == .markdown)
    #expect(file.content.contains("Hello there"))
    #expect(file.content.contains("Hi!"))
    #expect(file.name.hasSuffix(".md"))

    feed.exportFinished(.success(URL(fileURLWithPath: "/tmp/x.md")))
    #expect(feed.exporting == false)
    #expect(feed.exportFile == nil)
    #expect(feed.optionNotice == nil)
  }

  @Test func aCancelledExportIsNotAFailureButAnotherErrorIs() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.export(.text)
    feed.exportFinished(.failure(CocoaError(.userCancelled)))
    #expect(feed.optionNotice == nil)

    feed.export(.text)
    feed.exportFinished(.failure(CocoaError(.fileWriteOutOfSpace)))
    #expect(feed.optionNotice == .exportFailed)
    #expect(ChatActionNotices.text(attachment: nil, retry: nil, option: feed.optionNotice) == Strings.Chat.Export.failed)
  }
}

/// The pure pieces the options menu and the picker are made of.
@MainActor
@Suite struct ChatOptionsViewsTests {
  @Test func tokenCountsReadCoarselyAsTheExpoAppHasThem() {
    #expect(ContextFormat.tokens(0) == "0")
    #expect(ContextFormat.tokens(999) == "999")
    #expect(ContextFormat.tokens(1_000) == "1k")
    #expect(ContextFormat.tokens(164_200) == "164k")
    #expect(ContextFormat.tokens(999_999) == "1000k")
    #expect(ContextFormat.tokens(1_200_000) == "1.2M")
    #expect(ContextFormat.tokens(12_400_000) == "12M")
  }

  @Test func theContextLineSaysPercentCountsAndEstimates() {
    let exact = ContextUsage(used: 50_000, limit: 200_000, fraction: 0.25, percent: 25, estimated: false)
    let line = ContextFormat.line(exact)
    #expect(line.contains("25"))
    #expect(line.contains("50k"))
    #expect(line.contains("200k"))
    #expect(!line.contains(Strings.Chat.Context.estimated))

    let estimated = ContextUsage(used: 50_000, limit: 200_000, fraction: 0.25, percent: 25, estimated: true)
    #expect(ContextFormat.line(estimated).contains(Strings.Chat.Context.estimated))
  }

  @Test func theRingShowsOnlyWhenTheWindowIsNearlyFull() {
    func usage(_ fraction: Double) -> ContextUsage {
      ContextUsage(used: fraction * 100, limit: 100, fraction: fraction, percent: fraction * 100, estimated: false)
    }

    #expect(!ContextRing.shows(nil))
    #expect(!ContextRing.shows(usage(0.5)))
    #expect(!ContextRing.shows(usage(0.74)))
    #expect(ContextRing.shows(usage(0.75)))
    #expect(ContextRing.shows(usage(1)))
  }

  @Test func theReasoningLevelsAreTheGatewaysWordsAndAnUnknownOneIsKept() {
    #expect(ReasoningEffortChoice.choices(including: "high").map(\.value) == ReasoningEffortChoice.known)
    #expect(ReasoningEffortChoice.choices(including: nil).map(\.value) == ReasoningEffortChoice.known)
    #expect(ReasoningEffortChoice.choices(including: "auto").map(\.value) == ReasoningEffortChoice.known + ["auto"])
    #expect(ReasoningEffortChoice.label("auto") == "auto")
    #expect(ReasoningEffortChoice.label("xhigh") == NativeStrings.Chat.Reasoning.label("xhigh"))
    #expect(NativeStrings.Chat.Reasoning.label("none") != nil)
  }

  @Test func theModelsAreGroupedByProviderInTheGatewaysOrderAndSearched() {
    let choices = [
      BotModelChoice(provider: "a", providerName: "Alpha", model: "alpha-1"),
      BotModelChoice(provider: "b", providerName: "Beta", model: "beta-1"),
      BotModelChoice(provider: "a", providerName: "Alpha", model: "alpha-turbo")
    ]

    let all = ModelPickerSection.sections(choices, matching: "")
    #expect(all.map(\.name) == ["Alpha", "Beta"])
    #expect(all[0].choices.map(\.model) == ["alpha-1", "alpha-turbo"])

    #expect(ModelPickerSection.sections(choices, matching: "TURBO").flatMap(\.choices).map(\.model) == ["alpha-turbo"])
    #expect(ModelPickerSection.sections(choices, matching: "beta").map(\.name) == ["Beta"], "the provider's name matches too")
    #expect(ModelPickerSection.sections(choices, matching: "zzz").isEmpty)
  }
}

/// The export's file: both formats from the one serialisation, a name a file system takes, and the
/// device's own clock for the stamps.
@MainActor
@Suite struct TranscriptFileTests {
  private func items() -> [TranscriptItem] {
    [
      .user(UserItem(base: ItemBase(id: "u1", seq: 1, ts: 1_790_000_000, origin: .history, version: 1), text: "Hello")),
      .assistant(
        AssistantItem(
          base: ItemBase(id: "a1", seq: 2, ts: 1_790_000_060, origin: .history, version: 1), text: "**Hi!**", streaming: false,
          interim: false))
    ]
  }

  private let now = Date(timeIntervalSince1970: 1_790_000_100)
  private let utc = TimeZone(identifier: "UTC")!

  @Test func markdownKeepsTheBoldNameAndTheRepliesOwnMarkup() {
    let file = TranscriptFile.make(
      items: items(), botName: "Research Bot", selfName: "You", format: .markdown, now: now, timeZone: utc,
      formatTime: { _ in "T" })

    #expect(file.name == "Research-Bot-2026-09-21.md")
    #expect(file.format == .markdown)
    #expect(file.content.hasPrefix("# Research Bot\n"))
    #expect(file.content.contains("_Exported T_"))
    #expect(file.content.contains("**You** · T"))
    #expect(file.content.contains("**Research Bot** · T"))
    #expect(file.content.contains("**Hi!**"), "the reply's own markdown is the author's, not ours to strip")
    #expect(file.content.hasSuffix("\n"))
  }

  @Test func plainTextHasNoMarkupAroundTheNames() {
    let file = TranscriptFile.make(
      items: items(), botName: "Research Bot", selfName: "Jij", format: .text, now: now, timeZone: utc,
      formatTime: { _ in "T" })

    #expect(file.name == "Research-Bot-2026-09-21.txt")
    #expect(file.content.hasPrefix("Research Bot\n============\n"))
    #expect(file.content.contains("T · Jij:\nHello"))
    #expect(file.content.contains("T · Research Bot:\n**Hi!**"))
  }

  @Test func theNameIsSafeAndTheDayIsTheReadersOwn() {
    let late = Date(timeIntervalSince1970: 1_790_000_100 + 3600)
    let tokyo = TimeZone(identifier: "Asia/Tokyo")!

    #expect(TranscriptFile.isoDay(late, utc) == "2026-09-21")
    #expect(TranscriptFile.isoDay(late, tokyo) == "2026-09-22")
    #expect(
      TranscriptFile.make(items: [], botName: "ops/deploy", selfName: "You", format: .text, now: now, timeZone: utc).name
        == "ops-deploy-2026-09-21.txt")
    #expect(
      TranscriptFile.make(items: [], botName: "  ", selfName: "You", format: .text, now: now, timeZone: utc).name
        == "chat-2026-09-21.txt")
  }

  @Test func anEmptyConversationIsStillAFileWithAHeader() {
    let file = TranscriptFile.make(items: [], botName: "Bot", selfName: "You", format: .markdown, now: now, timeZone: utc)
    #expect(file.content.hasPrefix("# Bot\n"))
    #expect(file.content.hasSuffix("\n"))
  }

  @Test func theDeviceClockIsUsedWhenNoFormatterIsGiven() {
    let file = TranscriptFile.make(items: items(), botName: "Bot", selfName: "You", format: .text, now: now, timeZone: utc)
    #expect(file.content.contains("Exported "), "a stamp from the default style")
  }

  @Test func theDocumentHoldsTheTextAndKnowsBothContentTypes() throws {
    let document = TranscriptDocument(text: "héllo ✓")
    #expect(TranscriptDocument.writableContentTypes.count == TranscriptFileFormat.allCases.count)
    #expect(Data(document.text.utf8) == Data("héllo ✓".utf8))
    #expect(TranscriptFileFormat.text.contentType == .plainText)
    #expect(TranscriptFileFormat.markdown.fileExtension == .md)
  }
}
