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
    #expect(follow.geometryChanged(from: before, to: grown, phase: .idle, threshold: threshold) == .keepBottom)
    #expect(follow.following)

    // The reply streams in below; each delta that the anchor did not keep is brought back.
    let reply = geometry(offset: grown.offset, content: 2400)
    #expect(follow.geometryChanged(from: grown, to: reply, phase: .idle, threshold: threshold) == .keepBottom)
    #expect(follow.following)

    // Kept by the anchor: nothing to do.
    let kept = atBottom(content: 2450)
    #expect(follow.geometryChanged(from: reply, to: kept, phase: .idle, threshold: threshold) == .none)
    #expect(follow.following)
  }

  @Test func anIncomingMessageDoesNotMoveAReaderWhoScrolledUp() {
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let up = geometry(offset: 800, content: 2000)
    follow.phaseChanged(to: .reader)
    #expect(follow.geometryChanged(from: bottom, to: up, phase: .reader, threshold: threshold) == .none)
    follow.phaseChanged(to: .idle)
    #expect(!follow.following, "the reader scrolled away")

    // A message arrives below them, and a reply grows after it.
    let arrived = geometry(offset: 800, content: 2300)
    #expect(follow.geometryChanged(from: up, to: arrived, phase: .idle, threshold: threshold) == .none)
    let grown = geometry(offset: 800, content: 2900)
    #expect(follow.geometryChanged(from: arrived, to: grown, phase: .idle, threshold: threshold) == .none)
    #expect(!follow.following)
  }

  @Test func theReadersOwnSendFollowsFromWhereverTheyAre() {
    var follow = TranscriptFollow()
    let up = geometry(offset: 200, content: 3000)
    #expect(follow.geometryChanged(from: atBottom(content: 3000), to: up, phase: .idle, threshold: threshold) == .none)
    #expect(!follow.following, "the wheel took the reader up")

    follow.commandedBottom()
    #expect(follow.following)
    // The jump lands (one offset change of the list's own) and the bubble arrives after it.
    let landed = atBottom(content: 3000)
    #expect(follow.geometryChanged(from: up, to: landed, phase: .idle, threshold: threshold) == .none)
    let bubble = geometry(offset: landed.offset, content: 3110)
    #expect(follow.geometryChanged(from: landed, to: bubble, phase: .idle, threshold: threshold) == .keepBottom)
    #expect(follow.following)
  }

  @Test func theListsOwnAnimatedJumpIsNotTheReader() {
    var follow = TranscriptFollow()
    _ = follow.geometryChanged(
      from: atBottom(content: 3000), to: geometry(offset: 100, content: 3000), phase: .idle, threshold: threshold)
    follow.commandedBottom()
    follow.phaseChanged(to: .animating)
    // Halfway down, far from the bottom: still following.
    let halfway = geometry(offset: 1200, content: 3000)
    #expect(
      follow.geometryChanged(from: geometry(offset: 100, content: 3000), to: halfway, phase: .animating, threshold: threshold)
        == .none)
    #expect(follow.following)
    follow.phaseChanged(to: .idle)
    #expect(follow.following)
  }

  @Test func theWheelOrTheKeyboardDecideWithoutAPhase() {
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let up = geometry(offset: bottom.offset - 300, content: 2000)
    _ = follow.geometryChanged(from: bottom, to: up, phase: .idle, threshold: threshold)
    #expect(!follow.following)
    let back = atBottom(content: 2000)
    _ = follow.geometryChanged(from: up, to: back, phase: .idle, threshold: threshold)
    #expect(follow.following, "scrolled back to the end, following again")
  }

  @Test func showingARowStopsFollowing() {
    var follow = TranscriptFollow()
    follow.commandedItem()
    #expect(!follow.following)
    let jumped = geometry(offset: 500, content: 3000)
    _ = follow.geometryChanged(from: atBottom(content: 3000), to: jumped, phase: .idle, threshold: threshold)
    let grown = geometry(offset: 500, content: 3200)
    #expect(follow.geometryChanged(from: jumped, to: grown, phase: .idle, threshold: threshold) == .none)
  }

  @Test func aViewportThatShrinksWhileFollowingKeepsTheBottom() {
    // The composer grows a line, or the keyboard comes up: the container shrinks.
    var follow = TranscriptFollow()
    let bottom = atBottom(content: 2000)
    let shorter = Geometry(offset: bottom.offset, contentHeight: 2000, containerHeight: 520, visibleMaxY: bottom.offset + 520)
    #expect(follow.geometryChanged(from: bottom, to: shorter, phase: .idle, threshold: threshold) == .keepBottom)
    #expect(follow.following)
  }
}
