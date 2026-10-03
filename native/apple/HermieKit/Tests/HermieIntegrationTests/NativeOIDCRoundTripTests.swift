#if os(macOS)
import Foundation
import HermieCore
import HermieGateway
import HermieStore
import Testing

/**
 Plays a real browser against the fake gateway's staged identity provider (`--idp staged`): one
 cookie jar for the whole sign-in, redirects followed the way a browser follows them (a 303 after a
 form post becomes a GET), and the last hop is a plain GET to the loopback redirect, which the app's
 real listener answers.

 The person's part is scripted as a list of steps: the password form, then one-time codes. A wrong
 code is burned by the provider (as the FullStack Studio provider burns its challenge), so the steps
 can stage the "back to the password form" loop inside one attempt.
 */
@MainActor
final class StagedProviderBrowser: BrowserSessionPresenting {
  enum Step: Sendable {
    case password
    case code(String)
  }

  struct Hop: Sendable, Equatable {
    var path: String
    var status: Int
  }

  let steps: [Step]
  private(set) var opened = 0
  private(set) var closes = 0
  /// Where each step ended up, and with which status.
  private(set) var landed: [Hop] = []
  private(set) var finalPage = ""
  private(set) var finished = false
  private(set) var failure: String?

  init(steps: [Step]) {
    self.steps = steps
  }

  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool {
    opened += 1

    let steps = steps

    Task {
      // An ephemeral session: a cookie store of its own, as a browser profile has.
      let session = URLSession(configuration: .ephemeral)

      do {
        let base = try #require(URL(string: "/", relativeTo: url)?.absoluteURL)

        landed.append(try await Self.load(session, URLRequest(url: url)))

        for step in steps {
          let request: URLRequest

          switch step {
          case .password:
            request = Self.form(base, "/__idp/login", ["username": "tester", "password": "hunter2"])
          case .code(let code):
            request = Self.form(base, "/__idp/verify", ["code": code])
          }

          let (hop, page) = try await Self.loadPage(session, request)

          landed.append(hop)
          finalPage = page
        }

        finished = true
      } catch {
        failure = "\(error)"
      }
    }

    return true
  }

  func close() {
    closes += 1
  }

  private static func form(_ base: URL, _ path: String, _ fields: [String: String]) -> URLRequest {
    var request = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL)
    var body = URLComponents()

    body.queryItems = fields.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data((body.percentEncodedQuery ?? "").utf8)
    return request
  }

  private static func load(_ session: URLSession, _ request: URLRequest) async throws -> Hop {
    try await loadPage(session, request).0
  }

  private static func loadPage(_ session: URLSession, _ request: URLRequest) async throws -> (Hop, String) {
    let (data, response) = try await session.data(for: request)
    let http = try #require(response as? HTTPURLResponse)
    let final = try #require(http.url)
    let path = final.host == "127.0.0.1" && final.path == LoopbackCallbackListener.callbackPath
      && final.port != request.url?.port ? "loopback" : final.path

    return (Hop(path: path, status: http.statusCode), String(decoding: data, as: UTF8.self))
  }
}

extension Integration {
  /// The native sign-in end to end through the staged identity provider: the gateway's PKCE cookie,
  /// the provider's password and one-time-code steps with their own cookies, the provider's redirect
  /// to the gateway callback, the gateway's redirect to the loopback port this attempt listens on,
  /// the code exchange and the identity check.
  @Suite("Native OIDC round trip")
  struct NativeOIDCRoundTripTests {
    static let options = FakeGateway.Options(auth: .native, extraArguments: ["--idp", "staged"])

    @Test("password, one-time code, provider, gateway callback, loopback: signed in and stored")
    func fullRoundTrip() async throws {
      try await FakeGateway.with(Self.options) { gateway in
        try await Self.fullRoundTrip(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func fullRoundTrip(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)
      let browser = StagedProviderBrowser(steps: [.password, .code("246810")])

      model.address = baseURL
      await until { model.resolved != nil }
      #expect(model.authMode == .nativePKCE)
      model.continueFromAddress()

      model.startBrowserSignIn(presenter: browser)
      await until { browser.finished || browser.failure != nil }
      await until { model.signIn == .signedIn || { if case .failed = model.signIn { true } else { false } }() }

      #expect(browser.failure == nil)
      #expect(
        browser.landed == [
          .init(path: "/__idp/login", status: 200),
          .init(path: "/__idp/verify", status: 200),
          .init(path: "loopback", status: 200),
        ]
      )
      #expect(browser.finalPage.contains(LoopbackPages.english.success.title))
      #expect(model.signIn == .signedIn)
      #expect(browser.closes >= 1)
      #expect(model.identity?.userID == "tester@example.invalid")

      _ = await model.continueFromSignIn()
      model.continueFromName()

      let id = try #require(await model.finish())

      #expect(accounts.status(for: id) == .signedIn)
      #expect(try await accounts.identity(for: id).userID == "tester@example.invalid")
    }

    @Test("a wrong code sends the person back to the password form; the attempt waits and then finishes")
    func providerLoopInsideOneAttempt() async throws {
      try await FakeGateway.with(Self.options) { gateway in
        try await Self.providerLoopInsideOneAttempt(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func providerLoopInsideOneAttempt(baseURL: String) async throws {
      let stores = try OnboardingStores()
      let accounts = await stores.launch()
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)
      let browser = StagedProviderBrowser(steps: [.password, .code("000000"), .code("246810"), .password, .code("246810")])

      model.address = baseURL
      await until { model.resolved != nil }
      model.continueFromAddress()

      model.startBrowserSignIn(presenter: browser)
      await until { browser.finished || browser.failure != nil }
      await until { model.signIn == .signedIn || { if case .failed = model.signIn { true } else { false } }() }

      #expect(browser.failure == nil)
      #expect(
        browser.landed == [
          .init(path: "/__idp/login", status: 200),
          .init(path: "/__idp/verify", status: 200),
          // Wrong: the provider says so and burns the challenge.
          .init(path: "/__idp/verify", status: 200),
          // Right, but too late: expired.
          .init(path: "/__idp/verify", status: 200),
          .init(path: "/__idp/verify", status: 200),
          .init(path: "loopback", status: 200),
        ]
      )
      // One attempt, one sheet, one callback: the provider's own loop never reached the app.
      #expect(browser.opened == 1)
      #expect(model.signIn == .signedIn)
      #expect(model.identity?.userID == "tester@example.invalid")
    }
  }
}
#endif
