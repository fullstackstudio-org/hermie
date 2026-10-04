import CoreGraphics
import Testing

@testable import HermieUI

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

/// Heights that go stale (a row changed off screen, a text size change, a reused cell) and an
/// anchor whose row is gone.
@MainActor
@Suite struct TranscriptListStaleHeightTests {
  private func model(_ count: Int, height: CGFloat = 50, spacing: CGFloat = 10) -> TranscriptListLayoutModel<String> {
    var model = TranscriptListLayoutModel<String>()
    model.spacing = spacing
    model.estimatedHeight = height
    model.setWidth(320)
    model.setIDs((0..<count).map { "r\($0)" })
    return model
  }

  @Test func aRowChangedOffScreenIsMeasuredAgainBeforeItIsShownKeepingItsHeightUntilThen() {
    var model = model(5)
    model.setHeight(90, for: "r1")
    #expect(model.isMeasured("r1"))
    let tops = model.tops

    model.invalidate("r1")
    #expect(!model.isMeasured("r1"), "stale: the layout measures it before it comes into view")
    #expect(model.height(of: "r1") == 90, "its old height stands, so nothing around it moves yet")
    #expect(model.tops == tops)
    #expect(model.accepts(90, for: "r1"), "even the same height counts as its first measurement")

    model.setHeight(140, for: "r1")
    #expect(model.isMeasured("r1"))
    #expect(model.tops[2] == tops[2] + 50)
  }

  @Test func aTextSizeChangeForgetsEveryHeight() {
    var model = model(3)
    for id in ["r0", "r1", "r2"] { model.setHeight(70, for: id) }
    model.invalidateAll()
    #expect(["r0", "r1", "r2"].allSatisfy { !model.isMeasured($0) })
    #expect(model.height(of: "r2") == 70)
  }

  @Test func invalidatingARowNeverMeasuredChangesNothing() {
    var model = model(2)
    model.invalidate("r0")
    model.invalidate("nope")
    #expect(!model.isMeasured("r0"))
    #expect(model.height(of: "r0") == 50)
  }

  @Test func aRenamedAnchorRowIsReplacedByTheNearestRowStillThere() {
    // A page of history gives the tool group the reader was looking at an earlier call, and the
    // group's id with it: `tools:t5` becomes `tools:t4`.
    var model = model(4)
    let old = ["r0", "tools:t5", "r2", "r3"]
    model.setIDs(old)
    let anchor = TranscriptListLayoutModel<String>.Anchor(id: "tools:t5", offset: -12)
    model.setIDs(["h0", "h1", "r0", "tools:t4", "r2", "r3"])
    #expect(model.visibleTop(restoring: anchor) == nil, "the old id is gone")
    let top = model.visibleTop(restoring: anchor, previousIDs: old)
    #expect(top == model.frame(of: "r2")!.minY + 12, "r2, the next row still there, takes its place")
  }

  @Test func anAnchorStillThereIsRestoredAsBefore() {
    let model = model(4)
    let anchor = TranscriptListLayoutModel<String>.Anchor(id: "r2", offset: 5)
    #expect(model.visibleTop(restoring: anchor, previousIDs: model.ids) == model.visibleTop(restoring: anchor))
  }

  #if os(macOS)
    /// A row hosted the way a cell hosts it (`TranscriptRowReporting`), standing in for a reused
    /// cell: the same host shows another row.
    struct HostedRow: View {
      let id: String
      let height: CGFloat
      let report: (String, CGFloat) -> Void

      var body: some View {
        Color.clear
          .frame(height: height)
          .modifier(TranscriptRowReporting(id: id, report: { report(id, $0) }))
      }
    }

    @MainActor final class Reports {
      var all: [String] = []
    }

    @Test @MainActor func aReusedCellReportsItsNewRowsHeightEvenWhenItEqualsThePreviousOnes() async throws {
      let reports = Reports()
      let record: (String, CGFloat) -> Void = { id, height in reports.all.append("\(id):\(Int(height))") }
      let host = NSHostingView(rootView: HostedRow(id: "a", height: 44, report: record))
      host.frame = NSRect(x: 0, y: 0, width: 320, height: 200)
      let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = host
      defer { window.close() }
      host.layoutSubtreeIfNeeded()
      try await Task.sleep(for: .milliseconds(200))

      // The cell is reused for another row exactly as tall.
      host.rootView = HostedRow(id: "b", height: 44, report: record)
      host.layoutSubtreeIfNeeded()
      try await Task.sleep(for: .milliseconds(200))

      #expect(reports.all.contains("a:44"))
      #expect(reports.all.contains("b:44"), "the new occupant reported its height: \(reports.all)")
    }
  #endif
}
