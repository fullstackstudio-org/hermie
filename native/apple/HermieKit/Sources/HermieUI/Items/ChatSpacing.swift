import SwiftUI

/// The chat's spacing, in one place: how far a bubble sits from the window's edge, how far apart
/// messages stand, and how much room the words have inside their bubble.
///
/// Messages on iOS 26 and macOS 26 is the reference: bubbles of one run nearly touch, a new run
/// gets a clear step of air, and the words never sit tight against the bubble's edge. Everything
/// the transcript lays out reads these names, so the rhythm changes in one place and a test can
/// hold the one rule that matters, that a gap inside a group is plainly smaller than the gap
/// between groups.
enum ChatSpacing {
  /// The bubbles' distance from the window's left and right edges (the list itself runs edge to
  /// edge), and the composer's: the plus and the send button stand as far in as the bubbles beside
  /// them, and so do the notices over the composer and the line under the header. A Mac window has
  /// wide, round corners and is often wide itself: 20 there still read as the bubbles and the
  /// composer touching its edge (0.2.6).
  #if os(macOS)
    static let edgeMargin: CGFloat = 28
  #else
    static let edgeMargin: CGFloat = 16
  #endif

  /// Room under the newest row, on top of what the composer's own padding leaves (about 9-10 pt from
  /// the last meta line to the composer's edge, which read as touching it on the Mac, 0.2.7): the end
  /// of the list's content, so a list at its bottom stays pinned with the gap in place.
  #if os(macOS)
    static let transcriptTail: CGFloat = 10
  #else
    static let transcriptTail: CGFloat = 6
  #endif

  /// Between two bubbles of one group (same sender, no pause, nothing between them).
  static let withinGroup: CGFloat = 4

  /// Between one group and the next: the sender changes, or a tool group, a notice or a card stands between.
  static let betweenGroups: CGFloat = 16

  /// A bubble's inner padding, left and right of its words.
  static let bubbleInsetH: CGFloat = 14
  /// A bubble's inner padding, above and below its words.
  static let bubbleInsetV: CGFloat = 9

  /// Between a bubble and the time or the sending mark under it, and between a sender's name and its bubble.
  static let bubbleCaption: CGFloat = 4
  /// The caption's indent from the bubble's edge.
  static let captionInset: CGFloat = 6
}
