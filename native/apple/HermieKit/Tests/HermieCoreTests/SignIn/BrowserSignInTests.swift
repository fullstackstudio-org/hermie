import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// The browser sign-in's orchestration, with a fake sheet, a fake listener and a stubbed gateway.
@MainActor
@Suite("Browser sign-in")
struct BrowserSignInTests {
  let server = GatewayStub.gated()
  let base = "https://gw.example.test"

  func credentials() -> NativePKCECredentials {
    let transport = server.transport()
    let coordinator = TokenCoordinator(store: MemoryTokenStore(), refresh: { $0 }, nowSeconds: { 1_700_000_000 })

    return NativePKCECredentials(baseURL: base, coordinator: coordinator, transport: transport)
  }

  func run(
    _ credentials: NativePKCECredentials,
    listener: FakeListener,
    presenter: FakePresenter,
    timer: ManualTimer = ManualTimer()
  ) -> Task<Result<TokenSet, SignInProblem>, Never> {
    Task {
      await BrowserSignIn.run(
        credentials: credentials,
        provider: "self-hosted",
        listener: listener,
        presenter: presenter,
        timeout: .seconds(600),
        sleep: timer.sleep
      )
    }
  }

  @Test("the callback with this attempt's state is redeemed; the sheet closes and the listener stops")
  func success() async throws {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let attempt = run(credentials(), listener: listener, presenter: presenter)

    await listener.waitUntilStarted()
    await eventually { !presenter.opened.isEmpty }

    let opened = try #require(presenter.opened.first)
    #expect(opened.absoluteString.hasPrefix("\(base)/auth/native/authorize?provider=self-hosted&"))
    // The redirect URI names the port the listener was given, for this attempt alone.
    #expect(opened.absoluteString.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback"))
    #expect(presenter.redirectURI == "http://127.0.0.1:51234/callback")

    // Someone else's callback is refused (400) and the attempt goes on: another state, no code,
    // or the fixed port of the in-app page.
    #expect(await listener.deliver(presenter.callbackURL(state: "not-this-attempt")) == false)
    #expect(await listener.deliver("http://127.0.0.1:51234/callback?state=\(presenter.state)") == false)
    #expect(await listener.deliver("http://127.0.0.1:38007/callback?code=code-1&state=\(presenter.state)") == false)
    #expect(await listener.deliver(presenter.callbackURL()) == true)

    let tokens = try await attempt.value.get()

    #expect(tokens.accessToken == "at-1")
    #expect(presenter.closes >= 1)
    #expect(await listener.stopped)

    let exchange = try #require(server.requests.first { $0.path == "/auth/native/token" })
    #expect(exchange.bodyText.contains("code-1"))
  }

  @Test("the person closing the sheet cancels the attempt, and its code is never redeemed")
  func personCancels() async throws {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let credentials = credentials()
    let attempt = run(credentials, listener: listener, presenter: presenter)

    await eventually { !presenter.opened.isEmpty }
    let late = presenter.callbackURL()

    presenter.personClosesIt()

    #expect(await attempt.value == .failure(.cancelled))
    #expect(await listener.stopped)
    // The attempt is gone: a callback that arrives now is not redeemable.
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeSignIn(redirectURL: late)
    }
  }

  @Test("listening again after a suspension failed: the attempt ends, saying so, not after the timeout")
  func listeningAgainFailed() async {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let attempt = run(credentials(), listener: listener, presenter: presenter)

    await eventually { !presenter.opened.isEmpty }
    await listener.fail(.unavailable)

    #expect(await attempt.value == .failure(.listenerUnavailable))
    #expect(presenter.closes >= 1)
  }

  @Test("the timeout ends the attempt")
  func timesOut() async {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let timer = ManualTimer()
    let attempt = run(credentials(), listener: listener, presenter: presenter, timer: timer)

    await eventually { !presenter.opened.isEmpty }
    timer.fire()

    #expect(await attempt.value == .failure(.timedOut))
    #expect(presenter.closes >= 1)
    #expect(await listener.stopped)
  }

  @Test("cancelling the task closes the sheet and stops the listener")
  func taskCancelled() async {
    let listener = FakeListener()
    let presenter = FakePresenter()
    let attempt = run(credentials(), listener: listener, presenter: presenter)

    await eventually { !presenter.opened.isEmpty }
    attempt.cancel()

    #expect(await attempt.value == .failure(.cancelled))
    #expect(presenter.closes >= 1)
    #expect(await listener.stopped)
  }

  @Test("a port in use fails at once, before any browser opens")
  func portInUse() async {
    let presenter = FakePresenter()
    let result = await run(credentials(), listener: FakeListener(.fail(.portInUse(port: 38007))), presenter: presenter).value

    #expect(result == .failure(.portInUse))
    #expect(presenter.opened.isEmpty)
  }

  @Test("a browser that cannot open says so")
  func browserUnavailable() async {
    let listener = FakeListener()
    let presenter = FakePresenter()

    presenter.canOpen = false

    #expect(await run(credentials(), listener: listener, presenter: presenter).value == .failure(.browserUnavailable))
    #expect(await listener.stopped)
  }

  @Test("a refused exchange is reported by kind, never by URL")
  func exchangeRefused() async throws {
    let refusing = StubServer { request in
      request.path == "/auth/native/token" ? .json(#"{"detail":"Invalid or expired authorization code."}"#, status: 400) : .json("{}")
    }
    let coordinator = TokenCoordinator(store: MemoryTokenStore(), refresh: { $0 }, nowSeconds: { 0 })
    let credentials = NativePKCECredentials(baseURL: base, coordinator: coordinator, transport: refusing.transport())
    let listener = FakeListener()
    let presenter = FakePresenter()
    let attempt = run(credentials, listener: listener, presenter: presenter)

    await eventually { !presenter.opened.isEmpty }
    #expect(await listener.deliver(presenter.callbackURL()))

    guard case .failure(let problem) = await attempt.value else {
      Issue.record("the exchange should have failed")
      return
    }

    guard case .exchange = problem else {
      Issue.record("expected an exchange problem, got \(problem)")
      return
    }

    #expect(!String(describing: problem).contains("code-1"))
  }

  @Test("the state is read from the authorize URL")
  func stateOfAuthorizeURL() {
    #expect(BrowserSignIn.state(of: "https://g.test/auth/native/authorize?code_challenge=x&state=abc_-1") == "abc_-1")
    #expect(BrowserSignIn.state(of: "https://g.test/auth/native/authorize?code_challenge=x") == "")
  }
}
