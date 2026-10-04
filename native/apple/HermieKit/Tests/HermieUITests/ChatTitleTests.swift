import Foundation
import HermieCore
import HermieTranscript
import Testing

@testable import HermieUI

@MainActor
struct ChatTitleTests {
  @Test func aRunningToolIsNamedWithoutItsMCPPrefix() {
    #expect(ToolLabel.activityName("mcp__terminal") == "Terminal")
    #expect(ToolLabel.activityName("mcp__github__list_issues") == "Github · list issues")
    #expect(ToolLabel.activityName("read_file") == "Read file")
    #expect(ToolLabel.activityName("  terminal ") == "Terminal")
  }

  @Test func theSubtitleSaysTheToolTheWayTheRowsDo() {
    let presence = Presence.of(gatewayReady: true, sessionAttached: true, working: true, needsInput: false)
    let text = ChatTitle.text(activity: .tool("mcp__terminal"), presence: presence)
    #expect(text.contains("Terminal"))
    #expect(!text.contains("mcp__"))
  }

  @Test func theMacsPillHasRoomOnBothSidesAndAWidthItKeeps() {
    typealias Layout = ChatTitleView.Layout
    #expect(Layout.pillLeadingPadding >= 8)
    #expect(Layout.pillTrailingPadding >= 16, "the name touched the capsule's right edge")
    #expect(Layout.pillMinWidth >= 200)
    #expect(Layout.pillMinWidth <= Layout.pillIdealWidth)
    #expect(Layout.pillIdealWidth <= Layout.pillMaxWidth)
  }
}
