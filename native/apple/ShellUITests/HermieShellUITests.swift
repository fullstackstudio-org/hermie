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

  /// The largest accessibility text size (AX5), as a launch argument.
  private static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

  /// English, whatever the simulator's language: for the tests that find a control by its label.
  private static let english = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]

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

   One exclusion (besides `scrolling`, below): the clipped-text warning on the chat list's search
   field in the iPad sidebar, a system `UISearchBar` that keeps one height at every text size.
   */
  private func audit(
    _ app: XCUIApplication, scrolling: Bool = false, unattributed: Bool = true, file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    var issues: [String] = []
    // A page taller than the screen: the Dynamic Type check reports every text that a larger size
    // would push past the bottom edge as "partially unsupported", whatever its font. Such pages are
    // audited without that one check, and audited again at AX5, where clipped text is still caught.
    let types: XCUIAccessibilityAuditType = scrolling ? XCUIAccessibilityAuditType.all.subtracting(.dynamicType) : .all

    try app.performAccessibilityAudit(for: types) { issue in
      if issue.auditType == .textClipped, issue.element?.elementType == .searchField {
        return true
      }

      // See `unattributed: false` where it is passed.
      if !unattributed, issue.element == nil {
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
    let app = launch(
      [
        "-HermieSeedGateway", "Home|\(Self.home)",
        "-HermieSeedGateway", "Work|\(Self.work)",
        "-HermieFakeAuth", "fail,ok"
      ] + Self.english)

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
    waitForSyncToSettle(app)
    // With the iCloud Sync row above the list, the page is taller than the screen at large sizes;
    // testTheICloudPageShowsEachGatewayAndPassesTheAuditAtEverySize audits it at AX5.
    try audit(app, scrolling: true)

    // About.
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["hermie.settings.category.about"].tap()
    XCTAssertTrue(app.collectionViews["hermie.settings.about"].waitForExistence(timeout: 5))
    try audit(app)
  }

  // MARK: iCloud Sync

  /// Settings → Gateways, from the main window.
  private func openGatewaysSettings(_ app: XCUIApplication) {
    let settingsButton = app.buttons["hermie.toolbar.settings"]

    XCTAssertTrue(settingsButton.waitForExistence(timeout: 10))
    settingsButton.tap()
    XCTAssertTrue(app.buttons["hermie.settings.category.gateways"].waitForExistence(timeout: 5))
    app.buttons["hermie.settings.category.gateways"].tap()
  }

  /// Settings → Gateways → iCloud Sync.
  private func openICloudSettings(_ app: XCUIApplication) {
    openGatewaysSettings(app)
    let row = element(app, "hermie.settings.icloud")

    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    XCTAssertTrue(element(app, "hermie.settings.icloud.switch").waitForExistence(timeout: 5))
  }

  private func syncSwitch(_ app: XCUIApplication) -> XCUIElement {
    app.switches.matching(identifier: "hermie.settings.icloud.switch").firstMatch
  }

  /**
   Wait until the sync the page started has settled: opening Settings → Gateways reconciles, and a
   gateway the launch published turns from "Waiting to sync" to synced when that reconcile reads it
   back. An audit that runs across that change sees rows redrawn under it. English launches only.
   */
  private func waitForSyncToSettle(_ app: XCUIApplication, rows identifier: String = "hermie.settings.gateway") {
    let waiting = app.descendants(matching: .any).matching(identifier: identifier)
      .matching(NSPredicate(format: "label CONTAINS 'Waiting to sync'"))
    expectation(for: NSPredicate(format: "count == 0"), evaluatedWith: waiting)
    waitForExpectations(timeout: 10)
  }

  /// Flip a form toggle: its own switch when it exposes one, else the row.
  private func flip(_ toggle: XCUIElement) {
    let inner = toggle.switches.firstMatch
    (inner.exists ? inner : toggle).tap()
  }

  /// "Remove from This Device" keeps the gateway in iCloud Keychain, and Settings offers it back.
  func testAGatewayRemovedFromThisDeviceIsOfferedBack() throws {
    let app = launch(["-HermieSeedGateway", "Home|\(Self.home)", "-HermieSeedGateway", "Work|\(Self.work)"] + Self.english)

    openGatewaysSettings(app)
    let rows = app.buttons.matching(identifier: "hermie.settings.gateway")
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(rows.count, 2)

    rows.firstMatch.swipeLeft()
    let remove = app.buttons["Remove this gateway"].firstMatch
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    remove.tap()
    let thisDevice = app.buttons["hermie.settings.gateway.remove.thisDevice"].firstMatch
    XCTAssertTrue(thisDevice.waitForExistence(timeout: 5))
    thisDevice.tap()

    let add = app.buttons["hermie.settings.icloud.available.add"]
    XCTAssertTrue(add.waitForExistence(timeout: 10))
    waitForSyncToSettle(app)
    try audit(app, scrolling: true)
    add.tap()

    // The seeded gateway has no session token in iCloud: the sign-in sheet opens for it, the same
    // one "Sign in" opens. Closed, the gateway stays, saying "Sign in needed".
    let signIn = element(app, "hermie.signIn")
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
    app.buttons.matching(identifier: "hermie.onboarding.cancel").firstMatch.tap()
    XCTAssertTrue(signIn.waitForNonExistence(timeout: 5))

    XCTAssertFalse(add.exists)
    expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: rows)
    waitForExpectations(timeout: 10)
    let needing = rows.matching(NSPredicate(format: "label CONTAINS 'Sign in needed'"))
    XCTAssertEqual(needing.count, 1)
  }

  /// Setup on a new device looks in iCloud Keychain first, and one tap takes what is there.
  func testSetupOffersTheGatewaysInICloudAndTakesThemInOneTap() throws {
    let app = launch(["-HermieSync", "ask", "-HermieSeedICloudGateway", "Office|https://office.test|tok-office"])

    XCTAssertTrue(app.buttons["hermie.welcome.setUp"].waitForExistence(timeout: 10))
    app.buttons["hermie.welcome.setUp"].tap()

    let use = app.buttons["hermie.onboarding.icloud.use"]
    XCTAssertTrue(use.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Office"].exists)
    // Issues the audit cannot attach to an element are left out here, as OnboardingUITests does on
    // this sheet: on iPad it reports one it cannot name on the form sheet, where this section sits
    // above the empty address field (that step is audited, filled in, by OnboardingUITests). Every
    // element it can name is checked.
    try audit(app, scrolling: true, unattributed: false)
    use.tap()

    // A session-token gateway needs nothing more: setup closes on it, and nothing asks again.
    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 10))
    XCTAssertFalse(element(app, "hermie.icloud.disclosure").waitForExistence(timeout: 3))
  }

  /// A gateway taken in setup whose sign-in cannot travel continues with the sign-in step.
  func testSetupContinuesWithTheSignInForAGatewayFromICloudThatNeedsOne() throws {
    let app = launch(["-HermieSync", "ask", "-HermieSeedICloudGateway", "Lab|https://lab.test"])

    XCTAssertTrue(app.buttons["hermie.welcome.setUp"].waitForExistence(timeout: 10))
    app.buttons["hermie.welcome.setUp"].tap()

    let use = app.buttons["hermie.onboarding.icloud.use"]
    XCTAssertTrue(use.waitForExistence(timeout: 10))
    use.tap()

    XCTAssertTrue(element(app, "hermie.signIn").waitForExistence(timeout: 10))
  }

  func testTheDisclosureIsAskedBeforeAnythingIsStoredAndAcceptingTurnsSyncOn() throws {
    let app = launch(["-HermieSync", "ask", "-HermieSeedGateway", "Home|\(Self.home)"] + Self.english)
    let sheet = element(app, "hermie.icloud.disclosure")

    XCTAssertTrue(sheet.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Home"].exists, "the sheet names what would be stored")
    try audit(app, scrolling: true)

    app.buttons["hermie.icloud.disclosure.accept"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))

    openICloudSettings(app)
    XCTAssertEqual(syncSwitch(app).value as? String, "1")
    XCTAssertTrue(element(app, "hermie.settings.icloud.gateway").waitForExistence(timeout: 5))
    waitForSyncToSettle(app, rows: "hermie.settings.icloud.gateway")
    try audit(app, scrolling: true)
  }

  func testTheDisclosurePassesTheAuditAtAX5() throws {
    let app = launch(["-HermieSync", "ask", "-HermieSeedGateway", "Home|\(Self.home)"] + Self.ax5)

    XCTAssertTrue(element(app, "hermie.icloud.disclosure").waitForExistence(timeout: 10))
    try audit(app, scrolling: true)
  }

  func testDecliningTheDisclosureKeepsSyncOffAndTurningItOnAsksAgain() throws {
    let app = launch(["-HermieSync", "ask", "-HermieSeedGateway", "Home|\(Self.home)"])
    let sheet = element(app, "hermie.icloud.disclosure")

    XCTAssertTrue(sheet.waitForExistence(timeout: 10))
    app.buttons["hermie.icloud.disclosure.decline"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))

    openICloudSettings(app)
    XCTAssertEqual(syncSwitch(app).value as? String, "0")
    XCTAssertFalse(element(app, "hermie.settings.icloud.gateway").exists, "no per-gateway rows while off")
    XCTAssertFalse(element(app, "hermie.settings.icloud.syncNow").exists)

    // On again: the same question first, and declining leaves it off.
    flip(syncSwitch(app))
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    app.buttons["hermie.icloud.disclosure.decline"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
    XCTAssertEqual(syncSwitch(app).value as? String, "0")
  }

  /// A gateway in iCloud Keychain is not looked at before the answer, and after it, it comes over
  /// without typing.
  func testAGatewayInICloudArrivesOnlyAfterTheAnswer() throws {
    let app = launch([
      "-HermieSync", "ask",
      "-HermieSeedGateway", "Home|\(Self.home)",
      "-HermieSeedICloudGateway", "Office|https://office.test|tok-office"
    ])
    let sheet = element(app, "hermie.icloud.disclosure")

    XCTAssertTrue(sheet.waitForExistence(timeout: 10))
    app.buttons["hermie.icloud.disclosure.accept"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))

    openGatewaysSettings(app)
    let rows = app.buttons.matching(identifier: "hermie.settings.gateway")
    expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: rows)
    waitForExpectations(timeout: 10)
  }

  func testAnUnavailableStoreNeverAsksAndSaysSoInSettings() throws {
    let app = launch(["-HermieSync", "unavailable", "-HermieSeedGateway", "Home|\(Self.home)"])

    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 10))
    XCTAssertFalse(element(app, "hermie.icloud.disclosure").waitForExistence(timeout: 3))

    openICloudSettings(app)
    XCTAssertFalse(syncSwitch(app).isEnabled)
    XCTAssertTrue(element(app, "hermie.settings.icloud.detail").exists)
    XCTAssertFalse(element(app, "hermie.settings.icloud.deleteEverything").exists)
    try audit(app, scrolling: true)
  }

  func testTheICloudPageShowsEachGatewayAndPassesTheAuditAtEverySize() throws {
    for arguments in [[], Self.ax5] {
      let large = !arguments.isEmpty
      let app = launch(
        ["-HermieSeedGateway", "Home|\(Self.home)", "-HermieSeedGateway", "Work|\(Self.work)"] + Self.english
          + arguments)

      openGatewaysSettings(app)
      XCTAssertTrue(element(app, "hermie.settings.icloud").waitForExistence(timeout: 5))
      waitForSyncToSettle(app)
      try audit(app, scrolling: true)

      element(app, "hermie.settings.icloud").tap()
      XCTAssertTrue(syncSwitch(app).waitForExistence(timeout: 5))
      XCTAssertEqual(syncSwitch(app).value as? String, "1")
      let rows = app.descendants(matching: .any).matching(identifier: "hermie.settings.icloud.gateway")
      if !large {
        // At AX5 the rows start below the screen's edge; at the default size both are in view.
        XCTAssertEqual(rows.count, 2)
      }
      waitForSyncToSettle(app, rows: "hermie.settings.icloud.gateway")
      try audit(app, scrolling: true)

      if large {
        app.terminate()
        continue
      }

      // "Sync this gateway" off for one: it says so and stays.
      flip(rows.firstMatch)
      let deviceOnly = rows.matching(NSPredicate(format: "label CONTAINS 'This device only'")).firstMatch
      XCTAssertTrue(deviceOnly.waitForExistence(timeout: 5))

      // Delete everything: the confirmation says what happens before anything does.
      let delete = app.buttons["hermie.settings.icloud.deleteEverything"]
      for _ in 0..<6 where !delete.isHittable { app.swipeUp() }
      delete.tap()
      let confirm = app.buttons["hermie.settings.icloud.deleteEverything.confirm"].firstMatch
      XCTAssertTrue(confirm.waitForExistence(timeout: 5))
      confirm.tap()
      for _ in 0..<6 where !app.buttons["hermie.settings.icloud.gateway.syncAgain"].exists { app.swipeDown() }
      XCTAssertTrue(app.buttons["hermie.settings.icloud.gateway.syncAgain"].firstMatch.waitForExistence(timeout: 5))

      app.terminate()
    }
  }

  func testTurningSyncOffAsksWhetherToRemoveFromICloud() throws {
    let app = launch(["-HermieSeedGateway", "Home|\(Self.home)"])

    openICloudSettings(app)
    XCTAssertEqual(syncSwitch(app).value as? String, "1")
    flip(syncSwitch(app))

    let remove = app.buttons["hermie.settings.icloud.turnOff.remove"].firstMatch
    let keep = app.buttons["hermie.settings.icloud.turnOff.keep"].firstMatch
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    XCTAssertTrue(keep.exists)
    keep.tap()

    expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: syncSwitch(app))
    waitForExpectations(timeout: 5)
  }

  /// A synced gateway is removed from this device or from all; one that is not synced only here.
  func testRemovingASyncedGatewayOffersBothScopes() throws {
    for (sync, scoped) in [("on", true), ("off", false)] {
      let app = launch(["-HermieSync", sync, "-HermieSeedGateway", "Home|\(Self.home)"] + Self.english)

      openGatewaysSettings(app)
      let row = app.buttons["hermie.settings.gateway"]
      XCTAssertTrue(row.waitForExistence(timeout: 5))

      row.swipeLeft()
      let remove = app.buttons["Remove this gateway"].firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 5))
      remove.tap()

      let thisDevice = app.buttons["hermie.settings.gateway.remove.thisDevice"].firstMatch
      let allDevices = app.buttons["hermie.settings.gateway.remove.allDevices"].firstMatch
      let plain = app.buttons["hermie.settings.gateway.remove.confirm"].firstMatch

      if scoped {
        XCTAssertTrue(thisDevice.waitForExistence(timeout: 5))
        XCTAssertTrue(allDevices.exists)
        allDevices.tap()
      } else {
        XCTAssertTrue(plain.waitForExistence(timeout: 5))
        XCTAssertFalse(allDevices.exists)
        plain.tap()
      }

      XCTAssertTrue(row.waitForNonExistence(timeout: 5))
      app.terminate()
    }
  }
}
