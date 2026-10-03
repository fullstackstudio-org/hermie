import XCTest

/**
 The first build's path through the app, against a fake gateway (`packages/fake-gateway`) that
 `native/apple/scripts/test.sh --ui` starts on this Mac with a token, history, and replies slow
 enough to watch and stop (`HERMIE_CHAT_GATEWAY`; the simulator reaches the Mac's loopback).
 Without it the tests are skipped.

 Set up the gateway in the wizard with its token, see the bots in the chat list, open a chat, send
 with the composer, watch the reply stream, stop it, and answer an approval the gateway raises
 (`/__fake/request`). The chat screen's debug probe (`ChatTestProbe`, debug builds launched by a UI
 test only) reads the chat's state and the rows' render counts.
 */
@MainActor
final class ChatScreenUITests: XCTestCase {
  /// The fake gateway's bot whose chat ends in short rows (a run of bot-to-bot messages), so a phone
  /// screen holds several of them.
  private static let bot = "writer"
  /// The token `test.sh` starts the chat gateway with.
  private static let token = "ui-test-token"
  private var launched: XCUIApplication?
  private var gateway = ""
  /// The app was launched at the largest accessibility text size.
  private var largestText = false

  override func setUp() async throws {
    continueAfterFailure = false
  }

  override func tearDown() async throws {
    XCUIDevice.shared.orientation = .portrait
  }

  private func launch(_ extra: [String] = []) throws -> XCUIApplication {
    guard let address = ProcessInfo.processInfo.environment["HERMIE_CHAT_GATEWAY"], !address.isEmpty else {
      throw XCTSkip("HERMIE_CHAT_GATEWAY is not set: run native/apple/scripts/test.sh --ui.")
    }

    gateway = address

    let app = XCUIApplication()
    largestText = extra.contains("UICTContentSizeCategoryAccessibilityXXXL")
    app.launchArguments = ["-HermieUITest", "YES"] + extra
    app.launch()
    launched = app

    return app
  }

  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  // MARK: Setting the gateway up, as a person does

