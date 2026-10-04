import Foundation
import HermieProtocol
import Synchronization
import Testing

@testable import HermieGateway

/// A token store that counts what is done to it, so a test can see that nothing was.
final class CountingTokenStore: TokenStore {
  private let state: Mutex<(tokens: TokenSet?, saves: Int, clears: Int)>

  init(_ initial: TokenSet? = nil) {
    state = Mutex((initial, 0, 0))
  }

  var saves: Int { state.withLock { $0.saves } }
  var clears: Int { state.withLock { $0.clears } }

  func load() -> TokenSet? { state.withLock { $0.tokens } }

  func save(_ tokens: TokenSet) {
    state.withLock {
      $0.tokens = tokens
      $0.saves += 1
    }
  }

  func clear() {
    state.withLock {
      $0.tokens = nil
      $0.clears += 1
    }
  }
}

/// Passkey self-enrolment's re-authentication (contract §7.2, §8): the authorize URL that names the
/// grant, the token route's re-authentication answer, and that neither touches the token set.
@Suite struct ReauthTests {
  static let base = "https://gateway.test"
  static let grant = "CTbyDtvtuIQQmgUqM240kw"
  static let held = TokenSet(accessToken: "at-held", refreshToken: "rt-held", expiresAt: 4_102_444_800, provider: "self-hosted", userID: "u")

  /// A `wire_examples` entry of the contract's vectors, as the text a gateway would send.
  static func example(_ name: String) throws -> String {
    let value = try #require(PasskeyContractTests.vectors["wire_examples"]?[name], "no wire example \(name)")
    return try value.canonicalString()
  }

  static func credentials(_ server: StubServer, store: CountingTokenStore) -> (NativePKCECredentials, TokenCoordinator) {
    let coordinator = TokenCoordinator(store: store, refresh: { $0 }, nowSeconds: { 1_790_000_000 })
    let credentials = NativePKCECredentials(baseURL: base, coordinator: coordinator, transport: server.transport())
    return (credentials, coordinator)
  }

  static func callback(_ start: SignInStart, code: String = "code-r") -> String {
    "\(PKCE.redirectURI)?code=\(code)&state=\(query(start.authorizeURL, "state") ?? "")"
  }

  // MARK: - The authorize URL

  @Test("the grant goes last on the authorize URL, after the usual parameters; none, or an empty one, adds nothing")
  func authorizeURL() throws {
    let params = AuthorizeParams(provider: "self_hosted", challenge: "ch", state: "st", reauth: Self.grant)
    let url = try PKCE.authorizeURL(baseURL: Self.base, params: params)

    #expect(
      url == "https://gateway.test/auth/native/authorize?provider=self_hosted&code_challenge=ch"
        + "&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A38007%2Fcallback&state=st&reauth=\(Self.grant)"
    )

