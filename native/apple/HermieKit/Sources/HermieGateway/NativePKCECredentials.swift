import HermieProtocol

/// Gated gateway (`NativePkceCredentials` plus the pure steps of the sign-in
/// web view): `Authorization: Bearer` on REST, and a single-use ticket in the
/// WebSocket subprotocol list.
///
/// Sign-in is three steps, and only the middle one needs a web view:
///
/// 1. `beginSignIn(provider:)` mints a fresh verifier, challenge and state and
///    answers the authorize URL to open.
/// 2. The web view asks `decision(for:)` about every navigation. `allow` loads
///    it; `callback` means "do not load this, hand it to step 3"; `fail` means
///    "do not load this, the attempt is over" (and it is: the pending attempt
///    is dropped).
/// 3. `completeSignIn(redirectURL:)` checks the state, redeems the code and
///    hands the tokens to the coordinator.
///
/// `cancelSignIn()` drops an attempt the person walked away from.
///
/// A re-authentication (passkey self-enrolment, contract §7.2) is the same three
/// steps with `beginReauth(grantID:)` and `completeReauth(redirectURL:)`: the
/// authorize URL names the grant, and the code redeems to the grant's new state,
/// never to tokens. The token set and the auth epoch stay as they are.
public actor NativePKCECredentials: CredentialProvider {
  public nonisolated let mode = GatewayAuthMode.nativePKCE
  public nonisolated let baseURL: String
  public nonisolated let coordinator: TokenCoordinator
  private let extraHeaders: [String: String]
  private let transport: HTTPTransport
  private let timeline: (any AuthEventRecorder)?
  private let randomBytes: @Sendable (Int) -> [UInt8]
  private let canRevoke: Bool
  /// The attempt in progress: its verifier never leaves this actor, the
  /// loopback address it asked the gateway to send the browser back to, and,
  /// for a re-authentication, the grant it completes.
  private var pending: (pkce: PKCE, redirectURI: String, reauth: String?)?

  /// The `auth_flows` entry that says `POST /auth/native/revoke` exists.
  public static let nativeRevokeFlow = "native_revoke"
  /// Where a native client hands its refresh token back on sign-out.
  public static let revokePath = "/auth/native/revoke"
  /// How long sign-out waits for the gateway before it wipes locally anyway.
  public static let revokeTimeoutMs = 5_000

  /// - Parameters:
  ///   - extraHeaders: what goes on the wire beside the credential, front-door
  ///     headers included (`GatewaySecrets.wireHeaders`).
  ///   - canRevoke: the gateway's `/api/status` advertised `native_revoke`
  ///     (`ProbeResult.supportsNativeRevoke`); sign-out then revokes the grant.
  public init(
    baseURL: String,
    coordinator: TokenCoordinator,
    extraHeaders: [String: String] = [:],
    canRevoke: Bool = false,
    transport: HTTPTransport = HTTPTransport(),
    timeline: (any AuthEventRecorder)? = nil,
    randomBytes: @escaping @Sendable (Int) -> [UInt8] = PKCE.systemRandomBytes
  ) {
    self.baseURL = baseURL
    self.coordinator = coordinator
    self.extraHeaders = extraHeaders
    self.canRevoke = canRevoke
    self.transport = transport
    self.timeline = timeline
    self.randomBytes = randomBytes
  }

  // MARK: - CredentialProvider

  public func httpAuthHeaders(_ options: AuthHeaderOptions = AuthHeaderOptions()) async throws -> [String: String] {
    let token = try await coordinator.accessToken(
      AccessTokenOptions(forceRefresh: options.forceRefresh, rejectedAccessToken: options.rejectedAccessToken)
    )

    guard let token else {
      throw GatewayError(.auth, "You are signed out of this gateway. Sign in again.", status: 401)
    }

    return ["authorization": "Bearer \(token)"]
  }

  public func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    var headers = try GatewayAddress.normalizeHeaders(self.extraHeaders)
    headers.merge(extraHeaders) { _, dial in dial }
    headers.merge(try await httpAuthHeaders()) { _, auth in auth }

    let ticket = try await WSTicketMint.mint(baseURL: baseURL, headers: headers, transport: transport, timeline: timeline)

    return DialPlan(
      url: wsURL,
      protocols: [GatewayCredentials.webSocketProtocol, GatewayCredentials.webSocketTicketPrefix + ticket],
      headers: extraHeaders
    )
  }

  public func onRejected(rejectedToken: String?) async throws -> RejectionVerdict {
    let refreshed = try await coordinator.accessToken(
      AccessTokenOptions(forceRefresh: true, rejectedAccessToken: rejectedToken)
    )

    return refreshed == nil ? .reauth : .retry
  }

  /// Hand the grant back to the gateway when it can take it, then forget the
  /// tokens here.
  ///
  /// The gateway's `/auth/logout` only reads its own cookies, so a native
  /// client revokes instead: `POST /auth/native/revoke` with the refresh token
  /// and provider and no `Authorization` (the route is public), only when the
  /// gateway advertises `native_revoke`. Best effort and bounded by
  /// `revokeTimeoutMs`: a refusal, a 404, a 429 or no answer at all changes
  /// nothing, and the local wipe always happens.
  public func signOut() async throws {
    let held = try? await coordinator.current()

    if canRevoke, let held, !held.refreshToken.isEmpty, let url = try? GatewayAddress.apiURL(baseURL, path: Self.revokePath) {
      let headers = (try? GatewayAddress.normalizeHeaders(extraHeaders)) ?? [:]
      let body = JSONValue.object(["refresh_token": .string(held.refreshToken), "provider": .string(held.provider)])
      _ = try? await transport.requestText(
        url,
        JSONRequest(method: "POST", headers: headers, body: body, timeoutMs: Self.revokeTimeoutMs)
      )
    }

    try await coordinator.clear()
  }

  // MARK: - Sign-in

  /// Start an attempt: a fresh verifier, challenge and state (reusing any of
  /// them across attempts is what PKCE exists to prevent), and the URL the
  /// web view opens. A previous attempt still pending is abandoned.
  ///
  /// - Parameter redirectURI: where the gateway sends the browser back to. The
  ///   web view intercepts `PKCE.redirectURI` without loading it; a loopback
  ///   listener passes its own `http://127.0.0.1:<port>/callback` (RFC 8252
  ///   §7.3: any port), and only that address is then this attempt's callback.
  public func beginSignIn(provider: String? = nil, redirectURI: String = PKCE.redirectURI) throws(GatewayError)
    -> SignInStart
  {
    let pkce = PKCE.create(randomBytes: randomBytes)
    let url = try PKCE.authorizeURL(
      baseURL: baseURL,
      params: AuthorizeParams(provider: provider, challenge: pkce.challenge, state: pkce.state, redirectURI: redirectURI)
    )

    pending = (pkce, redirectURI, nil)
    return SignInStart(authorizeURL: url)
  }

  /// Start a re-authentication for the fresh-authentication grant `grantID`
  /// (`POST /api/auth/passkeys/reauth/begin`): exactly `beginSignIn`, plus
  /// `reauth=<grantID>` at the end of the query. It replaces any attempt still
  /// pending, a sign-in included: there is one browser attempt at a time.
  ///
  /// - Parameter provider: the grant's provider, as `reauth/begin` named it.
  public func beginReauth(grantID: String, provider: String? = nil, redirectURI: String = PKCE.redirectURI)
    throws(GatewayError) -> SignInStart
  {
    guard !grantID.isEmpty else {
      throw GatewayError(.config, "There is no grant to sign in again for.")
    }

    let pkce = PKCE.create(randomBytes: randomBytes)
    let url = try PKCE.authorizeURL(
      baseURL: baseURL,
      params: AuthorizeParams(
        provider: provider,
        challenge: pkce.challenge,
        state: pkce.state,
        redirectURI: redirectURI,
        reauth: grantID
      )
    )

    pending = (pkce, redirectURI, grantID)
    return SignInStart(authorizeURL: url)
  }

  /// Drop the attempt in progress, if any.
  public func cancelSignIn() {
    pending = nil
  }

  /// What the web view should do with one navigation of the attempt in
  /// progress. A `fail` ends the attempt.
  public func decision(for navigationURL: String) -> SignInNavigation {
    let decision = SignInNavigation.decide(
      navigationURL,
      expectedState: pending?.pkce.state ?? "",
      gatewayBaseURL: baseURL,
      redirectURI: pending?.redirectURI ?? PKCE.redirectURI
    )

    if case .fail = decision {
      pending = nil
    }

    return decision
  }

  /// Finish the attempt with the callback the web view intercepted: check the
  /// state, redeem the code, and save the tokens through the coordinator. The
  /// attempt is over whatever happens; a failure means starting again.
  ///
  /// Throws `SignInFailure` for anything the redirect itself says, a
  /// `GatewayError` from the exchange, or the token store's own error.
  @discardableResult
  public func completeSignIn(redirectURL: String) async throws -> TokenSet {
    let taken = try takeCallback(redirectURL, reauth: false)

    let tokens = try await NativeAuth.exchangeCode(
      baseURL: baseURL,
      code: taken.code,
      verifier: taken.verifier,
      options: NativeAuth.Options(transport: transport, extraHeaders: extraHeaders, timeline: timeline)
    )

    try await coordinator.save(tokens)
    return tokens
  }

  /// Finish a re-authentication with the callback it ended on: check the
  /// state, redeem the code, and answer what the sign-in did to the grant.
  /// Nothing is saved and nothing is cleared: the token set and the auth epoch
  /// are the coordinator's, and a re-authentication touches neither. The
  /// attempt is over whatever happens.
  ///
  /// Throws `SignInFailure` for the redirect itself, and a `GatewayError` from
  /// the exchange: `protocol` when the answer is not a re-authentication answer
  /// for this grant (one carrying tokens, above all).
  public func completeReauth(redirectURL: String) async throws -> ReauthCompletion {
    let taken = try takeCallback(redirectURL, reauth: true)

    let completion = try await NativeAuth.exchangeReauthCode(
      baseURL: baseURL,
      code: taken.code,
      verifier: taken.verifier,
      options: NativeAuth.Options(transport: transport, extraHeaders: extraHeaders, timeline: timeline)
    )

    guard completion.grantID == taken.grantID else {
      throw GatewayError(.protocol, "The gateway answered the re-authentication for another grant.")
    }

    return completion
  }

  /// End the attempt in progress and read its callback: the code to redeem,
  /// the verifier to redeem it with and the grant, if it is a
  /// re-authentication. An attempt of the other kind is over too, unredeemed:
  /// a sign-in's code never redeems as a re-authentication, nor the reverse.
  private func takeCallback(_ redirectURL: String, reauth: Bool) throws(SignInFailure)
    -> (code: String, verifier: String, grantID: String)
  {
    guard let attempt = pending else {
      throw .noSignInPending
    }

    pending = nil

    guard (attempt.reauth != nil) == reauth else {
      throw .noSignInPending
    }

    switch SignInNavigation.inspect(
      redirectURL,
      expectedState: attempt.pkce.state,
      gatewayBaseURL: baseURL,
      redirectURI: attempt.redirectURI
    ) {
    case .callback(let code):
      return (code, attempt.pkce.verifier, attempt.reauth ?? "")
    case .fail(let failure):
      throw failure
    case .allow:
      throw .notACallback
    }
  }
}

