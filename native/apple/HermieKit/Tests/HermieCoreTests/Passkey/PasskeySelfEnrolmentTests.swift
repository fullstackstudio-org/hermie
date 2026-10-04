import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// The contract's `wire_examples` (`contract/confirm-passkey/vectors.json`), as a gateway sends them.
enum SelfEnrolWire {
  static let vectors: JSONValue = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { url.deleteLastPathComponent() }
    let file = url.appendingPathComponent("contract/confirm-passkey/vectors.json")
    return (try? JSONValue(parsing: Data(contentsOf: file))) ?? .null
  }()

  static func example(_ name: String) -> JSONValue {
    vectors["wire_examples"]?[name] ?? .null
  }

  static func text(_ value: JSONValue) -> String {
    (try? value.canonicalString()) ?? "null"
  }

  static let grant = "CTbyDtvtuIQQmgUqM240kw"
  static let useSecret = "7LllY2NEkyiy8JkZ7NgZf_BQB8uqhIqVViH-KvJf2Qc"
}

/// A gateway with the self-enrolment routes, answering as the contract's examples do until a test
/// says otherwise for one path.
final class SelfEnrolGateway: Sendable {
  private final class Overrides: Sendable {
    let replies = Mutex<[String: StubReply]>([:])
  }

  private let overrides = Overrides()
  let server: StubServer

  init() {
    let overrides = overrides

    server = StubServer { request in
      if let reply = overrides.replies.withLock({ $0[request.path] }) {
        return reply
      }

      switch request.path {
      case "/api/auth/passkeys": return .json(SelfEnrolWire.text(SelfEnrolWire.example("status_self_enrol")))
      case "/api/auth/passkeys/reauth/begin": return .json(SelfEnrolWire.text(SelfEnrolWire.example("reauth_begin_answer_native")))
      case "/api/auth/passkeys/register/begin":
        return .json(SelfEnrolWire.text(SelfEnrolWire.example("register_begin_answer_with_grant")))
      case "/api/auth/passkeys/register/finish": return .json(SelfEnrolWire.text(SelfEnrolWire.example("register_finish_answer_self")))
      default: return .json("{}", status: 404)
      }
    }
  }

  func answer(_ path: String, _ reply: StubReply?) {
    overrides.replies.withLock { $0[path] = reply }
  }

  /// A `{error, …}` refusal as the routes write one.
  func refuse(_ path: String, status: Int, _ body: JSONValue, retryAfter: String? = nil) {
    answer(path, .json(SelfEnrolWire.text(body), status: status, headers: retryAfter.map { ["Retry-After": $0] } ?? [:]))
  }

  func requests(_ path: String) -> [StubRequest] {
    server.requests.filter { $0.path == path }
  }

  func body(_ request: StubRequest?) -> JSONValue {
    (try? JSONValue(parsing: request?.bodyText ?? "")) ?? .null
  }
}

/// A browser sign-in that answers what the test scripted, and remembers what it was asked.
@MainActor
final class ScriptedReauthenticator: PasskeyReauthenticating {
  var results: [Result<ReauthCompletion, SignInProblem>] = []
  private(set) var asked: [(grantID: String, provider: String?)] = []
  private(set) var resumes = 0
  /// The model's self-enrolment phase while the sheet was "up".
  private(set) var phasesSeen: [PasskeySelfEnrolment.Phase?] = []
  weak var model: PasskeyModel?

  static let fresh = ReauthCompletion(
    grantID: SelfEnrolWire.grant,
    state: .fresh(useSecret: SelfEnrolWire.useSecret),
    expiresAt: 1_790_000_600
  )

  /// Keep the sheet "up" until `release` or `cancel`.
  var hold = false
  private var held: CheckedContinuation<Result<ReauthCompletion, SignInProblem>, Never>?
  private(set) var cancels = 0

  var isHolding: Bool { held != nil }

  func reauthenticate(grantID: String, provider: String?, presenter: any BrowserSessionPresenting) async
    -> Result<ReauthCompletion, SignInProblem>
  {
    asked.append((grantID, provider))
    phasesSeen.append(model?.selfEnrolment?.phase)

    if hold {
      return await withCheckedContinuation { held = $0 }
    }

    return results.isEmpty ? .success(Self.fresh) : results.removeFirst()
  }

  func release(_ result: Result<ReauthCompletion, SignInProblem> = .success(fresh)) {
    let continuation = held
    held = nil
    continuation?.resume(returning: result)
  }

