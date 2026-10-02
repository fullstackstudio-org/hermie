import HermieProtocol

/// One sign-in provider a gated gateway offers (`AuthProvider`).
public struct AuthProvider: Sendable, Equatable {
  public var name: String
  public var displayName: String
  public var supportsPassword: Bool

  public init(name: String, displayName: String, supportsPassword: Bool) {
    self.name = name
    self.displayName = displayName
    self.supportsPassword = supportsPassword
  }
}

/// What a gateway's public endpoints said about it (`ProbeResult`).
public struct ProbeResult: Sendable, Equatable {
  /// The gateway's version string from `/api/status`; empty when it sent none.
  public var version: String
  public var authRequired: Bool
  /// Raw `auth_flows`, e.g. `["cookie", "native_pkce"]`; non-strings dropped.
  public var authFlows: [String]
  /// Empty for an ungated gateway, and for a gated one whose provider scan is down (503).
  public var providers: [AuthProvider]
  public var supportsNativePKCE: Bool

  public init(version: String, authRequired: Bool, authFlows: [String], providers: [AuthProvider], supportsNativePKCE: Bool) {
    self.version = version
    self.authRequired = authRequired
    self.authFlows = authFlows
    self.providers = providers
    self.supportsNativePKCE = supportsNativePKCE
  }

  /// How the native app authenticates with this gateway (`authModeOf` outside
  /// a browser): its session token when ungated, native PKCE when gated. The
  /// cookie flow is never chosen here.
  public var authMode: GatewayAuthMode {
    authRequired ? .nativePKCE : .sessionToken
  }

  /// False for a gated gateway too old to offer native PKCE: there is no way
  /// for this app to sign in to it, and the wizard says so.
  public var canSignIn: Bool {
    authMode != .nativePKCE || supportsNativePKCE
  }
}

/// A probe of what the user typed, and where it was found (`ResolvedAddress`).
public struct ResolvedAddress: Sendable, Equatable {
  public var probe: ProbeResult
  /// The address that answered, scheme included.
  public var baseURL: String
  /// No scheme was typed, `https://` did not answer at all, and the same host
  /// answered as a Hermes gateway over `http://`. The wizard says so out loud.
  public var foundOverHTTP: Bool
}

/// The onboarding probe (`probe.ts`): `/api/status`, then `/api/auth/providers`
/// for a gated gateway, all unauthenticated.
///
/// A failure is a `GatewayError`, and what onboarding needs from it is on the
/// error: `redirect` with `redirectedTo` (the host) and `redirectedOrigin` (the
/// origin the address pointed at; nothing was read from it), `not_hermes` with
/// `sawLandingPage` and `hint`,
/// `auth` 401/403 for an access proxy in the way. `ProbeVerdict.classify` turns
/// it into the hint and the buttons.
public enum Probe {
  /// How long a probe waits for one answer (`PROBE_TIMEOUT_MS`).
  public static let timeoutMs = GatewayTimeouts.probeMs

  /// Read a gateway's `/api/status` and, when it is gated, its providers
  /// (`probeGateway`). `extraHeaders` go on both calls, front-door headers
  /// included: an access proxy is the first thing the probe meets.
  public static func probeGateway(
    _ baseURL: String,
    extraHeaders: [String: String] = [:],
    transport: HTTPTransport = HTTPTransport()
  ) async throws(GatewayError) -> ProbeResult {
    do {
      return try await probeDetailed(baseURL, extraHeaders: extraHeaders, transport: transport)
    } catch {
      throw error.error
    }
  }

  /// A `GatewayError` that is not a transport failure, carried as one.
  private static func plain<T>(_ work: () throws(GatewayError) -> T) throws(TransportFailure) -> T {
    do {
      return try work()
    } catch {
      throw TransportFailure(error: error, certificate: false)
    }
  }

  /// `probeGateway`, keeping the one fact the scheme fallback needs.
  private static func probeDetailed(
    _ rawBaseURL: String,
    extraHeaders: [String: String],
    transport: HTTPTransport
  ) async throws(TransportFailure) -> ProbeResult {
    // Raw text is allowed (a debug screen passes what was typed): normalised once, here.
    let baseURL = try plain { () throws(GatewayError) in try GatewayAddress.normalizeBaseURL(rawBaseURL) }
    let headers = try plain { () throws(GatewayError) in try GatewayAddress.normalizeHeaders(extraHeaders) }
    // A redirect within one origin may be followed only while nothing of ours
    // rides along: a front-door header is a credential, and then the probe
    // refuses every redirect like an authenticated call.
    let redirects: RedirectPolicy = headers.isEmpty ? .sameOrigin : .refuseAll
    let statusURL = try plain { () throws(GatewayError) in try GatewayAddress.apiURL(baseURL, path: RESTPath.status) }
    // A redirect to another origin is refused by the transport before anything
    // is read: the reference's "before every other verdict".
    let status = try await transport.requestTextDetailed(
      statusURL,
      JSONRequest(headers: headers, timeoutMs: timeoutMs, redirects: redirects)
    )
    let reading = try plain { () throws(GatewayError) in try readStatus(status, baseURL: baseURL, statusURL: statusURL) }
    var result = ProbeResult(
      version: reading.version,
      authRequired: reading.authRequired,
      authFlows: reading.authFlows,
      providers: [],
      supportsNativePKCE: reading.supportsNativePKCE
    )

    if reading.authRequired {
      result.providers = try await probeProviders(baseURL, headers: headers, redirects: redirects, transport: transport)
    }

    return result
  }

