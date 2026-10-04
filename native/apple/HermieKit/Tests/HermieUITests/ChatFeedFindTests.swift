import Foundation
import HermieTranscript
import SwiftUI
import Testing

@testable import HermieCore
@testable import HermieUI

/// A chat opened from a message search hit: the feed looks for the row the words are in, scrolls the
/// list to it, marks it for a moment, and says so when the words are not in the chat's visible text.
/// The feed runs over a real session on a link that never connects, with snapshots handed to the model.
@MainActor
@Suite struct ChatFeedFindTests {
  let session = GatewaySession(gatewayID: "gateway-under-test", link: UnreachableLink())

  /// What a request's settle callback was told.
  final class Settled {
    var ids: [Int] = []
  }

  private func feed(_ owner: ChatFeedOwner<ChatFeed>) throws -> ChatFeed {
    let session = self.session
    owner.appeared {
      let feed = ChatFeed(chat: ChatRef(gatewayId: "gateway-under-test", bot: "writer"), session: session) { _ in .none }
      feed.readMarkDelay = .zero
      feed.flashDuration = .milliseconds(30)
      feed.noticeDuration = .milliseconds(30)
      feed.findRetryInterval = .milliseconds(10)
      return feed
    }

    return try #require(owner.feed)
  }

  private func base(_ id: String, _ seq: Int) -> ItemBase {
    ItemBase(id: id, seq: seq, ts: Double(seq), origin: .history, version: 1)
  }

  private func user(_ id: String, _ seq: Int, _ text: String) -> VisibleItem {
    VisibleItem(item: .user(UserItem(base: base(id, seq), text: text)), presentation: .full)
  }

  private func assistant(_ id: String, _ seq: Int, _ text: String) -> VisibleItem {
    VisibleItem(
      item: .assistant(AssistantItem(base: base(id, seq), text: text, streaming: false, interim: false)),
      presentation: .full)
  }

  private func publish(
    _ feed: ChatFeed, _ items: [VisibleItem], hydration: HydrationState = .live, revision: Int
  ) {
    feed.model.apply(
      ChatSnapshot(
        key: feed.model.key, items: items, hydration: hydration, busy: false, turnActive: false, activity: .idle,
        openRequests: [], queue: [], attached: true, canLoadOlder: false, revision: revision))
  }

  private func request(_ id: Int, _ query: String, bot: String = "writer") -> ChatFindRequest {
    ChatFindRequest(id: id, chat: ChatRef(gatewayId: "gateway-under-test", bot: bot), query: query)
  }

  private let conversation: [(id: String, text: String, user: Bool)] = [
    ("u1", "hello", true), ("a1", "the invoice is paid", false), ("u2", "thanks", true), ("a2", "any time", false),
  ]

  private var items: [VisibleItem] {
    conversation.enumerated().map { index, row in
      row.user ? user(row.id, index + 1, row.text) : assistant(row.id, index + 1, row.text)
    }
  }