  func appBecameActive() async {
    resumes += 1
  }

  func cancel() async {
    cancels += 1
    release(.failure(.cancelled))
  }
}

/// A passkey authenticator whose registration the person cancels, once.
final class CancelOnceAuthenticator: PasskeyAuthenticator {
  let base: SoftPasskeyAuthenticator
  private let cancelled = Mutex(false)

  init(_ base: SoftPasskeyAuthenticator) {
    self.base = base
  }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    let first = cancelled.withLock { done in
      defer { done = true }
      return !done
    }

    if first {
      throw .cancelled
    }

    return try await base.register(request)
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    try await base.assert(request)
  }

  func cancel() async {}
}

/// A clock a test moves.
final class SelfEnrolClock: Sendable {
  private let seconds = Mutex<Double>(1_790_000_000)

  var now: Double { seconds.withLock { $0 } }
  var read: @Sendable () -> Double { { [self] in now } }

  func set(_ value: Double) {
    seconds.withLock { $0 = value }
  }
}

/// Adding a passkey by signing in again (contract §7.2, §8; plan "Flows — Native app" steps 2–4):
/// the model over a stubbed gateway and a scripted browser sign-in.
@MainActor
@Suite("Passkey self-enrolment")
struct PasskeySelfEnrolmentTests {
  struct Fixture {
    let gateway: SelfEnrolGateway
    let model: PasskeyModel
    let browser: ScriptedReauthenticator
    let phone: SoftPasskeyAuthenticator
    let pins: InMemoryPasskeyPins
    let clock: SelfEnrolClock
  }

  static func fixture(
    authenticator: (SoftPasskeyAuthenticator) -> any PasskeyAuthenticator = { $0 },
    reauthenticator: Bool = true
  ) throws -> Fixture {
    let gateway = SelfEnrolGateway()
    let phone = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
    let browser = ScriptedReauthenticator()
    let pins = InMemoryPasskeyPins()
    let clock = SelfEnrolClock()
    let http = try HTTPClient(
      baseURL: "https://gw.example.com",
      credentials: SessionTokenCredentials(token: "st"),
      transport: gateway.server.transport()
    )
    let model = PasskeyModel(
      storedGatewayID: "gw-1",
      address: "https://gw.example.com",
      link: ScriptedLink(),
      client: PasskeyClient(http: http),
      authenticator: authenticator(phone),
      configuration: PasskeyConfiguration(rpID: "confirm.hermie.dev", displayName: "Test phone"),
      pins: pins,
      source: nil,
      reauthenticator: reauthenticator ? browser : nil,
      now: clock.read
    )

    browser.model = model
    return Fixture(gateway: gateway, model: model, browser: browser, phone: phone, pins: pins, clock: clock)
  }

  /// A sheet nobody looks at: the scripted sign-in never opens it.
  static var presenter: FakePresenter { FakePresenter() }

  // MARK: - The whole flow

  @Test("sign in again, then create the passkey with the grant: no code, the token route untouched, pinned")
  func flow() async throws {
    let f = try Self.fixture()

    await f.model.refresh()
    #expect(f.model.canSelfEnrol)

    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)

    #expect(ready.phase == .ready)
    #expect(ready.grantID == SelfEnrolWire.grant)
    #expect(ready.expiresAt == Date(timeIntervalSince1970: 1_790_000_600))
    #expect(ready.secondsLeft(at: Date(timeIntervalSince1970: 1_790_000_000)) == 600)
    #expect(ready.canEnrol(at: Date(timeIntervalSince1970: 1_790_000_000)))
    #expect(f.browser.asked.map(\.grantID) == [SelfEnrolWire.grant])
    #expect(f.browser.asked.first?.provider == "self_hosted", "the grant's provider, from reauth/begin")
    #expect(f.browser.phasesSeen == [.signingIn])
    #expect(f.model.selfEnrolment == ready)
    #expect(f.gateway.body(f.gateway.requests("/api/auth/passkeys/reauth/begin").first) == [:])

    let credential = try await f.model.enrol(grantID: ready.grantID)

    #expect(credential.createdVia == "self")
    #expect(f.model.selfEnrolment?.phase == .done)
    #expect(f.model.selfEnrolment?.useSecret == nil)

    let begin = f.gateway.body(f.gateway.requests("/api/auth/passkeys/register/begin").first)
    #expect(begin["grant_id"]?.stringValue == SelfEnrolWire.grant)
    #expect(begin["use_secret"]?.stringValue == SelfEnrolWire.useSecret)
    #expect(begin["code"] == nil)
    #expect(begin["name"]?.stringValue == "Test phone \u{2014} gw.example.com")

