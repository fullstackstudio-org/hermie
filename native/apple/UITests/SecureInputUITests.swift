import XCTest

/// The secure input sheet (`secret`, `sudo`, `vault.*`), against the fake
/// gateway the test script starts on the host (`TEST_RUNNER_HERMIE_LAB_GATEWAY`),
/// in the lab's composer screen, which mounts `.secureInput(...)`. The tests
/// raise prompts through `/__fake/request` and read what was answered from
/// `/__fake/state`.
@MainActor
final class SecureInputUITests: XCTestCase {
  private var gateway = ""

  override func setUp() async throws {
    continueAfterFailure = false
    guard let address = ProcessInfo.processInfo.environment["HERMIE_LAB_GATEWAY"], !address.isEmpty else {
      throw XCTSkip("No fake gateway: run through scripts/test.sh --ui, which starts one.")
    }
    gateway = address
    let (status, _) = try call("POST", "/__fake/withdraw-requests", body: [:])
    XCTAssertEqual(status, 200)
  }

  func testASecretIsTypedMaskedAndSent() throws {
    let app = launchLab()
    try raise("secret", ["env_var": "EXAMPLE_API_KEY", "prompt": "Paste the key for the example service"])

    let field = app.secureTextFields["secureInput.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "the sheet comes up with a secure field")
    XCTAssertTrue(app.staticTexts["secureInput.title"].label.contains("researcher"), "the app's own title names the bot")
    XCTAssertTrue(app.staticTexts["secureInput.gateway"].exists, "and the gateway")
    XCTAssertTrue(app.staticTexts["secureInput.envVar"].exists)
    let send = app.buttons["secureInput.send"]
    XCTAssertFalse(send.isEnabled, "nothing typed, nothing to send")
    XCTAssertFalse(hasKeyboardFocus(field), "the sheet never takes the keyboard by itself")

    engage(field)
    field.typeText("ui-secret-42")
    let shown = field.value as? String ?? ""
    XCTAssertFalse(shown.contains("ui-secret-42"), "typing is masked: \(shown.count) characters shown")
    waitUntilEnabled(send)
    send.tap()

    try waitForAnswer(#"{"value":"ui-secret-42"}"#)
    XCTAssertTrue(field.waitForNonExistence(timeout: 10), "the sheet goes once the answer went out")
  }

  func testALongPromptLeavesTheChromeAndTheReceiverInView() throws {
    let app = launchLab()
    let filler = String(repeating: ".\n\n", count: 200)
    try raise("sudo", ["command": filler + "rm -rf / # looks harmless"])

    let field = app.secureTextFields["secureInput.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    engage(field)
    XCTAssertTrue(app.staticTexts["secureInput.title"].isHittable, "who asks stays in view")
    XCTAssertTrue(app.staticTexts["secureInput.gateway"].isHittable, "and on which gateway")
    XCTAssertTrue(app.staticTexts["secureInput.receiver"].isHittable, "and who receives it")
    XCTAssertTrue(app.buttons["secureInput.command.more"].exists, "the rest is behind Show more")
  }

  func testSudoIsSkipped() throws {
    let app = launchLab()
    try raise("sudo", ["command": "apt-get install example"])

    let skip = app.buttons["secureInput.skip"]
    XCTAssertTrue(skip.waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["secureInput.command"].label.contains("apt-get install example"))
    XCTAssertTrue(app.staticTexts["secureInput.countdown"].exists, "the gateway's deadline is counted down")
    tapWhenHittable(skip)

    try waitForAnswer(#"{"value":""}"#)
    XCTAssertTrue(skip.waitForNonExistence(timeout: 10))
  }

  func testTheSheetPassesTheAccessibilityAudit() throws {
    let app = launchLab()
    try raise("secret", ["env_var": "EXAMPLE_API_KEY", "prompt": "Paste the key"])
    try auditSheet(app, "default size", pages: 1)
  }

  func testTheSheetPassesTheAccessibilityAuditAtTheLargestSize() throws {
    let app = launchLab(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    try raise("sudo", ["command": "apt-get install example"])
    try auditSheet(app, "AX5", pages: 3)
  }

  // MARK: Helpers

  private func launchLab(_ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments =
      ["-HermieLabScreen", "composer", "-HermieLabGateway", gateway, "-HermieLabHideTranscript", "YES"] + arguments
    app.launch()
    XCTAssertTrue(app.otherElements["composer"].firstMatch.waitForExistence(timeout: 30), "the lab is up")
    let unavailable = app.staticTexts["composer.unavailable"]
    if unavailable.exists {
      XCTAssertTrue(unavailable.waitForNonExistence(timeout: 30), "the chat opened")
    }
    return app
  }

  /// Audit the sheet a scroll area's page at a time (at the default size the
  /// whole sheet is one page).
  private func auditSheet(_ app: XCUIApplication, _ label: String, pages: Int) throws {
    let field = app.secureTextFields["secureInput.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    // The sheet as it is about to be answered: something typed, Send on.
    engage(field)
    field.typeText("x")
    waitUntilEnabled(app.buttons["secureInput.send"])
    // The keyboard away (the sheet's scroll view lets it go on a drag), so the
    // whole sheet can be audited.
    let sheet = app.scrollViews.firstMatch
    sheet.swipeDown()
    _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 1)

    // A screenful, then the rest (the sheet is taller than the screen at AX5).
    var issues: [String] = []
    for page in 0..<pages {
      let visible = sheet.frame
      try app.performAccessibilityAudit { issue in
        let element = issue.element.map { "'\($0.identifier)' '\($0.label)'" } ?? "-"
        let line = "\(label) page \(page): \(issue.compactDescription) on \(element) (\(issue.detailedDescription))"
        // As in the gallery's audit (docs/native.md): an element the scroll
        // view's edge cuts off is measured against the clip, and audited whole
        // on the other page; the Dynamic Type check reports every text on this
        // toolchain; "nearly passed" is the system's secondary colour.
        let clipped = issue.auditType == .contrast && issue.element.map { !visible.contains($0.frame) } == true
        #if os(iOS)
          let dynamicType = issue.auditType == .dynamicType
        #else
          let dynamicType = false
        #endif
        let tolerated =
          clipped || dynamicType
          || (issue.auditType == .contrast && issue.compactDescription.localizedCaseInsensitiveContains("nearly passed"))
        if tolerated {
          print("[secure-input-ui] audit (tolerated) \(line)")
        } else {
          issues.append(line)
        }
        return true
      }
      sheet.swipeUp()
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 1)
    }
    issues.forEach { print("[secure-input-ui] audit \($0)") }
    XCTAssertEqual(issues, [], "the accessibility audit found issues")
  }

  /// Put the keyboard in a field the way a person does, once the sheet's
  /// guard (400 ms after it appears) is over.
  private func engage(_ field: XCUIElement) {
    _ = XCTWaiter.wait(for: [XCTestExpectation(description: "guard")], timeout: 0.8)
    // At the largest sizes the field may be below the fold of the scroll area.
    let sheet = field.firstMatch
    for _ in 0..<6 where !sheet.isHittable {
      XCUIApplication().scrollViews.firstMatch.swipeUp()
    }
    tapWhenHittable(field)
  }

  private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
    (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
  }

  private func tapWhenHittable(_ element: XCUIElement) {
    let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: element)
    wait(for: [hittable], timeout: 10)
    element.tap()
  }

  private func waitUntilEnabled(_ element: XCUIElement) {
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: element)
    wait(for: [enabled], timeout: 5)
  }

  // MARK: The fake gateway

  private func raise(_ method: String, _ params: [String: Any]) throws {
    let body: [String: Any] = ["profile": "researcher", "method": method, "params": params]
    let (status, _) = try call("POST", "/__fake/request", body: body)
    XCTAssertEqual(status, 200)
  }

  /// Wait until an answer's result, as sorted JSON text, is `expected`.
  private func waitForAnswer(_ expected: String) throws {
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      let (_, data) = try call("GET", "/__fake/state")
      if let state = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
        let answers = state["serverRequestAnswers"] as? [[String: Any]] ?? []
        let found = answers.contains { answer in
          guard let result = answer["result"],
            let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes]),
            let json = String(data: data, encoding: .utf8)
          else { return false }
          return json == expected
        }
        if found {
          return
        }
      }
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.2)
    }
    XCTFail("Timed out waiting for the answer \(expected)")
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
