import Foundation
import HermieShared
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

// What the system's search is given about the chats: the titles of a bot's other conversations always,
// the text of the bots' chats only where the policy allows it, and nothing left behind by a sign-out.

private let gwKey = "bf796761db84e312"
private let otherGwKey = "1111111111111111"

/// The system's index as a test sees it: items by domain, deleted by domain with the system's rule that a
/// domain takes its subdomains with it.
final class RecordingSpotlight: SpotlightSink, Sendable {
  private struct State {
    var items: [String: [SpotlightItem]] = [:]
    var writes: [String] = []
    var deletes: [[String]] = []
  }

  private let state = Mutex(State())

  func replace(domain: String, with items: [SpotlightItem]) {
    state.withLock {
      $0.items[domain] = items
      $0.writes.append(domain)
    }
  }

  func delete(domains: [String]) {
    state.withLock { state in
      state.deletes.append(domains)

      for domain in domains {
        for held in state.items.keys where held == domain || held.hasPrefix(domain + ".") {
          state.items[held] = nil
        }
      }
    }
  }

  /// Every item held under `domain` or its subdomains.
  func items(under domain: String) -> [SpotlightItem] {
    state.withLock { state in
      state.items.filter { $0.key == domain || $0.key.hasPrefix(domain + ".") }.values.flatMap { $0 }
    }
  }

  var writes: [String] { state.withLock { $0.writes } }
  var deletes: [[String]] { state.withLock { $0.deletes } }

  func clearLog() {
    state.withLock {
      $0.writes = []
      $0.deletes = []
    }
  }
}

@Suite struct ChatSpotlightPolicyTests {
  @Test func textIsIndexedOnlyWhereNothingHidesPreviewsAndTheCacheIsOn() {
    #expect(ChatSpotlightPolicy.resolve(hidePreviews: false, transcriptCache: true) == .titlesAndText)
    #expect(ChatSpotlightPolicy.resolve(hidePreviews: true, transcriptCache: true) == .titlesOnly)
    #expect(ChatSpotlightPolicy.resolve(hidePreviews: false, transcriptCache: false) == .titlesOnly)
    #expect(ChatSpotlightPolicy.resolve(hidePreviews: true, transcriptCache: false) == .titlesOnly)
    #expect(ChatSpotlightPolicy.titlesAndText.allowsText)
    #expect(!ChatSpotlightPolicy.titlesOnly.allowsText)
  }
}

@Suite struct ChatSpotlightItemsTests {
  private let conversation = IndexedConversation(
    bot: "researcher", botName: "Researcher", session: "20260915_142233_a1b2c3", title: "Taxes 2025")

