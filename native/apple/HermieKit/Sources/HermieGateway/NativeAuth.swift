import HermieProtocol
import Synchronization

/// A signed-in gateway's bearer tokens (`TokenSet` in `native-auth.ts`).
///
/// Its description names which fields are present and never their values, so
/// a `print`, a log line or a failed test comparison cannot carry a token.
public struct TokenSet: Sendable, Equatable {
  public var accessToken: String
  /// Empty when the provider's client registration grants no refresh scope.
  public var refreshToken: String
  /// Unix seconds, as the gateway reports it; 0 when unknown (never refreshed proactively).
  public var expiresAt: Double
  public var provider: String
  public var userID: String

  public init(accessToken: String, refreshToken: String, expiresAt: Double, provider: String, userID: String) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.expiresAt = expiresAt
    self.provider = provider
    self.userID = userID
  }
}

extension TokenSet: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "TokenSet(accessToken: \(Redacted.presence(accessToken)), refreshToken: \(Redacted.presence(refreshToken)), "
      + "expiresAt: \(JSText.numberString(expiresAt)), provider: \(provider), userID: \(Redacted.presence(userID)))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "accessToken": Redacted.presence(accessToken), "refreshToken": Redacted.presence(refreshToken),
        "expiresAt": expiresAt, "provider": provider, "userID": Redacted.presence(userID)
      ],
      displayStyle: .struct
    )
  }
}

/// Where the token set lives (`TokenStore`). On device it is the keychain
/// (`SecretTokenStore`); the onboarding wizard holds tokens in memory until it
/// is allowed to persist them (`MemoryTokenStore`).
///
/// **Synchronous on purpose**, unlike the reference's promises. The
/// coordinator calls these on its own actor, so a save's several writes, the
/// auth-epoch check before them and the one after run as one uninterrupted
/// step: a sign-out or a sign-in cannot land between a rotation's refresh
/// token and its access token. A keychain call is a short IPC round trip,
/// and that is the price.
public protocol TokenStore: Sendable {
  func load() throws -> TokenSet?
  func save(_ tokens: TokenSet) throws
  func clear() throws
}

/// A token store that never touches disk (`createMemoryTokenStore`).
public final class MemoryTokenStore: TokenStore {
  private let tokens: Mutex<TokenSet?>

  public init(_ initial: TokenSet? = nil) {
    tokens = Mutex(initial)
  }

  public func load() -> TokenSet? { tokens.withLock { $0 } }
  public func save(_ tokens: TokenSet) { self.tokens.withLock { $0 = tokens } }
  public func clear() { tokens.withLock { $0 = nil } }
}

/// The native PKCE token endpoints (`exchangeCode`, `refreshTokens`).
public enum NativeAuth {
  /// Refresh this long before the access token actually expires (`REFRESH_SKEW_SECONDS`).
  public static let refreshSkewSeconds: Double = 60

  /// The only statuses that mean "this grant is finished, sign in again". A
  /// 408 or a 429 says nothing about the refresh token and must not delete it.
  static let definitiveRefreshStatuses: Set<Int> = [400, 401, 403]

  /// What both endpoints are called with.
  public struct Options: Sendable {
    public var transport: HTTPTransport
    public var extraHeaders: [String: String]
    /// `nil` is `FetchJSON.defaultTimeoutMs`.
    public var timeoutMs: Int?
    public var timeline: (any AuthEventRecorder)?

    public init(
      transport: HTTPTransport = HTTPTransport(),
      extraHeaders: [String: String] = [:],
      timeoutMs: Int? = nil,
      timeline: (any AuthEventRecorder)? = nil
    ) {
      self.transport = transport
      self.extraHeaders = extraHeaders
      self.timeoutMs = timeoutMs
      self.timeline = timeline
    }
  }

