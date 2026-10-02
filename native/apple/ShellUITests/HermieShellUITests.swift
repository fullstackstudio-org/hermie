import HermieGateway
import XCTest

/**
 The app shell on a simulator: the first frame, the lock, deep links, the split view and the
 accessibility audits. Run with `native/apple/scripts/test.sh --ui`, which creates a throwaway
 iPhone and iPad for the run and deletes them afterwards.

 Every launch passes `-HermieUITest YES`, so the app runs on a fresh data directory of its own with a
 scripted authenticator (debug builds only; see `LaunchTestHooks`).
 */
@MainActor
final class HermieShellUITests: XCTestCase {
  private static let home = "http://home.test:9119"
  private static let work = "https://work.test"

  override func setUp() async throws {
    continueAfterFailure = false
  }

  private func launch(_ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()

    app.launchArguments = ["-HermieUITest", "YES"] + arguments
    app.launch()

    return app
  }

  private var isPad: Bool {
    UIDevice.current.userInterfaceIdiom == .pad
  }

  /// An element by identifier, whatever its type.
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  /**
   The system audit, with every issue it finds written to the log before it fails the test.

   One exclusion: the clipped-text warning on the chat list's search field in the iPad sidebar, a
   system `UISearchBar` that keeps one height at every text size.
   */
  private func audit(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
    var issues: [String] = []

    try app.performAccessibilityAudit { issue in
      if issue.auditType == .textClipped, issue.element?.elementType == .searchField {
        return true
      }

      issues.append(
        "\(issue.compactDescription): \(issue.detailedDescription) — \(issue.element?.debugDescription ?? "no element")"
      )
      return true
    }

    XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n"), file: file, line: line)
  }

  // MARK: Launch

  func testColdLaunchShowsTheWelcomeAndOpensSetup() throws {
    let app = launch()

    XCTAssertTrue(app.buttons["hermie.welcome.setUp"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.otherElements["hermie.lock.plate"].exists)

    try audit(app)

    app.buttons["hermie.welcome.setUp"].tap()
    XCTAssertTrue(element(app, "hermie.onboarding.address").waitForExistence(timeout: 5))
  }

  /// The first frame with a lock configured is never the app: the gate draws nothing, then the plate.
  func testALockedLaunchShowsThePlateFirstAndUnlocks() throws {
    let app = launch([
      "-HermieSeedLock", #"{"threshold":"5m"}"#,
      "-HermieSeedGateway", "Home|\(Self.home)",
      // The automatic prompt at launch is refused, so the plate stays up for the test to see.
      "-HermieFakeAuth", "fail,ok",
      "-HermieLaunchTrace", "YES"
    ])

    let plate = app.otherElements["hermie.lock.plate"]
    let trace = app.staticTexts["hermie.launchTrace"]

    XCTAssertTrue(plate.waitForExistence(timeout: 10))
    XCTAssertTrue(trace.waitForExistence(timeout: 5))

    // Everything the gates drew so far, in order: never the content, never the root.
    let before = try XCTUnwrap(trace.value as? String)
    XCTAssertFalse(before.contains("content"), before)
    XCTAssertFalse(before.contains("root"), before)
    XCTAssertTrue(before == "pending>plate" || before == "plate", before)
    XCTAssertFalse(app.otherElements["hermie.root.split"].exists)
    XCTAssertFalse(app.otherElements["hermie.welcome"].exists)

    app.buttons["hermie.lock.unlock"].tap()

    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 10))
    XCTAssertFalse(plate.exists)

