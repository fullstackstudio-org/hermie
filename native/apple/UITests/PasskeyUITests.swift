import XCTest

/// The passkey confirm sheet and the Passkeys page, against the fake gateway the test script starts
/// on the host with `--auth native --passkey` (`TEST_RUNNER_HERMIE_PASSKEY_GATEWAY`), in the lab's
/// passkey screen: the real request area, notices and settings page over a session whose passkey
/// model runs the lab's software authenticator (no system sheet). The tests raise confirmations
/// through `/__fake/request` and read what the gateway recorded from `/__fake/state`.
///
/// The fake gateway lets a person start five enrolments per ten minutes, so one passkey ("the
/// phone", the same key and credential id on every launch of this run) is enrolled once, by the
/// first test that needs it, and the others launch it. A test of enrolling itself uses a phone of
/// its own.
@MainActor
final class PasskeyUITests: XCTestCase {
  private var gateway = ""

  /// The phone most tests use: one passkey for the whole run.
  private static let phone = "ui-phone-\(UUID().uuidString)"

  override func setUp() async throws {
    continueAfterFailure = false

    guard let address = ProcessInfo.processInfo.environment["HERMIE_PASSKEY_GATEWAY"], !address.isEmpty else {
      throw XCTSkip("No passkey fake gateway: run through scripts/test.sh --ui, which starts one.")
    }

    gateway = address
    // Nothing from an earlier test is still waiting, and the per-conversation limits start over.
    _ = try call("POST", "/__fake/passkey/expire", body: [:])
    _ = try call("POST", "/__fake/passkey/expire", body: ["window": true])
  }

  // MARK: Enrolling

  func testANewPhoneIsNotEnrolledAndSaysHowToAddOne() throws {
    let app = launchLab(phone: "new-\(UUID().uuidString)")
    openPasskeysPage(app)

    XCTAssertTrue(element(app, "hermie.passkeys.state").label.contains("No passkey for this gateway yet"))
    XCTAssertTrue(element(app, "hermie.passkeys.code").exists, "a code can be entered")
    XCTAssertFalse(element(app, "hermie.passkeys.credential").exists, "no passkey is listed")
    XCTAssertFalse(element(app, "hermie.passkeys.invite").exists, "no code can be made without a passkey")

    let add = element(app, "hermie.passkeys.add")
    XCTAssertFalse(add.isEnabled, "nothing typed, nothing to add")

    // A code that cannot be one is said so, in words, without asking the gateway.
    type("not a code", into: element(app, "hermie.passkeys.code"))
    tapWhenEnabled(add)
    XCTAssertTrue(element(app, "hermie.passkeys.failure").waitForExistence(timeout: 10))
    XCTAssertTrue(element(app, "hermie.passkeys.failure").label.contains("does not look right"))

    try auditPage(app, "not enrolled")
  }

  func testAPasskeyIsEnrolledWithACodeThenACodeIsMadeAndThePasskeyRemoved() throws {
    let app = launchLab(phone: "own-\(UUID().uuidString)")
    openPasskeysPage(app)

    let code = try operatorCode()
    type(code, into: element(app, "hermie.passkeys.code"))
    tapWhenEnabled(element(app, "hermie.passkeys.add"))

    let row = element(app, "hermie.passkeys.credential")
    XCTAssertTrue(row.waitForExistence(timeout: 30), "the passkey is listed once the gateway took it")
    XCTAssertTrue(row.label.contains("Lab phone"), "named by the app, after the display name: \(row.label)")
    XCTAssertTrue(row.label.contains("Never used"))
    XCTAssertTrue(waitForLabel(element(app, "hermie.passkeys.state"), contains: "on for this gateway"))

    // A code for another device: the passkey asks (the soft one answers), the code is shown with
    // when it expires, and can be copied.
    let invite = element(app, "hermie.passkeys.invite")
    XCTAssertTrue(invite.waitForExistence(timeout: 10))
    tapWhenEnabled(invite)
    let shown = element(app, "hermie.passkeys.invite.code")
    XCTAssertTrue(shown.waitForExistence(timeout: 30), "the code is shown")
    XCTAssertGreaterThanOrEqual(shown.label.count, 20, "a full code: \(shown.label.count) characters")
    XCTAssertTrue(element(app, "hermie.passkeys.invite.expires").exists)
    XCTAssertTrue(element(app, "hermie.passkeys.invite.copy").exists)
    tapWhenHittable(element(app, "hermie.passkeys.invite.hide"))
    XCTAssertTrue(shown.waitForNonExistence(timeout: 10), "the code goes when it is hidden")

    // Removing asks first, and says what it does.
    tapWhenHittable(element(app, "hermie.passkeys.remove"))
    let confirm = element(app, "hermie.passkeys.remove.confirm")
    XCTAssertTrue(confirm.waitForExistence(timeout: 10), "a confirmation before anything is removed")
    tapWhenHittable(confirm)
    XCTAssertTrue(row.waitForNonExistence(timeout: 30), "the passkey is gone")
    XCTAssertTrue(waitForLabel(element(app, "hermie.passkeys.state"), contains: "No passkey for this gateway yet"))
  }

