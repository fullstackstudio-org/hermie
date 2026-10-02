#if os(macOS)
import Foundation
import HermieCore
import HermieGateway
import HermieStore
import Testing

/// The stores one launch of the app has, in memory: the database and the secret storage. Never
/// the real keychain.
@MainActor
struct OnboardingStores {
  let store: SQLiteStore
  let secrets: InMemorySecretStorage

  init() throws {
    store = try SQLiteStore(.inMemory)
    secrets = InMemorySecretStorage()
  }

  /// What a launch builds over these stores: the gateway list and the accounts, loaded.
  func launch(makeListener: @escaping @Sendable () -> any LoopbackCallbackListening = { LoopbackCallbackListener() })
    async -> GatewayAccounts
  {
    let directory = GatewayDirectory(store: GatewayRegistryStore(store: store), changes: KeyValueStore(store: store))
    let accounts = GatewayAccounts(
      directory: directory,
      services: GatewayServices(store: store, secrets: secrets, makeListener: makeListener)
    )

    directory.onRemoved = { [weak accounts] id in await accounts?.forget(id) }
    await directory.load()
    accounts.follow()
    await accounts.refresh()
    return accounts
  }
}

/// Wait, by sleeping a little at a time, until `condition` holds; generous for a loaded machine.
@MainActor
func until(_ condition: @MainActor () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async {
  for _ in 0..<6_000 {
    if condition() {
      return
    }

    try? await Task.sleep(for: .milliseconds(5))
  }

  Issue.record("the condition never held", sourceLocation: sourceLocation)
}

/**
 Plays the system browser against the fake gateway: opens the authorize page, approves it the way
 its button does, and follows the gateway's redirect to the loopback callback with a real HTTP GET,
 which the real listener answers on the port the system gave it for this attempt.
 */
@MainActor
final class ScriptedBrowser: BrowserSessionPresenting {
  private(set) var opened: [URL] = []
  /// The redirect URI of the last attempt.
  private(set) var lastRedirect: String?
  private(set) var closes = 0
  /// The listener's answer to the callback.
  private(set) var callbackStatus: Int?
  private(set) var callbackPage = ""

  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool {
    opened.append(url)

    Task {
      do {
        let page = try await FakeGateway.plainResponse("GET", url.absoluteString)
        #expect(page.status == 200)

        let approved = try await FakeGateway.plainResponse("GET", url.absoluteString + "&auto=1")
        let location = try #require(approved.headers["location"])

        let redirect = try #require(
          URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "redirect_uri" }?.value
        )

        // The gateway sends the browser to exactly the redirect URI the attempt asked for, and that
        // is a port the system chose, not 38007.
        #expect(location.hasPrefix(redirect + "?"))
        #expect(redirect.hasPrefix("http://127.0.0.1:"))
        #expect(redirect.hasSuffix("/callback"))
        #expect(redirect != PKCE.redirectURI)
        lastRedirect = redirect

        // The browser following the redirect: a plain GET to the loopback address.
        let (data, response) = try await URLSession(configuration: .ephemeral).data(from: try #require(URL(string: location)))

        callbackStatus = (response as? HTTPURLResponse)?.statusCode
        callbackPage = String(decoding: data, as: UTF8.self)
      } catch {
        Issue.record("the scripted browser failed: \(error)")
      }
    }

    return true
  }

  func close() {
    closes += 1
  }
}