  @Test func theListScrollsToTheNewestRowWithTheWordsAndItIsMarkedForAMoment() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, items, revision: 1)
    await eventually("the rows") { feed.rows.count == 4 }

    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }

    #expect(settled.ids == [7])
    #expect(feed.listState.command == .item(AnyHashable("a1"), anchor: ChatFeed.findAnchor, animated: false))
    #expect(feed.rows.filter(\.flash).map(\.id) == ["a1"])
    #expect(feed.findNotice == nil)

    // The mark goes by itself, and takes nothing else with it.
    await eventually("the mark to go") { feed.rows.allSatisfy { !$0.flash } }
    #expect(feed.rows.map(\.id) == ["u1", "a1", "u2", "a2"])
  }

  @Test func aListThatHasNotLaidOutItsRowsIsWaitedFor() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, items, revision: 1)
    await eventually("the rows") { feed.rows.count == 4 }

    // A scroll asked of a list that has not loaded is dropped, so none is asked yet.
    feed.listState.rowsLaidOut = false
    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }

    #expect(settled.ids.isEmpty)
    #expect(feed.listState.command == nil)
    #expect(feed.rows.allSatisfy { !$0.flash })

    // No rebuild comes (nobody is writing in this chat): the walk looks again by itself.
    feed.listState.rowsLaidOut = true
    await eventually("the walk to settle") { settled.ids == [7] }

    #expect(feed.listState.command == .item(AnyHashable("a1"), anchor: ChatFeed.findAnchor, animated: false))
  }

  @Test func theSameRequestIsTakenOnce() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, items, revision: 1)
    await eventually("the rows") { feed.rows.count == 4 }

    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }
    feed.listState.command = nil
    feed.find(request(7, "invoice")) { settled.ids.append($0) }

    #expect(settled.ids == [7])
    #expect(feed.listState.command == nil)

    // The same words asked again are a new request, and are looked for again.
    feed.find(request(8, "invoice")) { settled.ids.append($0) }
    #expect(settled.ids == [7, 8])
    #expect(feed.listState.command != nil)
  }

  @Test func aRequestForAnotherChatIsNotThisFeedsToTake() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, items, revision: 1)
    await eventually("the rows") { feed.rows.count == 4 }

    let settled = Settled()
    feed.find(request(7, "invoice", bot: "someone-else")) { settled.ids.append($0) }

    #expect(settled.ids.isEmpty)
    #expect(feed.listState.command == nil)
  }

  @Test func aChatStillArrivingIsNotMissedAgainst() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, Array(items.prefix(1)), hydration: .hydrating, revision: 1)
    await eventually("the first row") { feed.rows.count == 1 }

    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }

    // Half a transcript: not a miss, and no notice.
    #expect(settled.ids.isEmpty)
    #expect(feed.findNotice == nil)

    publish(feed, items, hydration: .live, revision: 2)
    await eventually("the walk to settle") { settled.ids == [7] }

    #expect(feed.listState.command == .item(AnyHashable("a1"), anchor: ChatFeed.findAnchor, animated: false))
    #expect(feed.findNotice == nil)
  }

  @Test func wordsThatAreNotInTheVisibleTextAreSaidSoAndTheNoticeGoes() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, items, revision: 1)
    await eventually("the rows") { feed.rows.count == 4 }

    let settled = Settled()
    feed.find(request(7, "unicorn")) { settled.ids.append($0) }

    // The chat has no older history to read: the walk ends at once, and the list is left where it was.
    await eventually("the notice") { feed.findNotice != nil }
    #expect(feed.findNotice == Strings.App.Chat.findExhausted(query: "unicorn"))
    #expect(settled.ids == [7])
    #expect(feed.listState.command == nil)
    #expect(feed.rows.allSatisfy { !$0.flash })

    await eventually("the notice to go") { feed.findNotice == nil }
  }

  @Test func aNewerRequestReplacesAWalkStillWaitingAndLetsTheOldOneGo() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, Array(items.prefix(1)), hydration: .hydrating, revision: 1)
    await eventually("the first row") { feed.rows.count == 1 }

    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }
    #expect(settled.ids.isEmpty)

    feed.find(request(8, "thanks")) { settled.ids.append($0) }
    // The old request is let go without an outcome.
    #expect(settled.ids == [7])

    publish(feed, items, hydration: .live, revision: 2)
    await eventually("the new request") { settled.ids == [7, 8] }

    #expect(feed.listState.command == .item(AnyHashable("u2"), anchor: ChatFeed.findAnchor, animated: false))
    #expect(feed.findNotice == nil)
  }

  @Test func aScreenThatGoesBeforeTheWalkEndsLetsTheRequestGoWithoutANotice() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    publish(feed, Array(items.prefix(1)), hydration: .hydrating, revision: 1)
    await eventually("the first row") { feed.rows.count == 1 }

    let settled = Settled()
    feed.find(request(7, "invoice")) { settled.ids.append($0) }
    feed.stop()

    // Settled, so the router does not hand it to the next screen of this chat.
    #expect(settled.ids == [7])
    #expect(feed.findNotice == nil)
  }

  @Test func aMatchInsideARolledUpRunMarksTheRollUp() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)

    func exchange(_ id: String, _ seq: Int, _ text: String) -> VisibleItem {
      VisibleItem(
        item: .botDmIn(BotDmInItem(base: base(id, seq), senderName: "Ada", senderHandle: "ada", text: text)),
        presentation: .collapsed)
    }

    publish(
      feed,
      [
        user("u1", 1, "hello"), exchange("d1", 2, "first"), exchange("d2", 3, "the budget is approved"),
        exchange("d3", 4, "third"), exchange("d4", 5, "fourth"),
      ], revision: 1)
    await eventually("the rows") { feed.rows.count == 2 }

    let settled = Settled()
    feed.find(request(7, "budget")) { settled.ids.append($0) }

    #expect(settled.ids == [7])
    #expect(feed.listState.command == .item(AnyHashable("rollup:d1"), anchor: ChatFeed.findAnchor, animated: false))
    #expect(feed.rows.filter(\.flash).map(\.id) == ["rollup:d1"])
  }
}

