import Testing

@testable import HermieUI

/// A chat screen's feed lives as long as the screen's identity, whatever order its appearances
/// arrive in. The sequences are the ones the unified log recorded on an iPhone simulator (iOS 27)
/// while a chat was opened from the list in a collapsed split view: the selection and the column
/// change land in one update, and SwiftUI sends the new screen `onAppear` then `onDisappear`, with
/// no `onAppear` after it, while the screen stays on screen.
@MainActor
@Suite struct ChatFeedOwnerTests {
  @MainActor
  final class Feed: ChatScreenFeed {
    let name: String
    var starts = 0
    var stops = 0

    init(_ name: String) {
      self.name = name
    }

    func start() { starts += 1 }
    func stop() { stops += 1 }
  }

  @Test func aDisappearanceTheScreenOutlivesLeavesItsFeedRunning() throws {
    // view#2 appear → feed f2 init → view#2 disappear → (nothing more; the chat is on screen)
    let owner = ChatFeedOwner<Feed>()
    owner.appeared { Feed("researcher") }
    owner.disappeared()

    let feed = try #require(owner.feed, "the screen still draws its transcript and composer")
    #expect(feed.starts == 1)
    #expect(feed.stops == 0, "the chat is not given back while its screen exists")
  }

  @Test func appearDisappearAppearKeepsOneFeedStartedOnce() {
    // view#2 appear → disappear → appear, in one update: the same feed, never restarted.
    let owner = ChatFeedOwner<Feed>()
    var made = 0
    owner.appeared {
      made += 1
      return Feed("researcher")
    }
    let first = owner.feed
    owner.disappeared()
    owner.appeared {
      made += 1
      return Feed("researcher")
    }

    #expect(made == 1)
    #expect(owner.feed === first)
    #expect(first?.starts == 1)
    #expect(first?.stops == 0)
  }

  @Test func theFeedStopsOnceWhenTheScreenIsGone() {
    var owner: ChatFeedOwner<Feed>? = ChatFeedOwner<Feed>()
    owner?.appeared { Feed("writer") }
    let feed = owner?.feed
    owner?.disappeared()
    owner?.disappeared()
    #expect(feed?.stops == 0)

    owner = nil
    #expect(feed?.stops == 1, "the screen's identity went: its feed stops, once")
  }

  @Test func anOldScreensTeardownNeverTouchesTheNewScreensFeed() {
    // Back to the list and straight into another chat: the old screen goes after the new one came.
    var old: ChatFeedOwner<Feed>? = ChatFeedOwner<Feed>()
    old?.appeared { Feed("writer") }
    let oldFeed = old?.feed

    let new = ChatFeedOwner<Feed>()
    new.appeared { Feed("researcher") }
    old?.disappeared()
    old = nil

    #expect(oldFeed?.stops == 1)
    #expect(new.feed?.stops == 0)
    #expect(new.feed?.name == "researcher")
  }
}
