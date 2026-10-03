import XCTest

/// The composer and the request answering, against the fake gateway the test
/// script starts on the host (`scripts/test.sh --ui` passes its address as
/// `TEST_RUNNER_HERMIE_LAB_GATEWAY`). The lab's composer screen opens the
/// researcher's chat on it; the tests raise approvals and clarify questions
/// through the fake's `/__fake/request` and read what was answered from
/// `/__fake/state`.
@MainActor
final class ComposerUITests: XCTestCase {
  private var gateway = ""

  override func setUp() async throws {
    continueAfterFailure = false
    guard let address = ProcessInfo.processInfo.environment["HERMIE_LAB_GATEWAY"], !address.isEmpty else {
      throw XCTSkip("No fake gateway: run through scripts/test.sh --ui, which starts one.")
    }
    gateway = address
    // One gateway serves every test: start from no open question.
    let (status, _) = try call("POST", "/__fake/withdraw-requests", body: [:])
    XCTAssertEqual(status, 200)
  }

  // MARK: Send, stream, stop

  func testTypeSendSeeTheReplyStreamAndStopIt() throws {
    let app = launchComposer()
    waitForSendable(app)
    let field = composerField(app)
    XCTAssertTrue(field.waitForExistence(timeout: 10))

    tapWhenHittable(field)
    field.typeText("give me the long version")
    let send = app.buttons["composer.send"]
    XCTAssertTrue(send.isEnabled)
    send.tap()

    // The reply streams: the first words arrive, then more of them.
    let firstWords = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "let me walk through")).firstMatch
    XCTAssertTrue(firstWords.waitForExistence(timeout: 30), "the reply started streaming")
    let stop = app.buttons["composer.stop"]
    XCTAssertTrue(stop.waitForExistence(timeout: 10), "Stop is offered while the bot replies")
    stop.tap()

    // Stopped: the button is Send again and the turn is over on the gateway.
    XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 15))
    try waitForFake("the turn to stop") { state in
      (state["runningSessions"] as? [Any])?.isEmpty ?? false
    }
    XCTAssertTrue(firstWords.exists, "the partial reply stays")
  }

  // MARK: Approvals

  func testAnApprovalIsAllowedFromTheSheetAndAnotherDeniedFromItsCard() throws {
    let app = launchComposer()
    waitForSendable(app)

    try raise(
      "approval",
      ["request_id": "appr-ui-allow", "command": "rm -rf ./build", "choices": ["once", "session", "deny"]])
    let once = app.buttons["request.sheet.once"]
    XCTAssertTrue(once.waitForExistence(timeout: 15), "the sheet comes up for the question")
    XCTAssertFalse(app.buttons["request.sheet.always"].exists, "only the choices the request offered")
    waitUntilEnabled(once)
    tapWhenHittable(once)
    try waitForAnswer(containing: "once")
    XCTAssertTrue(once.waitForNonExistence(timeout: 10), "the sheet goes once the answer went out")

    try raise("approval", ["request_id": "appr-ui-deny", "command": "git push --force", "choices": ["once", "deny"]])
    let later = app.buttons["request.sheet.dismiss"]
    XCTAssertTrue(later.waitForExistence(timeout: 15))
    tapWhenHittable(later)
    let deny = app.buttons["approval.deny"].firstMatch
    XCTAssertTrue(deny.waitForExistence(timeout: 10), "put away, the question is still in the transcript")
    tapWhenHittable(deny)
    try waitForAnswer(containing: "deny")
    XCTAssertTrue(deny.waitForNonExistence(timeout: 10))
  }

  // MARK: Clarify

  func testAClarifyIsAnsweredWithAnOptionAndAnotherInFreeText() throws {
    let app = launchComposer()
    waitForSendable(app)

    try raise("clarify", ["question": "Which branch?", "choices": ["main", "next"]])
    // The card is in the transcript and in the sheet over it: the sheet's is
    // the one that can be tapped.
    hittable(app.buttons.matching(identifier: "clarify.option.main")).tap()
    hittable(app.buttons.matching(identifier: "clarify.submit")).tap()
    try waitForAnswer(containing: "main")

    try raise("clarify", ["question": "What should the release be called?"])
    let freeText = hittable(app.textFields.matching(identifier: "clarify.freeText"))
    freeText.tap()
    freeText.typeText("Spring cleaning")
    hittable(app.buttons.matching(identifier: "clarify.submit")).tap()
    try waitForAnswer(containing: "Spring cleaning")
  }

  // MARK: The keyboard alone (iPad)

  // The Mac's keys are `ComposerKeyTests` (HermieKit), on the text view itself.
  #if os(iOS)
  func testAHardwareKeyboardSendsWithReturnAddsALineWithShiftReturnAndStopsWithEsc() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("Hardware-keyboard rules are tested on the iPad.")
    }
    // Without the rows: on the iPad a TranscriptList with a bottom inset can
    // spin in layout (see the handoff); the keys are what this test is about.
    let app = launchComposer(["-HermieLabHideTranscript", "YES"])
    waitForSendable(app)
    let field = composerField(app)
    tapWhenHittable(field)

    // Whether this simulator delivers synthesized hardware keys at all: a
    // Delete key typed through `typeKey` takes a character back.
    field.typeText("ab")
    field.typeKey(.delete, modifierFlags: [])
    let probe = field.value as? String ?? ""
    print("[probe] after delete: \(probe.debugDescription)")
    guard probe == "a" else {
      throw XCTSkip("This simulator does not deliver typeKey events to the app (Delete left \(probe.debugDescription)).")
    }
    field.typeKey(.delete, modifierFlags: [])

    field.typeText("first line")
    field.typeKey(.return, modifierFlags: .shift)
    print("[probe] after shift-return: \((field.value as? String ?? "").debugDescription)")
    field.typeText("long second line")
    let typed = field.value as? String ?? ""
    XCTAssertTrue(typed.contains("first line\nlong second line"), "Shift-Return adds a line: \(typed.debugDescription)")

    field.typeKey(.return, modifierFlags: [])
    XCTAssertTrue(app.buttons["composer.stop"].waitForExistence(timeout: 20), "Return sent it")
    // The field kept its focus: keys go on landing in it without a tap.
    app.typeText("x")
    XCTAssertEqual(field.value as? String, "x", "the field keeps its focus after a send")
    app.typeKey(.delete, modifierFlags: [])

    field.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 15), "Esc stopped the reply")
    try waitForFake("the turn to stop") { state in
      (state["runningSessions"] as? [Any])?.isEmpty ?? false
    }
    XCTAssertEqual(field.value as? String ?? "", "", "Esc never brings the sent words back")

    // A question's sheet takes Esc first, and puts the question away unanswered.
    try raise("approval", ["request_id": "appr-kb", "command": "ls", "choices": ["once", "deny"]])
    let sheetOnce = app.buttons["request.sheet.once"]
    XCTAssertTrue(sheetOnce.waitForExistence(timeout: 15))
    // Esc puts the sheet away without answering.
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(sheetOnce.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.buttons["approval.once"].firstMatch.waitForExistence(timeout: 10))
  }
  #endif

  // MARK: Accessibility

  func testTheComposerAndTheSheetPassTheAccessibilityAudit() throws {
    // The rows have their own audit, over the item gallery; this one is the
    // composer's and the sheet's.
    let app = launchComposer(["-HermieLabHideTranscript", "YES"])
    waitForSendable(app)
    try audit(app, "composer")
    try raise("approval", ["request_id": "appr-audit", "command": "ls", "choices": ["once", "deny"]])
    let once = app.buttons["request.sheet.once"]
    XCTAssertTrue(once.waitForExistence(timeout: 15))
    // Settled: the sheet has stopped moving and its tap guard is over.
    waitUntilEnabled(once)
    _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 1)
    try audit(app, "approval sheet")
  }

  // MARK: Helpers

  private func launchComposer(_ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-HermieLabScreen", "composer", "-HermieLabGateway", gateway] + arguments
    app.launch()
    return app
  }

  private func composerField(_ app: XCUIApplication) -> XCUIElement {
    app.textViews["composer.field"].firstMatch
  }

  /// The chat is open and the socket ready: the field's line about why it
  /// cannot send is gone.
  private func waitForSendable(_ app: XCUIApplication) {
    XCTAssertTrue(app.otherElements["composer"].firstMatch.waitForExistence(timeout: 30), "the composer is up")
    let unavailable = app.staticTexts["composer.unavailable"]
    if unavailable.exists {
      XCTAssertTrue(unavailable.waitForNonExistence(timeout: 30), "the chat opened")
    }
  }

  /// The first element of `query` that can be tapped, once there is one.
  private func hittable(_ query: XCUIElementQuery, timeout: TimeInterval = 15) -> XCUIElement {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let element = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) {
        return element
      }
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.2)
    }
    XCTFail("Nothing that can be tapped for \(query)")
    return query.firstMatch
  }

  /// Taps once the element is on screen and not under something else (a
  /// sheet that is still sliding in or out).
  private func tapWhenHittable(_ element: XCUIElement) {
    let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: element)
    wait(for: [hittable], timeout: 10)
    element.tap()
  }

  private func waitUntilEnabled(_ element: XCUIElement) {
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: element)
    wait(for: [enabled], timeout: 5)
  }

  private func audit(_ app: XCUIApplication, _ label: String) throws {
    var issues: [String] = []
    try app.performAccessibilityAudit { issue in
      let element = issue.element.map { "'\($0.identifier)' '\($0.label)'" } ?? "-"
      let line = "\(label): \(issue.compactDescription) on \(element) (\(issue.detailedDescription))"
      // As in the gallery audit (docs/native.md): the Dynamic Type check reports
      // every text on this toolchain, and "nearly passed" is the system's own
      // secondary label colour.
      #if os(iOS)
        let dynamicType = issue.auditType == .dynamicType
      #else
        let dynamicType = false
      #endif
      let tolerated =
        dynamicType
        || (issue.auditType == .contrast && issue.compactDescription.localizedCaseInsensitiveContains("nearly passed"))
      if tolerated {
        print("[composer-ui] audit (tolerated) \(line)")
      } else {
        issues.append(line)
      }
      return true
    }
    issues.forEach { print("[composer-ui] audit \($0)") }
    XCTAssertEqual(issues, [], "the accessibility audit found issues")
  }

  // MARK: The fake gateway

  private func raise(_ method: String, _ params: [String: Any]) throws {
    let body: [String: Any] = ["profile": "researcher", "method": method, "params": params]
    let (status, _) = try call("POST", "/__fake/request", body: body)
    XCTAssertEqual(status, 200)
  }

  /// Wait until an answer to a server request carries `text`.
  private func waitForAnswer(containing text: String) throws {
    try waitForFake("an answer with \(text)") { state in
      let answers = state["serverRequestAnswers"] as? [[String: Any]] ?? []
      return answers.contains { answer in
        guard let result = answer["result"],
          let data = try? JSONSerialization.data(withJSONObject: result),
          let json = String(data: data, encoding: .utf8)
        else { return false }
        return json.contains(text)
      }
    }
  }

  private func waitForFake(_ what: String, _ condition: ([String: Any]) -> Bool) throws {
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      let (_, data) = try call("GET", "/__fake/state")
      if let state = try JSONSerialization.jsonObject(with: data) as? [String: Any], condition(state) {
        return
      }
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.2)
    }
    XCTFail("Timed out waiting for \(what)")
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
}