@MainActor
@Suite struct MessageSearchPresentationTests {
  @Test func theStatusIsWhatTheSearchHasToSay() {
    func status(_ searchable: Bool = true, answered: Bool = true, matches: Int = 0, failed: Bool = false)
      -> MessageSearchStatus
    {
      .of(searchable: searchable, answered: answered, matches: matches, failed: failed)
    }

    #expect(status(false) == .idle)
    #expect(status(false, answered: false) == .idle)
    #expect(status(answered: false) == .searching)
    #expect(status(matches: 3) == .hits)
    #expect(status(matches: 0) == .none)
    #expect(status(matches: 0, failed: true) == .failed)
    // A search that is out says so, whatever was held from before.
    #expect(status(answered: false, matches: 3, failed: true) == .searching)
  }

  @Test func eachStatusHasItsOwnWords() {
    #expect(MessageSearchStatus.idle.text.isEmpty)
    #expect(MessageSearchStatus.searching.text == Strings.App.Bots.messagesSearching)
    #expect(MessageSearchStatus.hits.text == Strings.App.Bots.messagesHint)
    #expect(MessageSearchStatus.none.text == Strings.App.Bots.messagesNone)
    #expect(MessageSearchStatus.failed.text == NativeStrings.Search.failed)
    #expect(MessageSearchStatus.none.text != MessageSearchStatus.failed.text)
  }

  @Test func theSearchRunsAgainOnlyWhenWhatItAsksChanges() {
    let session = GatewaySession(gatewayID: "g", link: UnreachableLink())
    let a = MessageSearchRequest(session: session, query: "  invoice ", ready: true)
    let same = MessageSearchRequest(session: session, query: "invoice", ready: true)
    let other = MessageSearchRequest(session: session, query: "invoices", ready: true)
    let offline = MessageSearchRequest(session: session, query: "invoice", ready: false)

    #expect(a.query == "invoice")
    #expect(a.key == same.key)
    #expect(a.key != other.key)
    #expect(a.key != offline.key)
    // No roster yet: nothing to ask, so the list says nothing about messages.
    #expect(!a.searchable)
  }

  @Test func theSnippetIsOnlyCharactersWithTheMatchMarked() {
    let text = MessageSnippetText.attributed("see [x](https://evil.example) >>>**bold**<<< now")

    #expect(String(text.characters) == "see [x](https://evil.example) **bold** now")
    #expect(text.runs.allSatisfy { $0.link == nil })

    let marked = text.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }
    #expect(marked.map { String(text[$0.range].characters) } == ["**bold**"])
  }
}

@MainActor
@Suite struct AppRouterFindTests {
  private let chat = ChatRef(gatewayId: "g1", bot: "ada")

  @Test func followingAHitOpensTheChatAndLeavesTheWordsForIt() {
    let router = AppRouter()

    router.openChat(chat, finding: "  invoice  ")

    #expect(router.selectedChat == chat)
    #expect(router.chatFind == ChatFindRequest(id: 1, chat: chat, query: "invoice"))
  }

  @Test func theSameWordsAskedAgainAreANewRequest() {
    let router = AppRouter()

    router.openChat(chat, finding: "invoice")
    let first = router.chatFind
    router.openChat(chat, finding: "invoice")

    #expect(router.chatFind?.id != first?.id)
    #expect(router.chatFind?.query == "invoice")
  }

  @Test func onlyTheRequestThatWasTakenIsSettled() {
    let router = AppRouter()

    router.openChat(chat, finding: "invoice")
    let old = router.chatFind?.id ?? 0
    router.openChat(chat, finding: "thanks")
    router.settleFind(old)

    #expect(router.chatFind?.query == "thanks")

    router.settleFind(router.chatFind?.id ?? 0)
    #expect(router.chatFind == nil)
  }

  @Test func theWordsBelongToTheChatTheHitNamed() {
    let router = AppRouter()

    router.openChat(chat, finding: "invoice")
    // Another chat is opened before the hit's chat took its request: the words go.
    router.openChat(ChatRef(gatewayId: "g1", bot: "bob"))
    #expect(router.chatFind == nil)

    router.openChat(chat, finding: "invoice")
    router.closeChat()
    #expect(router.chatFind == nil)

    // The chat of the hit opening again (a second tap on its row) keeps the request.
    router.openChat(chat, finding: "invoice")
    router.openChat(chat)
    #expect(router.chatFind?.query == "invoice")
  }

  @Test func aBlankFieldLeavesNothingToFind() {
    let router = AppRouter()

    router.openChat(chat, finding: "invoice")
    router.openChat(ChatRef(gatewayId: "g1", bot: "bob"), finding: "   ")

    #expect(router.selectedChat?.bot == "bob")
    #expect(router.chatFind == nil)
  }
}
