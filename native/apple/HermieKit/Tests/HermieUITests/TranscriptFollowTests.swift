import CoreGraphics
import Testing

@testable import HermieUI

/// The SwiftUI list's rules for following the newest row (`TranscriptFollow`): what the reader
/// does decides, the rows growing does not, and their own send always follows.
@Suite struct TranscriptFollowTests {
  private typealias Geometry = TranscriptFollow.Geometry
  private let threshold: CGFloat = 32

  /// A 600-point viewport over `content` points of rows, scrolled to `offset`.
  private func geometry(offset: CGFloat, content: CGFloat, container: CGFloat = 600) -> Geometry {
    Geometry(offset: offset, contentHeight: content, containerHeight: container, visibleMaxY: offset + container)
  }

  private func atBottom(content: CGFloat) -> Geometry {
    geometry(offset: content - 600, content: content)
  }

  @Test func aBubbleTallerThanTheThresholdKeepsTheListFollowing() {
    // The send's bubble (120 points) lands before the size-change anchor moved the offset: for one
    // update the list is 120 points from the bottom. Deciding from that update stopped following.
    var follow = TranscriptFollow()
    let before = atBottom(content: 2000)
    let grown = geometry(offset: before.offset, content: 2120)
    follow.geometryChanged(from: before, to: grown, phase: .idle, threshold: threshold)
    #expect(follow.following)

    // The reply streams in below.
    let reply = geometry(offset: grown.offset, content: 2400)
    follow.geometryChanged(from: grown, to: reply, phase: .idle, threshold: threshold)
    #expect(follow.following)
  }

  @Test func anIncomingMessageDoesNotMoveAReaderWhoScrolledUp() {
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let up = geometry(offset: 800, content: 2000)
    follow.phaseChanged(to: .reader, atBottom: true)
    follow.geometryChanged(from: bottom, to: up, phase: .reader, threshold: threshold)
    follow.phaseChanged(to: .idle, atBottom: false)
    #expect(!follow.following, "the reader scrolled away")

    // A message arrives below them, and a reply grows after it.
    let arrived = geometry(offset: 800, content: 2300)
    follow.geometryChanged(from: up, to: arrived, phase: .idle, threshold: threshold)
    let grown = geometry(offset: 800, content: 2900)
    follow.geometryChanged(from: arrived, to: grown, phase: .idle, threshold: threshold)
    #expect(!follow.following)
  }

  @Test func theReadersOwnSendFollowsFromWhereverTheyAre() {
    var follow = TranscriptFollow()
    let up = geometry(offset: 200, content: 3000)
    follow.geometryChanged(from: atBottom(content: 3000), to: up, phase: .idle, threshold: threshold)
    #expect(!follow.following, "the wheel took the reader up")

    follow.commandedBottom()
    #expect(follow.following)
    // The jump lands (one offset change of the list's own) and the bubble arrives after it.
    let landed = atBottom(content: 3000)
    follow.geometryChanged(from: up, to: landed, phase: .idle, threshold: threshold)
    let bubble = geometry(offset: landed.offset, content: 3110)
    follow.geometryChanged(from: landed, to: bubble, phase: .idle, threshold: threshold)
    #expect(follow.following)
  }

  @Test func theListsOwnAnimatedJumpIsNotTheReader() {
    var follow = TranscriptFollow()
    follow.geometryChanged(
      from: atBottom(content: 3000), to: geometry(offset: 100, content: 3000), phase: .idle, threshold: threshold)
    follow.commandedBottom()
    follow.phaseChanged(to: .animating, atBottom: false)
    // Halfway down, far from the bottom: still following.
    let halfway = geometry(offset: 1200, content: 3000)
    follow.geometryChanged(
      from: geometry(offset: 100, content: 3000), to: halfway, phase: .animating, threshold: threshold)
    #expect(follow.following)
    // The animation ends short of the bottom, a bubble having grown the content meanwhile.
    follow.phaseChanged(to: .idle, atBottom: false)
    #expect(follow.following, "the list's own scroll to the bottom keeps following")
  }

  @Test func anAnimatedScrollTheListDidNotStartIsTheReaders() {
    // Page Up, the keyboard, an accessibility scroll: animated, and not the list's.
    var follow = TranscriptFollow()
    follow.phaseChanged(to: .animating, atBottom: true)
    follow.geometryChanged(
      from: atBottom(content: 3000), to: geometry(offset: 1800, content: 3000), phase: .animating, threshold: threshold)
    #expect(follow.following, "undecided while it runs")
    follow.phaseChanged(to: .idle, atBottom: false)
    #expect(!follow.following, "it ended away from the bottom: the list stops following")

    // And one that ends at the bottom follows again.
    follow.phaseChanged(to: .animating, atBottom: false)
    follow.phaseChanged(to: .idle, atBottom: true)
    #expect(follow.following)
  }

