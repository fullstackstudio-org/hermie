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
public actor NativePKCECredentials: CredentialProvider {
  public nonisolated let mode = GatewayAuthMode.nativePKCE
  public nonisolated let baseURL: String
  public nonisolated let coordinator: TokenCoordinator
  private let extraHeaders: [String: String]
  private let transport: HTTPTransport
  private let timeline: (any AuthEventRecorder)?
  private let randomBytes: @Sendable (Int) -> [UInt8]
  private let canRevoke: Bool
  /// The attempt in progress: its verifier never leaves this actor, and the
  /// loopback address it asked the gateway to send the browser back to.
  private var pending: (pkce: PKCE, redirectURI: String)?

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

    pending = (pkce, redirectURI)
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
    guard let attempt = pending else {
      throw SignInFailure.noSignInPending
    }

    pending = nil

    let code: String

    switch SignInNavigation.inspect(
      redirectURL,
      expectedState: attempt.pkce.state,
      gatewayBaseURL: baseURL,
      redirectURI: attempt.redirectURI
    ) {
    case .callback(let found):
      code = found
    case .fail(let failure):
      throw failure
    case .allow:
      throw SignInFailure.notACallback
    }

    let tokens = try await NativeAuth.exchangeCode(
      baseURL: baseURL,
      code: code,
      verifier: attempt.pkce.verifier,
      options: NativeAuth.Options(transport: transport, extraHeaders: extraHeaders, timeline: timeline)
    )

    try await coordinator.save(tokens)
    return tokens
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
