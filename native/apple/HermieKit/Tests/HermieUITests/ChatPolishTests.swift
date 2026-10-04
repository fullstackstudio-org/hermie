import CoreGraphics
import Foundation
import Testing

@testable import HermieUI

/// The rhythm of the chat: the owner's "more room between messages", held as numbers.
@MainActor
@Suite struct ChatSpacingTests {
  @Test func aGapInsideAGroupIsPlainlySmallerThanTheGapBetweenGroups() {
    #expect(ChatSpacing.withinGroup < ChatSpacing.betweenGroups)
    #expect(ChatSpacing.betweenGroups >= ChatSpacing.withinGroup * 3, "the grouping stays readable")
  }

  @Test func theTranscriptReadsTheTokensAndNothingElse() {
    #expect(ChatTranscript.rowSpacing == 0, "each row carries its own room, so a row that draws nothing takes none")
    #expect(TranscriptItemView.Gaps.chat == TranscriptItemView.Gaps(within: ChatSpacing.withinGroup, between: ChatSpacing.betweenGroups))
    #expect(ChatTranscript.margin == ChatSpacing.edgeMargin)
  }

  @Test func theComposerStandsAsFarFromTheEdgeAsTheBubbles() {
    // 0.2.6 on the Mac: the bubbles 20 points in, the plus and the stop button 12.
    #expect(ComposerView.edgeInset == ChatSpacing.edgeMargin)
  }

  #if os(macOS)
    @Test func theMacsWindowEdgeHasMoreRoomThanTheBuildTheOwnerFoundTight() {
      // 0.2.6: 20 points read as the bubbles and the composer touching a wide window's edge.
      #expect(ChatSpacing.edgeMargin > 20)
    }
  #endif

  @Test func theRoomIsMoreThanTheBuildTheOwnerFoundCramped() {
    // 0.2.3: 2 points between bubbles of a group, 10 between groups, 12 from the window's edge, and
    // a bubble padded 13 by 8.
    #expect(ChatSpacing.withinGroup > 2)
    #expect(ChatSpacing.betweenGroups > 10)
    #expect(ChatSpacing.edgeMargin > 12)
    #expect(ChatSpacing.bubbleInsetH > 13)
    #expect(ChatSpacing.bubbleInsetV > 8)
  }

  @Test func theWordsHaveMoreRoomSideways_ThanAboveAndBelow() {
    #expect(ChatSpacing.bubbleInsetH > ChatSpacing.bubbleInsetV)
  }
}

/// Where the state bead sits on an avatar, and how big.
@Suite struct PresenceGeometryTests {
  @Test(arguments: [28, 36, 44, 60, 70] as [CGFloat])
  func theBeadIsCentredOnTheAvatarsCircleAtTheBottomRight(side: CGFloat) {
    let geometry = PresenceGeometry(avatarSide: side)
    let centre = CGPoint(x: side / 2, y: side / 2)
    let distance = hypot(geometry.center.x - centre.x, geometry.center.y - centre.y)

    #expect(abs(distance - side / 2) < 0.0001, "on the circle's edge")
    #expect(geometry.center.x > centre.x && geometry.center.y > centre.y, "bottom-right")
    #expect(abs((geometry.center.x - centre.x) - (geometry.center.y - centre.y)) < 0.0001, "at 45 degrees")
  }

  @Test(arguments: [36, 44, 60, 70] as [CGFloat])
  func theBeadFitsInsideTheAvatarsFrameAndTheBiteIsItAndARingAllRound(side: CGFloat) {
    let geometry = PresenceGeometry(avatarSide: side)

    #expect(geometry.center.x + geometry.dot / 2 <= side + 0.0001)
    #expect(geometry.center.y + geometry.dot / 2 <= side + 0.0001)
    #expect(abs(geometry.cutout - (geometry.dot + geometry.ring * 2)) < 0.0001)
    #expect(geometry.ring >= 2)
  }

  @Test func theAvatarIsACircleWithABiteTakenOutOnlyWhenThereIsABead() {
    let side: CGFloat = 44
    let frame = CGRect(x: 0, y: 0, width: side, height: side)
    let geometry = PresenceGeometry(avatarSide: side)
    let plain = AvatarShape(bite: nil).path(in: frame)
    let bitten = AvatarShape(bite: geometry).path(in: frame)

    #expect(plain.contains(CGPoint(x: side / 2, y: side / 2)))
    #expect(plain.contains(geometry.center), "no bead: nothing is cut")
    #expect(!plain.contains(CGPoint(x: 1, y: 1)), "a circle, not its square")

    #expect(bitten.contains(CGPoint(x: side / 2, y: side / 2)), "the picture stays")
    #expect(!bitten.contains(geometry.center), "the bite is empty")
    #expect(!bitten.contains(CGPoint(x: geometry.center.x - geometry.dot / 2 - geometry.ring / 2, y: geometry.center.y)), "and wide enough for the ring")
    #expect(!bitten.contains(CGPoint(x: side - 1, y: side - 1)), "the corner outside the circle stays empty")
    #expect(bitten.contains(CGPoint(x: side / 2, y: 2)), "the rest of the circle is whole")
  }

  @Test func theBeadScalesWithTheAvatarSoLargeTextGrowsBothTogether() {
    let normal = PresenceGeometry(avatarSide: 44)
    let large = PresenceGeometry(avatarSide: 44 * 1.6)

    #expect(abs(large.dot / normal.dot - 1.6) < 0.0001)
    #expect(abs(normal.dot / 44 - 0.28) < 0.0001, "about a quarter of the avatar, as Messages draws it")
    #expect(PresenceGeometry(avatarSide: 20).dot == 9, "never a speck")
  }
}