  /// What `/api/status` said.
  private struct StatusReading {
    var version: String
    var authRequired: Bool
    var authFlows: [String]
    var supportsNativePKCE: Bool
  }

  private static func readStatus(_ status: JSONResponse, baseURL: String, statusURL: String) throws(GatewayError)
    -> StatusReading
  {
    if status.status == 404 {
      throw GatewayError(.notHermes, "\(statusURL) does not exist — that address is not a Hermes gateway.", status: 404)
    }

    if status.status == 401 || status.status == 403 {
      throw GatewayError(
        .auth,
        "\(statusURL) is behind an access proxy (HTTP \(status.status)). Add the proxy's headers under Advanced, "
          + "or exempt /api/status, /auth/* and /login from it.",
        status: status.status
      )
    }

    if status.status >= 500 {
      throw GatewayError(.server, "The gateway answered HTTP \(status.status) on /api/status.", status: status.status)
    }

    if !status.ok {
      throw GatewayError(.notHermes, "\(statusURL) answered HTTP \(status.status).", status: status.status)
    }

    let hint = notHermesHint(baseURL: baseURL, body: status.text)
    let withHint = { (message: String) in hint.isEmpty ? message : "\(message) \(hint)" }
    let sawLandingPage = looksLikeLandingPage(status.text)
    let body: JSONObject

    do {
      body = try FetchJSON.parseJSONObject(status.text, url: statusURL, kind: .notHermes)
    } catch {
      throw GatewayError(
        .notHermes,
        withHint(error.message),
        hint: hint.isEmpty ? nil : hint,
        sawLandingPage: sawLandingPage
      )
    }

    guard case .bool(let authRequired)? = body["auth_required"] else {
      throw GatewayError(
        .notHermes,
        withHint("\(statusURL) answered JSON without \"auth_required\" — not a Hermes gateway."),
        hint: hint.isEmpty ? nil : hint,
        sawLandingPage: sawLandingPage
      )
    }

    let authFlows = body["auth_flows"]?.arrayValue?.compactMap(\.stringValue) ?? []

    return StatusReading(
      version: body["version"]?.stringValue ?? "",
      authRequired: authRequired,
      authFlows: authFlows,
      supportsNativePKCE: authFlows.contains { JSText.same($0, StatusResponse.nativePKCEFlow) }
    )
  }

  private static func probeProviders(
    _ baseURL: String,
    headers: [String: String],
    redirects: RedirectPolicy,
    transport: HTTPTransport
  ) async throws(TransportFailure) -> [AuthProvider] {
    let url = try plain { () throws(GatewayError) in try GatewayAddress.apiURL(baseURL, path: RESTPath.authProviders) }
    let response = try await transport.requestTextDetailed(
      url,
      JSONRequest(headers: headers, timeoutMs: timeoutMs, redirects: redirects)
    )

    return try plain { () throws(GatewayError) in try readProviders(response, url: url) }
  }

  private static func readProviders(_ response: JSONResponse, url: String) throws(GatewayError) -> [AuthProvider] {
    // 503: the provider scan found nothing usable. A configuration story, not a failure.
    if response.status == 503 {
      return []
    }

    if response.status == 401 || response.status == 403 {
      throw GatewayError(
        .auth,
        "\(url) is behind an access proxy (HTTP \(response.status)). Exempt /auth/* and /login from it.",
        status: response.status
      )
    }

    if response.status >= 500 {
      throw GatewayError(
        .server,
        "The gateway answered HTTP \(response.status) on /api/auth/providers.",
        status: response.status
      )
    }

    if !response.ok {
      throw GatewayError(.notHermes, "\(url) answered HTTP \(response.status).", status: response.status)
    }

    let body = try FetchJSON.parseJSONObject(response.text, url: url, kind: .notHermes)
    let rows = body["providers"]?.arrayValue ?? []

    return rows.compactMap { row -> AuthProvider? in
      guard case .object(let row) = row else {
        return nil
      }

      let name = row["name"]?.stringValue ?? ""
      let displayName = row["display_name"]?.stringValue ?? jsString(row["name"])

      return AuthProvider(name: name, displayName: displayName, supportsPassword: row["supports_password"] == .bool(true))
    }
    .filter { !$0.name.isEmpty }
  }

