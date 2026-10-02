import XCTest

/**
 Setting up a gateway on a simulator, against fake gateways that `native/apple/scripts/test.sh --ui`
 starts on the host (the simulator reaches them on 127.0.0.1): an ungated one, a token one and a
 native-sign-in one. Without them (another runner) these tests are skipped.

 The native test signs in with the in-app page, the fallback: the system browser sheet of the primary
 way is another process's window, which XCUITest cannot drive reliably. The browser way and its
 loopback listener are covered by the package's listener and integration tests.

 Every step passes the accessibility audit. The keyboard is put away before an audit: text it covers
 would fail the contrast check for what is drawn over it.
 */
@MainActor
final class OnboardingUITests: XCTestCase {
  override func setUp() async throws {
    continueAfterFailure = false
  }

  private func gateway(_ name: String) throws -> String {
    guard let url = ProcessInfo.processInfo.environment[name], !url.isEmpty else {
      throw XCTSkip("\(name) is not set: run native/apple/scripts/test.sh --ui, which starts the fake gateways.")
    }

    return url
  }

  /// The text size the app under test was launched at.
  private var largestText = false

  private func launch(largestText: Bool = false, _ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()

    self.largestText = largestText

    app.launchArguments = ["-HermieUITest", "YES"] + arguments

    if largestText {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    }

    app.launch()
    return app
  }

  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  /**
   The system audit, with the keyboard put away first; every issue is written out before the test fails.

   Each check runs at the size where it means something. At the default size, every check but Dynamic
   Type and clipping: those two are predictions of a larger size there, and on this form they flagged
   rows whose text does wrap and grow. At the largest accessibility size (`launch(largestText:)`),
   every check but contrast, which does not depend on the size and was checked at the default one;
   at that size it was measured on the action button and rows half scrolled out of the window.
   */
  private func audit(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
    hideKeyboard(app)

    let types: XCUIAccessibilityAuditType =
      largestText
      ? XCUIAccessibilityAuditType.all.subtracting(.contrast)
      : XCUIAccessibilityAuditType.all.subtracting([.dynamicType, .textClipped])
    let largestText = largestText
    var issues: [String] = []

    try app.performAccessibilityAudit(for: types) { issue in
      // On iPad, at the largest size, the audit also reports Dynamic Type issues it cannot attach to
      // any element (seen on the form sheet after scrolling). Every element it can name is checked.
      if largestText, issue.element == nil, issue.auditType == .dynamicType || issue.auditType == .textClipped {
        return true
      }

      issues.append(
        "\(issue.compactDescription): \(issue.detailedDescription) — \(issue.element?.debugDescription ?? "no element")"
      )
      return true
    }

    XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n"), file: file, line: line)
  }

  /// The steps' forms dismiss the keyboard when they scroll.
  private func hideKeyboard(_ app: XCUIApplication) {
    guard app.keyboards.count > 0 else {
      return
    }

    app.collectionViews.firstMatch.swipeUp()
    _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
  }

