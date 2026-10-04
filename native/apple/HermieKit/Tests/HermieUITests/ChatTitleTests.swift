import Foundation
import HermieCore
import HermieTranscript
import Testing

@testable import HermieUI

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
}
