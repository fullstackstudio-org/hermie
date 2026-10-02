import HermieTranscript
import SwiftUI
import Testing

@testable import HermieUI

/// Every gallery sample in every presentation, at the default text size and at
/// AX5, rendered at an iPhone's width. A crash, an empty image or a row that
/// draws nothing where it should is a failure here before it is one on screen.
@MainActor
@Suite struct TranscriptItemViewTests {
  @Test(arguments: [DynamicTypeSize.large, .accessibility5])
  func everySampleRendersInEveryPresentation(size: DynamicTypeSize) throws {
    for sample in GallerySample.all {
      for presentation in Presentation.allCases {
        let renderer = ImageRenderer(
          content: TranscriptItemView(row: sample.row(presentation))
            .frame(width: 390)
            .dynamicTypeSize(size)
        )
        renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
        let image = renderer.cgImage
        let drawsNothing = presentation == .hiddenPlaceholder && !Self.drawsWhenHidden(sample.item)
        if drawsNothing {
          continue
        }
        let height = try #require(image, "\(sample.title) as \(presentation) did not render").height
        #expect(height > 0, "\(sample.title) as \(presentation) drew nothing")
      }
    }
  }

  @Test func theStreamingRowIsTheOnlyUnequalOne() {
    var generator = SyntheticTranscript(seed: 1)
    var state = generator.chat(count: 200)
    let replyID = generator.beginReply(in: &state)
    var builder = TranscriptRowBuilder()
    let options = VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true)
    // The first token makes the empty reply visible; the comparison is between
    // two later states.
    state.items[replyID]?.updateAssistant {
      $0.text = "Hello"
      $0.version += 1
    }
    let before = builder.rows(for: visibleItems(state, options))
    state.items[replyID]?.updateAssistant {
      $0.text += generator.delta()
      $0.version += 1
    }
    let after = builder.rows(for: visibleItems(state, options))
    #expect(before.count == after.count)
    let changed = zip(before, after).filter { $0 != $1 }.map(\.0.id)
    #expect(changed == [replyID])
  }

  /// Approvals and clarifies are always drawn (the selectors never hide them).
  private static func drawsWhenHidden(_ item: TranscriptItem) -> Bool {
    switch item {
    case .approval, .clarify, .cronDelivery: true
    default: false
    }
  }
}