  /// The step's primary button (Continue, Done, Start chatting), once it can be pressed. It is always
  /// there (disabled, with a hint, until the step is complete), as the form's last section: at large
  /// text sizes it is scrolled into view first.
  private func primary(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let button = app.buttons.matching(identifier: "hermie.onboarding.continue").firstMatch

    for _ in 0..<8 where !button.waitForExistence(timeout: 4) || !button.isHittable {
      app.collectionViews.firstMatch.swipeUp()
    }

    XCTAssertTrue(button.waitForExistence(timeout: 20), "no primary button", file: file, line: line)

    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: button)
    wait(for: [enabled], timeout: 30)
    return button
  }

  /// Welcome → setup → type the address → wait for the probe line.
  private func openSetup(_ app: XCUIApplication, address: String) throws {
    let setUp = app.buttons["hermie.welcome.setUp"]

    XCTAssertTrue(setUp.waitForExistence(timeout: 10))
    setUp.tap()

    let field = app.textViews["hermie.onboarding.address"].exists
      ? app.textViews["hermie.onboarding.address"] : element(app, "hermie.onboarding.address")

    XCTAssertTrue(field.waitForExistence(timeout: 10))
    try audit(app)

    field.tap()
    field.typeText(address)

    // Continue appears once the probe found a gateway. (The probe line itself may be scrolled out of
    // the form at the largest text size, where a list does not build the rows it does not show.)
    _ = primary(app)
    try audit(app)
  }

  /// Name → Done → Start chatting → the app, with the gateway in it.
  private func finish(_ app: XCUIApplication, name: String) throws {
    let field = element(app, "hermie.onboarding.name")

    XCTAssertTrue(field.waitForExistence(timeout: 10))
    try audit(app)

    // The keyboard alone: clear the suggested name, type one, Return moves on.
    field.tap()
    field.typeText(XCUIKeyboardKey.delete.rawValue.repeated(40))
    field.typeText(name + "\n")

    XCTAssertTrue(element(app, "hermie.onboarding.done").waitForExistence(timeout: 10))
    try audit(app)

    primary(app).tap()

    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 20))
    XCTAssertFalse(element(app, "hermie.onboarding.address").exists)
  }

  // MARK: Ungated

  func testAnUngatedGatewayIsSetUpWithTheKeyboardAlone() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_NONE")
    let app = launch()

    try openSetup(app, address: address)

    // Return in the address field moves on, as the Continue button does.
    let field = element(app, "hermie.onboarding.address")

    field.tap()
    field.typeText("\n")

    let token = app.secureTextFields["hermie.onboarding.token"]

    XCTAssertTrue(token.waitForExistence(timeout: 10))
    try audit(app)

    token.tap()
    token.typeText("any-token\n")

    try finish(app, name: "Desk")
  }

  // MARK: Token

  func testATokenGatewayRefusesAWrongTokenAndTakesTheRightOne() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_TOKEN")
    let app = launch()

    try openSetup(app, address: address)
    primary(app).tap()

    let token = app.secureTextFields["hermie.onboarding.token"]

    XCTAssertTrue(token.waitForExistence(timeout: 10))
    token.tap()
    token.typeText("wrong-token")
    primary(app).tap()

    XCTAssertTrue(element(app, "hermie.onboarding.signInStatus").waitForExistence(timeout: 20))
    try audit(app)

    token.tap()
    token.typeText(XCUIKeyboardKey.delete.rawValue.repeated(20) + "ui-test-token")
    primary(app).tap()

    try finish(app, name: "Lab")

    // Settings → Account names who is signed in.
    let settings = app.buttons["hermie.toolbar.settings"]

    XCTAssertTrue(settings.waitForExistence(timeout: 10))
    settings.tap()
    app.buttons["hermie.settings.category.account"].tap()
    XCTAssertTrue(element(app, "hermie.settings.account.user").waitForExistence(timeout: 20))
    try audit(app)
  }

  // MARK: Native, in the in-app page

  func testANativeGatewaySignsInInsideHermie() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_NATIVE")
    let app = launch()

    try openSetup(app, address: address)
    primary(app).tap()

    let browser = app.buttons["hermie.onboarding.signInBrowser"]
    let inApp = app.buttons["hermie.onboarding.signInInApp"]

    XCTAssertTrue(browser.waitForExistence(timeout: 10))
    try audit(app)

    inApp.tap()

    // The fake gateway's own sign-in page, in the web view.
    let approve = app.webViews.buttons["Approve as tester"]

    XCTAssertTrue(approve.waitForExistence(timeout: 30))
    approve.tap()

    let status = element(app, "hermie.onboarding.signInStatus")

    XCTAssertTrue(status.waitForExistence(timeout: 30))
    XCTAssertTrue(status.label.contains("Fake Tester"), status.label)
    try audit(app)

    primary(app).tap()
    try finish(app, name: "Gated")
  }

  // MARK: The lock

  /// Locking takes the wizard down and must not end it: after unlocking, it is where it was.
  func testLockingDuringSetupHidesTheWizardAndKeepsIt() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_NONE")
    // The cold start's prompt is answered, the one after leaving refused (so the plate stays up to
    // be seen), and the tap on Unlock answered.
    let app = launch(["-HermieSeedLock", #"{"threshold":"immediately"}"#, "-HermieFakeAuth", "ok,fail,ok"])

    try openSetup(app, address: address)

    XCUIDevice.shared.press(.home)
    app.activate()

    let plate = app.otherElements["hermie.lock.plate"]

    XCTAssertTrue(plate.waitForExistence(timeout: 10))
    // Hidden while locked: nothing of the wizard is drawn.
    XCTAssertFalse(element(app, "hermie.onboarding.address").exists)

    app.buttons["hermie.lock.unlock"].tap()

    let field = element(app, "hermie.onboarding.address")

    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertEqual(field.value as? String, address)
    XCTAssertTrue(primary(app).isEnabled)
  }

  // MARK: The largest text size

  func testAnUngatedSetupPassesEveryAuditAtTheLargestTextSize() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_NONE")
    let app = launch(largestText: true)

    try openSetup(app, address: address)
    primary(app).tap()

    let token = app.secureTextFields["hermie.onboarding.token"]

    XCTAssertTrue(token.waitForExistence(timeout: 10))
    token.tap()
    token.typeText("any-token")
    try audit(app)

    primary(app).tap()
    try finish(app, name: "Large")
  }

  func testEveryStepPassesTheAuditAtTheLargestTextSize() throws {
    let address = try gateway("HERMIE_FAKE_GATEWAY_NATIVE")
    let app = launch(largestText: true)

    try openSetup(app, address: address)

    // Advanced, opened: the preset picker and the custom headers.
    let advanced = element(app, "hermie.onboarding.advanced")

    if advanced.waitForExistence(timeout: 5) {
      advanced.tap()
      try audit(app)
    }

    primary(app).tap()
    XCTAssertTrue(app.buttons["hermie.onboarding.signInBrowser"].waitForExistence(timeout: 10))
    try audit(app)

    app.buttons.matching(identifier: "hermie.onboarding.cancel").firstMatch.tap()
    XCTAssertTrue(app.buttons["hermie.welcome.setUp"].waitForExistence(timeout: 10))
  }
}

private extension String {
  func repeated(_ count: Int) -> String {
    String(repeating: self, count: count)
  }
}