  @Test func theWheelOrTheKeyboardDecideWithoutAPhase() {
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let up = geometry(offset: bottom.offset - 300, content: 2000)
    follow.geometryChanged(from: bottom, to: up, phase: .idle, threshold: threshold)
    #expect(!follow.following)
    let back = atBottom(content: 2000)
    follow.geometryChanged(from: up, to: back, phase: .idle, threshold: threshold)
    #expect(follow.following, "scrolled back to the end, following again")
  }

  @Test func showingARowStopsFollowing() {
    var follow = TranscriptFollow()
    follow.commandedItem()
    #expect(!follow.following)
    let jumped = geometry(offset: 500, content: 3000)
    follow.geometryChanged(from: atBottom(content: 3000), to: jumped, phase: .idle, threshold: threshold)
    let grown = geometry(offset: 500, content: 3200)
    follow.geometryChanged(from: jumped, to: grown, phase: .idle, threshold: threshold)
    #expect(!follow.following)
  }

  @Test func aViewportThatShrinksWhileFollowingStillFollows() {
    // The composer grows a line, or the keyboard comes up: the container shrinks.
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let shorter = Geometry(offset: bottom.offset, contentHeight: 2000, containerHeight: 520, visibleMaxY: bottom.offset + 520)
    follow.geometryChanged(from: bottom, to: shorter, phase: .idle, threshold: threshold)
    #expect(follow.following)
  }

  // MARK: The row to hold on to

  @Test func theNearestRowAfterAGoneAnchorTakesItsPlaceElseTheNearestBefore() {
    let old = ["a", "b", "tools:c", "d", "e"]
    #expect(TranscriptFollow.survivor(of: "tools:c", in: old, isPresent: { $0 != "tools:c" }) == "d")
    #expect(TranscriptFollow.survivor(of: "d", in: old, isPresent: { ["a", "b"].contains($0) }) == "b")
    #expect(TranscriptFollow.survivor(of: "b", in: old, isPresent: { _ in false }) == nil)
    #expect(TranscriptFollow.survivor(of: "zz", in: old, isPresent: { _ in true }) == nil, "not in the old order")
    #expect(TranscriptFollow.survivor(of: "b", in: old, isPresent: { _ in true }) == "b", "still there: itself")
  }
}

/// The collection-view list's rules (`ListPinning`): the same as the SwiftUI list's, in UIKit's
/// events.
@Suite struct ListPinningTests {
  @Test func theListsOwnScrollToTheBottomKeepsFollowingWhereverItEnds() {
    var pinning = ListPinning()
    pinning.offsetMoved(touching: true, atBottom: false)
    #expect(!pinning.pinned)

    pinning.listScrollsToBottom(animated: true)
    #expect(pinning.pinned)
    // The animation's own steps are not the reader's.
    pinning.offsetMoved(touching: false, atBottom: false)
    #expect(pinning.pinned)
    // It ends short of the bottom (a bubble grew meanwhile): put the bottom back.
    let ended = pinning.scrollAnimationEnded(atBottom: false)
    #expect(ended)
    #expect(pinning.pinned)
  }

  @Test func keyboardPagingAndVoiceOverScrollsAreTheReaders() {
    // Before, every animated scroll counted as the list's, and these snapped back to the bottom.
    var pinning = ListPinning()
    pinning.offsetMoved(touching: false, atBottom: false)
    #expect(!pinning.pinned, "a scroll the list did not start unpins as it moves")
    let ended = pinning.scrollAnimationEnded(atBottom: false)
    #expect(!ended, "and nothing puts the bottom back")
    #expect(!pinning.pinned)

    pinning.offsetMoved(touching: false, atBottom: true)
    let endedAgain = pinning.scrollAnimationEnded(atBottom: true)
    #expect(!endedAgain)
    #expect(pinning.pinned, "paged back down to the end: following again")
  }

  @Test func aTapOnTheStatusBarUnpins() {
    var pinning = ListPinning()
    pinning.scrolledToTop(atBottom: false)
    #expect(!pinning.pinned)
  }

  @Test func theReadersFingerTakesOverTheListsAnimation() {
    var pinning = ListPinning()
    pinning.listScrollsToBottom(animated: true)
    pinning.offsetMoved(touching: true, atBottom: false)
    #expect(!pinning.pinned)
    let ended = pinning.scrollAnimationEnded(atBottom: false)
    #expect(!ended)
  }

  @Test func showingARowUnpinsAndItsAnimationDoesNotRepin() {
    var pinning = ListPinning()
    pinning.listScrollsToRow(animated: true)
    #expect(!pinning.pinned)
    pinning.offsetMoved(touching: false, atBottom: true)
    #expect(!pinning.pinned, "passing the bottom during the list's own scroll")
    let ended = pinning.scrollAnimationEnded(atBottom: false)
    #expect(!ended)
  }
}
