import Foundation
import Testing

@testable import HermieCore
@testable import HermieUI

/// YOLO mode on the chat screen's feed: turning it on asks first, a switch that cannot be made says so
/// over the chat, and the line goes when it is dismissed.
@MainActor
@Suite struct ChatFeedYoloTests {
  let session = GatewaySession(gatewayID: "feed-yolo", link: UnreachableLink())

  private func makeFeed(_ owner: ChatFeedOwner<ChatFeed>) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-yolo", bot: "writer"), session: session) { _ in .none }
    }
    return owner.feed
  }

  @Test func aChatStartsWithYoloOffAndNothingAsked() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    #expect(feed.yolo == false)
    #expect(feed.confirmingYolo == false)
    #expect(feed.yoloFailure == nil)
  }

  @Test func turningItOnAsksBeforeAnythingGoesOut() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.requestYolo(true)
    #expect(feed.confirmingYolo)
    #expect(feed.yoloFailure == nil, "nothing was tried yet")
  }

  @Test func turningItOffWhileItIsOffDoesNothing() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.requestYolo(false)
    #expect(feed.confirmingYolo == false)
    try await Task.sleep(for: .milliseconds(50))
    #expect(feed.yoloFailure == nil)
  }

  @Test func aConfirmedSwitchThatCannotBeMadeSaysSoUntilDismissed() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))

    feed.requestYolo(true)
    feed.confirmYolo()
    #expect(feed.confirmingYolo == false)

    await eventually("the failure") { feed.yoloFailure != nil }
    let reason = try #require(feed.yoloFailure)
    #expect(ChatActionNotices.text(attachment: nil, retry: nil, yolo: reason) == NativeStrings.Chat.Yolo.failed(reason))
    #expect(feed.yolo == false)

    feed.dismissActionNotices()
    #expect(feed.yoloFailure == nil)
  }
}