extension ProbeResult {
  /// The gateway takes a native refresh token back on sign-out (`native_revoke` in `auth_flows`).
  public var supportsNativeRevoke: Bool {
    authFlows.contains { JSText.same($0, NativePKCECredentials.nativeRevokeFlow) }
  }
}

/// What `beginSignIn` hands the web view.
public struct SignInStart: Sendable, Equatable {
  /// `<base>/auth/native/authorize?…`
  public var authorizeURL: String
}

/// What a re-authentication sign-in did to its fresh-authentication grant (`POST /auth/native/token`
/// with a re-authentication code, contract §8). Its description shows neither the grant nor its
/// use secret.
public struct ReauthCompletion: Sendable, Equatable {
  public enum State: Sendable, Equatable {
    /// The sign-in counted. `useSecret` is the grant's one-time binding for `register/begin` and
    /// `register/finish`.
    case fresh(useSecret: String)
    /// It did not: a failure of contract §7.2 (`user_mismatch`, `provider_mismatch`,
    /// `auth_time_missing`, `auth_not_fresh`), or `unknown`, `not_open`, `client_mismatch` when the
    /// grant could not be completed at all. `""` when the gateway gave none.
    case failed(reason: String)
  }

  public var grantID: String
  public var state: State
  /// Unix seconds: when the grant runs out.
  public var expiresAt: Double