  func testAPasskeyAddedElsewhereIsAnnounced() throws {
    let app = launchEnrolled()

    let body: [String: Any] = [
      "change": "added",
      "credential": ["id": "AAECAwQFBgcICQoLDA0ODw", "name": "Another laptop", "rp_id": "confirm.hermie.dev"]
    ]
    _ = try call("POST", "/__fake/passkey/changed", body: body)

    let notice = element(app, "hermie.passkeys.notice.text")
    XCTAssertTrue(notice.waitForExistence(timeout: 20), "never a silent change")
    XCTAssertTrue(notice.label.contains("Another laptop"), notice.label)
  }

  // MARK: The sheet

  func testConfirmingWithAPasskeyAnswersAndCloses() throws {
    let app = launchEnrolled()
    let detail = "rm -rf ./backups/2025-*\n    (3 directories)"
    let id = try raise(title: "Delete backups", summary: "Delete 3 old backups.", detail: detail)

    let title = element(app, "confirm.title")
    XCTAssertTrue(title.waitForExistence(timeout: 20), "the sheet comes up")
    XCTAssertTrue(title.label.contains("researcher"), "the app names who asks: \(title.label)")
    XCTAssertTrue(element(app, "confirm.gateway").label.contains("Lab"), "and which gateway")
    let host = element(app, "confirm.host").label
    XCTAssertTrue(gateway.hasSuffix(host), "and its address: \(host)")
    XCTAssertEqual(element(app, "confirm.requestTitle").label, "Delete backups")
    XCTAssertEqual(element(app, "confirm.summary").label, "Delete 3 old backups.")
    XCTAssertTrue(element(app, "confirm.note").label.contains("confirm.hermie.dev"), "the name the system sheet will show")
    XCTAssertTrue(element(app, "confirm.countdown").exists, "the time left is counted down")

    // Esc and a swipe do not put it away.
    app.swipeDown()
    XCTAssertTrue(element(app, "confirm.sheet").exists, "an open confirmation stays")

    let confirm = element(app, "confirm.confirm")
    XCTAssertEqual(confirm.label, "Confirm with passkey", "fixed wording")
    XCTAssertEqual(element(app, "confirm.decline").label, "Decline")
    tapWhenEnabled(confirm)

    XCTAssertTrue(waitForLabel(element(app, "confirm.status"), contains: "received"), "the answer is received, not yet confirmed")
    XCTAssertTrue(element(app, "confirm.sheet").waitForNonExistence(timeout: 20), "and the sheet closes")

    let outcome = try waitForOutcome(id)
    XCTAssertEqual(outcome["outcome"] as? String, "confirmed")
    XCTAssertEqual(outcome["method"] as? String, "passkey")
    XCTAssertEqual(outcome["verified"] as? Bool, true, "the gateway verified it itself")
  }

  func testDecliningSendsNoAssertion() throws {
    let app = launchEnrolled()
    let id = try raise(title: "Send the report", summary: "Mail the report to everyone.", detail: nil)

    let decline = element(app, "confirm.decline")
    XCTAssertTrue(decline.waitForExistence(timeout: 20))
    tapWhenEnabled(decline)

    XCTAssertTrue(waitForLabel(element(app, "confirm.status"), contains: "declined"))
    XCTAssertTrue(element(app, "confirm.sheet").waitForNonExistence(timeout: 20))

    let outcome = try waitForOutcome(id)
    XCTAssertEqual(outcome["outcome"] as? String, "declined")
    XCTAssertEqual(outcome["method"] as? String, "tap")
    XCTAssertEqual(outcome["verified"] as? Bool, false)
  }