  static func tokenSet(_ body: JSONObject, url: String) throws(GatewayError) -> TokenSet {
    guard case .string(let accessToken)? = body["access_token"], !accessToken.isEmpty else {
      throw GatewayError(.protocol, "\(url) answered without an access_token.")
    }

    return TokenSet(
      accessToken: accessToken,
      refreshToken: body["refresh_token"]?.stringValue ?? "",
      expiresAt: body["expires_at"]?.doubleValue ?? 0,
      provider: body["provider"]?.stringValue ?? "",
      userID: body["user_id"]?.stringValue ?? ""
    )
  }

  /// Redeem the one-time loopback code (`POST /auth/native/token`). The
  /// gateway consumes the code on every path, so a failure here is final:
  /// start a new sign-in rather than retrying the exchange.
  public static func exchangeCode(
    baseURL: String,
    code: String,
    verifier: String,
    options: Options = Options()
  ) async throws(GatewayError) -> TokenSet {
    let url = try GatewayAddress.apiURL(baseURL, path: RESTPath.nativeToken)
    let response = try await options.transport.requestText(
      url,
      JSONRequest(
        method: "POST",
        headers: try GatewayAddress.normalizeHeaders(options.extraHeaders),
        body: .object(NativeTokenRequest(code: code, codeVerifier: verifier).json),
        timeoutMs: options.timeoutMs
      )
    )

    if response.status == 400 {
      throw GatewayError(.auth, "That sign-in code was already used or has expired. Sign in again.", status: 400)
    }

    if response.status >= 500 {
      throw GatewayError(
        .server,
        "The gateway answered HTTP \(response.status) while exchanging the code.",
        status: response.status
      )
    }

    if !response.ok {
      throw GatewayError(.auth, "The code exchange failed with HTTP \(response.status).", status: response.status)
    }

    let tokens = try tokenSet(FetchJSON.parseJSONObject(response.text, url: url, kind: .protocol), url: url)

    if tokens.refreshToken.isEmpty {
      // The sign-in worked and has an end date nobody was told about: a scope
      // missing from the provider's client registration, not anything here.
      options.timeline?.record(AuthEvent(.signinNoRefresh, kind: .auth))
    }

    return tokens
  }

  /// Rotate a refresh token (`POST /auth/native/refresh`). 400/401/403 mean
  /// the grant is finished; 503 means the identity provider is unreachable
  /// and the same refresh token is still worth retrying later.
  public static func refreshTokens(
    baseURL: String,
    refreshToken: String,
    provider: String,
    options: Options = Options()
  ) async throws(GatewayError) -> TokenSet {
    let url = try GatewayAddress.apiURL(baseURL, path: RESTPath.nativeRefresh)

    if refreshToken.isEmpty {
      throw GatewayError(.auth, "There is no refresh token to rotate. Sign in again.", status: 401)
    }

    let response = try await options.transport.requestText(
      url,
      JSONRequest(
        method: "POST",
        headers: try GatewayAddress.normalizeHeaders(options.extraHeaders),
        body: .object(NativeRefreshRequest(refreshToken: refreshToken, provider: provider).json),
        timeoutMs: options.timeoutMs
      )
    )

    if definitiveRefreshStatuses.contains(response.status) {
      throw GatewayError(.auth, "Your session has expired. Sign in again.", status: response.status)
    }

    if response.status == 503 {
      throw GatewayError(.server, "The identity provider is unreachable; Hermie will keep retrying.", status: 503)
    }

    // A gateway too old to have the endpoint is a configuration story, not an expired session.
    if response.status == 404 {
      throw GatewayError(.protocol, "This gateway has no /auth/native/refresh endpoint (HTTP 404).", status: 404)
    }

    if !response.ok {
      throw GatewayError(
        .server,
        "The gateway answered HTTP \(response.status) while refreshing.",
        status: response.status
      )
    }

    return try tokenSet(FetchJSON.parseJSONObject(response.text, url: url, kind: .protocol), url: url)
  }

  /// True once the access token is inside the proactive-refresh window; never
  /// for a set without an expiry.
  public static func tokenNeedsRefresh(_ tokens: TokenSet, nowSeconds: Double, skew: Double = refreshSkewSeconds) -> Bool {
    guard tokens.expiresAt != 0 else {
      return false
    }

    return tokens.expiresAt - nowSeconds < skew
  }
}