    let finish = f.gateway.body(f.gateway.requests("/api/auth/passkeys/register/finish").first)
    #expect(finish["grant_id"]?.stringValue == SelfEnrolWire.grant)
    #expect(finish["use_secret"]?.stringValue == SelfEnrolWire.useSecret)
    #expect(finish["code"] == nil)
    #expect(finish["credential"]?["id"]?.stringValue == f.phone.id)

    // The same pin and list read as an enrolment with a code.
    let pin = try #require(await f.pins.records()["gw-1"])
    #expect(pin.gatewayID == "2kvwXlBOqzLxDCPyRKi-lQ")
    #expect(f.model.notices.isEmpty, "its own enrolment is no news")
    #expect(f.gateway.requests("/auth/native/token").isEmpty)

    // A spent grant does not enrol twice.
    await #expect(throws: PasskeyActionError.reauth(.spent)) { try await f.model.enrol(grantID: ready.grantID) }
  }

  @Test("the self-enrolment never shows its grant or its use secret")
  func redacted() async throws {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    var dumped = ""
    dump(ready, to: &dumped)

    for text in ["\(ready)", String(reflecting: ready), dumped] {
      #expect(!text.contains(SelfEnrolWire.grant))
      #expect(!text.contains(SelfEnrolWire.useSecret))
    }
  }

  // MARK: - Step 1

  @Test("a sheet closed before the sign-in came back keeps the grant: signing in again reuses it")
  func reuseAfterCancel() async throws {
    let f = try Self.fixture()
    f.browser.results = [.failure(.cancelled)]

    await #expect(throws: PasskeyActionError.reauth(.signIn(.cancelled))) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
    #expect(f.model.selfEnrolment?.phase == .signInEnded(.cancelled))

    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    #expect(ready.phase == .ready)
    #expect(f.gateway.requests("/api/auth/passkeys/reauth/begin").count == 1, "one grant")
    #expect(f.browser.asked.map(\.grantID) == [SelfEnrolWire.grant, SelfEnrolWire.grant])
  }

  @Test("an expired grant is not reused: a new one is opened")
  func expiredNotReused() async throws {
    let f = try Self.fixture()
    f.browser.results = [.failure(.cancelled)]
    _ = try? await f.model.beginSelfEnrolment(presenter: Self.presenter)

    f.clock.set(1_790_000_600)
    _ = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    #expect(f.gateway.requests("/api/auth/passkeys/reauth/begin").count == 2)
  }

  @Test(
    "a sign-in that came back and did not count ends the grant, with the gateway's reason",
    arguments: [
      ("auth_not_fresh", PasskeyReauthReason.failed(failure: "auth_not_fresh")),
      ("user_mismatch", .failed(failure: "user_mismatch")),
      ("unknown", .expired),
      ("not_open", .expired),
      ("client_mismatch", .expired)
    ]
  )
  func failedSignIn(_ reason: String, _ expected: PasskeyReauthReason) async throws {
    let f = try Self.fixture()
    f.browser.results = [.success(ReauthCompletion(grantID: SelfEnrolWire.grant, state: .failed(reason: reason), expiresAt: 1_790_000_600))]

    await #expect(throws: PasskeyActionError.reauth(expected)) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
    #expect(f.model.selfEnrolment?.phase == .failed(expected))

    // Step 2 is not possible, and starting again opens a new grant.
    let refusal: PasskeyReauthReason = expected == .expired ? .expired : .notFresh
    await #expect(throws: PasskeyActionError.reauth(refusal)) { try await f.model.enrol(grantID: SelfEnrolWire.grant) }
    _ = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    #expect(f.gateway.requests("/api/auth/passkeys/reauth/begin").count == 2)
  }

  @Test("a token answer that is not a re-authentication answer is a bad answer, and the grant is dropped")
  func badTokenAnswer() async throws {
    let f = try Self.fixture()
    f.browser.results = [.failure(.exchange(.protocol, status: nil))]

    await #expect(throws: PasskeyActionError.badAnswer) { try await f.model.beginSelfEnrolment(presenter: Self.presenter) }
    #expect(f.model.selfEnrolment?.phase == .failed(.signIn(.exchange(.protocol, status: nil))))
  }

  @Test("reauth/begin's refusals: 429 with its Retry-After, disabled, no re-authentication, an older gateway")
  func beginRefusals() async throws {
    let cases: [(Int, JSONValue, String?, PasskeyReauthReason)] = [
      (429, SelfEnrolWire.example("error_reauth_rate_limited")["body"] ?? [:], "600", .rateLimited(retryAfter: 600)),
      (403, SelfEnrolWire.example("error_self_enrol_disabled")["body"] ?? [:], nil, .disabled),
      (403, SelfEnrolWire.example("error_provider_no_reauth")["body"] ?? [:], nil, .providerNoReauth),
      (405, [:], nil, .notOffered)
    ]

    for (status, body, retryAfter, expected) in cases {
      let f = try Self.fixture()
      f.gateway.refuse("/api/auth/passkeys/reauth/begin", status: status, body, retryAfter: retryAfter)

      await #expect(throws: PasskeyActionError.reauth(expected), "HTTP \(status)") {
        try await f.model.beginSelfEnrolment(presenter: Self.presenter)
      }
      #expect(f.browser.asked.isEmpty)
      #expect(f.model.selfEnrolment == nil)
    }
  }

  @Test("the status decides first: no self_enrol, or not available, opens no grant")
  func statusDecides() async throws {
    var status = SelfEnrolWire.example("status_self_enrol").objectValue ?? [:]
    let cases: [(JSONValue?, PasskeyReauthReason)] = [
      (nil, .notOffered),
      (SelfEnrolWire.example("self_enrol_disabled"), .disabled),
      (SelfEnrolWire.example("self_enrol_provider_no_reauth"), .providerNoReauth)
    ]

    for (selfEnrol, expected) in cases {
      let f = try Self.fixture()
      status["self_enrol"] = selfEnrol
      f.gateway.answer("/api/auth/passkeys", .json(SelfEnrolWire.text(.object(status))))

      await f.model.refresh()
      #expect(!f.model.canSelfEnrol)
      await #expect(throws: PasskeyActionError.reauth(expected)) {
        try await f.model.beginSelfEnrolment(presenter: Self.presenter)
      }
      #expect(f.gateway.requests("/api/auth/passkeys/reauth/begin").isEmpty)
    }
  }

  @Test("a session that cannot sign in through the browser does not offer it")
  func noBrowser() async throws {
    let f = try Self.fixture(reauthenticator: false)
    await f.model.refresh()

    #expect(!f.model.canSelfEnrol)
    await #expect(throws: PasskeyActionError.reauth(.notOffered)) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
  }

  @Test("coming back to the app listens again for the sign-in")
  func appBecameActive() async throws {
    let f = try Self.fixture()
    await f.model.appBecameActive()
    #expect(f.browser.resumes == 1)
  }

  // MARK: - Step 2

  @Test("a cancelled passkey sheet leaves the grant ready: step 2 runs again")
  func ceremonyCancelled() async throws {
    let f = try Self.fixture(authenticator: { CancelOnceAuthenticator($0) })
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)

    await #expect(throws: PasskeyActionError.ceremony(.cancelled)) { try await f.model.enrol(grantID: ready.grantID) }
    #expect(f.model.selfEnrolment?.phase == .ready)

    _ = try await f.model.enrol(grantID: ready.grantID)
    #expect(f.model.selfEnrolment?.phase == .done)
    #expect(f.gateway.requests("/api/auth/passkeys/register/begin").count == 2, "begin again with the same grant")
  }

  @Test(
    "the grant's refusals at register/begin and register/finish end it; a 429 does not",
    arguments: [
      ("/api/auth/passkeys/register/finish", 403, "error_reauth_invalid", PasskeyReauthReason.failed(failure: "auth_not_fresh"), true),
      ("/api/auth/passkeys/register/begin", 403, "error_reauth_invalid_unknown", .expired, true),
      ("/api/auth/passkeys/register/begin", 403, "error_self_enrol_disabled", .disabled, true),
      ("/api/auth/passkeys/register/finish", 429, "error_reauth_rate_limited", .rateLimited(retryAfter: 30), false)
    ]
  )
  func stepTwoRefusals(_ path: String, _ status: Int, _ example: String, _ expected: PasskeyReauthReason, _ ends: Bool)
    async throws
  {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    f.gateway.refuse(path, status: status, SelfEnrolWire.example(example)["body"] ?? [:], retryAfter: status == 429 ? "30" : nil)

    await #expect(throws: PasskeyActionError.reauth(expected)) { try await f.model.enrol(grantID: ready.grantID) }
    #expect(f.model.selfEnrolment?.phase == (ends ? .failed(expected) : .ready))
  }

  @Test("other refusals of step 2 stay what they are and leave the grant ready")
  func otherRefusals() async throws {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    f.gateway.refuse("/api/auth/passkeys/register/finish", status: 400, ["error": "attestation_invalid", "detail": "no"])

    let error = await #expect(throws: PasskeyActionError.self) { try await f.model.enrol(grantID: ready.grantID) }
    guard case .refused(let route)? = error else {
      Issue.record("expected a refusal, got \(String(describing: error))")
      return
    }
    #expect(route.error == "attestation_invalid")
    #expect(f.model.selfEnrolment?.phase == .ready)
  }

  @Test("past expires_at, or for a grant this model did not open, step 2 does not run")
  func expiredGrant() async throws {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)

    await #expect(throws: PasskeyActionError.reauth(.expired)) { try await f.model.enrol(grantID: "another-grant") }

    f.clock.set(1_790_000_600)
    #expect(!ready.canEnrol(at: Date(timeIntervalSince1970: 1_790_000_600)))
    #expect(ready.secondsLeft(at: Date(timeIntervalSince1970: 1_790_000_700)) == 0)
    await #expect(throws: PasskeyActionError.reauth(.expired)) { try await f.model.enrol(grantID: ready.grantID) }
    #expect(f.model.selfEnrolment?.phase == .failed(.expired))
    #expect(f.gateway.requests("/api/auth/passkeys/register/begin").isEmpty)
  }

  @Test("an enrolment with a code sends the code and no grant, as before")
  func codePathUnchanged() async throws {
    let f = try Self.fixture()
    _ = try await f.model.enrol(code: "abcde-fghjk-mnpqr-stvwx")

    let begin = f.gateway.body(f.gateway.requests("/api/auth/passkeys/register/begin").first)
    let finish = f.gateway.body(f.gateway.requests("/api/auth/passkeys/register/finish").first)
    #expect(begin["grant_id"] == nil)
    #expect(begin["use_secret"] == nil)
    #expect(finish["code"]?.stringValue == "ABCDEFGHJKMNPQRSTVWX")
    #expect(finish["grant_id"] == nil)
  }

  @Test("forgetting it drops the grant here")
  func forget() async throws {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    f.model.forgetSelfEnrolment()

    #expect(f.model.selfEnrolment == nil)
    await #expect(throws: PasskeyActionError.reauth(.expired)) { try await f.model.enrol(grantID: ready.grantID) }
  }

  // MARK: - While the sheet is up

  /// Start step 1 with the sheet held up; answers once the model shows `signingIn`.
  func startHeld(_ f: Fixture) async throws -> Task<PasskeySelfEnrolment, any Error> {
    f.browser.hold = true
    let model = f.model
    let running = Task { @MainActor in try await model.beginSelfEnrolment(presenter: Self.presenter) }
    let browser = f.browser
    try await eventually("the sheet") { await MainActor.run { browser.isHolding } }
    #expect(f.model.selfEnrolment?.phase == .signingIn)
    return running
  }

  @Test("forgotten while the sheet is up: the sheet is closed and its late result is nobody's")
  func forgottenWhileSigningIn() async throws {
    let f = try Self.fixture()
    let running = try await startHeld(f)

    f.model.forgetSelfEnrolment()
    #expect(f.model.selfEnrolment == nil)

    let error = await #expect(throws: PasskeyActionError.self) { try await running.value }
    #expect(error == .reauth(.signIn(.cancelled)))
    #expect(f.browser.cancels == 1, "the sheet was asked to close")
    #expect(f.model.selfEnrolment == nil, "the result did not bring it back")
  }

  @Test("a late fresh result for a forgotten attempt is dropped, not adopted")
  func lateResultDropped() async throws {
    let f = try Self.fixture()
    let running = try await startHeld(f)

    // Forget without the sheet answering the cancel (as when it had already called back), then the
    // fresh result arrives.
    f.model.selfEnrolment = nil
    f.model.selfEnrolmentAttempt &+= 1
    f.browser.release()

    let error = await #expect(throws: PasskeyActionError.self) { try await running.value }
    #expect(error == .reauth(.signIn(.cancelled)))
    #expect(f.model.selfEnrolment == nil)
  }

  @Test("a second start while the sheet is up is busy: no second grant, the first goes on")
  func busyWhileSigningIn() async throws {
    let f = try Self.fixture()
    let running = try await startHeld(f)

    await #expect(throws: PasskeyActionError.reauth(.busy)) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
    await #expect(throws: PasskeyActionError.reauth(.busy)) { try await f.model.enrol(grantID: SelfEnrolWire.grant) }
    #expect(f.gateway.requests("/api/auth/passkeys/reauth/begin").count == 1)
    #expect(f.browser.asked.count == 1)

    f.browser.release()
    #expect(try await running.value.phase == .ready)
  }

  @Test("the session shutting down mid-sign-in closes the sheet, forgets the grant, and refuses both steps")
  func shutdownWhileSigningIn() async throws {
    let f = try Self.fixture()
    let running = try await startHeld(f)

    await f.model.shutdown()

    #expect(f.browser.cancels == 1)
    #expect(f.model.selfEnrolment == nil)
    await #expect(throws: PasskeyActionError.notConfigured) { try await running.value }
    await #expect(throws: PasskeyActionError.notConfigured) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
    await #expect(throws: PasskeyActionError.notConfigured) { try await f.model.enrol(grantID: SelfEnrolWire.grant) }
    #expect(f.gateway.requests("/api/auth/passkeys/register/begin").isEmpty)
  }

  @Test("the session shutting down with a ready grant forgets it and its secret")
  func shutdownWhenReady() async throws {
    let f = try Self.fixture()
    let ready = try await f.model.beginSelfEnrolment(presenter: Self.presenter)

    await f.model.shutdown()

    #expect(f.model.selfEnrolment == nil)
    await #expect(throws: PasskeyActionError.notConfigured) { try await f.model.enrol(grantID: ready.grantID) }
  }

  // MARK: - Expiry and reuse

  @Test("a ready grant past expires_at drops its secret and says so, unused")
  func readyGrantExpires() async throws {
    let f = try Self.fixture()
    _ = try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    #expect(f.model.selfEnrolment?.useSecret != nil)

    f.clock.set(1_790_000_601)
    f.model.expireSelfEnrolmentIfDue()

    #expect(f.model.selfEnrolment?.phase == .failed(.expired))
    #expect(f.model.selfEnrolment?.useSecret == nil)
  }

  @Test("an open grant is not reused once the operator switched self-enrolment off")
  func reuseRechecksStatus() async throws {
    let f = try Self.fixture()
    f.browser.results = [.failure(.cancelled)]
    _ = try? await f.model.beginSelfEnrolment(presenter: Self.presenter)
    #expect(f.model.selfEnrolment?.phase == .signInEnded(.cancelled))

    var status = SelfEnrolWire.example("status_self_enrol").objectValue ?? [:]
    status["self_enrol"] = SelfEnrolWire.example("self_enrol_disabled")
    f.gateway.answer("/api/auth/passkeys", .json(SelfEnrolWire.text(.object(status))))

    await #expect(throws: PasskeyActionError.reauth(.disabled)) {
      try await f.model.beginSelfEnrolment(presenter: Self.presenter)
    }
    #expect(f.browser.asked.count == 1, "no second sign-in")
  }
}

