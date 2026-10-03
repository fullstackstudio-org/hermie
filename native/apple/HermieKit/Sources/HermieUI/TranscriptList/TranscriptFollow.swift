import CoreGraphics

/// Whether the SwiftUI transcript list keeps the newest row in view, decided from what moved the
/// content: the reader, the list itself, or the rows growing.
///
/// "At the bottom" as geometry is not enough to decide it. When a send appends a bubble taller
/// than the threshold, the content grows before the size-change anchor has moved the offset, so
/// for one geometry update the list is no longer within the threshold of the bottom. Deciding
/// "follow" from that update stopped the following there, and the bubble and the reply after it
/// stayed below the composer. So the list follows until the reader takes it away: only a move of
/// the offset that nothing else explains (a drag, a fling, the wheel, the keyboard, the scroller,
/// an animated scroll the list did not ask for) changes it. While it follows, the size-change
/// anchor (`defaultScrollAnchor(.bottom, for: .sizeChanges)`, which reads `following`) keeps the
/// bottom as the rows grow.
///
/// A plain value, so the rules are tested without a scroll view (`TranscriptFollowTests`); the
/// collection-view list keeps the same rules in `ListPinning`.
struct TranscriptFollow: Equatable {
  /// The scroll view's geometry, reduced to the vertical axis.
  struct Geometry: Equatable {
    var offset: CGFloat
    var contentHeight: CGFloat
    var containerHeight: CGFloat
    /// The bottom edge of what is visible, in content coordinates (the offset, the viewport, the
    /// insets).
    var visibleMaxY: CGFloat

    func isAtBottom(threshold: CGFloat) -> Bool {
      visibleMaxY >= contentHeight - threshold
    }
  }

  /// The scroll view's phase, as far as these rules care.
  enum Phase: Equatable {
    case idle
    /// The reader's finger, trackpad or fling.
    case reader
    /// An animated scroll: the list's own (a command), or one the system ran for the reader
    /// (the keyboard, the scroller, an accessibility scroll).
    case animating
  }

  /// The list keeps the newest row in view as rows arrive and grow.
  private(set) var following = true
  /// The list moved the content itself (a command); the next offset change, or the animation that
  /// carries it, is its own.
  private(set) var listMoving = false
  private var phase = Phase.idle
  /// The animation now running was started by the list.
  private var animationIsList = false

  /// The list was told to go to the bottom: by the reader's own send, or the jump pill.
  mutating func commandedBottom() {
    following = true
    listMoving = true
  }

  /// The list was told to show a row: it stops following, as a reader who scrolled there would.
  mutating func commandedItem() {
    following = false
    listMoving = true
  }

  /// The scroll phase changed. `atBottom` is where the list is now.
  mutating func phaseChanged(to next: Phase, atBottom: Bool) {
    switch next {
    case .animating:
      animationIsList = listMoving
    case .reader:
      listMoving = false
      animationIsList = false
    case .idle:
      if phase == .animating && !animationIsList {
        // An animated scroll the list did not ask for (Page Up, the keyboard, an accessibility
        // scroll): where it ended is the reader's choice.
        following = atBottom
      }
      listMoving = false
      animationIsList = false
    }
    phase = next
  }

  /// The geometry moved from `old` to `new` during `phase`.
  mutating func geometryChanged(from old: Geometry, to new: Geometry, phase: Phase, threshold: CGFloat) {
    let atBottom = new.isAtBottom(threshold: threshold)

    switch phase {
    case .reader:
      // The reader is scrolling: they decide.
      following = atBottom
      listMoving = false
      return
    case .animating:
      // An animated scroll; whose it was, and where it lands, is decided when it ends.
      return
    case .idle:
      break
    }

    if listMoving {
      // The list's own unanimated jump.
      listMoving = false
      return
    }

    let resized = old.contentHeight != new.contentHeight || old.containerHeight != new.containerHeight
    if !resized {
      if old.offset != new.offset {
        // Only the offset moved and nothing explains it but the reader (the wheel, the keyboard,
        // the scroller).
        following = atBottom
      }
      return
    }

    // The rows or the viewport changed size: the anchor keeps the bottom while following. A
    // reader near the end of content that shrank under them is at the bottom again.
    if !following && atBottom {
      following = true
    }
  }

  /// The row to hold on to when the row the list was anchored to is gone: the nearest one after
  /// it that is still there, else the nearest before it. `old` is the order the anchor was taken
  /// in; `isPresent` says whether an id is in the new rows. Nil when none is left, or the anchor
  /// was not in `old`.
  static func survivor<ID: Hashable>(of anchor: ID, in old: [ID], isPresent: (ID) -> Bool) -> ID? {
    guard let index = old.firstIndex(of: anchor) else { return nil }
    if let later = old[index...].first(where: isPresent) { return later }
    return old[..<index].last(where: isPresent)
  }
}

/// Whether the collection-view list (iPhone, iPad) follows the newest row: the same rules as
/// `TranscriptFollow`, in the events UIKit gives.
///
/// The list follows (`pinned`) after a `.bottom` command (a send, the jump pill) until the
/// reader moves the content: their drag or fling, and any scroll the list did not start itself
/// (keyboard paging, VoiceOver's three-finger scroll, scrolling to a focused element, a tap on
/// the status bar). The end of the list's own animated scroll does not decide it: a bubble that
/// arrived while that animation ran must not unpin a send.
struct ListPinning: Equatable {
  private(set) var pinned = true
  /// The list itself is animating the offset (`setContentOffset(_:animated: true)`).
  private(set) var listAnimating = false

  /// The list scrolls to the bottom and follows from there.
  mutating func listScrollsToBottom(animated: Bool) {
    pinned = true
    listAnimating = animated
  }

  /// The list scrolls to a row and stops following there.
  mutating func listScrollsToRow(animated: Bool) {
    pinned = false
    listAnimating = animated
  }

  /// The offset moved, outside the list's own updates. `touching`: the reader's finger is on the
  /// list (tracking, dragging, decelerating), which takes over any animation the list began.
  mutating func offsetMoved(touching: Bool, atBottom: Bool) {
    if touching { listAnimating = false }
    guard !listAnimating else { return }
    pinned = atBottom
  }

  /// An animated scroll ended. Answers whether the list should put the bottom back exactly (its
  /// own scroll to the bottom, during which rows may have grown).
  mutating func scrollAnimationEnded(atBottom: Bool) -> Bool {
    if listAnimating {
      listAnimating = false
      return pinned
    }
    pinned = atBottom
    return false
  }

  /// The status bar was tapped and the list went to the top.
  mutating func scrolledToTop(atBottom: Bool) {
    listAnimating = false
    pinned = atBottom
  }
}