  @Test func aConversationIsIndexedByItsTitleAndLinksToItself() throws {
    let items = ChatSpotlightIndex.titleItems([conversation], gatewayKey: gwKey)
    let item = try #require(items.first)

    #expect(items.count == 1)
    #expect(item.title == "Taxes 2025")
    #expect(item.summary == "Researcher")
    #expect(item.text == nil)
    #expect(item.domain == "dev.hermie.app.conversations.\(gwKey)")
    #expect(item.keywords.contains("researcher"))
    // The identifier is a link the router already opens, naming the gateway and the conversation.
    #expect(
      ChatSpotlightIndex.link(forIdentifier: item.identifier)
        == .conversation(bot: "researcher", session: "20260915_142233_a1b2c3", gatewayKey: gwKey))
  }

  @Test func aConversationWithoutATitleOrALinkableIdIsLeftOut() {
    let untitled = IndexedConversation(bot: "researcher", botName: "R", session: "s1", title: "   ")
    let odd = IndexedConversation(bot: "researcher", botName: "R", session: "../x", title: "Fine")

    #expect(ChatSpotlightIndex.titleItems([untitled, odd], gatewayKey: gwKey).isEmpty)
  }

  @Test func theTextOfAChatIsCutToItsRecentEnd() throws {
    let long = String(repeating: "old ", count: 3000) + "the newest words"
    let items = ChatSpotlightIndex.textItems(
      [IndexedChatText(bot: "researcher", botName: "Researcher", text: long)], gatewayKey: gwKey)
    let item = try #require(items.first)
    let text = try #require(item.text)

    #expect(text.count <= ChatSpotlightIndex.textLimit)
    #expect(text.hasSuffix("the newest words"))
    #expect(item.title == "Researcher")
    #expect(item.summary == nil)
    #expect(item.domain == "dev.hermie.app.chattext.\(gwKey)")
  }

  @Test func aTextItemOpensTheBotsChatAndNeverSharesTheBotItemsIdentifier() throws {
    let item = try #require(
      ChatSpotlightIndex.textItems([IndexedChatText(bot: "researcher", botName: "R", text: "words")], gatewayKey: gwKey)
        .first)
    let botItem = try #require(
      BotSpotlightIndex.entries(
        for: [
          WidgetSnapshot.Bot(
            name: "researcher", displayName: "R", initials: "R", colour: "#000000", presence: "online", lastLine: "",
            lastAt: 0, unread: 0, needsInput: false)
        ], gatewayKey: gwKey, hidePreviews: false
      ).first)

    #expect(ChatSpotlightIndex.link(forIdentifier: item.identifier) == .chat(bot: "researcher", gatewayKey: gwKey))
    #expect(item.identifier != botItem.identifier)
  }

  @Test func aChatWithNoWordsIsNotIndexed() {
    #expect(
      ChatSpotlightIndex.textItems([IndexedChatText(bot: "r", botName: "R", text: " \n ")], gatewayKey: gwKey).isEmpty)
  }

  @Test func anIdentifierThatIsNotOursIsNoLink() {
    #expect(ChatSpotlightIndex.link(forIdentifier: nil) == nil)
    #expect(ChatSpotlightIndex.link(forIdentifier: "https://evil.invalid/chat/x") == nil)
    #expect(ChatSpotlightIndex.link(forIdentifier: "hermie://gateway/x") == nil)
  }
}

@MainActor
@Suite struct ChatSpotlightIndexerTests {
  /// What the gateway offers: bots, their other conversations, the text of their chats; counted.
  final class Gateway: Sendable {
    private let state = Mutex(State())

    struct State {
      var conversations: [String: [IndexedConversation]] = [:]
      var text: [String: String] = [:]
      var listCalls = 0
      var textCalls = 0
    }

    var listCalls: Int { state.withLock { $0.listCalls } }
    var textCalls: Int { state.withLock { $0.textCalls } }

    func set(text: [String: String]) { state.withLock { $0.text = text } }
    func set(conversations: [String: [IndexedConversation]]) { state.withLock { $0.conversations = conversations } }

    var source: ChatSpotlightIndexer.Source {
      ChatSpotlightIndexer.Source(
        bots: [IndexedBot(name: "researcher", displayName: "Researcher"), IndexedBot(name: "writer", displayName: "Writer")],
        conversations: { bot in
          self.state.withLock {
            $0.listCalls += 1
            return $0.conversations[bot] ?? []
          }
        },
        text: { bot in
          self.state.withLock {
            $0.textCalls += 1
            return $0.text[bot]
          }
        })
    }
  }

  /// A clock the test moves.
  final class Clock: Sendable {
    private let offset = Mutex(Duration.zero)
    private let origin = ContinuousClock.now

    var now: ContinuousClock.Instant { origin + offset.withLock { $0 } }
    func advance(_ by: Duration) { offset.withLock { $0 += by } }
  }

  private func rig() -> (ChatSpotlightIndexer, RecordingSpotlight, Gateway, Clock) {
    let sink = RecordingSpotlight()
    let clock = Clock()
    let gateway = Gateway()
    gateway.set(conversations: [
      "researcher": [IndexedConversation(bot: "researcher", botName: "Researcher", session: "s1", title: "Taxes")]
    ])
    gateway.set(text: ["researcher": "talking about the invoice", "writer": "a draft of the post"])

    return (ChatSpotlightIndexer(index: ChatSpotlightIndex(sink: sink), clock: { clock.now }), sink, gateway, clock)
  }