// MARK: - The browser half

/// `BrowserReauthenticator`: the sign-in's sheet, listener and gate, the app lock's guard, and the
/// token set left alone.
@MainActor
@Suite("Passkey self-enrolment: signing in again")
struct BrowserReauthenticatorTests {
  static let base = "https://gw.example.com"

  static func lock() async throws -> AppLock {
    let settings = KeyValueStore(store: try SQLiteStore(.inMemory))
    try await settings.setString(#"{"threshold":"immediately"}"#, forKey: StoreKeys.lock)
    let lock = AppLock(settings: settings, authenticator: ScriptedAuthenticator(), forcedLock: false)
    await lock.hydrate()
    await lock.unlock(reason: "test")
    return lock
  }

  static let held = TokenSet(accessToken: "at-held", refreshToken: "rt-held", expiresAt: 4_102_444_800, provider: "self-hosted", userID: "u")

  struct Fixture {
    let reauth: BrowserReauthenticator
    let services: GatewayServices
    let store: MemoryTokenStore
    let server: StubServer
    let lock: AppLock
  }

  static func fixture(listeners: ListenerQueue, timer: ManualTimer = ManualTimer()) async throws -> Fixture {
    let fresh = SelfEnrolWire.text(SelfEnrolWire.example("native_token_reauth_fresh"))
    let server = StubServer { request in
      request.path == "/auth/native/token" ? .json(fresh) : .json("{}", status: 404)
    }
    let store = MemoryTokenStore(held)
    let coordinator = TokenCoordinator(store: store, refresh: { $0 }, nowSeconds: { 1_790_000_000 })
    let credentials = NativePKCECredentials(baseURL: base, coordinator: coordinator, transport: server.transport())
    let services = GatewayServices(
      transport: server.transport(),
      makeListener: { listeners.next() },
      sleep: timer.sleep
    )
    let lock = try await lock()

    return Fixture(
      reauth: BrowserReauthenticator(services: services, credentials: credentials, lock: lock),
      services: services,
      store: store,
      server: server,
      lock: lock
    )
  }

  @Test("the sheet opens the grant's authorize URL, is a system prompt for the lock, and the token set stays")
  func signsInAgain() async throws {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let f = try await Self.fixture(listeners: ListenerQueue([listener]))

    let attempt = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: "self_hosted", presenter: presenter) }

