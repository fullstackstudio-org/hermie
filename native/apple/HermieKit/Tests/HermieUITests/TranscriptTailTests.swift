import SwiftUI
import Testing

@testable import HermieUI

struct TranscriptTailTests {
  @Test func theTailIsAddedToTheBottomInsetAndNothingElse() {
    let safeArea = EdgeInsets(top: 50, leading: 3, bottom: 90, trailing: 4)
    let insets = CollectionTranscriptHost<TestRow, Text>.insets(safeArea, tail: 10)
    #expect(insets.top == 50)
    #expect(insets.leading == 3)
    #expect(insets.trailing == 4)
    #expect(insets.bottom == 100)
  }

  @Test func theChatLeavesRoomUnderTheNewestRow() {
    #expect(ChatSpacing.transcriptTail > 0)
    // The Mac's last meta line stood about 10 pt above the composer: with the tail it is 16 to 20.
    #if os(macOS)
      #expect(ChatSpacing.transcriptTail >= 8)
    #endif
  }

  private struct TestRow: Identifiable, Equatable, Sendable {
    let id: Int
  }
}