  /// `String(row.name ?? '')` for the display name fallback. Only reached for
  /// a provider that has no string `display_name`; a row without a string
  /// `name` is dropped by the filter whatever this answers.
  private static func jsString(_ value: JSONValue?) -> String {
    switch value {
    case nil, .null?: ""
    case .string(let text)?: text
    case .bool(let flag)?: flag ? "true" : "false"
    case .number(let number)?: JSText.numberString(number)
    case .array?, .object?: ""
    }
  }

  /// Probe what the user typed, trying `http://` only when no scheme was typed
  /// and `https://` got no answer at all (`resolveGatewayAddress`, ADR-0014).
  ///
  /// A rejected certificate, any HTTP status and a redirect are answers, and
  /// are reported as they are. If both schemes fail to answer, the https
  /// failure is the one reported, except a redirect found in the clear.
  ///
  /// The custom headers and the front door come in separately because the wire
  /// headers are worked out per attempt, for that attempt's URL: front-door
  /// headers never go out over http (`FrontDoor.headers(for:)`). And with a
  /// front door configured there is no cleartext fallback at all: an address
  /// behind an access proxy is an https address, and a network that blocks
  /// 443 is not a reason to go looking for it in the clear.
  public static func resolveGatewayAddress(
    _ raw: String,
    customHeaders: [String: String] = [:],
    frontDoor: FrontDoor = .none,
    transport: HTTPTransport = HTTPTransport()
  ) async throws(GatewayError) -> ResolvedAddress {
    let baseURL = try GatewayAddress.normalizeBaseURL(raw)
    let headers = { (url: String) in GatewaySecrets.wireHeaders(custom: customHeaders, frontDoor: frontDoor, baseURL: url) }
    let fallback = frontDoor.isComplete ? nil : try GatewayAddress.cleartextFallback(for: raw)

    guard let cleartextURL = fallback, !GatewayAddress.hasExplicitScheme(raw) else {
      let probe = try await probeGateway(baseURL, extraHeaders: headers(baseURL), transport: transport)
      return ResolvedAddress(probe: probe, baseURL: baseURL, foundOverHTTP: false)
    }

    let httpsFailure: TransportFailure

    do {
      let probe = try await probeDetailed(baseURL, extraHeaders: headers(baseURL), transport: transport)
      return ResolvedAddress(probe: probe, baseURL: baseURL, foundOverHTTP: false)
    } catch {
      httpsFailure = error
    }

    guard isTransportFailure(httpsFailure) else {
      throw httpsFailure.error
    }

    // Nobody has agreed to plain http yet: on a host anyone can be on the path to, the custom
    // headers (a proxy's shared secret, often) stay back, as the front door does on any http.
    let cleartextHeaders = HostClassification.isExposedCleartext(cleartextURL) ? [:] : headers(cleartextURL)

    do {
      let probe = try await probeGateway(cleartextURL, extraHeaders: cleartextHeaders, transport: transport)
      return ResolvedAddress(probe: probe, baseURL: cleartextURL, foundOverHTTP: true)
    } catch {
      // A redirect is the address saying it has moved, not a failure to reach it.
      if error.kind == .redirect {
        throw error
      }

      throw httpsFailure.error
    }
  }

  /// A failure to get an answer at all, as opposed to an answer we did not like.
  private static func isTransportFailure(_ failure: TransportFailure) -> Bool {
    let error = failure.error

    guard error.status == nil else {
      return false
    }

    switch error.kind {
    case .network, .timeout:
      return true
    case .tls:
      // A rejected certificate, or a TLS alert from the peer, means there IS an https server here.
      return !failure.tlsServerAnswered
    default:
      return false
    }
  }

  /// The extra sentence for "answered, but not like a Hermes gateway"
  /// (`notHermesHint`): what came back (a landing page), and where the address
  /// points (a host only one network can reach; loopback excluded).
  public static func notHermesHint(baseURL: String, body: String) -> String {
    let privacy = HostClassification.of(baseURL).privacy
    let reachableOnlyThere = privacy != .public && privacy != .loopback
    let seen = looksLikeLandingPage(body) ? "This looks like a landing page, not a Hermes gateway." : ""

    guard reachableOnlyThere else {
      return seen
    }

    let network =
      "If the gateway is only reachable on that private network or tailnet, make sure this device is connected to it."

    return seen.isEmpty ? network : "\(seen) \(network)"
  }

  /// A web page where a JSON object was expected: `<!doctype html` or `<html`
  /// in the first 2000 UTF-16 code units, case-insensitively.
  static func looksLikeLandingPage(_ body: String) -> Bool {
    let head = String(decoding: Array(body.utf16.prefix(2000)), as: UTF16.self).lowercased()
    return FetchJSON.contains(head, "<!doctype html") || FetchJSON.contains(head, "<html")
  }
}
