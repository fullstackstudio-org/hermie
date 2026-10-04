import SwiftUI
import Testing

@testable import HermieUI

/// A notice at the top of the root view, however long, leaves the window's minimum size as it is.
///
/// The notice stack (the launch's one-time notices and the router's refusals) wraps its text with
/// `fixedSize(vertical:)` like the composer's notice did, and SwiftUI measures a window's minimum at
/// the narrowest width it probes, where a long or unbreakable text takes a line every few letters.
/// The same guard as the composer's applies: at most `ComposerView.noticeLineLimit` lines, the whole
/// text in the tooltip.
@MainActor
@Suite(.serialized) struct NoticeStackLayoutTests {
  /// A notice with no place to break a line.
  nonisolated static let unbreakable = String(repeating: "x", count: 5000)
  nonisolated static let sentence = String(repeating: "This notice is a long sentence that says what happened. ", count: 100)

  @Test(arguments: [unbreakable, sentence])
  func aNoticeTakesAFewLinesAtAnyWidth(text: String) {
    let bare = ChatNoticeLayoutTests.height(of: NoticeRow(text: "Short", systemImage: "link.badge.plus") {}, width: 400)

    // A phone's width: a few lines. The narrowest width SwiftUI probes for a minimum, where every
    // letter takes a line: still a few lines, whatever the length of the text.
    for (width, limit) in [(CGFloat(400), CGFloat(160)), (1, 320)] {
      let height = ChatNoticeLayoutTests.height(
        of: NoticeRow(text: text, systemImage: "link.badge.plus") {}, width: width)
      #expect(height < limit, "at \(width) points the notice is \(height) points tall")
      #expect(height >= bare, "and never shorter than a short one (\(bare))")
    }
  }
}
