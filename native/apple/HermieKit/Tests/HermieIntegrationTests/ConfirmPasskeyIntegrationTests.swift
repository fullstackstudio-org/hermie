#if os(macOS)
import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// Poll a main-actor condition until it holds.
@MainActor
private func passkeyWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// How many `client.capabilities` calls so far offered `passkey`.
private func passkeyAdvertisements(_ gateway: FakeGateway) async throws -> Int {
  let calls = try await gateway.control("GET", "/__fake/state")["clientCapabilities"]?.arrayValue ?? []
  return calls.filter { $0["confirm"]?.arrayValue?.contains(.string("passkey")) == true }.count
}

/// `FakeGateway.with` a gateway that knows the passkey level, with a body on the main actor.
private func withPasskeyGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(PasskeyApp.options) { gateway in try await body(gateway) }
}

/// A gateway that knows the passkey level (`--auth native --passkey`, its own address as the base
/// URL, the default native RP), a native PKCE sign-in, and a session whose passkey model runs the
/// soft authenticator: the app as it would run, with the system sheet replaced.
@MainActor
private struct PasskeyApp {
  let gateway: FakeGateway
  let session: GatewaySession
  let passkeys: PasskeyModel
  let phone: SoftPasskeyAuthenticator
  let pins: InMemoryPasskeyPins

  static let options = FakeGateway.Options(auth: .native, extraArguments: ["--passkey"])

  static func open(
    _ gateway: FakeGateway,
    storedID: String = "g-passkey",
    pins: InMemoryPasskeyPins = InMemoryPasskeyPins(),
    phone: SoftPasskeyAuthenticator = SoftPasskeyAuthenticator(),
    backoff: Duration = .milliseconds(100),
    openChat: Bool = true
  ) async throws -> PasskeyApp {
    let native = try await NativeSession(gateway: gateway)
    try await native.signIn()

    var options = GatewaySession.Options()
    options.connection.backoff = { _ in backoff }
    options.passkey = PasskeySetup(
      configuration: PasskeyConfiguration(rpID: SoftPasskeyAuthenticator.nativeRPID, displayName: "Test phone"),
      authenticator: phone,
      pins: pins
    )
    let record = GatewayRecord(id: storedID, name: "fake", address: gateway.baseURL, authKind: .nativePKCE, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: native.credentials,
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let passkeys = try #require(session.passkeys)

    await session.start()
    try await passkeyWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows["researcher"] != nil
    }
    if openChat {
      try await session.open("researcher")
    }
    try await passkeyWait("the first capability report") { passkeys.capability != nil }

    return PasskeyApp(gateway: gateway, session: session, passkeys: passkeys, phone: phone, pins: pins)
  }

  /// An operator enrolment code (`hermes dashboard passkey invite`).
  func operatorCode() async throws -> String {
    try #require(try await gateway.control("POST", "/__fake/passkey/code", body: .object([:]))["code"]?.stringValue)
  }

  /// Enrol the soft passkey with an operator code and wait until `passkey` is accepted on the socket.
  func enrol() async throws {
    let credential = try await passkeys.enrol(code: try await operatorCode())
    #expect(credential.id == phone.id)

    let passkeys = self.passkeys
    try await passkeyWait("passkey accepted on the socket") { passkeys.capability?.passkeyAccepted == true }
  }

  /// Raise a `confirm` at level `passkey` on the researcher's chat; answers its request id once the
  /// model shows it.
  func raise(summary: String = "Delete 3 old backups.", detail: String? = "rm -rf ./backups/2025-*\n(3 directories)") async throws
    -> String
  {
    var params: JSONObject = ["level": "passkey", "title": "Delete backups", "summary": .string(summary)]
    params["detail"] = detail.map(JSONValue.string)
    let raised = try await gateway.control(
      "POST",
      "/__fake/request",
      body: .object(["method": "confirm", "params": .object(params)])
    )
    let id = try #require(raised["request_id"]?.stringValue)
    let passkeys = self.passkeys
    try await passkeyWait("the confirmation \(id)") { passkeys.confirmation(id) != nil }
    return id
  }

  /// `GET /__fake/state` → `passkey`.
  func state() async throws -> JSONValue {
    try #require(try await gateway.control("GET", "/__fake/state")["passkey"])
  }

  func outcome(_ id: String) async throws -> JSONValue? {
    try await state()["outcomes"]?.arrayValue?.first { $0["request_id"]?.stringValue == id }
  }

  func isOpen(_ id: String) async throws -> Bool {
    try await state()["open"]?.arrayValue?.contains { ($0["id"] ?? $0["request_id"])?.stringValue == id } == true
  }
}