extension Integration {
  /// Onboarding end to end against the fake gateway, for each way a gateway authenticates, and what
  /// a later launch over the same stores finds. The native tests listen for the redirect for real,
  /// on a port the system chooses for each attempt.
  @Suite("Onboarding")
  struct OnboardingIntegrationTests {
    @Test("an ungated gateway with no token check: set up, stored, active, and still there after a relaunch")
    func authNone() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .none)) { gateway in
        try await Self.authNone(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func authNone(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)

      model.address = baseURL
      await until { model.resolved != nil }
      #expect(model.authMode == .sessionToken)
      #expect(model.cleartextPrivacy == .loopback)
      #expect(model.canLeaveAddress)
      model.continueFromAddress()

      model.sessionToken = "any-token"
      _ = await model.continueFromSignIn()
      #expect(model.signIn == .signedIn)
      model.continueFromName()

      let id = try #require(await model.finish())
      #expect(accounts.directory.activeId == id)

      let relaunched = await stores.launch()
      #expect(relaunched.directory.entries.map(\.id) == [id])
      #expect(relaunched.status(for: id) == .signedIn)
      #expect(try await relaunched.client(for: id).get("/api/profiles") != nil)
    }

    @Test("a token gateway: a wrong token is refused, the right one is stored and works after a relaunch")
    func authToken() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .token, token: "integration-token")) { gateway in
        try await Self.authToken(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func authToken(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)

      model.address = baseURL
      await until { model.resolved != nil }
      model.continueFromAddress()

      model.sessionToken = "not-the-token"
      _ = await model.continueFromSignIn()
      #expect(model.signIn == .failed(.rejected))

      model.sessionToken = "integration-token"
      _ = await model.continueFromSignIn()
      #expect(model.signIn == .signedIn)
      model.name = "Lab"
      model.continueFromName()

      let id = try #require(await model.finish())
      let keys = try GatewaySecretKeys(gatewayID: id)

      #expect(try stores.secrets.get(keys.sessionToken) == "integration-token")

      let relaunched = await stores.launch()
      #expect(relaunched.directory.entry(id: id)?.name == "Lab")
      #expect(relaunched.status(for: id) == .signedIn)
      #expect(try await relaunched.identity(for: id).userID == "tester@example.invalid")

      // Removing it wipes its secrets.
      try await relaunched.directory.remove(id: id)
      #expect(stores.secrets.keys.isEmpty)
    }

    @Test(
      "a native gateway: the browser's redirect reaches the real listener, the grant is stored, a relaunch is signed in, removal revokes and wipes"
    )
    func authNative() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native)) { gateway in
        try await Self.authNative(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func authNative(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)
      let browser = ScriptedBrowser()

      model.address = baseURL
      await until { model.resolved != nil }
      #expect(model.authMode == .nativePKCE)
      #expect(model.canSignInWithProvider)
      model.continueFromAddress()

      model.startBrowserSignIn(presenter: browser)
      await until { model.signIn == .signedIn || { if case .failed = model.signIn { true } else { false } }() }

      #expect(model.signIn == .signedIn)
      #expect(browser.callbackStatus == 200)
      #expect(browser.callbackPage.contains(LoopbackPages.english.success.title))
      #expect(!browser.callbackPage.contains("code-"))
      #expect(browser.closes >= 1)
      #expect(model.identity?.userID == "tester@example.invalid")

      _ = await model.continueFromSignIn()
      model.continueFromName()

      let id = try #require(await model.finish())
      let keys = try GatewaySecretKeys(gatewayID: id)
      let refreshToken = try #require(try stores.secrets.get(keys.refreshToken))

      // Nothing listens on the attempt's port any more: it stopped as soon as the callback came.
      let redirect = try #require(browser.lastRedirect)
      let port = try #require(URLComponents(string: redirect)?.port)
      let again = await Self.connects(port: port)
      #expect(!again)

      // A later launch over the same stores is signed in, and its bearer works.
      let relaunched = await stores.launch()
      #expect(relaunched.status(for: id) == .signedIn)
      #expect(try await relaunched.identity(for: id).userID == "tester@example.invalid")

      // Removing the gateway hands the grant back first, then wipes every item.
      try await relaunched.directory.remove(id: id)
      #expect(stores.secrets.keys.isEmpty)

      await #expect(throws: GatewayError.self) {
        try await NativeAuth.refreshTokens(baseURL: baseURL, refreshToken: refreshToken, provider: "self-hosted")
      }
    }

    @Test("a native gateway signed out of and signed in again through the sign-in sheet")
    func nativeSignOutAndBackIn() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native)) { gateway in
        try await Self.nativeSignOutAndBackIn(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func nativeSignOutAndBackIn(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let setup = OnboardingModel(mode: .newGateway, accounts: accounts)

      setup.address = baseURL
      await until { setup.resolved != nil }
      setup.startBrowserSignIn(presenter: ScriptedBrowser())
      await until { setup.signIn == .signedIn }
      setup.name = "Gated"
      let id = try #require(await setup.finish())

      await accounts.signOut(id)
      #expect(accounts.status(for: id) == .signedOut)
      await #expect(throws: GatewayAccessError.signedOut) {
        _ = try await accounts.identity(for: id)
      }

      let sheet = OnboardingModel(mode: .signIn(gatewayId: id), accounts: accounts)

      await sheet.load()
      await until { sheet.resolved != nil }
      sheet.startBrowserSignIn(presenter: ScriptedBrowser())
      await until { sheet.signIn == .signedIn }

      #expect(await sheet.continueFromSignIn() == id)
      #expect(accounts.status(for: id) == .signedIn)
      #expect(accounts.directory.entry(id: id)?.name == "Gated")
      #expect(try await accounts.identity(for: id).userID == "tester@example.invalid")
    }

    /// Whether something still accepts connections on `127.0.0.1:port`.
    static func connects(port: Int) async -> Bool {
      guard let url = URL(string: "http://127.0.0.1:\(port)/callback") else {
        return false
      }

      var request = URLRequest(url: url)
      request.timeoutInterval = 5

      return (try? await URLSession(configuration: .ephemeral).data(for: request)) != nil
    }
  }
}
#endif