    let plain = try PKCE.authorizeURL(baseURL: Self.base, params: AuthorizeParams(provider: "self_hosted", challenge: "ch", state: "st"))
    let empty = try PKCE.authorizeURL(
      baseURL: Self.base,
      params: AuthorizeParams(provider: "self_hosted", challenge: "ch", state: "st", reauth: "")
    )
    #expect(!plain.contains("reauth"))
    #expect(empty == plain)
  }

  // MARK: - The token route's answer

  @Test("the contract's fresh and failed answers read as the grant's new state")
  func readsContractAnswers() async throws {
    let freshText = try Self.example("native_token_reauth_fresh")
    let failedText = try Self.example("native_token_reauth_failed")
    let fresh = try await NativeAuth.exchangeReauthCode(
      baseURL: Self.base,
      code: "c",
      verifier: "v",
      options: NativeAuth.Options(transport: StubServer { _ in .json(freshText) }.transport())
    )
    #expect(fresh == ReauthCompletion(grantID: Self.grant, state: .fresh(useSecret: "7LllY2NEkyiy8JkZ7NgZf_BQB8uqhIqVViH-KvJf2Qc"), expiresAt: 1_790_000_600))

    let failed = try await NativeAuth.exchangeReauthCode(
      baseURL: Self.base,
      code: "c",
      verifier: "v",
      options: NativeAuth.Options(transport: StubServer { _ in .json(failedText) }.transport())
    )
    #expect(failed == ReauthCompletion(grantID: Self.grant, state: .failed(reason: "auth_not_fresh"), expiresAt: 1_790_000_600))
  }

  @Test(
    "an answer with tokens, a fresh one without its use secret, an unknown state or no grant is a protocol error",
    arguments: [
      #"{"access_token":"at","refresh_token":"rt","provider":"p","user_id":"u"}"#,
      #"{"reauth":{"grant_id":"g","state":"fresh","expires_at":1},"access_token":"at"}"#,
      #"{"reauth":{"grant_id":"g","state":"fresh","expires_at":1},"refresh_token":"rt"}"#,
      #"{"reauth":{"grant_id":"g","state":"fresh","expires_at":1}}"#,
      #"{"reauth":{"grant_id":"g","state":"open","expires_at":1}}"#,
      #"{"reauth":{"state":"failed","expires_at":1}}"#,
      #"{"reauth":{"grant_id":"g","state":"failed"}}"#,
      #"{}"#,
      #"not json"#
    ]
  )
  func badAnswers(_ body: String) async {
    let error = await gatewayError {
      try await NativeAuth.exchangeReauthCode(
        baseURL: Self.base,
        code: "c",
        verifier: "v",
        options: NativeAuth.Options(transport: StubServer { _ in .json(body) }.transport())
      )
    }

    #expect(error?.kind == .protocol)
  }

  @Test("a used or expired code is an auth error, a 5xx a server error, like the sign-in's exchange")
  func statuses() async {
    for (status, kind) in [(400, GatewayErrorKind.auth), (502, .server), (403, .auth)] {
      let error = await gatewayError {
        try await NativeAuth.exchangeReauthCode(
          baseURL: Self.base,
          code: "c",
          verifier: "v",
          options: NativeAuth.Options(transport: StubServer { _ in .json("{}", status: status) }.transport())
        )
      }
      #expect(error?.kind == kind, "HTTP \(status)")
      #expect(error?.status == status)
    }
  }

  // MARK: - The credentials

  @Test("a re-authentication redeems its code with its verifier and leaves the token set and the auth epoch alone")
  func tokenSetUntouched() async throws {
    let freshText = try Self.example("native_token_reauth_fresh")
    let server = StubServer { _ in .json(freshText) }
    let store = CountingTokenStore(Self.held)
    let (credentials, coordinator) = Self.credentials(server, store: store)
    let epoch = await coordinator.currentAuthEpoch

    let start = try await credentials.beginReauth(grantID: Self.grant, provider: "self_hosted")
    #expect(query(start.authorizeURL, "reauth") == Self.grant)
    #expect(query(start.authorizeURL, "provider") == "self_hosted")
    #expect(await credentials.decision(for: start.authorizeURL) == .allow)
    #expect(await credentials.decision(for: Self.callback(start)) == .callback)

    let completion = try await credentials.completeReauth(redirectURL: Self.callback(start))

    #expect(completion.grantID == Self.grant)
    #expect(completion.state == .fresh(useSecret: "7LllY2NEkyiy8JkZ7NgZf_BQB8uqhIqVViH-KvJf2Qc"))
    #expect(store.saves == 0)
    #expect(store.clears == 0)
    #expect(try await coordinator.current() == Self.held)
    #expect(await coordinator.currentAuthEpoch == epoch)

    // The code went to the token route with this attempt's verifier, and nothing else was called.
    #expect(server.requests.map(\.path) == ["/auth/native/token"])
    let body = try JSONValue(parsing: try #require(server.requests.first).bodyText)
    #expect(body["code"] == "code-r")
    #expect(body["code_verifier"]?.stringValue?.count == 43)

    // The attempt is over.
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeReauth(redirectURL: Self.callback(start))
    }
  }

  @Test("a token-bearing answer to a re-authentication is refused, and the tokens are not taken")
  func tokensRefused() async throws {
    let server = StubServer { _ in
      .json(#"{"access_token":"at-new","refresh_token":"rt-new","expires_at":4102444800,"provider":"self-hosted","user_id":"u"}"#)
    }
    let store = CountingTokenStore(Self.held)
    let (credentials, coordinator) = Self.credentials(server, store: store)
    let start = try await credentials.beginReauth(grantID: Self.grant)

    let error = await gatewayError { try await credentials.completeReauth(redirectURL: Self.callback(start)) }

    #expect(error?.kind == .protocol)
    #expect(store.saves == 0)
    #expect(try await coordinator.current() == Self.held)
  }

  @Test("an answer for another grant is refused")
  func otherGrant() async throws {
    let server = StubServer { _ in .json(#"{"reauth":{"grant_id":"someone-else","state":"failed","reason":"unknown","expires_at":1}}"#) }
    let (credentials, _) = Self.credentials(server, store: CountingTokenStore())
    let start = try await credentials.beginReauth(grantID: Self.grant)

    let error = await gatewayError { try await credentials.completeReauth(redirectURL: Self.callback(start)) }
    #expect(error?.kind == .protocol)
  }

  @Test("a sign-in's callback never redeems as a re-authentication, nor the reverse, and neither reaches the gateway")
  func kindsDoNotMix() async throws {
    let server = StubServer { _ in .json("{}", status: 500) }
    let store = CountingTokenStore()
    let (credentials, _) = Self.credentials(server, store: store)

    let reauth = try await credentials.beginReauth(grantID: Self.grant)
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeSignIn(redirectURL: Self.callback(reauth))
    }

    let signIn = try await credentials.beginSignIn()
    await #expect(throws: SignInFailure.noSignInPending) {
      try await credentials.completeReauth(redirectURL: Self.callback(signIn))
    }

    #expect(server.requests.isEmpty)
    #expect(store.saves == 0)
  }

  @Test("a callback with another state is refused, and an empty grant does not start")
  func refusals() async throws {
    let freshText = try Self.example("native_token_reauth_fresh")
    let server = StubServer { _ in .json(freshText) }
    let (credentials, _) = Self.credentials(server, store: CountingTokenStore())
    let start = try await credentials.beginReauth(grantID: Self.grant)

    await #expect(throws: SignInFailure.stateMismatch) {
      try await credentials.completeReauth(redirectURL: "\(PKCE.redirectURI)?code=c&state=not-this-one")
    }
    #expect(query(start.authorizeURL, "reauth") == Self.grant)
    #expect(server.requests.isEmpty)

    let empty = await gatewayError { try await credentials.beginReauth(grantID: "") }
    #expect(empty?.kind == .config)
  }

  // MARK: - Descriptions

  @Test("nothing that describes a re-authentication shows its grant or its use secret")
  func redacted() throws {
    let secret = "7LllY2NEkyiy8JkZ7NgZf_BQB8uqhIqVViH-KvJf2Qc"
    let completion = ReauthCompletion(grantID: Self.grant, state: .fresh(useSecret: secret), expiresAt: 1)
    let outcome = try #require(NativeReauthTokenAnswer(jsonValue: try JSONValue(parsing: try Self.example("native_token_reauth_fresh"))))
    let begin = PasskeyRegisterBeginParams(rpID: "r", baseURL: "https://gw", name: "n", grantID: Self.grant, useSecret: secret)
    let finish = PasskeyRegisterFinishParams(
      registrationID: "reg",
      baseURL: "https://gw",
      grantID: Self.grant,
      useSecret: secret,
      credential: PasskeyNewCredential(id: "c", clientDataJSON: "", attestationObject: "", transports: [])
    )

    for text in [
      "\(completion)", String(reflecting: completion), dumped(completion), "\(completion.state)",
      "\(outcome)", "\(outcome.reauth!)", dumped(outcome), "\(begin)", dumped(begin), "\(finish)", dumped(finish)
    ] {
      #expect(!text.contains(secret), "\(text)")
      #expect(!text.contains(Self.grant), "\(text)")
    }
  }

  private func dumped(_ value: some Any) -> String {
    var text = ""
    dump(value, to: &text)
    return text
  }

  // MARK: - The REST types

  @Test("the self-enrolment status, the begin answer and a grant refusal read as the contract writes them")
  func restTypes() throws {
    let status = try #require(PasskeyStatus(jsonValue: try JSONValue(parsing: try Self.example("status_self_enrol_cooling_off"))))
    #expect(status.selfEnrol?.available == true)
    #expect(status.selfEnrol?.reason == "")
    #expect(status.selfEnrol?.coolingOffS == 600)

    let disabled = try #require(PasskeySelfEnrolStatus(jsonValue: try JSONValue(parsing: try Self.example("self_enrol_disabled"))))
    #expect(disabled.available == false)
    #expect(disabled.reason == "disabled")

    let begin = try #require(PasskeyReauthBeginResult(jsonValue: try JSONValue(parsing: try Self.example("reauth_begin_answer_native"))))
    #expect(begin.grantID == Self.grant)
    #expect(begin.expiresAt == 1_790_000_600)
    #expect(begin.provider == "self_hosted")
    #expect(begin.loginPath == nil)

    let refusal = try #require(PasskeyContractTests.vectors["wire_examples"]?["error_reauth_invalid"])
    let error = PasskeyClient.refusal(HTTPExchange(status: 403, body: refusal["body"], retryAfter: ""))
    #expect(error.kind == .refused)
    #expect(error.error == "reauth_invalid")
    #expect(error.reason == "failed")
    #expect(error.failure == "auth_not_fresh")

    // The app's bodies, as the contract's native examples have them.
    let nativeBegin = PasskeyRegisterBeginParams(
      rpID: "confirm.hermie.dev",
      baseURL: "https://gw.example.com",
      name: "Alex Example \u{2014} gw.example.com",
      grantID: Self.grant,
      useSecret: "7LllY2NEkyiy8JkZ7NgZf_BQB8uqhIqVViH-KvJf2Qc"
    )
    #expect(try nativeBegin.jsonValue.canonicalString() == Self.example("register_begin_request_with_grant_native"))
  }

  @Test("reauth/begin posts an empty object to its route")
  func reauthBeginRoute() async throws {
    let answer = try Self.example("reauth_begin_answer_native")
    let server = StubServer { _ in .json(answer) }
    let http = try HTTPClient(baseURL: Self.base, credentials: SessionTokenCredentials(token: "st-1"), transport: server.transport())
    let begin = try await PasskeyClient(http: http).reauthBegin()

    #expect(begin.grantID == Self.grant)
    let request = try #require(server.requests.first)
    #expect(request.method == "POST")
    #expect(request.path == "/api/auth/passkeys/reauth/begin")
    #expect(try JSONValue(parsing: request.bodyText) == [:])
  }
}