  public init(grantID: String, state: State, expiresAt: Double) {
    self.grantID = grantID
    self.state = state
    self.expiresAt = expiresAt
  }
}

extension ReauthCompletion: RedactedDescription {
  public var description: String {
    "ReauthCompletion(grantID: \(Redacted.presence(grantID)), state: \(state), expiresAt: \(JSText.numberString(expiresAt)))"
  }
}

extension ReauthCompletion.State: RedactedDescription {
  public var description: String {
    switch self {
    case .fresh(let secret): "fresh(useSecret: \(Redacted.presence(secret)))"
    case .failed(let reason): "failed(reason: \(reason))"
    }
  }
}

/// Why a sign-in attempt ended without tokens. The app owns the sentences.
public enum SignInFailure: Error, Sendable, Equatable {
  /// `completeSignIn` without a `beginSignIn` (or after the attempt ended).
  case noSignInPending
  /// `completeSignIn` was handed something that is not the loopback callback.
  case notACallback
  /// A navigation the sign-in web view must never load: anything on this
  /// device other than the callback and the gateway's own origin, or a scheme
  /// that is not http or https. Nothing of ours listens there, and something
  /// else might.
  case blockedNavigation
  /// The callback carried neither a code nor an error.
  case noCode
  /// The callback's `state` is not this attempt's: the code belongs to some
  /// other flow and is dropped, never exchanged.
  case stateMismatch
  /// The identity provider said no.
  case provider(error: String, description: String)
}