  func testTheDetailKeepsEveryLineBreakAndIsNeverCut() throws {
    let app = launchEnrolled()
    let long = String(repeating: "--flag=value ", count: 18) + "end"
    let detail = "first line\n\n    third line, indented\n\(long)"
    _ = try raise(title: "Run a command", summary: "Runs a long command.", detail: detail)

    let shown = element(app, "confirm.detail")
    XCTAssertTrue(shown.waitForExistence(timeout: 20))
    XCTAssertEqual(shown.label, detail, "the text as sent: line breaks, blank line, indentation and the long line whole")
    XCTAssertEqual(shown.label.components(separatedBy: "\n").count, 4, "four lines, not one wrapped paragraph")
  }

  func testATimeoutDuringTheSheetEndsItWithANoticeAndAClose() throws {
    let app = launchEnrolled()
    _ = try raise(title: "Delete backups", summary: "Delete 3 old backups.", detail: nil)
    XCTAssertTrue(element(app, "confirm.confirm").waitForExistence(timeout: 20))

    _ = try call("POST", "/__fake/passkey/expire", body: [:])

    XCTAssertTrue(waitForLabel(element(app, "confirm.status"), contains: "timed out"), "the end is said")
    XCTAssertFalse(element(app, "confirm.confirm").exists, "nothing can be confirmed any more")
    XCTAssertFalse(element(app, "confirm.decline").exists)
    let close = element(app, "confirm.close")
    XCTAssertTrue(close.exists)
    tapWhenHittable(close)
    XCTAssertTrue(element(app, "confirm.sheet").waitForNonExistence(timeout: 10))
  }

  func testARefusedAnswerIsARetryableState() throws {
    let app = launchEnrolled(tamper: "once")
    let id = try raise(title: "Delete backups", summary: "Delete 3 old backups.", detail: nil)

    let confirm = element(app, "confirm.confirm")
    XCTAssertTrue(confirm.waitForExistence(timeout: 20))
    tapWhenEnabled(confirm)

    // The first answer was wrong on purpose: the gateway says no, the sheet says why in words and
    // stays, with the same two buttons.
    XCTAssertTrue(waitForLabel(element(app, "confirm.status"), contains: "did not accept"))
    XCTAssertTrue(element(app, "confirm.sheet").exists)
    XCTAssertEqual(confirm.label, "Confirm with passkey", "the button does not change its words")
    XCTAssertTrue(element(app, "confirm.decline").exists)

    // Trying again goes through.
    tapWhenEnabled(confirm)
    XCTAssertTrue(element(app, "confirm.sheet").waitForNonExistence(timeout: 30))
    let outcome = try waitForOutcome(id)
    XCTAssertEqual(outcome["outcome"] as? String, "confirmed")
    XCTAssertEqual(outcome["verified"] as? Bool, true)
  }

  func testTheSheetPassesTheAccessibilityAudit() throws {
    let app = launchEnrolled()
    _ = try raise(title: "Delete backups", summary: "Delete 3 old backups.", detail: "rm -rf ./backups\n(3 directories)")
    XCTAssertTrue(element(app, "confirm.confirm").waitForExistence(timeout: 20))
    try auditSheet(app, "default size")
  }

  func testTheSheetPassesTheAccessibilityAuditAtTheLargestSize() throws {
    let app = launchEnrolled(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    _ = try raise(title: "Delete backups", summary: "Delete 3 old backups.", detail: "rm -rf ./backups\n(3 directories)")
    XCTAssertTrue(element(app, "confirm.confirm").waitForExistence(timeout: 20))
    try auditSheet(app, "AX5")
  }

  // MARK: Launching

  /// The lab with a phone, once it has heard from the gateway.
  private func launchLab(phone: String, tamper: String? = nil, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    var launch = [
      "-HermieLabScreen", "passkeys", "-HermieLabGateway", gateway, "-HermiePasskeyPhone", phone
    ]

    if let tamper {
      launch += ["-HermiePasskeyTamper", tamper]
    }

    app.launchArguments = launch + arguments
    app.launch()

    let status = element(app, "passkeyLab.status")
    XCTAssertTrue(status.waitForExistence(timeout: 60), "the lab is up")
    // Signed in and told by the gateway what it offers.
    let ready = NSPredicate(format: "label BEGINSWITH 'passkey'")
    wait(for: [expectation(for: ready, evaluatedWith: status)], timeout: 60)
    return app
  }

  /// The run's phone with its passkey enrolled and accepted by the gateway on this connection.
  private func launchEnrolled(tamper: String? = nil, arguments: [String] = []) -> XCUIApplication {
    let app = launchLab(phone: Self.phone, tamper: tamper, arguments: arguments)
    let status = element(app, "passkeyLab.status")

    // The list is read after the first report: a passkey the gateway has is advertised then.
    if !waitForLabel(status, contains: "passkey accepted", timeout: 15) {
      openPasskeysPage(app)
      do {
        type(try operatorCode(), into: element(app, "hermie.passkeys.code"))
      } catch {
        XCTFail("no operator code: \(error)")
      }
      tapWhenEnabled(element(app, "hermie.passkeys.add"))
      XCTAssertTrue(element(app, "hermie.passkeys.credential").waitForExistence(timeout: 30), "enrolled")
      app.navigationBars.buttons.firstMatch.tap()
      XCTAssertTrue(waitForLabel(element(app, "passkeyLab.status"), contains: "passkey accepted", timeout: 30))
    }

    return app
  }

  private func openPasskeysPage(_ app: XCUIApplication) {
    tapWhenHittable(element(app, "passkeyLab.passkeys"))
    XCTAssertTrue(element(app, "hermie.passkeys.state").waitForExistence(timeout: 20), "the page is open")
    // The first read of the gateway has answered.
    let loaded = NSPredicate(format: "NOT (label CONTAINS 'Checking this gateway')")
    wait(for: [expectation(for: loaded, evaluatedWith: element(app, "hermie.passkeys.state"))], timeout: 20)
  }

  // MARK: Helpers

  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  @discardableResult
  private func waitForLabel(_ element: XCUIElement, contains text: String, timeout: TimeInterval = 20) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)

