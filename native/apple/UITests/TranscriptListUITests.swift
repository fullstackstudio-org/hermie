import XCTest

/// The transcript list spike's measurements and the item gallery's checks, run
/// against the `HermieLab` host (`scripts/test.sh --ui`). The numbers they
/// print are the ones in docs/native.md, "Transcript list".
@MainActor
final class TranscriptListUITests: XCTestCase {
  override func setUp() async throws {
    continueAfterFailure = false
  }

  // MARK: - (b) prepend without a jump

  func testPrependingHistoryKeepsTheAnchoredRowInPlace() throws {
    continueAfterFailure = true
    let app = launch(screen: "lab")
    waitForReport(app, containing: "rows")

    // Mid-list, by the reader's own scrolling: the way history is loaded (the
    // list asks for it when the reader nears the top).
    let list = app.scrollViews["transcript.list"]
    for _ in 0..<4 { scrollUp(list) }
    settle(seconds: 2)
    let moved = try prependDelta(app, label: "after the reader scrolled")
    XCTAssertLessThanOrEqual(abs(moved), 1, "the anchored row moved \(moved) pt on prepend")

    // Mid-list by a scroll command, then a prepend forced at once. The list
    // never asks for history in this state (it waits for the reader to scroll),
    // so this is recorded, not asserted: it is the known limit of the SwiftUI
    // list, written up in docs/native.md.
    app.buttons["lab.middle"].tap()
    settle()
    _ = try prependDelta(app, label: "forced straight after a scroll command")
  }

  /// Prepends 200 rows and returns how far a row in the middle of the screen
  /// moved, in points.
  private func prependDelta(_ app: XCUIApplication, label: String) throws -> CGFloat {
    let list = app.scrollViews["transcript.list"].frame
    let before = try rowFrames(app)
    let anchor = try XCTUnwrap(
      before.filter { $0.value.minY > list.minY + 140 && $0.value.minY < list.maxY - 60 }
        .min { abs($0.value.midY - list.midY) < abs($1.value.midY - list.midY) },
      "no row on screen: \(before.count) rows in \(list), \(before.values.map(\.minY).sorted())")
    app.buttons["lab.prepend"].tap()
    record("prepend 200 (\(label)): \(waitForReport(app, containing: "after prepend"))")
    settle()
    let after = try rowFrames(app)
    let moved = before.compactMap { id, frame in after[id].map { (id, $0.minY - frame.minY) } }
    record(
      "prepend 200 (\(label)), id:Δy of every row on screen before and after = "
        + moved.sorted { $0.0 < $1.0 }.map { "\($0.0):\(String(format: "%.1f", $0.1))" }.joined(separator: " "))
    guard let newFrame = after[anchor.key] else {
      record("prepend 200 (\(label)): \(anchor.key) left the screen")
      return .infinity
    }
    let delta = newFrame.minY - anchor.value.minY
    record("prepend 200 (\(label)): \(anchor.key) moved \(delta) pt (y \(anchor.value.minY) → \(newFrame.minY))")
    return delta
  }

  /// The frame of every row in one accessibility snapshot.
  private func rowFrames(_ app: XCUIApplication) throws -> [String: CGRect] {
    var frames: [String: CGRect] = [:]
    func walk(_ node: any XCUIElementSnapshot) {
      if node.identifier.hasPrefix("row."), node.frame.height > 0 {
        frames[node.identifier] = node.frame
        return
      }
      node.children.forEach(walk)
    }
    walk(try app.scrollViews["transcript.list"].snapshot())
    return frames
  }

  // MARK: - (c) a delta re-renders the streaming row only

  func testStreamedDeltasReRenderOnlyTheStreamingRow() throws {
    let app = launch(screen: "lab")
    record("loaded: \(waitForReport(app, containing: "footprint"))")
    app.buttons["lab.renderTest"].tap()
    let report = waitForReport(app, containing: "re-rendered", timeout: 120)
    record(report)
    let rerendered = try XCTUnwrap(number(after: "re-rendered ", in: report))
    let streaming = try XCTUnwrap(number(after: "streaming row bodies ", in: report))
    let onScreen = try XCTUnwrap(number(after: "rows on screen before ", in: report))
    XCTAssertGreaterThan(onScreen, 3, "the test needs rows on screen to mean anything")
    XCTAssertGreaterThan(streaming, 0, "the streaming row never re-rendered")
    XCTAssertEqual(rerendered, 0, "rows that did not change were evaluated again")
  }

  // MARK: - (a)/(d) scrolling while a reply streams

