import HermieProtocol

/// The constants and helpers of `credentials.ts`.
public enum GatewayCredentials {
  /// The stable public subprotocol the gateway selects back on accept.
  public static let webSocketProtocol = "hermes-gateway-v1"
  /// Prefix of the credential-bearing subprotocol; never reflected back by the server.
  public static let webSocketTicketPrefix = "hermes-gateway-ticket."
  /// Header an ungated gateway authenticates REST calls with.
  public static let sessionTokenHeader = "X-Hermes-Session-Token"

  /// Pull the bearer value back out of a header map, for 401 bookkeeping
  /// (`bearerFrom`): `authorization` or `Authorization`, `Bearer ` prefix.
  public static func bearer(from headers: [String: String]) -> String? {
    guard let value = headers["authorization"] ?? headers["Authorization"], JSText.hasPrefix(value, "Bearer ") else {
      return nil
    }

    return String(value.unicodeScalars.dropFirst("Bearer ".unicodeScalars.count))
  }

  /// The provider for a stored gateway's auth mode.
  ///
  /// `cookie` cannot work outside a page the gateway serves, so a stored
  /// gateway naming it gets `SignInRequiredCredentials`, which asks for a new
  /// sign-in on every call instead of failing in some stranger way.
  public static func provider(
    mode: GatewayAuthMode,
    baseURL: String,
    sessionToken: String?,
    coordinator: TokenCoordinator?,
    extraHeaders: [String: String] = [:],
    transport: HTTPTransport = HTTPTransport(),
    timeline: (any AuthEventRecorder)? = nil
  ) -> any CredentialProvider {
    switch mode {
    case .sessionToken:
      return SessionTokenCredentials(token: sessionToken ?? "")
    case .nativePKCE:
      guard let coordinator else {
        return SignInRequiredCredentials(storedMode: .nativePKCE)
      }

      return NativePKCECredentials(
        baseURL: baseURL,
        coordinator: coordinator,
        extraHeaders: extraHeaders,
        transport: transport,
        timeline: timeline
      )
    case .cookie:
      return SignInRequiredCredentials(storedMode: .cookie)
    }
  }
}

/// Ungated gateway: the session token rides as a header on REST and as
/// `?token=` on the WebSocket. Nothing to refresh, so a rejection is always
/// "fix the token".
public struct SessionTokenCredentials: CredentialProvider, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  public let mode = GatewayAuthMode.sessionToken
  private let token: String

  public init(token: String) {
    self.token = token
  }

  public func httpAuthHeaders(_ options: AuthHeaderOptions = AuthHeaderOptions()) async throws -> [String: String] {
    [GatewayCredentials.sessionTokenHeader: token]
  }

  /// `new URL(wsUrl)` with `searchParams.set('token', token)`: an existing
  /// `token` parameter is replaced (the first kept, the rest dropped),
  /// anything else is appended, and the query is written back form-encoded.
  public func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    guard let url = WHATWGURL.parse(wsURL) else {
      throw GatewayError(.config, "That is not a valid address: \(wsURL)")
    }

    var pairs = JSText.formParse(url.query ?? "")
    var replaced = false

    pairs = pairs.compactMap { pair in
      guard JSText.same(pair.0, "token") else {
        return pair
      }

      if replaced {
        return nil
      }

      replaced = true
      return ("token", token)
    }

    if !replaced {
      pairs.append(("token", token))
    }

    return DialPlan(
      url: "\(url.protocolString)//\(url.hostWithPort)\(url.pathname)?\(JSText.formSerialize(pairs))",
      headers: extraHeaders
    )
  }

  public func onRejected(rejectedToken: String?) async throws -> RejectionVerdict {
    .reauth
  }

  /// Nothing is cached here; the app deletes the stored token itself.
  public func signOut() async throws {}

  public var description: String { "SessionTokenCredentials(token: \(Redacted.presence(token)))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["token": Redacted.presence(token)]) }
}

/// A stored gateway whose credential the native app cannot use: the browser
/// cookie flow, or a PKCE gateway with nowhere to keep its tokens. Every call
/// says "sign in again"; nothing crashes and nothing is sent.
public struct SignInRequiredCredentials: CredentialProvider {
  public let mode: GatewayAuthMode

  public init(storedMode: GatewayAuthMode) {
    mode = storedMode
  }

  private var signInAgain: GatewayError {
    GatewayError(.auth, "This gateway was set up with a sign-in this app cannot use. Sign in again.", status: 401)
  }

  public func httpAuthHeaders(_ options: AuthHeaderOptions = AuthHeaderOptions()) async throws -> [String: String] {
    throw signInAgain
  }

  public func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    throw signInAgain
  }

  public func onRejected(rejectedToken: String?) async throws -> RejectionVerdict {
    .reauth
  }

  public func signOut() async throws {}
}

/// The WebSocket ticket mint (`mintWsTicket`): `POST /api/auth/ws-ticket`,
/// single use, 30 s TTL, one per dial. The only place in a dial where a stale
/// credential shows itself, so its status is recorded.
public enum WSTicketMint {
  public static func mint(
    baseURL: String,
    headers: [String: String],
    transport: HTTPTransport,
    timeline: (any AuthEventRecorder)? = nil
  ) async throws(GatewayError) -> String {
    let url = try GatewayAddress.apiURL(baseURL, path: RESTPath.wsTicket)
    let response: JSONResponse

    do {
      response = try await transport.requestText(url, JSONRequest(method: "POST", headers: headers, body: .object([:])))
    } catch {
      timeline?.record(AuthEvent(.ticketFailed, kind: error.kind))
      throw error
    }

    if response.status == 401 || response.status == 403 {
      timeline?.record(AuthEvent(.ticketFailed, status: response.status, kind: .auth))
      throw GatewayError(.auth, "The gateway refused to mint a WebSocket ticket. Sign in again.", status: response.status)
    }

    if response.status >= 500 {
      timeline?.record(AuthEvent(.ticketFailed, status: response.status, kind: .server))
      throw GatewayError(
        .server,
        "The gateway answered HTTP \(response.status) while minting a ticket.",
        status: response.status
      )
    }

    if !response.ok {
      timeline?.record(AuthEvent(.ticketFailed, status: response.status, kind: .protocol))
      throw notAGateway(baseURL: baseURL, response: response)
    }

    let body = try FetchJSON.parseJSONObject(response.text, url: url, kind: .protocol)

    guard case .string(let ticket)? = body["ticket"], !ticket.isEmpty else {
      timeline?.record(AuthEvent(.ticketFailed, status: response.status, kind: .protocol))
      throw GatewayError(.protocol, "\(url) answered without a ticket.")
    }

    timeline?.record(AuthEvent(.ticketMinted))
    return ticket
  }

  /// A well-formed HTTP answer no gateway would give: say what was seen and
  /// who answered, and the network sentence only where it is earned.
  static func notAGateway(baseURL: String, response: JSONResponse) -> GatewayError {
    let seen = "The address answered HTTP \(response.status), but not as a Hermes gateway."
    let who = response.server.isEmpty ? "" : " The answer came from \(response.server)."
    let hint = Probe.notHermesHint(baseURL: baseURL, body: response.text)

    return GatewayError(
      .protocol,
      hint.isEmpty ? "\(seen)\(who)" : "\(seen)\(who) \(hint)",
      status: response.status,
      hint: hint.isEmpty ? nil : hint
    )
  }
}

