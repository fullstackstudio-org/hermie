import Foundation
import HermieGateway
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A resolver that answers from a table, by the address as typed, and records what it was handed.
final class ProbeStub: Sendable {
  struct Call: Sendable {
    var raw: String
    var custom: [String: String]
    var frontDoor: FrontDoor
  }

  private let answers: Mutex<[String: Result<OnboardingProbe, GatewayError>]>
  private let seen = Mutex<[Call]>([])

  init(_ answers: [String: Result<OnboardingProbe, GatewayError>]) {
    self.answers = Mutex(answers)
  }

  var calls: [Call] { seen.withLock { $0 } }

  var resolve: @Sendable (String, [String: String], FrontDoor) async throws -> OnboardingProbe {
    { raw, custom, door in
      self.seen.withLock { $0.append(Call(raw: raw, custom: custom, frontDoor: door)) }

      guard let answer = self.answers.withLock({ $0[raw] }) else {
        throw GatewayError(.network, "unreachable")
      }

      return try answer.get()
    }
  }

  static func ungated(_ baseURL: String, overHTTP: Bool = false) -> Result<OnboardingProbe, GatewayError> {
    .success(
      OnboardingProbe(
        result: ProbeResult(version: "1.2.3", authRequired: false, authFlows: [], providers: [], supportsNativePKCE: false),
        baseURL: baseURL,
        foundOverHTTP: overHTTP
      )
    )
  }

  static func gated(_ baseURL: String, providers: [AuthProvider] = [selfHosted]) -> Result<OnboardingProbe, GatewayError> {
    .success(
      OnboardingProbe(
        result: ProbeResult(
          version: "1.2.3",
          authRequired: true,
          authFlows: ["native_pkce", "native_revoke"],
          providers: providers,
          supportsNativePKCE: true
        ),
        baseURL: baseURL,
        foundOverHTTP: false
      )
    )
  }

  static let selfHosted = AuthProvider(name: "self-hosted", displayName: "Self-Hosted", supportsPassword: true)
}

/// A secret store that refuses every write.
final class RefusingSecretStorage: GatewaySecretStorage {
  struct Refused: Error {}

  func get(_ key: String) throws -> String? { nil }
  func set(_ key: String, _ value: String) throws { throw Refused() }
  func delete(_ key: String) throws {}
}

@MainActor
@Suite("Onboarding model")
struct OnboardingModelTests {
  // MARK: Probe outcomes

  @Test("an ungated gateway is found and asks for its session token")
  func ungatedFound() async throws {
    let harness = try OnboardingHarness(
      transport: HTTPTransport(),
      resolve: ProbeStub(["gw.example.test": ProbeStub.ungated("https://gw.example.test")]).resolve
    )
    let model = harness.model()

    model.address = "gw.example.test"
    #expect(model.probe == .checking(pinnedScheme: nil))

    await eventually { model.resolved != nil }
    #expect(model.baseURL == "https://gw.example.test")
    #expect(model.authMode == .sessionToken)
    #expect(model.cleartextPrivacy == nil)
    #expect(model.canLeaveAddress)

    model.continueFromAddress()
    #expect(model.path == [.signIn])
  }

  @Test("a typed scheme is the one that is checked")
  func pinnedScheme() throws {
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve)
    let model = harness.model()