    while Date() < deadline {
      if element.exists, element.label.localizedCaseInsensitiveContains(text) {
        return true
      }

      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.1)
    }

    return false
  }

  private func tapWhenHittable(_ element: XCUIElement) {
    let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: element)
    wait(for: [hittable], timeout: 20)
    element.tap()
  }

  /// Confirm, Decline and the page's buttons are off for a moment (the sheet's guard, or an action
  /// under way).
  private func tapWhenEnabled(_ element: XCUIElement) {
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true AND isHittable == true"), evaluatedWith: element)
    wait(for: [enabled], timeout: 20)
    element.tap()
  }

  private func type(_ text: String, into field: XCUIElement) {
    tapWhenHittable(field)
    field.typeText(text)
  }

  /// Audit the sheet: every check, the Dynamic Type one apart (it reports every text on this
  /// toolchain, as in the other lab tests), over each page of the sheet's own scroll.
  private func auditSheet(_ app: XCUIApplication, _ label: String) throws {
    var issues: [String] = []

    try app.performAccessibilityAudit { issue in
      let element = issue.element.map { "'\($0.identifier)' '\($0.label)'" } ?? "-"
      let line = "\(label): \(issue.compactDescription) on \(element) (\(issue.detailedDescription))"
      let tolerated =
        issue.auditType == .dynamicType
        || (issue.auditType == .contrast && issue.compactDescription.localizedCaseInsensitiveContains("nearly passed"))
      if tolerated {
        print("[passkey-ui] audit (tolerated) \(line)")
      } else {
        issues.append(line)
      }
      return true
    }

    issues.forEach { print("[passkey-ui] audit \($0)") }
    XCTAssertEqual(issues, [], "the accessibility audit found issues")
  }

  private func auditPage(_ app: XCUIApplication, _ label: String) throws {
    try auditSheet(app, "page \(label)")
  }

  // MARK: The fake gateway

  /// An operator enrolment code (`hermes dashboard passkey invite`).
  private func operatorCode() throws -> String {
    let (status, data) = try call("POST", "/__fake/passkey/code", body: [:])
    XCTAssertEqual(status, 200)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try XCTUnwrap(json["code"] as? String)
  }

  /// Raise a `confirm` at level `passkey` on the researcher's chat; the request's id.
  private func raise(title: String, summary: String, detail: String?) throws -> String {
    var params: [String: Any] = ["level": "passkey", "title": title, "summary": summary]
    params["detail"] = detail
    let (status, data) = try call("POST", "/__fake/request", body: ["method": "confirm", "params": params])
    XCTAssertEqual(status, 200, String(data: data, encoding: .utf8) ?? "")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try XCTUnwrap(json["request_id"] as? String)
  }

  /// What the gateway recorded as the outcome of request `id` (what the agent would learn).
  private func waitForOutcome(_ id: String) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(30)

    while Date() < deadline {
      let (_, data) = try call("GET", "/__fake/state")

      if let state = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let passkey = state["passkey"] as? [String: Any],
        let outcomes = passkey["outcomes"] as? [[String: Any]],
        let found = outcomes.first(where: { $0["request_id"] as? String == id })
      {
        return found
      }

      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.2)
    }

    XCTFail("Timed out waiting for the outcome of \(id)")
    return [:]
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