  func testScrollingWhileAReplyStreams() throws {
    let app = launch(screen: "lab", arguments: ["-HermieLabStream", "YES"])
    waitForReport(app, containing: "rows")
    let list = app.scrollViews["transcript.list"]
    app.buttons["lab.meter"].tap()

    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTHitchMetric(application: app)], options: options) {
      // About 7 s of scrolling up and down per iteration, 20 s or so in all,
      // while 30 deltas a second arrive.
      for _ in 0..<3 {
        scrollUp(list)
        scrollUp(list)
        scrollDown(list)
        scrollDown(list)
      }
    }

    app.buttons["lab.meter"].tap()
    record("in-app meter: \(waitForReport(app, containing: "hitch"))")
  }

  // MARK: - The gallery

  func testGalleryPassesTheAccessibilityAudit() throws {
    let app = launch(screen: "gallery")
    try auditWhileScrolling(app, pages: 14)
    app.switches["gallery.ax5"].tap()
    try auditWhileScrolling(app, pages: 6)
  }

  func testClarifyCardIsAnsweredThroughItsControls() throws {
    // Only the open clarify sample, so its first card is on screen.
    let app = launch(screen: "gallery", arguments: ["-HermieGallerySample", "Clarify, open"])
    let option = app.buttons["clarify.option.Amsterdam"].firstMatch
    XCTAssertTrue(option.waitForExistence(timeout: 10))
    option.tap()
    app.buttons[Self.next].firstMatch.tap()
    app.buttons["clarify.option.Luggage"].firstMatch.tap()
    app.buttons[Self.next].firstMatch.tap()
    let field = app.textFields["clarify.freeText"].firstMatch
    field.tap()
    field.typeText("Window seat")
    app.buttons["clarify.submit"].firstMatch.tap()
    let log = app.staticTexts["gallery.log"]
    let expectation = expectation(for: Self.contains("q1=Amsterdam, q2=Luggage, q3=Window seat"), evaluatedWith: log)
    wait(for: [expectation], timeout: 5)
  }

  // MARK: - Helpers

  private func launch(screen: String, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-HermieLabScreen", screen] + arguments
    // A knob from the spike: TEST_RUNNER_HERMIE_LAB_MIDDLE_ANCHOR=top|bottom
    // changes where the lab's "Middle" command puts its row.
    if let anchor = ProcessInfo.processInfo.environment["HERMIE_LAB_MIDDLE_ANCHOR"] {
      app.launchArguments += ["-HermieLabMiddleAnchor", anchor]
    }
    app.launch()
    return app
  }

  @discardableResult
  private func waitForReport(_ app: XCUIApplication, containing text: String, timeout: TimeInterval = 30) -> String {
    let report = app.staticTexts["lab.report"]
    let found = expectation(for: Self.contains(text), evaluatedWith: report)
    wait(for: [found], timeout: timeout)
    return Self.text(of: report)
  }

  /// The clarify card's "Next", by identifier, whatever the language.
  private static let next = "clarify.next"

  /// Audits a screenful, scrolls on, and again. Every issue is recorded with
  /// the element it is about before the test fails on it.
  private func auditWhileScrolling(_ app: XCUIApplication, pages: Int) throws {
    let gallery = app.scrollViews.firstMatch
    var issues: [String] = []
    for page in 0..<pages {
      let visible = gallery.frame
      try app.performAccessibilityAudit { issue in
        let element = issue.element.map { "\($0.elementType.rawValue) '\($0.identifier)' '\($0.label)'" } ?? "-"
        let line = "page \(page): \(issue.compactDescription) on \(element)"
        // An element only partly inside the scroll view is measured against
        // the edge that clips it; it is audited whole on the next page.
        let clipped = issue.auditType == .contrast && issue.element.map { !visible.contains($0.frame) } == true
        if clipped || Self.toleratedAuditIssue(issue) {
          self.record("audit (tolerated) \(line)")
        } else {
          // Collected and failed on below, so one run lists every page's issues.
          issues.append(line)
        }
        return true
      }
      scrollDown(gallery, distance: 0.8)
    }
    issues.forEach { record("audit \($0)") }
    XCTAssertEqual(issues, [], "the accessibility audit found issues")
  }

  /// Two of the three audit findings the test records but does not fail on
  /// (docs/native.md, "Transcript list"):
  ///
  /// - the Dynamic Type check, which on this toolchain reports "partially
  ///   unsupported" for every text including a system `Toggle`'s label; AX5 is
  ///   covered by `TranscriptItemViewTests`, which renders every sample at AX5;
  /// - "Contrast nearly passed", which is the system's own `.secondary` label
  ///   colour (above 3:1, under 4.5:1). "Contrast failed" still fails.
  private static func toleratedAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
    #if os(iOS)
      // The Dynamic Type audit exists on iOS only.
      if issue.auditType == .dynamicType { return true }
    #endif
    return issue.auditType == .contrast && issue.compactDescription.localizedCaseInsensitiveContains("nearly passed")
  }

  /// Moves the content towards older rows (a finger dragging down).
  private func scrollUp(_ element: XCUIElement) {
    #if os(macOS)
      element.scroll(byDeltaX: 0, deltaY: 600)
    #else
      element.swipeDown(velocity: .fast)
    #endif
  }

  /// Moves the content towards newer rows (further down the gallery). A
  /// `distance` under 1 is a slow drag over that fraction of the view, so a
  /// screenful is never skipped.
  private func scrollDown(_ element: XCUIElement, distance: CGFloat = 1) {
    #if os(macOS)
      element.scroll(byDeltaX: 0, deltaY: -600 * distance)
    #else
      if distance < 1 {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2 + 0.6 * distance))
        let end = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        start.press(forDuration: 0.05, thenDragTo: end)
      } else {
        element.swipeUp(velocity: .fast)
      }
    #endif
  }

  private func settle(seconds: TimeInterval = 1) {
    _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: seconds)
  }

  /// A static text's words: its label on iOS, its value on the Mac.
  private static func text(of element: XCUIElement) -> String {
    element.label.isEmpty ? (element.value as? String ?? "") : element.label
  }

  private static func contains(_ text: String) -> NSPredicate {
    NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)
  }

  private func number(after prefix: String, in text: String) -> Int? {
    guard let range = text.range(of: prefix) else { return nil }
    return Int(text[range.upperBound...].prefix { $0.isNumber })
  }

  private func record(_ line: String) {
    print("[transcript-spike] \(line)")
    let attachment = XCTAttachment(string: line)
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
