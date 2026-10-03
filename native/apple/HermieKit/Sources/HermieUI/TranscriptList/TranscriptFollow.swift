import CoreGraphics

/// Whether the SwiftUI transcript list keeps the newest row in view, decided from what moved the
/// content: the reader, the list itself, or the rows growing.
///
/// "At the bottom" as geometry is not enough to decide it. When a send appends a bubble taller
/// than the threshold, the content grows before the size-change anchor has moved the offset, so
/// for one geometry update the list is no longer within the threshold of the bottom. Deciding
/// "follow" from that update stopped the following there, and the bubble and the reply after it
/// stayed below the composer. So the list follows until the reader takes it away: only a move of
/// the offset that nothing else explains (a drag, a fling, the wheel, the keyboard, the scroller)
/// changes it, and growth while following is brought back to the bottom.
///
/// A plain value, so the rules are tested without a scroll view (`TranscriptFollowTests`); the
/// collection-view list keeps the same rule as its own `pinned`.
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
    /// An animated scroll the list started.
    case animating
  }

  /// What the list should do after a change.
  enum Action: Equatable {
    case none
    /// Scroll to the bottom, unanimated: the rows grew while following.
    case keepBottom
  }

  /// The list keeps the newest row in view as rows arrive and grow.
  private(set) var following = true
  /// The list moved the content itself (a command); the next offset change is its own.
  private(set) var listMoving = false

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

  mutating func phaseChanged(to phase: Phase) {
    switch phase {
    case .reader, .idle:
      listMoving = false
    case .animating:
      break
    }
  }

  /// The geometry moved from `old` to `new` during `phase`.
  mutating func geometryChanged(from old: Geometry, to new: Geometry, phase: Phase, threshold: CGFloat) -> Action {
    let atBottom = new.isAtBottom(threshold: threshold)

    switch phase {
    case .reader:
      // The reader is scrolling: they decide.
      following = atBottom
      listMoving = false
      return .none
    case .animating:
      // The list's own animated scroll; where it lands is decided when it ends.
      return .none
    case .idle:
      break
    }

    if listMoving {
      listMoving = false
      return following && !atBottom ? .keepBottom : .none
    }

    let resized = old.contentHeight != new.contentHeight || old.containerHeight != new.containerHeight
    if !resized {
      if old.offset != new.offset {
        // Only the offset moved and nothing explains it but the reader (the wheel, the keyboard,
        // the scroller).
        following = atBottom
      }
      return .none
    }

    // The rows or the viewport changed size.
    if following {
      return atBottom ? .none : .keepBottom
    }
    if atBottom {
      // Content that shrank under a reader near its end: they are at the bottom again.
      following = true
    }
    return .none
  }
}
