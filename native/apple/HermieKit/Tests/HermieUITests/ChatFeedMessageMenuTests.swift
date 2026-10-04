import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// The message menu on the chat screen's feed: read when the menu opens, nothing that sends, types or
/// forks while a request has the composer (HERM-251), and the lines that start a turn re-checked when
/// they are chosen.
@MainActor
@Suite struct ChatFeedMessageMenuTests {
  let session = GatewaySession(gatewayID: "feed-menu", link: UnreachableLink())

  private func makeFeed(_ owner: ChatFeedOwner<ChatFeed>, standardActions: Bool = true) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-menu", bot: "writer"), session: session, standardActions: standardActions) {
        _ in .none
      }
    }
    return owner.feed
  }

  private static func base(_ id: String, _ seq: Int) -> ItemBase {
    ItemBase(id: id, seq: seq, ts: 1, origin: .history, version: 1)
  }

  private static let ask = UserItem(base: base("u1", 1), text: "write a haiku")
  private static let answer = AssistantItem(
    base: base("a1", 2), text: "Autumn **moonlight**", streaming: false, interim: false)

  private func show(_ feed: ChatFeed, turnActive: Bool = false, connected: Bool = true) {
    feed.model.connectionReady = connected
    feed.model.apply(
      ChatSnapshot(
        key: "writer",
        items: [
          VisibleItem(item: .user(Self.ask), presentation: .full),
          VisibleItem(item: .assistant(Self.answer), presentation: .full)
        ],
        hydration: .live, busy: turnActive, turnActive: turnActive, activity: turnActive ? .working : .idle,
        openRequests: [], queue: [], attached: true, canLoadOlder: false, revision: 1))
  }

  @Test func theChatsRowsGetItsMenuAndARowOutsideAChatGetsTheCopies() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)

    let reply = feed.itemActions.messageMenu(.assistant(Self.answer))
    #expect(reply.entries.map(\.action) == [.copyText, .copyMarkdown, .regenerate, .branch])
    #expect(feed.itemActions.messageMenu(.user(Self.ask)).entries.map(\.action) == [.copyText, .editResend, .branch])

    // A caller with actions of its own (a gallery, a viewer) has the copies and nothing that acts.
    let plain = TranscriptItemActions.none
    #expect(plain.messageMenu(.assistant(Self.answer)).entries.map(\.action) == [.copyText, .copyMarkdown])
  }

  @Test func aRequestOnScreenDisablesWhatSendsTypesOrForksButNotTheCopies() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)
    feed.requests.present("srq-1")
    #expect(feed.requestUp)

    let reply = feed.messageMenu(for: .assistant(Self.answer))
    #expect(reply.entry(.copyText)?.enabled == true)
    #expect(reply.entry(.regenerate)?.enabled == false)
    #expect(reply.entry(.branch)?.enabled == false)

    let own = feed.messageMenu(for: .user(Self.ask))
    #expect(own.entry(.editResend)?.enabled == false)
    #expect(own.entry(.branch)?.enabled == false)
  }

  @Test func theMenuIsReadWhenItOpensSoARunningTurnShowsInIt() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.regenerate)?.enabled == true)

    show(feed, turnActive: true)
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.regenerate)?.enabled == false)
    #expect(feed.messageMenu(for: .user(Self.ask)).entry(.editResend)?.enabled == false)
  }

  @Test func withNoConnectionThereIsNothingToFork() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed, connected: false)

    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.branch) == nil)
  }

  @Test func selectTextIsOfferedOnATouchScreenOnlyAndOpensTheMessagesWords() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)

    // The platform decides: a Mac selects in the bubble, a touch screen has a long press for the menu.
    #expect(feed.offersSelectText == !ChatFeed.selectsInPlace)

    feed.offersSelectText = false
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.selectText) == nil)
    feed.chooseMessageAction(.selectText, .assistant(Self.answer))
    #expect(feed.selectTextRequest == nil, "a line that is not offered does nothing when chosen")

    feed.offersSelectText = true
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.selectText)?.enabled == true)
    #expect(feed.messageMenu(for: .user(Self.ask)).entry(.selectText)?.enabled == true)

    feed.chooseMessageAction(.selectText, .assistant(Self.answer))
    #expect(feed.selectTextRequest == SelectTextRequest(id: "a1", text: "Autumn moonlight"))

    feed.chooseMessageAction(.selectText, .user(Self.ask))
    #expect(feed.selectTextRequest == SelectTextRequest(id: "u1", text: "write a haiku"))
  }

  @Test func editAndResendPutsTheWordsInTheComposerAndOnlyWhenItMay() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)

    feed.requests.present("srq-1")
    feed.composer.held = true
    feed.chooseMessageAction(.editResend, .user(Self.ask))
    #expect(feed.composer.draft.isEmpty, "a request has the composer: nothing is put in it")

    feed.requests.dismissSheet()
    feed.composer.held = false
    feed.chooseMessageAction(.editResend, .user(Self.ask))
    #expect(feed.composer.draft == "write a haiku")
    #expect(feed.composer.focusRequests == 1)
  }

  @Test func aLineThatIsNotOfferedDoesNothingWhenChosenFromAStaleMenu() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)

    // Regenerate chosen on a reply that is no longer the newest (a stale menu): nothing is sent.
    let older = AssistantItem(base: Self.base("a0", 0), text: "an earlier answer", streaming: false, interim: false)
    feed.chooseMessageAction(.regenerate, .assistant(older))
    try await Task.sleep(for: .milliseconds(50))
    #expect(feed.lastRetry == nil)
    #expect(feed.branchFailure == nil)
  }

  @Test func aBranchThatCannotBeMadeSaysSoOverTheChatUntilDismissed() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    show(feed)
    var opened: Conversation?
    feed.openConversation = { opened = $0 }

    // The feed's chat has no session under it: the fork is refused, and the reason is shown.
    feed.chooseMessageAction(.branch, .assistant(Self.answer))
    await eventually("the failure") { feed.branchFailure != nil }
    let reason = try #require(feed.branchFailure)
    #expect(opened == nil)
    let line = try #require(ChatActionNotices.text(attachment: nil, retry: nil, branch: reason))
    #expect(line.hasPrefix(Strings.Chat.Sessions.branchFailed))

    feed.dismissActionNotices()
    #expect(feed.branchFailure == nil)
  }
}