    let after = try XCTUnwrap(trace.value as? String)
    XCTAssertTrue(after.hasPrefix(before + ">content"), after)
  }

  func testTheLockPlatePassesTheAccessibilityAudit() throws {
    let app = launch(["-HermieSeedLock", #"{"threshold":"immediately"}"#, "-HermieFakeAuth", "fail"])

    XCTAssertTrue(app.otherElements["hermie.lock.plate"].waitForExistence(timeout: 10))
    try audit(app)
  }

  func testAnUnreadableLockSettingFailsClosed() throws {
    let app = launch(["-HermieSeedLock", "{not json", "-HermieFakeAuth", "fail"])

    XCTAssertTrue(app.otherElements["hermie.lock.plate"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.otherElements["hermie.welcome"].exists)
  }

  // MARK: Links and the split view

  func testADeepLinkOpensTheRightChatOnTheRightGateway() throws {
    let key = GatewayKey.of(Self.work)
    let app = launch([
      "-HermieSeedGateway", "Home|\(Self.home)",
      "-HermieSeedGateway", "Work|\(Self.work)",
      "-HermieOpenURL", "hermie://chat/alice?gateway=\(key)"
    ])

    let chat = element(app, "hermie.chat")

    XCTAssertTrue(chat.waitForExistence(timeout: 10))
    XCTAssertEqual(chat.value as? String, "alice")
    XCTAssertTrue(app.staticTexts["alice"].exists)

    // The link named the second gateway, so it is now the live one: the sidebar is titled with it.
    if isPad {
      XCUIDevice.shared.orientation = .landscapeLeft
      XCTAssertTrue(app.staticTexts["Work"].waitForExistence(timeout: 5))
      XCUIDevice.shared.orientation = .portrait
    }
  }

  func testALinkDeliveredWhileRunningOpensTheChat() throws {
    let app = launch(["-HermieSeedGateway", "Home|\(Self.home)"])

    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 10))

    app.open(URL(string: "hermie://chat/bob")!)

    let chat = element(app, "hermie.chat")

    XCTAssertTrue(chat.waitForExistence(timeout: 10))
    XCTAssertEqual(chat.value as? String, "bob")
  }

  func testALinkForAnUnknownGatewaySaysSoAndOpensNothing() throws {
    let app = launch([
      "-HermieSeedGateway", "Home|\(Self.home)",
      "-HermieOpenURL", "hermie://chat/mallory?gateway=0123456789abcdef"
    ])

    XCTAssertTrue(app.otherElements["hermie.notice"].waitForExistence(timeout: 10))
    XCTAssertFalse(element(app, "hermie.chat").exists)
  }

  func testTheSplitViewShowsTheListBesideTheChatOnIPadAndStacksOnIPhone() throws {
    let app = launch([
      "-HermieSeedGateway", "Home|\(Self.home)",
      "-HermieOpenURL", "hermie://chat/alice"
    ])

    XCTAssertTrue(element(app, "hermie.chat").waitForExistence(timeout: 10))

    if isPad {
      XCUIDevice.shared.orientation = .landscapeLeft
      XCTAssertTrue(element(app, "hermie.chatList").waitForExistence(timeout: 5))
      XCTAssertTrue(element(app, "hermie.chat").exists)
      XCUIDevice.shared.orientation = .portrait
    } else {
      // Collapsed: the chat is pushed over the list; back closes it.
      XCTAssertFalse(element(app, "hermie.chatList").isHittable)
      app.navigationBars.buttons.element(boundBy: 0).tap()
      XCTAssertTrue(element(app, "hermie.chatList").waitForExistence(timeout: 5))
    }

    try audit(app)
  }

  // MARK: Settings

  func testSettingsPassTheAuditAndTheLockChangesOnlyAfterAuthenticating() throws {
    let app = launch([
      "-HermieSeedGateway", "Home|\(Self.home)",
      "-HermieSeedGateway", "Work|\(Self.work)",
      "-HermieFakeAuth", "fail,ok"
    ])

    let settingsButton = app.buttons["hermie.toolbar.settings"]

    XCTAssertTrue(settingsButton.waitForExistence(timeout: 10))
    settingsButton.tap()

    XCTAssertTrue(app.buttons["hermie.settings.category.privacy"].waitForExistence(timeout: 5))
    try audit(app)

    // Privacy → Require unlock → 5 min: the first prompt is refused and nothing changes.
    app.buttons["hermie.settings.category.privacy"].tap()
    app.buttons["hermie.settings.lock"].tap()

    let fiveMinutes = app.buttons["hermie.lock.option.5m"]

    XCTAssertTrue(fiveMinutes.waitForExistence(timeout: 5))
    try audit(app)

    fiveMinutes.tap()
    XCTAssertTrue(app.staticTexts["hermie.lock.footer"].waitForExistence(timeout: 5))
    XCTAssertFalse(fiveMinutes.isSelected)

    // The second is accepted: the page goes back and the row shows the new value.
    fiveMinutes.tap()
    let lockRow = app.buttons["hermie.settings.lock"]

    XCTAssertTrue(lockRow.waitForExistence(timeout: 5))
    XCTAssertTrue(lockRow.label.contains("5"), lockRow.label)

    // Gateways: both listed.
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["hermie.settings.category.gateways"].tap()
    XCTAssertEqual(app.buttons.matching(identifier: "hermie.settings.gateway").count, 2)
    try audit(app)

    // About.
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["hermie.settings.category.about"].tap()
    XCTAssertTrue(app.collectionViews["hermie.settings.about"].waitForExistence(timeout: 5))
    try audit(app)
  }
}