  private var conversations: String { ChatSpotlightIndex.conversationsDomain }
  private var text: String { ChatSpotlightIndex.textDomain }

  @Test func titlesAndTextAreIndexedWhereThePolicyAllowsText() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)

    #expect(sink.items(under: conversations).map(\.title) == ["Taxes"])
    #expect(Set(sink.items(under: text).map(\.title)) == ["Researcher", "Writer"])
    #expect(sink.items(under: text).allSatisfy { $0.text?.isEmpty == false })
  }

  @Test func underTitlesOnlyTheTextIsNeverIndexedOrEvenRead() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly)

    #expect(sink.items(under: conversations).map(\.title) == ["Taxes"])
    #expect(sink.items(under: text).isEmpty)
    #expect(gateway.textCalls == 0)
    #expect(!sink.writes.contains { $0.hasPrefix(text) })
  }

  @Test func theAppLockTakesTheTextOutAndKeepsTheTitles() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    #expect(!sink.items(under: text).isEmpty)

    // Hide previews comes on (the app lock is configured): the policy no longer allows text.
    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly)

    #expect(sink.items(under: text).isEmpty)
    #expect(sink.items(under: conversations).map(\.title) == ["Taxes"])
    #expect(sink.deletes.contains([text]))
  }

  @Test func theTextIsPurgedForEveryGatewayNotOnlyTheLiveOne() async {
    let (indexer, sink, gateway, clock) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    clock.advance(.seconds(120))
    await indexer.refresh(gatewayKey: otherGwKey, source: gateway.source, policy: .titlesAndText)
    #expect(sink.items(under: "\(text).\(gwKey)").count == 2)
    #expect(sink.items(under: "\(text).\(otherGwKey)").count == 2)

    await indexer.refresh(gatewayKey: otherGwKey, source: gateway.source, policy: .titlesOnly)

    #expect(sink.items(under: text).isEmpty)
    #expect(!sink.items(under: conversations).isEmpty)
  }

  @Test func allowingTextAgainWritesItAllAfresh() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly)
    #expect(sink.items(under: text).isEmpty)

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)

    #expect(Set(sink.items(under: text).map(\.title)) == ["Researcher", "Writer"])
  }

  @Test func askedAgainAtOnceItReadsAndWritesNothing() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    let writes = sink.writes
    let listed = gateway.listCalls
    let read = gateway.textCalls

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)

    #expect(sink.writes == writes)
    #expect(gateway.listCalls == listed)
    #expect(gateway.textCalls == read)
  }

  @Test func afterTheIntervalsItReadsAgainButWritesOnlyWhatChanged() async {
    let (indexer, sink, gateway, clock) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    sink.clearLog()
    clock.advance(.seconds(120))

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)

    // The text was read again (a minute passed), found the same, and wrote nothing.
    #expect(gateway.textCalls == 4)
    #expect(sink.writes.isEmpty)

    gateway.set(text: ["researcher": "talking about the invoice and the tax", "writer": "a draft of the post"])
    clock.advance(.seconds(120))
    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)

    #expect(sink.writes == ["\(text).\(gwKey)"])
  }

  @Test func theGatewaysSessionsChangingReadsTheTitlesAtOnce() async {
    let (indexer, sink, gateway, _) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly)
    gateway.set(conversations: [
      "researcher": [
        IndexedConversation(bot: "researcher", botName: "Researcher", session: "s1", title: "Taxes"),
        IndexedConversation(bot: "researcher", botName: "Researcher", session: "s2", title: "Holiday")
      ]
    ])

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly)
    #expect(sink.items(under: conversations).count == 1)

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesOnly, force: true)
    #expect(Set(sink.items(under: conversations).map(\.title)) == ["Taxes", "Holiday"])
  }

  @Test func aSignOutTakesThatGatewaysTitlesAndTextAwayAndOnlyThat() async {
    let (indexer, sink, gateway, clock) = rig()

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    clock.advance(.seconds(120))
    await indexer.refresh(gatewayKey: otherGwKey, source: gateway.source, policy: .titlesAndText)

    indexer.purge(gatewayKey: gwKey)

    #expect(sink.items(under: "\(conversations).\(gwKey)").isEmpty)
    #expect(sink.items(under: "\(text).\(gwKey)").isEmpty)
    #expect(!sink.items(under: "\(conversations).\(otherGwKey)").isEmpty)
    #expect(!sink.items(under: "\(text).\(otherGwKey)").isEmpty)

    // It forgot the gateway: the next time it is live, everything is written afresh.
    sink.clearLog()
    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    #expect(!sink.items(under: "\(text).\(gwKey)").isEmpty)
  }

  @Test func aReadThatWasInFlightWhenTheGatewayWasPurgedWritesNothing() async {
    let (indexer, sink, _, _) = rig()
    let gate = SearchGate()
    let source = ChatSpotlightIndexer.Source(
      bots: [IndexedBot(name: "researcher", displayName: "Researcher")],
      conversations: { _ in
        try? await gate.wait()
        return [IndexedConversation(bot: "researcher", botName: "Researcher", session: "s1", title: "Taxes")]
      },
      text: { _ in "words" })

    let run = Task { await indexer.refresh(gatewayKey: gwKey, source: source, policy: .titlesAndText) }

    // The purge lands while the listing is out.
    try? await Task.sleep(for: .milliseconds(50))
    indexer.purge(gatewayKey: gwKey)
    gate.open()
    await run.value

    #expect(sink.items(under: "\(conversations).\(gwKey)").isEmpty)
    #expect(sink.items(under: "\(text).\(gwKey)").isEmpty)
  }

  @Test func theSurfacesPurgeOfASignedOutGatewayTakesItsChatItemsWithIt() async throws {
    let (indexer, sink, gateway, clock) = rig()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-spotlight-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let surfaces = SystemSurfaces(
      container: AppGroupContainer(url: directory), copy: SystemSurfacesTests.copy, chatSpotlight: indexer,
      isLocked: { false })

    await indexer.refresh(gatewayKey: gwKey, source: gateway.source, policy: .titlesAndText)
    clock.advance(.seconds(120))
    await indexer.refresh(gatewayKey: otherGwKey, source: gateway.source, policy: .titlesAndText)

    // The same call the accounts make after a sign-out or a removal went through.
    surfaces.purge(gatewayKey: gwKey)

    #expect(sink.items(under: "\(conversations).\(gwKey)").isEmpty)
    #expect(sink.items(under: "\(text).\(gwKey)").isEmpty)
    #expect(!sink.items(under: "\(conversations).\(otherGwKey)").isEmpty)
    #expect(!sink.items(under: "\(text).\(otherGwKey)").isEmpty)
  }

  @Test func theBotsAreCappedSoOneGatewayCannotFloodTheIndex() async {
    let sink = RecordingSpotlight()
    let indexer = ChatSpotlightIndexer(index: ChatSpotlightIndex(sink: sink))
    let bots = (0..<60).map { IndexedBot(name: "bot\($0)", displayName: "Bot \($0)") }
    let source = ChatSpotlightIndexer.Source(
      bots: bots, conversations: { _ in [] }, text: { _ in "words" })

    await indexer.refresh(gatewayKey: gwKey, source: source, policy: .titlesAndText)

    #expect(sink.items(under: text).count == ChatSpotlightIndexer.maxBots)
  }

  @Test func eachBotPutsAtMostSomeConversationsInTheIndex() async {
    let sink = RecordingSpotlight()
    let indexer = ChatSpotlightIndexer(index: ChatSpotlightIndex(sink: sink))
    let many = (0..<60).map { IndexedConversation(bot: "researcher", botName: "R", session: "s\($0)", title: "T\($0)") }
    let source = ChatSpotlightIndexer.Source(
      bots: [IndexedBot(name: "researcher", displayName: "R")], conversations: { _ in many }, text: { _ in nil })

    await indexer.refresh(gatewayKey: gwKey, source: source, policy: .titlesOnly)

    #expect(sink.items(under: conversations).count == ChatSpotlightIndex.conversationsPerBot)
  }
}