  /// The wizard's primary button once it can be pressed, scrolled into view.
  private func primary(_ app: XCUIApplication) -> XCUIElement {
    let button = app.buttons.matching(identifier: "hermie.onboarding.continue").firstMatch

    for _ in 0..<8 where !button.waitForExistence(timeout: 4) || !button.isHittable {
      app.collectionViews.firstMatch.swipeUp()
    }

    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: button)
    wait(for: [enabled], timeout: 30)
    return button
  }

  /// Welcome → address → token → name → the app, with the gateway in it.
  private func setUpGateway(_ app: XCUIApplication) {
    let setUp = app.buttons["hermie.welcome.setUp"]
    XCTAssertTrue(setUp.waitForExistence(timeout: 15))
    setUp.tap()

    let address = element(app, "hermie.onboarding.address")
    XCTAssertTrue(address.waitForExistence(timeout: 10))
    address.tap()
    address.typeText(gateway)
    primary(app).tap()

    let token = app.secureTextFields["hermie.onboarding.token"]
    XCTAssertTrue(token.waitForExistence(timeout: 15))
    token.tap()
    token.typeText(Self.token)
    primary(app).tap()

    let name = element(app, "hermie.onboarding.name")
    XCTAssertTrue(name.waitForExistence(timeout: 20))
    // At the end of the suggested name (the host), so the deletes clear it.
    name.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
    name.typeText(XCUIKeyboardKey.delete.rawValue.repeated(40) + "Chat\n")

    XCTAssertTrue(element(app, "hermie.onboarding.done").waitForExistence(timeout: 10))
    primary(app).tap()
    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 20))

    // Landscape on iPad, so the sidebar with the chat list stands beside the chat. (Set up in
    // portrait, as the wizard's own tests do.)
    if UIDevice.current.userInterfaceIdiom == .pad {
      XCUIDevice.shared.orientation = .landscapeLeft
    }
  }

  /// The connection is up and stays up: no connecting banner for three seconds running. (The banner
  /// fades in and out, and an audit mid-fade measures the contrast of half a banner; a gateway set up
  /// a moment ago can connect twice, once more when its new credentials are read.)
  private func settle(_ app: XCUIApplication) {
    let banner = element(app, "hermie.connection.banner")
    let deadline = Date().addingTimeInterval(45)
    var quietSince = Date()

    while Date() < deadline {
      if banner.exists {
        quietSince = Date()
      } else if Date().timeIntervalSince(quietSince) >= 3 {
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    }

    XCTFail("the gateway did not stay connected")
  }

  // MARK: The fake gateway

  private func raise(_ method: String, _ params: [String: Any]) throws {
    let (status, _) = try call("POST", "/__fake/request", body: ["profile": Self.bot, "method": method, "params": params])
    XCTAssertEqual(status, 200)
  }

  /// Wait until the fake gateway's state says `condition`.
  private func waitForFake(_ what: String, _ condition: ([String: Any]) -> Bool) throws {
    let deadline = Date().addingTimeInterval(30)

    while Date() < deadline {
      let (_, data) = try call("GET", "/__fake/state")

      if let state = try JSONSerialization.jsonObject(with: data) as? [String: Any], condition(state) {
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }

    XCTFail("Timed out waiting for \(what)")
  }

  /// Wait until an answer to a server request carries `text`.
  private func waitForAnswer(containing text: String) throws {
    try waitForFake("an answer with \(text)") { state in
      let answers = state["serverRequestAnswers"] as? [[String: Any]] ?? []
      return answers.contains { answer in
        guard let result = answer["result"], let data = try? JSONSerialization.data(withJSONObject: result),
          let json = String(data: data, encoding: .utf8)
        else { return false }
        return json.contains(text)
      }
    }
  }

  private func call(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> (Int, Data) {
    var request = URLRequest(url: try XCTUnwrap(URL(string: gateway + path)))
    request.httpMethod = method

    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }

    let done = expectation(description: "\(method) \(path)")
    nonisolated(unsafe) var outcome: (Int, Data) = (0, Data())

    URLSession.shared.dataTask(with: request) { data, response, _ in
      outcome = ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data())
      done.fulfill()
    }.resume()

    wait(for: [done], timeout: 10)
    return outcome
  }

  // MARK: Reading the chat

  /// The probe's state line, as `key=value` pairs.
  private func probeState(_ app: XCUIApplication) -> [String: String] {
    let text = element(app, "hermie.chat.probe.state").value as? String ?? ""

    return Dictionary(
      text.split(separator: " ").compactMap { pair in
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        return parts.count == 2 ? (parts[0], parts[1]) : nil
      },
      uniquingKeysWith: { $1 }
    )
  }

  private func waitFor(
    _ what: String,
    timeout: TimeInterval = 30,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: () -> Bool
  ) {
    let deadline = Date().addingTimeInterval(timeout)

    while !condition() {
      if Date() > deadline {
        let probe = launched.map { element($0, "hermie.chat.probe.state").value as? String ?? "-" } ?? "-"
        XCTFail("Timed out waiting for \(what); probe: \(probe)", file: file, line: line)
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
  }

  /// One row as the probe reports it: how often its `body` ran, and what it draws (its version,
  /// presentation and the rest of the stamp the list compares rows on).
  struct Rendered: Equatable {
    var count: Int
    /// How often the row's view appeared. The lazy list builds a row again when it lets go of it
    /// and needs it back (a row near the edge while the rows above it change height), and a
    /// rebuilt row runs its `body`: that is not the row being compared and redrawn.
    var appearances: Int
    var stamp: String

    /// Body runs that no new appearance explains.
    func redraws(since earlier: Rendered) -> Int {
      (count - earlier.count) - (appearances - earlier.appearances)
    }
  }

  /// The rows on screen (at least a line of each), between the navigation bar and the composer,
  /// read from one snapshot of the hierarchy while the list moves. A row the lazy list let go of off
  /// screen and builds again when it comes back runs its `body` again, rightly; the claim is about
  /// rows the reader is looking at.
  private func visibleRows(_ app: XCUIApplication) throws -> Set<String> {
    let top = app.navigationBars.firstMatch.frame.maxY
    let bottom = element(app, "composer").frame.minY
    var found = Set<String>()
    var pending = [try app.snapshot()]

    while let node = pending.popLast() {
      pending += node.children

      guard node.identifier.hasPrefix("row.") else { continue }
      let shown = min(node.frame.maxY, bottom) - max(node.frame.minY, top)

      if shown >= 24 {
        found.insert(String(node.identifier.dropFirst(4)))
      }
    }

    return found
  }

  /// Every row in the list, by id (the probe refreshes them four times a second).
  private func renderCounts(_ app: XCUIApplication) -> [String: Rendered] {
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))

    let text = element(app, "hermie.chat.probe.renders").value as? String ?? ""

    return Dictionary(
      text.split(separator: ";").compactMap { entry in
        let parts = entry.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        let value = parts[1].split(separator: "|", maxSplits: 2).map(String.init)
        guard value.count == 3, let count = Int(value[0]), let appearances = Int(value[1]) else { return nil }
        return (parts[0], Rendered(count: count, appearances: appearances, stamp: value[2]))
      },
      uniquingKeysWith: { $1 }
    )
  }

  private func audit(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
    var issues: [String] = []
    // What the bars leave of the screen. A transcript row scrolled partly under the navigation bar
    // or the composer is measured against the bar, not its own background; the lab tolerates the
    // same for the scroll view's edge (docs/native.md, "The lab").
    let top = app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.frame.maxY : 0
    let composer = element(app, "composer")
    let bottom = composer.exists ? composer.frame.minY : app.frame.maxY

    // As in the setup wizard's tests: at the default size, Dynamic Type and clipping are only
    // predictions of a larger size (and flagged rows whose text does wrap); they are checked at
    // the largest size, where they mean something.
    let types: XCUIAccessibilityAuditType =
      largestText ? .all : XCUIAccessibilityAuditType.all.subtracting([.dynamicType, .textClipped])

    // The iPad sidebar while a chat is open beside it: its row for that chat is drawn selected.
    let chatOpen = element(app, "composer").exists
    let sidebar = element(app, "hermie.chatList")
    let sidebarFrame = UIDevice.current.userInterfaceIdiom == .pad && chatOpen && sidebar.exists ? sidebar.frame : .null
    // Where the transcript's rows begin: 16 pt in from the chat column's edge.
    let rowsLeading = (sidebarFrame.isNull ? 0 : sidebarFrame.maxX) + 16

    try app.performAccessibilityAudit(for: types) { issue in
      // The debug probe is invisible on purpose and exists only in a UI test's launch.
      if issue.element?.identifier.hasPrefix("hermie.chat.probe") == true {
        return true
      }

      // Recorded and not failed on, as in the transcript lab (docs/native.md, "The lab"): the
      // Dynamic Type check reports every text on this toolchain, and "nearly passed" is the
      // system's own secondary label colour.
      if issue.auditType == .dynamicType
        || (issue.auditType == .contrast && issue.compactDescription.localizedCaseInsensitiveContains("nearly passed"))
      {
        return true
      }

      if issue.auditType == .contrast, let frame = issue.element?.frame, frame.minY < top || frame.maxY > bottom {
        return true
      }

      // Text whose frame starts left of the rows' margin: a code block or a table scrolled sideways
      // under its own edge, or a code block's language label, whose accessibility frame reaches past
      // the block's edge, so the audit measures it against what lies outside the row.
      if issue.auditType == .contrast, let frame = issue.element?.frame, chatOpen, frame.minX < rowsLeading {
        return true
      }

      // The system search field in the iPad sidebar keeps one height at every text size, and the
      // keyboard's prediction bar is the system's own.
      if issue.auditType == .textClipped, issue.element?.elementType == .searchField {
        return true
      }

      if issue.detailedDescription.contains("TUIPrediction") {
        return true
      }

      // The selected row of the iPad sidebar is the system's selection look: its small text on the
      // selection fill is measured against the fill. The list is audited before a chat is opened,
      // unselected, and on iPhone.
      if issue.auditType == .contrast, let frame = issue.element?.frame, sidebarFrame.contains(frame) {
        return true
      }

      // A contrast finding the audit cannot name an element for was on screen for a moment only
      // (an animated typing dot, a banner leaving); the settled screen is what is judged.
      if issue.auditType == .contrast, issue.element == nil {
        return true
      }

      issues.append("\(issue.compactDescription): \(issue.detailedDescription) — \(issue.element?.debugDescription ?? "-")")
      return true
    }

    XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n"), file: file, line: line)
  }

  /// The first build's whole path: set up, the bots, a chat, send, the reply streaming (redrawing
  /// only its own rows), Stop, and an approval answered.
  func testSetUpOpenAChatSendStopAndAnswerAnApproval() throws {
    let app = try launch()
    setUpGateway(app)

    // The chat list shows the gateway's bots.
    let row = element(app, "hermie.chatList.row.\(Self.bot)")
    XCTAssertTrue(row.waitForExistence(timeout: 30), "the chat list shows the fake gateway's bots")
    XCTAssertTrue(element(app, "hermie.chatList.row.researcher").exists)
    settle(app)
    try audit(app)

    row.tap()

    XCTAssertTrue(element(app, "composer").waitForExistence(timeout: 20), "the composer is up")
    waitFor("the chat to go live with its history") {
      let state = probeState(app)
      return state["hydration"] == "live" && Int(state["rows"] ?? "") ?? 0 > 10 && state["ready"] == "1"
    }
    try audit(app)

    // The counts the stream must leave alone, taken with the list settled and the keyboard down.
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    let before = renderCounts(app)
    let onScreenBefore = try visibleRows(app)
    let rowsBefore = Int(probeState(app)["rows"] ?? "") ?? 0

    let field = app.textViews["composer.field"].firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    // "long": the fake gateway answers with a long reply and a tool call.
    field.typeText("Write a long answer, please.")

    let send = app.buttons["composer.send"]
    XCTAssertTrue(send.isEnabled)
    send.tap()

    waitFor("the reply to start") { probeState(app)["activity"] == "busy" }

    // Scrolled up a little, as a reader does: the keyboard goes, the list stops following the reply,
    // and the older rows stay in view while it streams below them. The reply has been drawn frame
    // after frame; no row on screen that it did not change may have been drawn again.
    // A scroll view or a collection view, whichever implementation draws the list.
    app.descendants(matching: .any)["transcript.list"].firstMatch.swipeDown(velocity: .slow)
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    let during = renderCounts(app)
    let onScreenDuring = try visibleRows(app)

    let drawn = before.filter { $0.value.count > 0 && onScreenBefore.contains($0.key) && onScreenDuring.contains($0.key) }
    let untouched = drawn.filter { id, row in during[id]?.stamp == row.stamp }
    let redrawn = untouched.filter { id, row in (during[id]?.redraws(since: row) ?? 0) > 0 }
    XCTAssertGreaterThan(untouched.count, 0, "rows on screen that the stream did not change")
    XCTAssertEqual(redrawn.keys.sorted(), [], "rows drawn again by a stream that did not change them: \(redrawn)")

    // The reply streams below the rows in view. The SwiftUI list keeps it built and draws it frame
    // after frame; the collection view (iPhone and iPad) builds only the rows on screen, and draws the
    // reply when it comes into view.
    let reply = during.filter { id, _ in before[id] == nil }
    let streamed = reply.filter { id, row in row.count > 2 || !onScreenDuring.contains(id) }
    XCTAssertFalse(
      streamed.isEmpty,
      "the streaming reply was drawn once per frame while on screen: new rows \(reply), on screen \(onScreenDuring.sorted())")

    // Stop: the button is Send again, the turn is over on the gateway, the partial reply stays.
    let stop = app.buttons["composer.stop"]
    XCTAssertTrue(stop.waitForExistence(timeout: 10), "Stop is offered while the bot replies")
    stop.tap()
    XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 15))
    try waitForFake("the turn to stop") { state in (state["runningSessions"] as? [Any])?.isEmpty ?? false }
    waitFor("the chat to be idle") { probeState(app)["activity"] == "idle" }
    XCTAssertGreaterThan(Int(probeState(app)["rows"] ?? "") ?? 0, rowsBefore, "the partial reply stays")

    // An approval the gateway raises: answered from its sheet.
    try raise("approval", ["request_id": "appr-chat-ui", "command": "ls -la", "choices": ["once", "deny"]])
    let once = app.buttons["request.sheet.once"]
    XCTAssertTrue(once.waitForExistence(timeout: 15), "the sheet comes up for the question")
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true AND isHittable == true"), evaluatedWith: once)
    wait(for: [enabled], timeout: 10)
    once.tap()
    try waitForAnswer(containing: "once")
    XCTAssertTrue(once.waitForNonExistence(timeout: 10), "the sheet goes once the answer went out")
  }

  // MARK: The transcript's geometry

  /// The transcript's row ids in order, oldest first, as the probe lists them.
  private func rowOrder(_ app: XCUIApplication) -> [String] {
    let text = element(app, "hermie.chat.probe.renders").value as? String ?? ""
    return text.split(separator: ";").compactMap { entry in
      entry.split(separator: "=", maxSplits: 1).first.map(String.init)
    }
  }

  /// Every row the hierarchy holds, by id, with its frame on screen, from one snapshot. A row whose
  /// identifier SwiftUI hands to each of its elements is the union of their frames.
  private func rowFrames(_ app: XCUIApplication) throws -> [String: CGRect] {
    var frames: [String: CGRect] = [:]
    var pending = [try app.snapshot()]

    while let node = pending.popLast() {
      pending += node.children
      if node.identifier.hasPrefix("row."), node.frame.height >= 1 {
        let id = String(node.identifier.dropFirst(4))
        frames[id] = frames[id].map { $0.union(node.frame) } ?? node.frame
      }
    }

    return frames
  }

  /// No two rows on screen overlap, and the newest row is on screen and ends above the composer's
  /// top edge: nothing the reader should see is under the composer or drawn over another row.
  private func assertTranscriptLayout(
    _ app: XCUIApplication, _ moment: String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    let order = rowOrder(app)
    let frames = try rowFrames(app)
    let composer = element(app, "composer").frame
    let shown = order.filter { frames[$0] != nil }
    XCTAssertGreaterThan(shown.count, 1, "rows on screen \(moment)", file: file, line: line)

    for (earlier, later) in zip(shown, shown.dropFirst()) {
      guard let above = frames[earlier], let below = frames[later] else { continue }
      XCTAssertGreaterThanOrEqual(
        below.minY, above.maxY - 1,
        "\(moment): row \(later) \(below) overlaps row \(earlier) \(above)", file: file, line: line)
    }

    guard let newest = order.last, let frame = frames[newest] else {
      XCTFail("\(moment): the newest row \(order.last ?? "-") is not on screen", file: file, line: line)
      return
    }

    XCTAssertLessThanOrEqual(
      frame.maxY, composer.minY + 1,
      "\(moment): the newest row \(frame) ends under the composer \(composer)", file: file, line: line)
    XCTAssertGreaterThan(
      frame.maxY, composer.minY - 80,
      "\(moment): the list is not at the bottom (newest row \(frame), composer \(composer))", file: file, line: line)
  }

  private func openChat(_ app: XCUIApplication) {
    let row = element(app, "hermie.chatList.row.\(Self.bot)")
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    row.tap()
    XCTAssertTrue(element(app, "composer").waitForExistence(timeout: 20))
    waitFor("the chat to go live with its history") {
      let state = probeState(app)
      return state["hydration"] == "live" && Int(state["rows"] ?? "") ?? 0 > 10 && state["ready"] == "1"
    }
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
  }

  private func send(_ app: XCUIApplication, _ text: String) {
    let field = app.textViews["composer.field"].firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText(text)
    app.buttons["composer.send"].tap()
  }

  /// The rows keep apart and the newest row ends above the composer: opened, after a send and its
  /// reply with the keyboard up, and in landscape. (The rows used to take the safe area of the bars
  /// they scroll under, so a row under the header was drawn pushed down over the next one, and one
  /// under the composer pushed up.)
  func testRowsKeepApartAndTheNewestRowEndsAboveTheComposer() throws {
    let app = try launch()
    setUpGateway(app)
    openChat(app)
    try assertTranscriptLayout(app, "opened")

    send(app, "Introduce yourself in one line.")
    waitFor("the reply to start") { probeState(app)["activity"] == "busy" }
    waitFor("the reply to finish", timeout: 60) { probeState(app)["activity"] == "idle" }
    try assertTranscriptLayout(app, "after a send, the keyboard up")

    XCUIDevice.shared.orientation = .landscapeLeft
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    try assertTranscriptLayout(app, "in landscape")
    XCUIDevice.shared.orientation = .portrait
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    try assertTranscriptLayout(app, "back in portrait")
  }

  /// A reader who scrolled up stays where they are while the bot's reply arrives and grows below
  /// them (the jump pill shows), and their own send takes them to the very bottom, the new bubble
  /// and the reply after it whole above the composer.
  func testAReplyArrivingBelowAScrolledUpReaderMovesNothingAndASendGoesToTheBottom() throws {
    let app = try launch()
    setUpGateway(app)
    openChat(app)

    // A first turn, to its end. The fake gateway's extra history carries negative row ids, and
    // the engine's re-ordering at a turn's end (`inRowOrder`, whose "newest row above" starts at
    // -1) moves that history's tool rows, which have no row id, to just after it the first time.
    // That move is the fake's, not the list's: a real gateway's row ids are positive.
    send(app, "Introduce yourself in one line.")
    waitFor("the first reply to start") { probeState(app)["activity"] == "busy" }
    waitFor("the first reply to finish", timeout: 60) { probeState(app)["activity"] == "idle" }
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))

    // "long": the fake gateway answers with a long reply and a tool call, slowly.
    send(app, "Write a long answer, please.")
    waitFor("the reply to start") { probeState(app)["activity"] == "busy" }

    let list = app.descendants(matching: .any)["transcript.list"].firstMatch
    list.swipeDown(velocity: .slow)
    list.swipeDown(velocity: .slow)
    let pill = app.buttons["transcript.jumpToLatest"]
    XCTAssertTrue(pill.waitForExistence(timeout: 5), "scrolled up, the pill offers the way back")
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))

    // The reply goes on arriving below: rows are added and the streaming one grows.
    let rowsBefore = Int(probeState(app)["rows"] ?? "") ?? 0
    let before = try rowFrames(app)
    waitFor("the reply to finish", timeout: 90) { probeState(app)["activity"] == "idle" }
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    let after = try rowFrames(app)
    let kept = before.keys.filter { after[$0] != nil }
    XCTAssertFalse(kept.isEmpty, "the rows in view are still there")
    for id in kept {
      XCTAssertEqual(after[id]!.minY, before[id]!.minY, accuracy: 1, "row \(id) moved under a scrolled-up reader")
    }
    XCTAssertTrue(pill.exists, "a reply arriving below does not take the reader down")
    XCTAssertGreaterThanOrEqual(Int(probeState(app)["rows"] ?? "") ?? 0, rowsBefore)

    send(app, "Introduce yourself in one line.")
    waitFor("the reply to start") { probeState(app)["activity"] == "busy" }
    waitFor("the reply to finish", timeout: 60) { probeState(app)["activity"] == "idle" }
    try assertTranscriptLayout(app, "after a send from a scrolled-up place")
    XCTAssertFalse(pill.exists, "at the bottom, no pill")
  }

  /// The list and the chat at the largest text size: they wrap instead of clipping, the search
  /// field narrows the list by name, and the audit passes on both.
  func testTheListAndTheChatPassTheAuditAtTheLargestTextSize() throws {
    let app = try launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    setUpGateway(app)

    XCTAssertTrue(element(app, "hermie.chatList.row.researcher").waitForExistence(timeout: 30))
    settle(app)
    try audit(app)

    // At this size a row can be taller than the sidebar: find the bot through the search field.
    let search = app.searchFields.firstMatch
    search.tap()
    // Return puts the keyboard away, so the row it would cover can be tapped.
    search.typeText(Self.bot + "\n")

    let row = element(app, "hermie.chatList.row.\(Self.bot)")
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertFalse(element(app, "hermie.chatList.row.researcher").exists, "the search leaves only the bot it names")

    row.tap()
    XCTAssertTrue(element(app, "hermie.chat.probe.state").waitForExistence(timeout: 20))
    waitFor("the chat to go live, the socket up") {
      let state = probeState(app)
      return state["hydration"] == "live" && state["ready"] == "1"
    }
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    try audit(app)
  }
}

private extension String {
  func repeated(_ count: Int) -> String {
    String(repeating: self, count: count)
  }
}
