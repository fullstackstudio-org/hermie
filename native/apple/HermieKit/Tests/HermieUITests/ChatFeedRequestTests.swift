import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// HERM-251 on the chat screen's feed: leaving a chat puts its request away for the next screen of
/// that chat, and the shipped chat's rows have a working Retry and attachment opening.
@MainActor
@Suite struct ChatFeedRequestTests {
  let session = GatewaySession(gatewayID: "feed-requests", link: UnreachableLink())

  private func makeFeed(_ owner: ChatFeedOwner<ChatFeed>, standardActions: Bool = true) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-requests", bot: "writer"), session: session, standardActions: standardActions) { _ in
        .none
      }
    }
    return owner.feed
  }

  @Test func leavingTheChatPutsItsRequestAwayForTheNextScreenOfIt() throws {
    var owner: ChatFeedOwner<ChatFeed>? = ChatFeedOwner<ChatFeed>()
    let first = try #require(owner.flatMap { makeFeed($0) })
    first.requests.present("srq-1")
    #expect(first.requestUp)

    // Another chat chosen: the screen's identity goes, and its feed with it.
    owner = nil
    #expect(first.stopped)
    #expect(first.requests.presentedRequestID == nil)

    let next = ChatFeedOwner<ChatFeed>()
    let again = try #require(makeFeed(next))
    #expect(again.requests.shelf === first.requests.shelf, "the session's, not the screen's")
    #expect(again.requests.shelf.contains("srq-1", chat: "writer", kind: .answer))
    #expect(!again.requestUp, "nothing is raised by itself")
  }

  @Test func retryOnAFailedReplyGoesToTheChatAndSaysWhenItSentNothing() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    let failed = AssistantItem(
      base: ItemBase(id: "a1", seq: 2, ts: 1, origin: .history, version: 1), text: "", streaming: false, interim: false,
      error: AssistantFailure(message: "The model is unavailable.", partial: false))
    feed.model.apply(
      ChatSnapshot(
        key: "writer",
        items: [
          VisibleItem(item: .user(UserItem(base: ItemBase(id: "u1", seq: 1, ts: 1, origin: .history, version: 1), text: "hi")), presentation: .full),
          VisibleItem(item: .assistant(failed), presentation: .full)
        ],
        hydration: .live, busy: true, turnActive: true, activity: .working, openRequests: [], queue: [], attached: true,
        canLoadOlder: false, revision: 1))

    feed.itemActions.retry(failed)
    await eventually("the retry's outcome") { feed.lastRetry != nil }
    #expect(feed.lastRetry == .busy, "a running turn: nothing is sent")
    #expect(ChatActionNotices.text(attachment: nil, retry: feed.lastRetry) == Strings.Chat.Menu.turnRunning)

    feed.dismissActionNotices()
    #expect(feed.lastRetry == nil)
  }

  @Test func openingAnAttachmentOnlyOnTheGatewaysDiskSaysSo() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.itemActions.openAttachment("@file:/srv/hermie/only-there-\(UUID().uuidString).pdf")
    await eventually("the notice") { feed.attachmentNotice != nil }
    guard case .unavailable(let name)? = feed.attachmentNotice else {
      Issue.record("expected unavailable, got \(String(describing: feed.attachmentNotice))")
      return
    }
    #expect(name.hasSuffix(".pdf"))
    #expect(feed.attachmentPreview == nil)
    #expect(ChatActionNotices.text(attachment: feed.attachmentNotice, retry: nil)?.contains(name) == true)
  }

  @Test func aCallerWithActionsOfItsOwnKeepsThem() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, standardActions: false))
    let failed = AssistantItem(
      base: ItemBase(id: "a1", seq: 1, ts: 1, origin: .history, version: 1), text: "", streaming: false, interim: false)

    feed.itemActions.retry(failed)
    feed.itemActions.openAttachment("@file:/x")
    #expect(feed.lastRetry == nil)
    #expect(feed.attachmentNotice == nil)
  }
}
