import XCTest

/**
 The primary native sign-in on a simulator: the system browser sheet (`ASWebAuthenticationSession`)
 and the loopback redirect into the app, against a fake gateway with the staged identity provider
 (`--auth native --idp staged`, `HERMIE_FAKE_GATEWAY_STAGED`). The sheet is another process's window
 (SafariViewService), and the question whether it may open the session is SpringBoard's; both are
 driven from here.

 It proves the parts nothing else can on a simulator: that the browser's redirect to
 `http://127.0.0.1:<port>/callback` reaches the app's listener while the sheet is up, and that the
 sheet then closes. It is skipped without the gateway.
 */
@MainActor
final class BrowserSignInUITests: XCTestCase {
  override func setUp() async throws {
    continueAfterFailure = false
  }

  func testANativeGatewaySignsInThroughTheSystemBrowserAndTheLoopback() throws {
    guard let address = ProcessInfo.processInfo.environment["HERMIE_FAKE_GATEWAY_STAGED"], !address.isEmpty else {
      throw XCTSkip("HERMIE_FAKE_GATEWAY_STAGED is not set: start a fake gateway with --auth native --idp staged.")
    }

    let app = XCUIApplication()

    app.launchArguments = ["-HermieUITest", "YES"]
    app.launch()

    let setUp = app.buttons["hermie.welcome.setUp"]

    XCTAssertTrue(setUp.waitForExistence(timeout: 10))
    setUp.tap()

    let field = app.descendants(matching: .any).matching(identifier: "hermie.onboarding.address").firstMatch

    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText(address)

    let next = app.buttons.matching(identifier: "hermie.onboarding.continue").firstMatch

    XCTAssertTrue(next.waitForExistence(timeout: 20))
    wait(for: [expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: next)], timeout: 30)
    next.tap()

    let browserButton = app.buttons["hermie.onboarding.signInBrowser"]

    XCTAssertTrue(browserButton.waitForExistence(timeout: 10))
    browserButton.tap()

    // SpringBoard asks whether Hermie may use the site to sign in: Cancel, then Continue (by
    // position, so the simulator's language does not matter).
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let question = springboard.alerts.firstMatch

    if question.waitForExistence(timeout: 15) {
      question.buttons.element(boundBy: question.buttons.count - 1).tap()
    }

    // The provider's pages, in the sheet. A browser that is still signed in at the provider (this
    // simulator ran the test before, against the same gateway) goes straight through instead.
    let sheet = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    let username = sheet.webViews.textFields.firstMatch
    let status = app.descendants(matching: .any).matching(identifier: "hermie.onboarding.signInStatus").firstMatch
    let signedIn = NSPredicate(format: "label CONTAINS 'Fake Tester'")

    for _ in 0..<60 where !username.exists && !signedIn.evaluate(with: status.exists ? status : nil) {
      Thread.sleep(forTimeInterval: 0.5)
    }

    if username.exists {
      username.tap()
      username.typeText("tester")

      let password = sheet.webViews.secureTextFields.firstMatch

      password.tap()
      password.typeText("hunter2")
      sheet.webViews.buttons["Sign in"].tap()

      // The system may offer to save the password; that sheet is not the provider's.
      let verify = sheet.webViews.buttons["Verify"]

      if !verify.waitForExistence(timeout: 10) {
        let offer = springboard.alerts.firstMatch.exists ? springboard.alerts.firstMatch : sheet.alerts.firstMatch

        if offer.exists {
          offer.buttons.element(boundBy: offer.buttons.count - 1).tap()
        }
      }

      XCTAssertTrue(verify.waitForExistence(timeout: 30), "the one-time-code form never showed")

      let code = sheet.webViews.textFields.firstMatch

      code.tap()
      code.typeText("246810")
      verify.tap()
    }

    // The loopback callback reached the app: the sheet closes and the step says who signed in.
    XCTAssertTrue(status.waitForExistence(timeout: 60), "the app never learned the sign-in finished")
    wait(for: [expectation(for: signedIn, evaluatedWith: status)], timeout: 60)
    XCTAssertFalse(sheet.webViews.firstMatch.exists, "the browser sheet stayed open")
  }
}