extension Integration {
  /// `confirm` at level `passkey` against the fake gateway, over real sockets and REST.
  @Suite("Confirm passkey") @MainActor
  struct ConfirmPasskeyIntegrationTests {
    @Test("enrol with an operator code, confirm with the passkey, and the gateway records verified: true")
    func enrolAndConfirm() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        #expect(app.passkeys.capability?.verdict == .notEnrolled, "no credential yet: passkey not advertised")

        try await app.enrol()
        #expect(app.passkeys.credentials.map(\.id) == [app.phone.id])
        #expect(app.passkeys.notices.isEmpty, "its own enrolment is no news")
        #expect(await app.pins.records()["g-passkey"]?.gatewayID == app.passkeys.status?.gatewayID, "pinned on enrolment")

        let id = try await app.raise()
        let shown = try #require(app.passkeys.confirmation(id))
        #expect(shown.display.title == "Delete backups")
        #expect(shown.display.detail == "rm -rf ./backups/2025-*\n(3 directories)", "as the gateway sent it, line break kept")
        #expect(shown.display.baseURL == gateway.baseURL)

        await app.passkeys.confirm(id)
        #expect(app.passkeys.confirmation(id)?.phase == .received)

        try await passkeyWait("the outcome") { try await app.outcome(id) != nil }
        let outcome = try #require(try await app.outcome(id))
        #expect(outcome["outcome"]?.stringValue == "confirmed")
        #expect(outcome["method"]?.stringValue == "passkey")
        #expect(outcome["verified"]?.boolValue == true)
        #expect(outcome["credential_id"]?.stringValue == app.phone.id)
        #expect(app.passkeys.confirmation(id)?.phase == .received, "resolved after its own answer changes nothing")
        await app.session.shutdown()
      }
    }

    @Test("Decline settles declined, unverified, without a ceremony")
    func decline() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        try await app.enrol()
        let ceremonies = app.phone.ceremonies

        let id = try await app.raise()
        await app.passkeys.decline(id)
        #expect(app.passkeys.confirmation(id)?.phase == .declined)

        try await passkeyWait("the outcome") { try await app.outcome(id) != nil }
        let outcome = try #require(try await app.outcome(id))
        #expect(outcome["outcome"]?.stringValue == "declined")
        #expect(outcome["method"]?.stringValue == "tap")
        #expect(outcome["verified"]?.boolValue == false)
        #expect(app.phone.ceremonies == ceremonies)
        await app.session.shutdown()
      }
    }

    @Test("a tampered assertion is refused with its reason and the request stays open; an honest one then confirms")
    func tampered() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        try await app.enrol()
        let id = try await app.raise()

        var tampering = SoftPasskeyAuthenticator.Tampering()
        tampering.flipSignatureBit = true
        app.phone.setTampering(tampering)
        await app.passkeys.confirm(id)
        #expect(app.passkeys.confirmation(id)?.phase == .refused(reason: "signature_invalid"))
        #expect(try await app.isOpen(id))
        #expect(try await app.outcome(id) == nil)

        tampering = SoftPasskeyAuthenticator.Tampering()
        tampering.flipChallengeBit = true
        app.phone.setTampering(tampering)
        await app.passkeys.confirm(id)
        #expect(app.passkeys.confirmation(id)?.phase == .refused(reason: "challenge_mismatch"))

        app.phone.setTampering(SoftPasskeyAuthenticator.Tampering())
        await app.passkeys.confirm(id)
        #expect(app.passkeys.confirmation(id)?.phase == .received)
        try await passkeyWait("the outcome") { try await app.outcome(id) != nil }
        #expect(try await app.outcome(id)?["verified"]?.boolValue == true)
        await app.session.shutdown()
      }
    }

    @Test("the fifth refused assertion ends it as too_many_attempts, unverified")
    func tooManyAttempts() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        try await app.enrol()
        let id = try await app.raise()

        var tampering = SoftPasskeyAuthenticator.Tampering()
        tampering.flipSignatureBit = true
        app.phone.setTampering(tampering)

        for attempt in 1...4 {
          await app.passkeys.confirm(id)
          #expect(app.passkeys.confirmation(id)?.phase == .refused(reason: "signature_invalid"), "attempt \(attempt)")
        }

        await app.passkeys.confirm(id)
        #expect(app.passkeys.confirmation(id)?.phase == .ended(.tooManyAttempts))

        try await passkeyWait("the outcome") { try await app.outcome(id) != nil }
        let outcome = try #require(try await app.outcome(id))
        #expect(outcome["outcome"]?.stringValue == "unavailable")
        #expect(outcome["reason"]?.stringValue == "verification_failed")
        #expect(outcome["verified"]?.boolValue == false)
        await app.session.shutdown()
      }
    }

    @Test("a gateway presenting another gateway_id than the pinned one leaves a notice and is not trusted")
    func gatewayIDMismatch() async throws {
      try await withPasskeyGateway { gateway in
        // This device enrolled at this address before, on a gateway with another id (a reset store,
        // or another gateway answering there now).
        let pinned = PasskeyPinRecord(
          gatewayID: Base64URL.encode(Array(repeating: 0xAB, count: 16)),
          knownCredentialIDs: ["AQID"],
          appCredentialIDs: ["AQID"],
          seenAt: 1
        )
        let app = try await PasskeyApp.open(gateway, pins: InMemoryPasskeyPins(["g-passkey": pinned]))

        let passkeys = app.passkeys
        try await passkeyWait("the notice") { passkeys.notices.contains { $0.kind == .gatewayIDMismatch } }

        guard case .gatewayIDMismatch? = app.passkeys.capability?.verdict else {
          Issue.record("expected a mismatch verdict, got \(String(describing: app.passkeys.capability?.verdict))")
          return
        }

        #expect(app.passkeys.capability?.passkeyAccepted == false, "passkey is not advertised to it")

        await #expect(throws: PasskeyActionError.gatewayIDMismatch) {
          _ = try await app.passkeys.enrol(code: try await app.operatorCode())
        }
        #expect(try await app.state()["credentials"]?.arrayValue?.isEmpty == true)
        await app.session.shutdown()
      }
    }

    @Test("revoke with a passkey step-up; an invite step-up mints a code")
    func stepUps() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        try await app.enrol()

        let invite = try await app.passkeys.mintInvite()
        #expect(EnrolmentCode.canonical(invite.code) != nil)
        #expect(!"\(invite)".contains(invite.code))

        try await app.passkeys.revoke(credentialID: app.phone.id)
        #expect(app.passkeys.credentials.isEmpty)
        #expect(app.passkeys.notices.isEmpty, "its own revoke is no news")

        let credentials = try #require(try await app.state()["credentials"]?.arrayValue)
        #expect(credentials.first { $0["id"]?.stringValue == app.phone.id }?["active"]?.boolValue == false)

        let passkeys = app.passkeys
        try await passkeyWait("passkey withdrawn from the socket") { passkeys.capability?.verdict == .notEnrolled }
        await app.session.shutdown()
      }
    }

    @Test("a passkey confirm raised while this socket was down reaches the model after the reconnect")
    func raisedWhileDown() async throws {
      try await withPasskeyGateway { gateway in
        // This device comes back slowly; a second device of the same person stays capable meanwhile,
        // so the gateway has someone to send the request to while this socket is down.
        let app = try await PasskeyApp.open(gateway, backoff: .seconds(2), openChat: false)
        try await app.enrol()
        let other = try await PasskeyApp.open(gateway, storedID: "g-other", phone: app.phone.clone())
        let otherModel = other.passkeys
        try await passkeyWait("passkey accepted on the second socket") { otherModel.capability?.passkeyAccepted == true }

        // The researcher's chat is attached on this device's connection, and only there: no chat
        // store replays it after the reconnect, so what the connection asks is all it gets.
        let stored = try #require(await app.session.roster.bot(named: "researcher")?.canonical?.id)
        _ = try await app.session.link.requestReply("session.resume", params: ["session_id": .string(stored)])

        let advertised = try await passkeyAdvertisements(gateway)
        try await gateway.dropSockets()
        try await passkeyWait("the second device advertising again") {
          try await passkeyAdvertisements(gateway) > advertised
        }

        let raised = try await gateway.control(
          "POST",
          "/__fake/request",
          body: .object([
            "method": "confirm",
            "params": .object(["level": "passkey", "title": "Rotate keys", "summary": "Rotate the deploy keys."])
          ])
        )
        let id = try #require(raised["request_id"]?.stringValue)
        let passkeys = app.passkeys
        try await passkeyWait("the confirmation on the device that was away") { passkeys.confirmation(id) != nil }
        #expect(app.passkeys.confirmation(id)?.phase == .waiting)

        await other.session.shutdown()
        await app.session.shutdown()
      }
    }

    @Test("a passkey added elsewhere is announced as a notice")
    func addedElsewhere() async throws {
      try await withPasskeyGateway { gateway in
        let app = try await PasskeyApp.open(gateway)
        try await app.enrol()

        try await gateway.control(
          "POST",
          "/__fake/passkey/changed",
          body: ["change": "added", "credential": ["id": "elsewhere", "name": "Laptop", "rp_id": "confirm.hermie.dev"]]
        )

        let passkeys = app.passkeys
        try await passkeyWait("the notice") { !passkeys.notices.isEmpty }
        #expect(app.passkeys.notices.map(\.kind) == [.credentialAdded(name: "Laptop")])
        await app.session.shutdown()
      }
    }
  }
}
#endif