    await eventually { !presenter.opened.isEmpty }
    let opened = try #require(presenter.opened.first?.absoluteString)
    #expect(opened.hasPrefix("\(Self.base)/auth/native/authorize?provider=self_hosted&"))
    #expect(opened.hasSuffix("&reauth=\(SelfEnrolWire.grant)"))
    #expect(f.lock.ceremonies == 1, "the sheet is up: a system prompt")

    // The sheet's resign does not lock the app under it.
    f.lock.appWentAway()
    f.lock.appCameBack()
    #expect(!f.lock.machine.locked)

    // Listening again after the app comes back reaches the attempt's listener.
    await f.reauth.appBecameActive()
    #expect(await listener.resumes == 1)

    #expect(await listener.deliver(presenter.callbackURL(code: "code-r")))
    let completion = try await attempt.value.get()

    #expect(completion == ReauthCompletion(grantID: SelfEnrolWire.grant, state: .fresh(useSecret: SelfEnrolWire.useSecret), expiresAt: 1_790_000_600))
    #expect(f.lock.ceremonies == 0)
    #expect(presenter.closes >= 1)
    #expect(await listener.stopped)
    #expect(f.store.load() == Self.held, "the token set is untouched")
    #expect(f.server.requests.map(\.path) == ["/auth/native/token"])
  }

  @Test("the person closing the sheet cancels it, and the lock's guard ends with it")
  func personCloses() async throws {
    let presenter = FakePresenter()
    let f = try await Self.fixture(listeners: ListenerQueue([FakeListener()]))
    let attempt = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: presenter) }

    await eventually { !presenter.opened.isEmpty }
    #expect(presenter.opened.first?.absoluteString.contains("provider=") == false)
    presenter.personClosesIt()

    #expect(await attempt.value == .failure(.cancelled))
    #expect(f.lock.ceremonies == 0)
    #expect(f.server.requests.isEmpty)
  }

  @Test("one browser attempt at a time: a new one ends the one before, which gives the lock back")
  func oneAtATime() async throws {
    let first = FakeListener()
    let second = FakeListener()
    let firstSheet = FakePresenter()
    let secondSheet = FakePresenter()
    let f = try await Self.fixture(listeners: ListenerQueue([first, second]))

    let a = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: firstSheet) }
    await eventually { !firstSheet.opened.isEmpty }

    let b = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: secondSheet) }

    #expect(await a.value == .failure(.cancelled))
    #expect(await first.stopped)
    await eventually { !secondSheet.opened.isEmpty }
    #expect(f.lock.ceremonies == 1)

    #expect(await second.deliver(secondSheet.callbackURL(code: "code-2")))
    #expect(try await b.value.get().grantID == SelfEnrolWire.grant)
    #expect(f.lock.ceremonies == 0)
  }

  @Test("the caller cancelling ends the attempt: the sheet closes, the listener stops, the lock is given back")
  func callerCancels() async throws {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let f = try await Self.fixture(listeners: ListenerQueue([listener]))
    let attempt = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: presenter) }

    await eventually { !presenter.opened.isEmpty }
    #expect(f.lock.ceremonies == 1)
    attempt.cancel()

    #expect(await attempt.value == .failure(.cancelled))
    #expect(presenter.closes >= 1)
    #expect(await listener.stopped)
    #expect(f.lock.ceremonies == 0)
    #expect(f.server.requests.isEmpty)
  }

  @Test("cancel() ends the attempt in progress and waits until the lock is given back")
  func cancelEnds() async throws {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let f = try await Self.fixture(listeners: ListenerQueue([listener]))
    let attempt = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: presenter) }

    await eventually { !presenter.opened.isEmpty }
    await f.reauth.cancel()

    #expect(f.lock.ceremonies == 0)
    #expect(await listener.stopped)
    #expect(await attempt.value == .failure(.cancelled))

    // Nothing in progress: nothing to do.
    await f.reauth.cancel()
  }

  @Test("the lock is given back when the attempt cannot start, cannot listen, or times out")
  func lockBalancedOnEveryEnd() async throws {
    // No grant: the authorize URL cannot be made.
    let f1 = try await Self.fixture(listeners: ListenerQueue([FakeListener()]))
    #expect(await f1.reauth.reauthenticate(grantID: "", provider: nil, presenter: FakePresenter()) == .failure(.couldNotStart))
    #expect(f1.lock.ceremonies == 0)

    let f2 = try await Self.fixture(listeners: ListenerQueue([FakeListener(.fail(.unavailable))]))
    #expect(await f2.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: FakePresenter()) == .failure(.listenerUnavailable))
    #expect(f2.lock.ceremonies == 0)

    let timer = ManualTimer()
    let presenter = FakePresenter()
    let f3 = try await Self.fixture(listeners: ListenerQueue([FakeListener()]), timer: timer)
    let attempt = Task { await f3.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: presenter) }
    await eventually { !presenter.opened.isEmpty }
    timer.fire()
    #expect(await attempt.value == .failure(.timedOut))
    #expect(f3.lock.ceremonies == 0)
  }

  @Test("an onboarding sign-in started during a re-authentication ends it, and the reverse")
  func sharesTheGateWithOnboarding() async throws {
    let reauthListener = FakeListener()
    let signInListener = FakeListener()
    let laterReauthListener = FakeListener()
    let listeners = ListenerQueue([reauthListener, signInListener, laterReauthListener])
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport(), listener: { listeners.next() })
    let window = harness.model()
    let fresh = SelfEnrolWire.text(SelfEnrolWire.example("native_token_reauth_fresh"))
    let server = StubServer { _ in .json(fresh) }
    let coordinator = TokenCoordinator(store: MemoryTokenStore(), refresh: { $0 }, nowSeconds: { 1_790_000_000 })
    let credentials = NativePKCECredentials(baseURL: Self.base, coordinator: coordinator, transport: server.transport())
    let lock = try await Self.lock()
    let reauth = BrowserReauthenticator(services: harness.accounts.services, credentials: credentials, lock: lock)

    window.address = "https://gw.example.test"
    await eventually { window.resolved != nil }

    // The re-authentication first; the sign-in from the window ends it.
    let sheet = FakePresenter()
    let first = Task { await reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: sheet) }
    await eventually { !sheet.opened.isEmpty }

    let signInSheet = FakePresenter()
    window.startBrowserSignIn(presenter: signInSheet)

    #expect(await first.value == .failure(.cancelled))
    #expect(await reauthListener.stopped)
    #expect(lock.ceremonies == 0)
    await signInListener.waitUntilStarted()
    await eventually { !signInSheet.opened.isEmpty }
    #expect(window.isWaitingForBrowser)

    // Then a re-authentication ends the window's sign-in.
    let laterSheet = FakePresenter()
    let second = Task { await reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: laterSheet) }

    await eventually { window.signIn == .idle }
    #expect(await signInListener.stopped)
    await eventually { !laterSheet.opened.isEmpty }
    #expect(await laterReauthListener.deliver(laterSheet.callbackURL(code: "code-r")))
    #expect(try await second.value.get().grantID == SelfEnrolWire.grant)
    #expect(lock.ceremonies == 0)
  }

  @Test("a sign-in in progress in the same gate is ended by a re-authentication")
  func endsASignIn() async throws {
    let f = try await Self.fixture(listeners: ListenerQueue([FakeListener()]))
    let signIn = Task<Void, Never> {
      try? await Task.sleep(for: .seconds(3_600))
    }
    f.services.browserGate.current = signIn

    let presenter = FakePresenter()
    let attempt = Task { await f.reauth.reauthenticate(grantID: SelfEnrolWire.grant, provider: nil, presenter: presenter) }

    await eventually { !presenter.opened.isEmpty }
    #expect(signIn.isCancelled)
    presenter.personClosesIt()
    _ = await attempt.value
  }
}
