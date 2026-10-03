import CoreGraphics
import Foundation
import Testing

@testable import HermieUI

/// The rhythm of the chat: the owner's "more room between messages", held as numbers.
@Suite struct ChatSpacingTests {
  @Test func aGapInsideAGroupIsPlainlySmallerThanTheGapBetweenGroups() {
    #expect(ChatSpacing.withinGroup < ChatSpacing.betweenGroups)
    #expect(ChatSpacing.betweenGroups >= ChatSpacing.withinGroup * 3, "the grouping stays readable")
    #expect(ChatSpacing.groupGap + ChatSpacing.withinGroup == ChatSpacing.betweenGroups)
  }

  @Test func theTranscriptReadsTheTokensAndNothingElse() {
    #expect(ChatTranscript.rowSpacing == ChatSpacing.withinGroup)
    #expect(ChatTranscript.margin == ChatSpacing.edgeMargin)
    #expect(TranscriptItemView.groupGap == ChatSpacing.groupGap)
  }

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

  @Test func theBeadScalesWithTheAvatarSoLargeTextGrowsBothTogether() {
    let normal = PresenceGeometry(avatarSide: 44)
    let large = PresenceGeometry(avatarSide: 44 * 1.6)

    #expect(abs(large.dot / normal.dot - 1.6) < 0.0001)
    #expect(abs(normal.dot / 44 - 0.28) < 0.0001, "about a quarter of the avatar, as Messages draws it")
    #expect(PresenceGeometry(avatarSide: 20).dot == 9, "never a speck")
  }
}