/// The web view's verdict on one navigation.
public enum SignInNavigation: Sendable, Equatable {
  /// Load it.
  case allow
  /// It is this attempt's callback: do not load it; pass it to `completeSignIn(redirectURL:)`.
  case callback
  /// Do not load it; the attempt is over.
  case fail(SignInFailure)

  /// The rule, as a pure function. In order:
  ///
  /// 1. **The callback** is a URL whose origin and path are exactly those of
  ///    `PKCE.redirectURI`, read with the URL parser (so `:038007` is port
  ///    38007). It is handed over or, when its state or code is wrong, fails.
  /// 2. **Only http and https load**, plus `about:blank` and `about:srcdoc`.
  ///    Any other scheme (an app scheme, `file:`, `data:`, `javascript:`,
  ///    `ws:`) fails.
  /// 3. **Nothing on this device loads** (`PKCE.isLoopbackURL`: 127.0.0.0/8,
  ///    `localhost` and names under it, `::1`, IPv4-mapped loopback, `0.0.0.0`,
  ///    `::`, `::ffff:0:0`), except the gateway's own origin, for a gateway
  ///    that runs on this device. An unparseable URL fails closed.
  public static func decide(
    _ url: String,
    expectedState: String,
    gatewayBaseURL: String,
    redirectURI: String = PKCE.redirectURI
  ) -> SignInNavigation {
    switch inspect(url, expectedState: expectedState, gatewayBaseURL: gatewayBaseURL, redirectURI: redirectURI) {
    case .allow: .allow
    case .callback: .callback
    case .fail(let failure): .fail(failure)
    }
  }

  enum Inspection {
    case allow
    case callback(code: String)
    case fail(SignInFailure)
  }

  /// `PKCE.redirectURI`, parsed once.
  private static let callbackURL = WHATWGURL.parse(PKCE.redirectURI)!

  static func inspect(
    _ url: String,
    expectedState: String,
    gatewayBaseURL: String,
    redirectURI: String = PKCE.redirectURI
  ) -> Inspection {
    guard let parsed = WHATWGURL.parse(url) else {
      // Nothing a web view can load fails to parse; fail closed.
      return .fail(.blockedNavigation)
    }

    let callback = redirectURI == PKCE.redirectURI ? callbackURL : (WHATWGURL.parse(redirectURI) ?? callbackURL)

    if parsed.origin == callback.origin, parsed.pathname == callback.pathname {
      return readCallback(url, expectedState: expectedState)
    }

    switch parsed.scheme {
    case "http", "https":
      break
    case "about" where parsed.pathname == "blank" || parsed.pathname == "srcdoc":
      return .allow
    default:
      return .fail(.blockedNavigation)
    }

    if PKCE.isLoopbackURL(url), parsed.origin.lowercased() != GatewayAddress.origin(of: gatewayBaseURL) {
      return .fail(.blockedNavigation)
    }

    return .allow
  }

  private static func readCallback(_ url: String, expectedState: String) -> Inspection {
    let redirect: LoopbackRedirect

    do {
      redirect = try PKCE.parseLoopbackRedirect(url)
    } catch {
      return .fail(.noCode)
    }

    switch redirect {
    case .error(let error, let description):
      return .fail(error == "invalid_redirect" ? .noCode : .provider(error: error, description: description))
    case .code(let code, let state):
      guard !expectedState.isEmpty, JSText.same(state, expectedState) else {
        return .fail(.stateMismatch)
      }

      return .callback(code: code)
    }
  }
}
