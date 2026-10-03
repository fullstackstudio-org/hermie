import XCTest

/**
 Archiving and unarchiving a chat on a phone or a tablet, against a fake gateway of its own that
 `native/apple/scripts/test.sh --ui` starts on this Mac (`HERMIE_LIST_GATEWAY`, with the token the
 chat tests use). Without it the test is skipped.

 Archive is the row's trailing swipe; the row leaves the list and the archive's row appears at the
 bottom; that row opens the archive, where the trailing swipe unarchives, and the archive closes by
 itself once it is empty, with the chat back in the list.
 */
@MainActor
final class ChatListUITests: XCTestCase {
  private static let bot = "writer"
  private static let token = "ui-test-token"

  override func setUp() async throws {
    continueAfterFailure = false
  }

  override func tearDown() async throws {
    XCUIDevice.shared.orientation = .portrait
  }

  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  /// Welcome → address → token → name → the app, as `ChatScreenUITests` sets it up.
  private func launchWithGateway() throws -> XCUIApplication {
    guard let address = ProcessInfo.processInfo.environment["HERMIE_LIST_GATEWAY"], !address.isEmpty else {
      throw XCTSkip("HERMIE_LIST_GATEWAY is not set: run native/apple/scripts/test.sh --ui.")
    }

    let app = XCUIApplication()
    app.launchArguments = ["-HermieUITest", "YES"]
    app.launch()

    let setUp = app.buttons["hermie.welcome.setUp"]
    XCTAssertTrue(setUp.waitForExistence(timeout: 15))
    setUp.tap()

    let field = element(app, "hermie.onboarding.address")
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText(address)
    primary(app).tap()

    let token = app.secureTextFields["hermie.onboarding.token"]
    XCTAssertTrue(token.waitForExistence(timeout: 15))
    token.tap()
    token.typeText(Self.token)
    primary(app).tap()

    XCTAssertTrue(element(app, "hermie.onboarding.name").waitForExistence(timeout: 20))
    primary(app).tap()
    XCTAssertTrue(element(app, "hermie.onboarding.done").waitForExistence(timeout: 10))
    primary(app).tap()
    XCTAssertTrue(app.otherElements["hermie.root.split"].waitForExistence(timeout: 20))

    if UIDevice.current.userInterfaceIdiom == .pad {
      XCUIDevice.shared.orientation = .landscapeLeft
    }

    return app
  }

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

  private func waitUntilGone(_ element: XCUIElement, _ what: String) {
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
    wait(for: [gone], timeout: 10)
  }

  /// Swipe the row and press one of its trailing actions. On a wide row (an iPad) the swipe can run
  /// all the way and perform the first action (archive, unarchive) itself; the checks after it
  /// say whether the right thing happened.
  private func trailingAction(_ app: XCUIApplication, row: XCUIElement, _ identifier: String) {
    let action = app.buttons[identifier]

    for _ in 0..<3 where row.exists && !action.exists {
      row.swipeLeft()
      _ = action.waitForExistence(timeout: 1)
    }

    if action.exists {
      action.tap()
    }
  }

  func testArchiveAndUnarchiveAChat() throws {
    let app = try launchWithGateway()
    let row = element(app, "hermie.chatList.row.\(Self.bot)")
    let entry = element(app, "hermie.chatList.archived")

    XCTAssertTrue(element(app, "hermie.chatList.row.researcher").waitForExistence(timeout: 30))

    // The archive lives on the gateway, which the iPhone and the iPad runs share: a run that
    // stopped halfway leaves the bot archived, and this one starts by taking it back out.
    if !row.waitForExistence(timeout: 5), entry.exists {
      entry.tap()
      let leftover = element(app, "hermie.chatList.archive").descendants(matching: .any)
        .matching(identifier: "hermie.chatList.row.\(Self.bot)").firstMatch
      XCTAssertTrue(leftover.waitForExistence(timeout: 5))
      trailingAction(app, row: leftover, "hermie.chatList.action.unarchive")
    }

    XCTAssertTrue(row.waitForExistence(timeout: 10), "the chat list shows the bot")
    waitUntilGone(entry, "the archive row")

    // Archive: the row leaves the list and the archive row appears.
    trailingAction(app, row: row, "hermie.chatList.action.archive")
    waitUntilGone(row, "the archived row")
    XCTAssertTrue(entry.waitForExistence(timeout: 5), "the archive row appears")
    XCTAssertTrue(element(app, "hermie.chatList.row.researcher").exists, "the other chat stays")

    // The archive holds the chat.
    entry.tap()
    let archive = element(app, "hermie.chatList.archive")
    XCTAssertTrue(archive.waitForExistence(timeout: 5), "the archive opens")
    let archived = archive.descendants(matching: .any).matching(identifier: "hermie.chatList.row.\(Self.bot)").firstMatch
    XCTAssertTrue(archived.waitForExistence(timeout: 5), "the archive shows the chat")

    // Unarchive: the archive empties, closes, and the chat is back in the list.
    trailingAction(app, row: archived, "hermie.chatList.action.unarchive")
    waitUntilGone(archive, "the archive")
    XCTAssertTrue(row.waitForExistence(timeout: 5), "the chat is back in the list")
    XCTAssertFalse(entry.exists, "no archive row once nothing is archived")
  }
}
