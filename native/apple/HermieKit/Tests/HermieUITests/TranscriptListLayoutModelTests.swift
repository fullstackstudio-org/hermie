import CoreGraphics
import Testing

@testable import HermieUI

@MainActor
@Suite struct TranscriptListLayoutModelTests {
  private func model(_ count: Int, height: CGFloat = 50, spacing: CGFloat = 10) -> TranscriptListLayoutModel<String> {
    var model = TranscriptListLayoutModel<String>()
    model.spacing = spacing
    model.estimatedHeight = height
    model.setWidth(320)
    model.setIDs((0..<count).map { "r\($0)" })
    return model
  }

  @Test func rowsStackWithSpacing() {
    let model = model(3)
    #expect(model.tops == [0, 60, 120])
    #expect(model.contentHeight == 170)
    #expect(model.frame(at: 1) == CGRect(x: 0, y: 60, width: 320, height: 50))
  }

  @Test func aHeightChangeMovesOnlyTheRowsBelow() {
    var model = model(4)
    let delta = model.setHeight(80, for: "r1")
    #expect(delta == 30)
    #expect(model.tops == [0, 60, 150, 210])
    #expect(model.contentHeight == 260)
    var fresh = model
    fresh.recompute()
    #expect(fresh.tops == model.tops)
  }

  @Test func binarySearchFindsTheRowsInARect() {
    let model = model(100)
    #expect(model.firstPosition(endingBelow: 0) == 0)
    #expect(model.firstPosition(endingBelow: 55) == 1)
    #expect(model.positions(intersecting: 115, 245) == 2..<5)
    #expect(model.positions(intersecting: 100_000, 100_100).isEmpty)
  }

  @Test func heightsSurviveAPrependAndTheAnchorComesBackToThePoint() {
    var model = model(50)
    for index in 0..<50 { model.setHeight(CGFloat(30 + index % 7 * 11), for: "r\(index)") }
    let visibleTop: CGFloat = 1234.5
    let anchor = model.anchor(visibleTop: visibleTop)!
    let before = model.frame(of: anchor.id)!

    model.setIDs((0..<200).map { "old\($0)" } + (0..<50).map { "r\($0)" })
    let restored = model.visibleTop(restoring: anchor)!
    let after = model.frame(of: anchor.id)!
    #expect(after.height == before.height, "the anchor kept its measured height")
    #expect(after.minY - restored == before.minY - visibleTop, "the anchor sits where it sat")
  }

  @Test func onlyARowAboveTheViewportMovesTheOffset() {
    var model = model(20)
    let visibleTop: CGFloat = 300  // rows 0...4 start above, row 5 (top 300) does not
    _ = model.setHeight(70, for: "r2")
    #expect(model.offsetAdjustment(forRowAt: 2, delta: 20, visibleTop: visibleTop, pinnedToBottom: false) == 20)
    _ = model.setHeight(70, for: "r8")
    #expect(model.offsetAdjustment(forRowAt: 8, delta: 20, visibleTop: visibleTop + 20, pinnedToBottom: false) == 0)
    #expect(model.offsetAdjustment(forRowAt: 8, delta: 20, visibleTop: visibleTop, pinnedToBottom: true) == 20)
  }

  @Test func aRowMeasuredAtAnotherWidthIsOnlyAnEstimate() {
    var model = model(2)
    model.setHeight(90, for: "r0")
    #expect(model.isMeasured("r0"))
    model.setWidth(500)
    #expect(!model.isMeasured("r0"))
    #expect(model.height(of: "r0") == 90)
  }
}
