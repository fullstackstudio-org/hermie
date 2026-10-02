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
///    "do not load this, the attempt is over".
/// 3. `completeSignIn(redirectURL:)` checks the state, redeems the code and
///    hands the tokens to the coordinator.
public actor NativePKCECredentials: CredentialProvider {
  public nonisolated let mode = GatewayAuthMode.nativePKCE
  public nonisolated let baseURL: String
  public nonisolated let coordinator: TokenCoordinator
  private let extraHeaders: [String: String]
  private let transport: HTTPTransport
  private let timeline: (any AuthEventRecorder)?
  private let randomBytes: @Sendable (Int) -> [UInt8]
  /// The attempt in progress: its verifier never leaves this actor.
  private var pending: PKCE?

  /// - Parameter extraHeaders: what goes on the wire beside the credential,
  ///   front-door headers included (`GatewaySecrets.wireHeaders`).
  public init(
    baseURL: String,
    coordinator: TokenCoordinator,
    extraHeaders: [String: String] = [:],
    transport: HTTPTransport = HTTPTransport(),
    timeline: (any AuthEventRecorder)? = nil,
    randomBytes: @escaping @Sendable (Int) -> [UInt8] = PKCE.systemRandomBytes
  ) {
    self.baseURL = baseURL
    self.coordinator = coordinator
    self.extraHeaders = extraHeaders
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

  /// Forget the tokens here, then tell the gateway (`POST /auth/logout` with
  /// the bearer it held), best effort: a sign-out the server never heard
  /// about is still a sign-out on this device.
  public func signOut() async throws {
    let held = try? await coordinator.current()
    var failure: (any Error)?

    do {
      try await coordinator.clear()
    } catch {
      failure = error
    }

    if let held, !held.accessToken.isEmpty, let url = try? GatewayAddress.apiURL(baseURL, path: RESTPath.logout) {
      var headers = (try? GatewayAddress.normalizeHeaders(extraHeaders)) ?? [:]
      headers["authorization"] = "Bearer \(held.accessToken)"
      _ = try? await transport.requestText(url, JSONRequest(method: "POST", headers: headers))
    }

    if let failure {
      throw failure
    }
  }

  // MARK: - Sign-in

  /// Start an attempt: a fresh verifier, challenge and state (reusing any of
  /// them across attempts is what PKCE exists to prevent), and the URL the
  /// web view opens. A previous attempt still pending is abandoned.
  public func beginSignIn(provider: String? = nil) throws(GatewayError) -> SignInStart {
    let pkce = PKCE.create(randomBytes: randomBytes)
    let url = try PKCE.authorizeURL(
      baseURL: baseURL,
      params: AuthorizeParams(provider: provider, challenge: pkce.challenge, state: pkce.state)
    )

    pending = pkce
    return SignInStart(authorizeURL: url)
  }

  /// What the web view should do with one navigation of the attempt in progress.
  public func decision(for navigationURL: String) -> SignInNavigation {
    SignInNavigation.decide(navigationURL, expectedState: pending?.state ?? "", gatewayBaseURL: baseURL)
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

    switch SignInNavigation.inspect(redirectURL, expectedState: attempt.state, gatewayBaseURL: baseURL) {
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
      verifier: attempt.verifier,
      options: NativeAuth.Options(transport: transport, extraHeaders: extraHeaders, timeline: timeline)
    )

    try await coordinator.save(tokens)
    return tokens
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
  /// A navigation to this device's own loopback that is not the callback. It
  /// is never loaded: nothing of ours listens there, and something else might.
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

  /// The rule, as a pure function.
  ///
  /// An `http` URL whose host is this device's loopback (`127.0.0.0/8`,
  /// `[::1]`, `localhost` and its subdomains, and the unspecified
  /// `0.0.0.0`/`[::]`, which also reach this device) is never allowed to load:
  /// it is this attempt's callback or the attempt fails. Ports are read the way
  /// the web view will read them, so `:038007` is port 38007 and is refused
  /// rather than loaded. The one exception is the gateway's own origin, for a
  /// gateway that runs on this device.
  public static func decide(_ url: String, expectedState: String, gatewayBaseURL: String) -> SignInNavigation {
    switch inspect(url, expectedState: expectedState, gatewayBaseURL: gatewayBaseURL) {
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

  static func inspect(_ url: String, expectedState: String, gatewayBaseURL: String) -> Inspection {
    if PKCE.isLoopbackRedirect(url) {
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

    guard let parsed = WHATWGURL.parse(url) else {
      // Nothing a web view can load fails to parse; fail closed.
      return .fail(.blockedNavigation)
    }

    if parsed.scheme == "http", isThisDevice(parsed.host ?? ""),
      parsed.origin.lowercased() != GatewayAddress.origin(of: gatewayBaseURL)
    {
      return .fail(.blockedNavigation)
    }

    return .allow
  }

  /// A host, as the URL Standard serialises it, that names this device.
  private static func isThisDevice(_ host: String) -> Bool {
    let host = host.lowercased()

    if host == "localhost" || host == "localhost." || JSText.hasSuffix(host, ".localhost")
      || JSText.hasSuffix(host, ".localhost.")
    {
      return true
    }

    if host == "[::1]" || host == "[::]" || host == "0.0.0.0" {
      return true
    }

    // IPv4 serialises as dotted decimal; IPv4-mapped IPv6 as `[::ffff:7fxx:xxxx]`.
    if JSText.hasPrefix(host, "127."), host.unicodeScalars.allSatisfy({ JSText.isASCIIDigit($0) || $0 == "." }) {
      return true
    }

    return JSText.hasPrefix(host, "[::ffff:7f")
  }
}
