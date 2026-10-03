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
  /// The bubbles' distance from the window's left and right edges (the list itself runs edge to edge).
  #if os(macOS)
    static let edgeMargin: CGFloat = 20
  #else
    static let edgeMargin: CGFloat = 16
  #endif

  /// Between two bubbles of one group (same sender, no pause, nothing between them).
  static let withinGroup: CGFloat = 4

  /// Between one group and the next: the sender changes, or a tool group, a notice or a card stands between.
  static let betweenGroups: CGFloat = 16

  /// The room a row that opens a group adds above itself, on top of the list's own `withinGroup`
  /// spacing between rows.
  static let groupGap: CGFloat = betweenGroups - withinGroup

  /// A bubble's inner padding, left and right of its words.
  static let bubbleInsetH: CGFloat = 14
  /// A bubble's inner padding, above and below its words.
  static let bubbleInsetV: CGFloat = 9

  /// Between a bubble and the time or the sending mark under it, and between a sender's name and its bubble.
  static let bubbleCaption: CGFloat = 4
  /// The caption's indent from the bubble's edge.
  static let captionInset: CGFloat = 6
}
