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
private func selfEnrolWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with` a gateway that knows the passkey level, with a body on the main actor.
private func withSelfEnrolGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(SelfEnrolApp.options) { gateway in try await body(gateway) }
}

/// A native PKCE sign-in to a gateway that knows the passkey level, and a session whose passkey
/// model can sign in again through the real loopback listener and the scripted browser.
@MainActor
private struct SelfEnrolApp {
  let gateway: FakeGateway
  let native: NativeSession
  let signedIn: TokenSet
  let session: GatewaySession
  let passkeys: PasskeyModel
  let phone: SoftPasskeyAuthenticator

  static let options = FakeGateway.Options(auth: .native, extraArguments: ["--passkey"])

  static func open(_ gateway: FakeGateway) async throws -> SelfEnrolApp {
    let native = try await NativeSession(gateway: gateway)
    let signedIn = try await native.signIn()
    let phone = SoftPasskeyAuthenticator()

    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    options.passkey = PasskeySetup(
      configuration: PasskeyConfiguration(rpID: SoftPasskeyAuthenticator.nativeRPID, displayName: "Test phone"),
      authenticator: phone,
      pins: InMemoryPasskeyPins(),
      reauth: PasskeyReauthSetup(services: GatewayServices(makeListener: { LoopbackCallbackListener() }), lock: nil)
    )
    let record = GatewayRecord(id: "g-self", name: "fake", address: gateway.baseURL, authKind: .nativePKCE, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: native.credentials,
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let passkeys = try #require(session.passkeys)

    await session.start()
    try await selfEnrolWait("the socket") { session.status.phase == .ready }
    try await selfEnrolWait("the first capability report") { passkeys.capability != nil }
    await passkeys.refresh()

    return SelfEnrolApp(gateway: gateway, native: native, signedIn: signedIn, session: session, passkeys: passkeys, phone: phone)
  }

  func state() async throws -> JSONValue {
    try await gateway.control("GET", "/__fake/state")
  }
}

extension Integration {
  /// Adding a passkey by signing in again (contract §7.2, §8), over the real routes, the real
  /// loopback listener and the fake gateway's simulated identity provider.
  @Suite("Passkey self-enrolment") @MainActor
  struct SelfEnrolPasskeyIntegrationTests {
    @Test("sign in again, create the passkey with the grant: listed as self, the grant spent, the token set untouched")
    func signInAgainAndEnrol() async throws {
      try await withSelfEnrolGateway { gateway in
        let app = try await SelfEnrolApp.open(gateway)
        #expect(app.passkeys.canSelfEnrol)
        #expect(app.passkeys.status?.selfEnrol?.coolingOffS == 0)

        let exchanges = try await app.state()["tokenExchanges"]
        let browser = ScriptedBrowser()
        let ready = try await app.passkeys.beginSelfEnrolment(presenter: browser)

        #expect(ready.phase == .ready)
        #expect(browser.callbackStatus == 200, "the real listener took the callback")
        #expect(browser.closes >= 1)
        let opened = try #require(browser.opened.first)
        #expect(URLComponents(url: opened, resolvingAgainstBaseURL: false)?.queryItems?.last?.name == "reauth")

        // The re-authentication signed nobody in: no exchange counted, the stored set unchanged.
        #expect(try await app.state()["tokenExchanges"] == exchanges)
        #expect(try await app.native.coordinator.current() == app.signedIn)

        let grants = try #require(try await app.state()["passkey"]?["grants"]?.arrayValue)
        #expect(grants.count == 1)
        #expect(grants.first?["client"]?.stringValue == "native")
        #expect(grants.first?["state"]?.stringValue == "fresh")

        let credential = try await app.passkeys.enrol(grantID: ready.grantID)
        #expect(credential.id == app.phone.id)
        #expect(credential.createdVia == "self")
        #expect(app.passkeys.selfEnrolment?.phase == .done)
        #expect(app.passkeys.credentials.contains { $0.id == app.phone.id && $0.createdVia == "self" })
        #expect(app.passkeys.notices.isEmpty, "its own enrolment is no news")

        let after = try #require(try await app.state()["passkey"]?["grants"]?.arrayValue?.first)
        #expect(after["state"]?.stringValue == "spent")

        // The bearer from the first sign-in still works.
        #expect(try await app.native.http.authMe().userID == "tester@example.invalid")

        let passkeys = app.passkeys
        try await selfEnrolWait("passkey accepted on the socket") { passkeys.capability?.passkeyAccepted == true }
        await app.session.shutdown()
      }
    }

    @Test("a sign-in the gateway does not count ends the grant with its reason; nothing is enrolled")
    func notFresh() async throws {
      try await withSelfEnrolGateway { gateway in
        let app = try await SelfEnrolApp.open(gateway)
        try await gateway.control("POST", "/__fake/passkey/reauth", body: ["fail": "auth_not_fresh"])

        await #expect(throws: PasskeyActionError.reauth(.failed(failure: "auth_not_fresh"))) {
          try await app.passkeys.beginSelfEnrolment(presenter: ScriptedBrowser())
        }
        #expect(app.passkeys.selfEnrolment?.phase == .failed(.failed(failure: "auth_not_fresh")))

        let grantID = try #require(app.passkeys.selfEnrolment?.grantID)
        await #expect(throws: PasskeyActionError.reauth(.notFresh)) { try await app.passkeys.enrol(grantID: grantID) }
        #expect(try await app.state()["passkey"]?["credentials"]?.arrayValue?.isEmpty == true)
        #expect(try await app.native.coordinator.current() == app.signedIn)
        await app.session.shutdown()
      }
    }

    @Test("switched off by the operator: not offered, and refused with self_enrol_disabled")
    func switchedOff() async throws {
      try await withSelfEnrolGateway { gateway in
        let app = try await SelfEnrolApp.open(gateway)
        try await gateway.control("POST", "/__fake/passkey/enable", body: ["self_enrol": ["enabled": false]])

        await #expect(throws: PasskeyActionError.reauth(.disabled)) {
          try await app.passkeys.beginSelfEnrolment(presenter: ScriptedBrowser())
        }
        #expect(!app.passkeys.canSelfEnrol)

        // A grant opened before the switch is refused too, at the route.
        let client = try #require(app.passkeys.client)
        let refused = await #expect(throws: PasskeyRouteError.self) { try await client.reauthBegin() }
        #expect(refused?.error == "self_enrol_disabled")
        await app.session.shutdown()
      }
    }

    @Test("the sixth grant in ten minutes is rate limited, with the gateway's Retry-After")
    func rateLimited() async throws {
      try await withSelfEnrolGateway { gateway in
        let app = try await SelfEnrolApp.open(gateway)
        let client = try #require(app.passkeys.client)

        for _ in 0..<5 {
          _ = try await client.reauthBegin()
        }

        let error = await #expect(throws: PasskeyActionError.self) {
          try await app.passkeys.beginSelfEnrolment(presenter: ScriptedBrowser())
        }
        guard case .reauth(.rateLimited(let retryAfter))? = error else {
          Issue.record("expected rate limited, got \(String(describing: error))")
          return
        }
        #expect((retryAfter ?? 0) > 0)
        await app.session.shutdown()
      }
    }
  }
}
#endif
