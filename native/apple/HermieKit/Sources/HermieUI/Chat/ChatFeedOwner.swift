import Observation

/// What a chat screen's feed does for the screen that owns it.
@MainActor
protocol ChatScreenFeed: AnyObject {
  /// Start watching the chat. Called once, when the feed is made.
  func start()
  /// The screen is gone: stop watching and give the chat back. Called at most once.
  func stop()
}

/**
 Holds a chat screen's feed for as long as the screen's identity lives, and stops it when that
 identity goes, never earlier.

 `onAppear` and `onDisappear` are not a screen's lifetime. In a collapsed `NavigationSplitView` the
 selection and the column change land in one update when a chat is opened from the list, and
 SwiftUI then sends the new chat's screen `onAppear` and `onDisappear` (sometimes `onAppear` once
 more) while the screen stays on screen. A screen that dropped its feed on `onDisappear` drew
 nothing from then on: no transcript, no composer, until it was closed (the black chat after a
 switch).

 So the appearances only make the feed (the first `appeared`) and are recorded for the
 diagnostics; the feed stops when this owner is released, which SwiftUI does when the screen's
 identity is removed (another chat selected, the chat closed, the session replaced). Each screen
 has an owner of its own, so one screen's teardown cannot reach another screen's feed.
 */
@MainActor
@Observable
final class ChatFeedOwner<Feed: ChatScreenFeed> {
  private(set) var feed: Feed?
  /// A number for this screen in the diagnostics and the lifecycle log, from its first appearance.
  @ObservationIgnored private(set) var screen = 0
  /// Appearances and disappearances so far, for the diagnostics.
  @ObservationIgnored private(set) var appearances = 0
  @ObservationIgnored private(set) var disappearances = 0
  /// The last appearance event was a disappearance (SwiftUI thinks the screen is off screen).
  @ObservationIgnored private(set) var offScreen = false

  init() {}

  isolated deinit {
    feed?.stop()
  }

  /// The screen appeared: make and start its feed, once for the screen's lifetime.
  func appeared(make: () -> Feed) {
    appearances += 1
    offScreen = false

    if screen == 0 {
      screen = ChatScreenNumbers.next()
    }

    guard feed == nil else {
      return
    }

    let next = make()
    next.start()
    feed = next
  }

  /// The screen went away, or SwiftUI says so: the feed carries on until the owner goes.
  func disappeared() {
    disappearances += 1
    offScreen = true
  }
}

/// Numbers the chat screens in the order they first appear (a generic type has no static storage).
@MainActor
enum ChatScreenNumbers {
  private static var last = 0

  static func next() -> Int {
    last += 1
    return last
  }
}