    model.address = "HTTPS://gw.example.test"
    #expect(model.probe == .checking(pinnedScheme: "https://"))
  }

  @Test("every probe failure keeps what the classifier makes of it")
  func failures() async throws {
    let stub = ProbeStub([
      "down.example.test": .failure(GatewayError(.network, "no answer")),
      "https://pinned.example.test": .failure(GatewayError(.network, "no answer")),
      "tls.example.test": .failure(GatewayError(.tls, "bad certificate")),
      "slow.example.test": .failure(GatewayError(.timeout, "slow")),
      "500.example.test": .failure(GatewayError(.server, "boom", status: 502)),
      "old.example.test": .failure(GatewayError(.incompatible, "old")),
      "http://192.168.1.20:9119": .failure(GatewayError(.notHermes, "a web page", sawLandingPage: true)),
      "proxy.example.test": .failure(GatewayError(.auth, "proxy", status: 403)),
      "moved.example.test": .failure(
        GatewayError(.redirect, "moved", redirectedTo: "new.example.test", redirectedOrigin: "https://new.example.test:8443")
      )
    ])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    func failure(_ address: String) async -> OnboardingModel.ProbeFailure? {
      model.address = address
      await eventually { if case .failed = model.probe { true } else { false } }
      if case .failed(let failure) = model.probe { return failure }
      return nil
    }

    let down = await failure("down.example.test")
    #expect(down?.kind == .network)
    #expect(down?.host == "down.example.test")
    #expect(down?.httpsWasPinned == false)
    #expect(down?.verdict == ProbeVerdict())

    #expect(await failure("https://pinned.example.test")?.httpsWasPinned == true)
    #expect(await failure("tls.example.test")?.kind == .tls)
    #expect(await failure("slow.example.test")?.kind == .timeout)
    #expect(await failure("500.example.test")?.status == 502)
    #expect(await failure("old.example.test")?.kind == .incompatible)

    // A web page from a host only a private network reaches: both facts are kept.
    let page = await failure("http://192.168.1.20:9119")
    #expect(page?.verdict.landingPage == true)
    #expect(page?.verdict.hint == .privateNetwork)

    // A proxy in the way: the front door is offered, and opening it picks the Cloudflare preset.
    let proxy = await failure("proxy.example.test")
    #expect(proxy?.verdict.actions == [.frontDoor])
    model.openFrontDoor()
    #expect(model.advancedShown)
    #expect(model.frontDoorKind == .cloudflareAccess)

    // A redirect: the target is offered, scheme and port included, and taking it probes there.
    let moved = await failure("moved.example.test")
    #expect(moved?.verdict.actions == [.useHost("new.example.test", origin: "https://new.example.test:8443")])
    #expect(!model.canLeaveAddress)
    model.useRedirectTarget("https://new.example.test:8443")
    #expect(model.address == "https://new.example.test:8443")
    await eventually { stub.calls.last?.raw == "https://new.example.test:8443" }
  }

  @Test("what is not an address fails without a request, and an empty field says nothing")
  func notAnAddress() async throws {
    let stub = ProbeStub([:])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "ftp://gw.example.test"
    guard case .failed(let failure) = model.probe else {
      Issue.record("expected a failure, got \(model.probe)")
      return
    }
    #expect(failure.kind == .config)

    model.address = "   "
    #expect(model.probe == .idle)
    #expect(stub.calls.isEmpty)
  }

  @Test("a late answer for an older address is dropped")
  func lateAnswerDropped() async throws {
    let gate = ManualTimer()
    let resolve: @Sendable (String, [String: String], FrontDoor) async throws -> OnboardingProbe = { raw, _, _ in
      if raw == "first.example.test" {
        try? await gate.sleep(.zero)
        return try ProbeStub.ungated("https://first.example.test").get()
      }

      return try ProbeStub.gated("https://second.example.test").get()
    }
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: resolve)
    let model = harness.model()

    model.address = "first.example.test"
    await Task.yield()
    model.address = "second.example.test"
    await eventually { model.resolved != nil }
    gate.fire()

    for _ in 0..<20 {
      await Task.yield()
    }

    #expect(model.baseURL == "https://second.example.test")
  }

  // MARK: Plain http

  @Test("plain http on a private network is described; on a public host it must be confirmed")
  func cleartextRules() async throws {
    let stub = ProbeStub([
      "http://192.168.1.10:9119": ProbeStub.ungated("http://192.168.1.10:9119"),
      "http://hermes.box.ts.net": ProbeStub.ungated("http://hermes.box.ts.net"),
      "http://127.0.0.1:9119": ProbeStub.ungated("http://127.0.0.1:9119"),
      "public.example.com": ProbeStub.ungated("http://public.example.com", overHTTP: true),
      "other.example.com": ProbeStub.ungated("http://other.example.com", overHTTP: true)
    ])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    for (address, privacy) in [
      ("http://192.168.1.10:9119", HostPrivacy.private),
      ("http://hermes.box.ts.net", .tailnet),
      ("http://127.0.0.1:9119", .loopback)
    ] {
      model.address = address
      await eventually { model.baseURL == address }
      #expect(model.cleartextPrivacy == privacy)
      #expect(!model.needsCleartextConfirmation)
      #expect(model.canLeaveAddress)
    }

    model.address = "public.example.com"
    await eventually { model.baseURL == "http://public.example.com" }
    #expect(model.cleartextPrivacy == .public)
    #expect(model.needsCleartextConfirmation)
    #expect(!model.canLeaveAddress)

    model.continueFromAddress()
    #expect(model.path.isEmpty)

    model.cleartextConfirmed = true
    #expect(model.canLeaveAddress)

    // The confirmation was for that address; another one asks again.
    model.address = "other.example.com"
    await eventually { model.baseURL == "http://other.example.com" }
    #expect(!model.cleartextConfirmed)
    #expect(!model.canLeaveAddress)

    // The way out: the same address over https.
    model.useHTTPS()
    #expect(model.address == "https://other.example.com")
  }

  // MARK: The front door and headers

  @Test("the Cloudflare Access pair is never sent over http, and is sent over https")
  func frontDoorNeverOverHTTP() async throws {
    let server = GatewayStub.ungated()
    let harness = try OnboardingHarness(transport: server.transport())
    let model = harness.model()

    model.advancedShown = true
    model.frontDoorKind = .cloudflareAccess
    model.accessClientID = "abc123.access"
    model.accessClientSecret = "cf-secret-value"
    model.address = "http://gw.example.test"
    await eventually { model.resolved != nil }

    #expect(model.frontDoorWithheld)
    #expect(model.wireHeaders[FrontDoor.clientSecretHeader] == nil)
    #expect(!server.requests.isEmpty)
    #expect(server.requests.allSatisfy { $0.header(FrontDoor.clientSecretHeader) == nil && $0.header(FrontDoor.clientIDHeader) == nil })

    model.address = "https://gw.example.test"
    await eventually { model.baseURL == "https://gw.example.test" }

    #expect(!model.frontDoorWithheld)
    #expect(model.wireHeaders[FrontDoor.clientSecretHeader] == "cf-secret-value")
    #expect(server.requests.last?.header(FrontDoor.clientSecretHeader) == "cf-secret-value")
    #expect(server.requests.filter { $0.scheme == "http" }.allSatisfy { $0.header(FrontDoor.clientSecretHeader) == nil })
  }

  @Test("the probe gets the custom headers and the front door separately; leaving the preset drops the pair")
  func headersReachTheProbe() async throws {
    let stub = ProbeStub(["https://gw.example.test": ProbeStub.ungated("https://gw.example.test")])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.addHeader()
    model.headers[0].name = "X-Proxy-Key"
    model.headers[0].value = "proxy-secret"
    model.frontDoorKind = .cloudflareAccess
    model.accessClientID = "id"
    model.accessClientSecret = "secret"
    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }

    let call = try #require(stub.calls.last)
    #expect(call.custom == ["X-Proxy-Key": "proxy-secret"])
    #expect(call.frontDoor.isComplete)

    model.frontDoorKind = .custom
    #expect(model.accessClientSecret.isEmpty)
    #expect(model.frontDoor == .none)
  }

  @Test("header rows are checked: a bad name and a reserved one are named, and neither travels")
  func headerValidation() throws {
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve)
    let model = harness.model()

    model.addHeader()
    model.addHeader()
    model.addHeader()
    model.addHeader()
    model.headers[0].name = "Bad Name"
    model.headers[1].name = "Authorization"
    model.headers[2].name = "X-Good"
    model.headers[2].value = " v\r\n "

    #expect(model.headerProblem(model.headers[0]) == .invalidName)
    #expect(model.headerProblem(model.headers[1]) == .reserved)
    #expect(model.headerProblem(model.headers[2]) == nil)
    #expect(model.headerProblem(model.headers[3]) == nil)
    #expect(model.customHeaders == ["X-Good": "v"])

    model.removeHeader(model.headers[0].id)
    #expect(model.headers.count == 3)
  }

  // MARK: Session token

  @Test("a session token is checked, then the gateway is stored, activated and the secrets forgotten")
  func sessionTokenEndToEnd() async throws {
    let server = GatewayStub.ungated()
    let harness = try OnboardingHarness(transport: server.transport())
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.continueFromAddress()

    model.sessionToken = "wrong-token"
    #expect(await model.continueFromSignIn() == nil)
    #expect(model.signIn == .failed(.rejected))
    #expect(model.path == [.signIn])

    model.sessionToken = "good-token"
    #expect(model.signIn == .idle)
    _ = await model.continueFromSignIn()
    #expect(model.signIn == .signedIn)
    #expect(model.path == [.signIn, .name])
    #expect(model.name == "gw.example.test")

    model.name = "Home"
    model.continueFromName()
    #expect(model.path == [.signIn, .name, .done])

    let id = try #require(await model.finish())
    let registry = try await harness.registry()
    let keys = try GatewaySecretKeys(gatewayID: id)

    #expect(registry.activeGatewayId == id)
    #expect(registry.gateway(id: id)?.name == "Home")
    #expect(registry.gateway(id: id)?.authKind == .sessionToken)
    #expect(try harness.secrets.get(keys.sessionToken) == "good-token")
    #expect(harness.directory.activeId == id)
    #expect(await harness.config(id) == StoredGatewayConfig(baseUrl: "https://gw.example.test", authMode: .sessionToken, version: "1.2.3"))
    #expect(harness.accounts.status(for: id) == .signedIn)

    // Nothing secret is left in the model.
    #expect(model.sessionToken.isEmpty)
    #expect(model.signIn == .idle)
  }

  // MARK: Native sign-in

  @Test("a browser sign-in is checked with /api/auth/me and stored with who signed in")
  func browserSignInEndToEnd() async throws {
    let server = GatewayStub.gated()
    let listener = FakeListener()
    let harness = try OnboardingHarness(transport: server.transport(), listener: { listener })
    let model = harness.model()
    let presenter = FakePresenter()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    #expect(model.authMode == .nativePKCE)
    #expect(model.provider?.name == "self-hosted")
    #expect(model.canSignInWithProvider)
    model.continueFromAddress()

    model.startBrowserSignIn(presenter: presenter)
    #expect(model.isWaitingForBrowser)
    await eventually { !presenter.opened.isEmpty }
    await listener.waitUntilStarted()
    #expect(await listener.deliver(presenter.callbackURL()))

    await eventually { model.signIn == .signedIn }
    #expect(model.identity?.displayName == "Tester")
    #expect(model.canLeaveSignIn)

    _ = await model.continueFromSignIn()
    model.continueFromName()

    let id = try #require(await model.finish())
    let keys = try GatewaySecretKeys(gatewayID: id)
    let config = try #require(await harness.config(id))

    #expect(try harness.secrets.get(keys.accessToken) == "at-1")
    #expect(try harness.secrets.get(keys.refreshToken) == "rt-1")
    #expect(try harness.secrets.get(keys.sessionToken) == nil)
    #expect(config.authMode == "native_pkce")
    #expect(config.provider == "self-hosted")
    #expect(config.providerDisplayName == "Self-Hosted")
    #expect(config.userDisplayName == "Tester")
    #expect(config.userEmail == "tester@example.invalid")
    #expect(try await harness.registry().gateway(id: id)?.signedInUser == "Tester")
  }

  @Test("the in-app page: its navigations are ruled, the callback is redeemed and never loaded")
  func inAppSignIn() async throws {
    let server = GatewayStub.gated()
    let harness = try OnboardingHarness(transport: server.transport())
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }

    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }

    let attempt = try #require(model.inAppAttempt)
    let state = try #require(URLComponents(url: attempt.authorizeURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)

    #expect(await attempt.decide(attempt.authorizeURL.absoluteString) == .allow)
    #expect(await attempt.decide("https://idp.example.test/login") == .allow)
    #expect(await attempt.decide("http://127.0.0.1:38007/callback?code=code-1&state=\(state)") == .cancel)

    await eventually { model.signIn == .signedIn }
    #expect(model.inAppAttempt == nil)
  }

  @Test("the in-app page refuses anything else on this device, and that ends the attempt")
  func inAppBlocksLoopback() async throws {
    let server = GatewayStub.gated()
    let harness = try OnboardingHarness(transport: server.transport())
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }

    let attempt = try #require(model.inAppAttempt)

    #expect(await attempt.decide("http://127.0.0.1:9999/steal") == .cancel)
    await eventually { model.signIn == .failed(.blockedNavigation) }
    #expect(server.requests.allSatisfy { $0.path != "/auth/native/token" })
  }

  @Test("another app holding the port is reported, and the in-app page still works")
  func portInUseOffersTheFallback() async throws {
    let server = GatewayStub.gated()
    let harness = try OnboardingHarness(
      transport: server.transport(),
      listener: { FakeListener(.fail(.portInUse(port: 38007))) }
    )
    let model = harness.model()
    let presenter = FakePresenter()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startBrowserSignIn(presenter: presenter)

    await eventually { model.signIn == .failed(.portInUse) }
    #expect(presenter.opened.isEmpty)

    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }
  }

  @Test("with several providers, nothing starts until one is chosen")
  func severalProviders() async throws {
    let other = AuthProvider(name: "oidc", displayName: "Company SSO", supportsPassword: false)
    let stub = ProbeStub(["https://gw.example.test": ProbeStub.gated("https://gw.example.test", providers: [ProbeStub.selfHosted, other])])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    #expect(model.provider == nil)
    #expect(!model.canSignInWithProvider)

    model.selectedProvider = "oidc"
    #expect(model.provider?.displayName == "Company SSO")
    #expect(model.canSignInWithProvider)
  }

  @Test("a gated gateway without native sign-in, or without providers, cannot be signed in to")
  func cannotSignIn() async throws {
    let old = OnboardingProbe(
      result: ProbeResult(version: "0.9", authRequired: true, authFlows: ["cookie"], providers: [ProbeStub.selfHosted], supportsNativePKCE: false),
      baseURL: "https://old.example.test",
      foundOverHTTP: false
    )
    let stub = ProbeStub([
      "https://old.example.test": .success(old),
      "https://bare.example.test": ProbeStub.gated("https://bare.example.test", providers: [])
    ])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "https://old.example.test"
    await eventually { model.resolved != nil }
    #expect(!model.canSignInWithProvider)

    model.address = "https://bare.example.test"
    await eventually { model.baseURL == "https://bare.example.test" }
    #expect(!model.canSignInWithProvider)
    #expect(!model.canLeaveSignIn)
  }

  // MARK: Leaving at each step

  @Test("closing on the address step stops the probe and stores nothing")
  func cancelOnAddress() async throws {
    let gate = ManualTimer()
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve, sleep: gate.sleep)
    let model = harness.model()

    model.address = "gw.example.test"
    model.close()
    gate.fire()

    for _ in 0..<20 {
      await Task.yield()
    }

    #expect(model.probe == .checking(pinnedScheme: nil))
    #expect(try await harness.registry().gateways.isEmpty)
  }

  @Test("closing during a browser sign-in closes the sheet and stops the listener")
  func cancelDuringBrowserSignIn() async throws {
    let listener = FakeListener()
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport(), listener: { listener })
    let model = harness.model()
    let presenter = FakePresenter()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startBrowserSignIn(presenter: presenter)
    await eventually { !presenter.opened.isEmpty }

    model.close()

    await eventually { presenter.closes > 0 }
    for _ in 0..<50 where !(await listener.stopped) {
      try? await Task.sleep(for: .milliseconds(5))
    }
    #expect(await listener.stopped)
    #expect(model.signIn == .idle)
    // The callback that might still arrive is no longer taken.
    #expect(await listener.deliver(presenter.callbackURL()) == false)
  }

  @Test("one browser sign-in at a time: a second, from another window, ends the first and waits for its port")
  func oneBrowserSignInAtATime() async throws {
    let first = FakeListener()
    let second = FakeListener()
    let listeners = ListenerQueue([first, second])
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport(), listener: { listeners.next() })
    let windowA = harness.model()
    let windowB = harness.model()
    let presenterA = FakePresenter()
    let presenterB = FakePresenter()

    for model in [windowA, windowB] {
      model.address = "https://gw.example.test"
    }

    await eventually { windowA.resolved != nil && windowB.resolved != nil }

    windowA.startBrowserSignIn(presenter: presenterA)
    await first.waitUntilStarted()

    windowB.startBrowserSignIn(presenter: presenterB)
    await second.waitUntilStarted()

    // The first was stopped before the second listened, and its window is back to idle.
    #expect(await first.stopped)
    #expect(presenterA.closes >= 1)
    await eventually { windowA.signIn == .idle }
    #expect(windowB.isWaitingForBrowser)

    await eventually { !presenterB.opened.isEmpty }
    #expect(await second.deliver(presenterB.callbackURL()))
    await eventually { windowB.signIn == .signedIn }
  }

  @Test("cancelling the in-app page ends the attempt")
  func cancelInApp() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport())
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }

    let attempt = try #require(model.inAppAttempt)

    model.cancelSignIn()
    #expect(model.inAppAttempt == nil)
    #expect(model.signIn == .idle)
    #expect(attempt.phase == .failed(.cancelled))
    #expect(await attempt.decide("https://gw.example.test/") == .cancel)
  }

  @Test("closing after signing in, before saving, forgets the tokens and stores nothing")
  func cancelBeforeSaving() async throws {
    let listener = FakeListener()
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport(), listener: { listener })
    let model = harness.model()
    let presenter = FakePresenter()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startBrowserSignIn(presenter: presenter)
    await eventually { !presenter.opened.isEmpty }
    await listener.waitUntilStarted()
    _ = await listener.deliver(presenter.callbackURL())
    await eventually { model.signIn == .signedIn }

    model.close()

    #expect(!model.canLeaveSignIn)
    #expect(await model.finish() == nil)
    #expect(try await harness.registry().gateways.isEmpty)
    #expect(harness.secrets.keys.isEmpty)
  }

  @Test("changing the address after signing in drops the sign-in")
  func addressChangeDropsSignIn() async throws {
    let stub = ProbeStub([
      "https://a.example.test": ProbeStub.ungated("https://a.example.test"),
      "https://b.example.test": ProbeStub.ungated("https://b.example.test")
    ])
    let server = GatewayStub.ungated()
    let harness = try OnboardingHarness(transport: server.transport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "https://a.example.test"
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"
    _ = await model.continueFromSignIn()
    #expect(model.signIn == .signedIn)

    model.address = "https://b.example.test"
    await eventually { model.baseURL == "https://b.example.test" }
    #expect(model.signIn == .idle)
  }

  // MARK: Saving

  @Test("a keychain that refuses leaves nothing behind")
  func keychainRefuses() async throws {
    let server = GatewayStub.ungated()
    let store = try SQLiteStore(.inMemory)
    let directory = GatewayDirectory(store: GatewayRegistryStore(store: store), changes: KeyValueStore(store: store))
    let accounts = GatewayAccounts(
      directory: directory,
      services: GatewayServices(store: store, secrets: RefusingSecretStorage(), transport: server.transport(), sleep: OnboardingHarness.instantDebounce)
    )
    let model = OnboardingModel(mode: .newGateway, accounts: accounts)

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"
    _ = await model.continueFromSignIn()

    #expect(await model.finish() == nil)
    #expect(model.saveState == .failed(.keychain))
    #expect(try await GatewayRegistryStore(store: store).load().gateways.isEmpty)
  }

  @Test("a list from a newer Hermie is not written over, and the secrets are taken back out")
  func newerRegistry() async throws {
    let server = GatewayStub.ungated()
    let harness = try OnboardingHarness(transport: server.transport())
    let model = harness.model()

    try await KeyValueStore(store: harness.store).setString(#"{"v":99,"gateways":[]}"#, forKey: StoreKeys.gateways)

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"
    _ = await model.continueFromSignIn()

    #expect(await model.finish() == nil)
    #expect(model.saveState == .failed(.unsupportedRegistry))
    #expect(harness.secrets.keys.isEmpty)
  }

  // MARK: Review fixes

  @Test("switching to the in-app page while the browser waits: the browser attempt's cleanup cannot erase the new one")
  func switchingAttemptsKeepsTheNewOne() async throws {
    let gate = ManualTimer()
    let slowStop = SlowStopListener(gate: gate)
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport(), listener: { slowStop })
    let model = harness.model()
    let presenter = FakePresenter()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startBrowserSignIn(presenter: presenter)
    await eventually { !presenter.opened.isEmpty }

    // The person switches; the browser attempt is cancelled, and its cleanup is held back.
    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }

    let attempt = try #require(model.inAppAttempt)
    let state = try #require(URLComponents(url: attempt.authorizeURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)

    // The browser attempt's cleanup (stopping its listener, cancelling its sign-in) now runs...
    gate.fire()

    for _ in 0..<20 {
      await Task.yield()
    }

    // ...and the in-app attempt still completes.
    #expect(await attempt.decide("http://127.0.0.1:38007/callback?code=code-1&state=\(state)") == .cancel)
    await eventually { model.signIn == .signedIn }
  }

  @Test("headers a browser cannot send make the in-app page the way to sign in")
  func headersNeedTheInAppPage() async throws {
    let stub = ProbeStub(["https://gw.example.test": ProbeStub.gated("https://gw.example.test")])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    #expect(!model.needsInAppSignIn)

    model.frontDoorKind = .cloudflareAccess
    model.accessClientID = "id"
    model.accessClientSecret = "secret"
    await eventually { model.resolved != nil }
    #expect(model.needsInAppSignIn)
    #expect(model.browserMightWork)

    model.addHeader()
    model.headers[0].name = "X-Proxy-Key"
    model.headers[0].value = "v"
    await eventually { model.resolved != nil }
    #expect(model.needsInAppSignIn)
    #expect(!model.browserMightWork)
  }

  @Test("an error callback in the in-app page ends the attempt only with this attempt's state")
  func errorCallbacksNeedTheState() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.gated().transport())
    let model = harness.model()

    model.address = "https://gw.example.test"
    await eventually { model.resolved != nil }
    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil }

    let attempt = try #require(model.inAppAttempt)

    #expect(await attempt.decide("http://127.0.0.1:38007/callback?error=access_denied&error_description=Click%20here&state=forged") == .cancel)
    await eventually { model.signIn == .failed(.stateMismatch) }

    model.startInAppSignIn()
    await eventually { model.inAppAttempt != nil && model.inAppAttempt !== attempt }

    let second = try #require(model.inAppAttempt)
    let state = try #require(URLComponents(url: second.authorizeURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)

    #expect(await second.decide("http://127.0.0.1:38007/callback?error=access_denied&state=\(state)") == .cancel)
    await eventually { if case .failed(.provider) = model.signIn { true } else { false } }
  }

  /// A gateway stored and signed in with a session token, for the sign-in-again tests.
  func storedTokenGateway(_ harness: OnboardingHarness, id: String, address: String = "https://gw.example.test") async throws {
    try await GatewayRegistryStore(store: harness.store).add(
      GatewayRecord(id: id, name: "Work", address: address, authKind: .sessionToken, addedAt: 1)
    )
    try await KeyValueStore(store: harness.store).setString(
      try StoredGatewayConfig(baseUrl: address, authMode: .sessionToken).encoded(),
      forKey: StoredGatewayConfig.key(gatewayId: id)
    )
    await harness.directory.load()
  }

  @Test("signing in again to a gateway removed meanwhile stores nothing and leaves no credential behind")
  func signInAgainAfterRemoval() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.ungated().transport())
    let id = "g00aa11bb22cc33"

    try await storedTokenGateway(harness, id: id)

    let model = harness.model(.signIn(gatewayId: id))

    await model.load()
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"

    // Removed while the person was typing.
    try await harness.directory.remove(id: id)

    #expect(await model.continueFromSignIn() == nil)
    #expect(model.saveState == .failed(.gatewayRemoved))
    #expect(harness.secrets.keys.isEmpty)
    #expect(await harness.config(id) == nil)
    #expect(try await harness.registry().gateways.isEmpty)
  }

  @Test("signing in again where the gateway now answers at another address stores nothing")
  func signInAgainAtAnotherAddress() async throws {
    let stub = ProbeStub(["https://old.example.test": ProbeStub.ungated("https://moved.example.test")])
    let harness = try OnboardingHarness(transport: GatewayStub.ungated().transport(), resolve: stub.resolve)
    let id = "g00aa11bb22cc44"

    try await storedTokenGateway(harness, id: id, address: "https://old.example.test")

    let model = harness.model(.signIn(gatewayId: id))

    await model.load()
    await eventually { model.resolved != nil }
    model.sessionToken = "good-token"

    #expect(await model.continueFromSignIn() == nil)
    #expect(model.saveState == .failed(.addressChanged))
    #expect(harness.secrets.keys.isEmpty)
  }

  @Test("load() runs once, however often the sheet is built again")
  func loadRunsOnce() async throws {
    let harness = try OnboardingHarness(transport: GatewayStub.ungated().transport())
    let id = "g00aa11bb22cc55"

    try await storedTokenGateway(harness, id: id)
    try GatewaySecrets.save(
      storage: harness.secrets,
      keys: try GatewaySecretKeys(gatewayID: id),
      baseURL: "https://gw.example.test",
      customHeaders: ["X-Proxy-Key": "v"]
    )

    let model = harness.model(.signIn(gatewayId: id))

    await model.load()
    await model.load()
    #expect(model.headers.count == 1)
  }

  // MARK: Signing in again

  @Test("signing in again keeps the address, the name and the way in, and replaces the credential")
  func resume() async throws {
    let server = GatewayStub.ungated()
    let harness = try OnboardingHarness(transport: server.transport())
    let id = "g00112233445566"
    let keys = try GatewaySecretKeys(gatewayID: id)

    try await GatewayRegistryStore(store: harness.store).add(
      GatewayRecord(id: id, name: "Work", address: "https://gw.example.test", authKind: .sessionToken, addedAt: 1)
    )
    try await KeyValueStore(store: harness.store).setString(
      try StoredGatewayConfig(baseUrl: "https://gw.example.test", authMode: .sessionToken).encoded(),
      forKey: StoredGatewayConfig.key(gatewayId: id)
    )
    try GatewaySecrets.save(
      storage: harness.secrets,
      keys: keys,
      baseURL: "https://gw.example.test",
      customHeaders: ["X-Proxy-Key": "proxy-secret"],
      frontDoor: .cloudflareAccess(.init(clientID: "id", clientSecret: "cf", origin: "https://gw.example.test"))
    )
    try harness.secrets.set(keys.accessToken, "stale-access")
    await harness.directory.load()

    let model = harness.model(.signIn(gatewayId: id))

    await model.load()
    #expect(model.address == "https://gw.example.test")
    #expect(model.headers.map(\.name) == ["X-Proxy-Key"])
    #expect(model.frontDoorKind == .cloudflareAccess)
    #expect(model.accessClientSecret == "cf")
    #expect(model.name == "Work")

    await eventually { model.resolved != nil }
    let probe = try #require(server.requests.last)
    #expect(probe.header("x-proxy-key") == "proxy-secret")
    #expect(probe.header(FrontDoor.clientSecretHeader) == "cf")

    model.sessionToken = "good-token"
    let saved = await model.continueFromSignIn()

    #expect(saved == id)
    #expect(try harness.secrets.get(keys.sessionToken) == "good-token")
    #expect(try harness.secrets.get(keys.accessToken) == nil)
    #expect(try harness.secrets.get(keys.extraHeaders) != nil)
    #expect(try harness.secrets.get(keys.frontDoor) != nil)
    #expect(try await harness.registry().gateway(id: id)?.name == "Work")
    #expect(try await harness.registry().gateways.count == 1)
  }

  @Test("an unknown gateway cannot be signed in to")
  func resumeUnknown() async throws {
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve)
    let model = harness.model(.signIn(gatewayId: "g0000000000000000"))

    await model.load()
    #expect(model.loadFailed)
  }

  @Test("no description, debug description or dump of the model or its rows shows a secret it holds")
  func redaction() throws {
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve)
    let model = harness.model()

    model.sessionToken = "st-SECRET-1"
    model.frontDoorKind = .cloudflareAccess
    model.accessClientSecret = "cf-SECRET-2"
    model.addHeader()
    model.headers[0].name = "X-Key"
    model.headers[0].value = "hv-SECRET-3"

    var dumped = ""
    dump(model, to: &dumped)
    dump(model.headers, to: &dumped)

    for text in [String(describing: model), String(reflecting: model), String(describing: model.headers), dumped] {
      #expect(!text.contains("SECRET"), "\(text)")
    }
  }

  @Test("the display name is the first of name, email, user id")
  func displayName() {
    let tokens = TokenSet(accessToken: "a", refreshToken: "r", expiresAt: 0, provider: "p", userID: "u1")
    #expect(OnboardingModel.displayName(nil, tokens: tokens) == "u1")
    #expect(OnboardingModel.displayName(nil, tokens: nil) == nil)
  }

  @Test("the config is the Expo app's shape")
  func configShape() throws {
    let config = StoredGatewayConfig(baseUrl: "https://g.test", authMode: .nativePKCE, provider: "p", userDisplayName: "T")

    #expect(try config.encoded() == #"{"authMode":"native_pkce","baseUrl":"https://g.test","provider":"p","userDisplayName":"T"}"#)
    #expect(StoredGatewayConfig.decode(try config.encoded()) == config)
    #expect(StoredGatewayConfig.decode(#"{"baseUrl":"","authMode":"x"}"#) == nil)
    #expect(StoredGatewayConfig.key(gatewayId: "gab") == "hermie.gateway.config@gab")
  }
}
