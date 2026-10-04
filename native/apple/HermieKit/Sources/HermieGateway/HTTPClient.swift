import Foundation
import HermieProtocol

/// Who `/api/auth/me` says the caller is (`AuthIdentity`).
public struct AuthIdentity: Sendable, Equatable {
  public var userID: String
  public var email: String
  public var displayName: String
  public var orgID: String
  public var provider: String
  public var expiresAt: Double
  /// Relative, including the query (`/api/auth/picture?id=…`); empty when the gateway holds none.
  public var pictureURL: String

  public init(
    userID: String,
    email: String = "",
    displayName: String = "",
    orgID: String = "",
    provider: String,
    expiresAt: Double = 0,
    pictureURL: String = ""
  ) {
    self.userID = userID
    self.email = email
    self.displayName = displayName
    self.orgID = orgID
    self.provider = provider
    self.expiresAt = expiresAt
    self.pictureURL = pictureURL
  }
}

/// `POST /api/auth/ws-ticket`'s answer (`WsTicket`).
public struct WSTicket: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var ticket: String
  public var ttlSeconds: Double

  public var description: String { "WSTicket(ticket: \(Redacted.presence(ticket)), ttlSeconds: \(ttlSeconds))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/// A status and its JSON body (`nil` when empty or not JSON), for `HTTPClient.exchange`.
public struct HTTPExchange: Sendable, Equatable {
  public var status: Int
  public var body: JSONValue?
  /// The `retry-after` header, verbatim; empty when absent.
  public var retryAfter: String

  public init(status: Int, body: JSONValue?, retryAfter: String = "") {
    self.status = status
    self.body = body
    self.retryAfter = retryAfter
  }

  public var ok: Bool { (200...299).contains(status) }
}

/// What fetching an authenticated picture came back with (`PictureFetchOutcome`).
public enum PictureFetchOutcome: Sendable, Equatable {
  case ready(dataURI: String)
  /// The gateway does not have this picture.
  case missing
  /// Refused, unreachable, or not an image.
  case error
}

/// The REST half of a gateway connection (`GatewayHttp`): everything that is
/// not the JSON-RPC socket.
///
/// It owns the one retry the auth contract allows: a 401 asks the credential
/// provider whether a fresh credential exists, and only then does the call go
/// out a second time. No call follows a redirect (`RedirectPolicy.refuseAll`).
public struct HTTPClient: Sendable {
  public let baseURL: String
  public let credentials: any CredentialProvider
  let extraHeaders: [String: String]
  let transport: HTTPTransport
  private let defaultTimeoutMs: Int
  private let timeline: (any AuthEventRecorder)?

  /// - Parameter extraHeaders: what goes on the wire beside the credential,
  ///   front-door headers included (`GatewaySecrets.wireHeaders`). Validated
  ///   here, as the reference's constructor does.
  public init(
    baseURL: String,
    credentials: any CredentialProvider,
    extraHeaders: [String: String] = [:],
    transport: HTTPTransport = HTTPTransport(),
    defaultTimeoutMs: Int = GatewayTimeouts.restMs,
    timeline: (any AuthEventRecorder)? = nil
  ) throws(GatewayError) {
    self.baseURL = baseURL
    self.credentials = credentials
    self.extraHeaders = try GatewayAddress.normalizeHeaders(extraHeaders)
    self.transport = transport
    self.defaultTimeoutMs = defaultTimeoutMs
    self.timeline = timeline
  }

  /// `nil` for an empty body; otherwise the parsed JSON, object or array.
  public func get(_ path: String, timeoutMs: Int? = nil) async throws -> JSONValue? {
    try await send("GET", path, body: nil, timeoutMs: timeoutMs)
  }

  public func post(_ path: String, body: JSONValue? = nil, timeoutMs: Int? = nil) async throws -> JSONValue? {
    try await send("POST", path, body: body, timeoutMs: timeoutMs)
  }

  public func put(_ path: String, body: JSONValue? = nil, timeoutMs: Int? = nil) async throws -> JSONValue? {
    try await send("PUT", path, body: body, timeoutMs: timeoutMs)
  }

  public func patch(_ path: String, body: JSONValue? = nil, timeoutMs: Int? = nil) async throws -> JSONValue? {
    try await send("PATCH", path, body: body, timeoutMs: timeoutMs)
  }

  public func delete(_ path: String, body: JSONValue? = nil, timeoutMs: Int? = nil) async throws -> JSONValue? {
    try await send("DELETE", path, body: body, timeoutMs: timeoutMs)
  }

  /// `GET /api/auth/me`. A missing or mistyped field reads as empty (or 0).
  public func authMe(timeoutMs: Int? = nil) async throws -> AuthIdentity {
    let body = try await get(RESTPath.authMe, timeoutMs: timeoutMs)?.objectValue ?? [:]

    return AuthIdentity(
      userID: body["user_id"]?.stringValue ?? "",
      email: body["email"]?.stringValue ?? "",
      displayName: body["display_name"]?.stringValue ?? "",
      orgID: body["org_id"]?.stringValue ?? "",
      provider: body["provider"]?.stringValue ?? "",
      expiresAt: body["expires_at"]?.doubleValue ?? 0,
      pictureURL: body["picture_url"]?.stringValue ?? ""
    )
  }

  /// `GET` an authenticated picture and return it as a `data:` URI, with the
  /// same 401-then-retry as every other call. Never throws for a transport
  /// failure: a picture that could not be loaded is `.error`.
  public func fetchAuthenticatedPicture(_ path: String, timeoutMs: Int? = nil) async throws -> PictureFetchOutcome {
    let first = try await attemptBinary(path, timeoutMs: timeoutMs, auth: AuthHeaderOptions())

    guard first.status == 401 else {
      return Self.outcome(of: first)
    }

    timeline?.record(AuthEvent(.restUnauthorized, status: 401, kind: .auth))

    if try await credentials.onRejected(rejectedToken: first.usedToken) == .reauth {
      return .error
    }

    return Self.outcome(of: try await attemptBinary(path, timeoutMs: timeoutMs, auth: AuthHeaderOptions(forceRefresh: false)))
  }

  /// `GET` a file the gateway serves (`/api/files/…`), with the same 401-then-retry as every other
  /// call and no redirect followed. Nil when the gateway refused it, does not have it, or could not
  /// be reached; throws only what the credential provider throws.
  public func fetchFile(_ path: String, timeoutMs: Int? = nil) async throws -> Data? {
    var attempt = try await attemptBinary(path, timeoutMs: timeoutMs, auth: AuthHeaderOptions())

    if attempt.status == 401 {
      timeline?.record(AuthEvent(.restUnauthorized, status: 401, kind: .auth))

      if try await credentials.onRejected(rejectedToken: attempt.usedToken) == .reauth {
        return nil
      }

      attempt = try await attemptBinary(path, timeoutMs: timeoutMs, auth: AuthHeaderOptions(forceRefresh: false))
    }

    return attempt.ok ? attempt.data : nil
  }

  /// The headers a fetch this client does NOT make would still need (an
  /// image in a reply). Mints and refreshes nothing beyond what the provider does.
  public func requestHeaders() async throws -> [String: String] {
    extraHeaders.merging(try await credentials.httpAuthHeaders(AuthHeaderOptions())) { _, auth in auth }
  }

  /// `POST /api/auth/ws-ticket` through the ordinary REST path.
  public func wsTicket(timeoutMs: Int? = nil) async throws -> WSTicket {
    let body = try await post(RESTPath.wsTicket, body: .object([:]), timeoutMs: timeoutMs)?.objectValue ?? [:]

    guard case .string(let ticket)? = body["ticket"], !ticket.isEmpty else {
      throw GatewayError(.protocol, "The gateway answered /api/auth/ws-ticket without a ticket.")
    }

    return WSTicket(ticket: ticket, ttlSeconds: body["ttl_seconds"]?.doubleValue ?? 0)
  }

  /// A call whose refusals are part of its answer (the passkey routes answer `403 code_invalid`,
  /// `422 assertion_invalid` with a `reason`, …): any status comes back with its JSON body instead
  /// of being thrown. The 401 retry still applies, and a 401 after it throws `auth` as `send` does.
  public func exchange(_ method: String, _ path: String, body: JSONValue? = nil, timeoutMs: Int? = nil) async throws
    -> HTTPExchange
  {
    var attempt = try await self.attempt(method, path, body: body, timeoutMs: timeoutMs, auth: AuthHeaderOptions())

    if attempt.response.status == 401 {
      timeline?.record(AuthEvent(.restUnauthorized, status: 401, kind: .auth))

      if try await credentials.onRejected(rejectedToken: attempt.usedToken) == .reauth {
        throw GatewayError(.auth, "The gateway rejected the credentials for \(method) \(path). Sign in again.", status: 401)
      }

      attempt = try await self.attempt(method, path, body: body, timeoutMs: timeoutMs, auth: AuthHeaderOptions(forceRefresh: false))

      if attempt.response.status == 401 {
        throw GatewayError(.auth, "The gateway refused \(method) \(path) (HTTP 401).", status: 401)
      }
    }

    let text = attempt.response.text
    let parsed = JSText.trim(text).isEmpty ? nil : try? JSONValue(parsing: text)
    return HTTPExchange(status: attempt.response.status, body: parsed, retryAfter: attempt.response.retryAfter)
  }

  // MARK: - The round trip

  private struct Attempt {
    var response: JSONResponse
    var url: String
    var usedToken: String?
  }

  private func send(_ method: String, _ path: String, body: JSONValue?, timeoutMs: Int?) async throws -> JSONValue? {
    let attempt = try await self.attempt(method, path, body: body, timeoutMs: timeoutMs, auth: AuthHeaderOptions())

    guard attempt.response.status == 401 else {
      return try unwrap(attempt, method: method, path: path)
    }

    timeline?.record(AuthEvent(.restUnauthorized, status: 401, kind: .auth))

    if try await credentials.onRejected(rejectedToken: attempt.usedToken) == .reauth {
      throw GatewayError(.auth, "The gateway rejected the credentials for \(method) \(path). Sign in again.", status: 401)
    }

    let retry = try await self.attempt(
      method,
      path,
      body: body,
      timeoutMs: timeoutMs,
      auth: AuthHeaderOptions(forceRefresh: false)
    )

    return try unwrap(retry, method: method, path: path)
  }

  private func attempt(
    _ method: String,
    _ path: String,
    body: JSONValue?,
    timeoutMs: Int?,
    auth options: AuthHeaderOptions
  ) async throws -> Attempt {
    let url = try GatewayAddress.apiURL(baseURL, path: path)
    let auth = try await credentials.httpAuthHeaders(options)
    let response = try await transport.requestText(
      url,
      JSONRequest(
        method: method,
        headers: extraHeaders.merging(auth) { _, auth in auth },
        body: body,
        timeoutMs: timeoutMs ?? defaultTimeoutMs
      )
    )

    // The URL the answer came from: the transport has refused every redirect, so it is the one asked.
    return Attempt(
      response: response,
      url: response.url.isEmpty ? url : response.url,
      usedToken: GatewayCredentials.bearer(from: auth)
    )
  }

  private struct BinaryAttempt {
    var status: Int
    var ok: Bool
    var data: Data?
    var contentType: String
    var usedToken: String?
  }

  /// `attemptBinary`: a plain `GET` read as bytes. Any transport failure is
  /// status 0, since a picture that failed to load is `.error` whatever the reason.
  private func attemptBinary(_ path: String, timeoutMs: Int?, auth options: AuthHeaderOptions) async throws
    -> BinaryAttempt
  {
    let url = try GatewayAddress.apiURL(baseURL, path: path)
    let auth = try await credentials.httpAuthHeaders(options)
    let usedToken = GatewayCredentials.bearer(from: auth)

    do {
      let raw = try await transport.send(
        url,
        method: "GET",
        headers: extraHeaders.merging(auth) { _, auth in auth },
        body: nil,
        timeoutMs: timeoutMs ?? defaultTimeoutMs,
        redirects: .refuseAll
      )
      let ok = (200...299).contains(raw.status)

      return BinaryAttempt(
        status: raw.status,
        ok: ok,
        data: ok ? raw.data : nil,
        contentType: ok ? raw.contentType : "",
        usedToken: usedToken
      )
    } catch {
      return BinaryAttempt(status: 0, ok: false, data: nil, contentType: "", usedToken: usedToken)
    }
  }

  private static func outcome(of attempt: BinaryAttempt) -> PictureFetchOutcome {
    if attempt.status == 404 {
      return .missing
    }

    guard attempt.ok, let data = attempt.data else {
      return .error
    }

    let type = attempt.contentType.isEmpty ? "image/png" : attempt.contentType
    return .ready(dataURI: "data:\(type);base64,\(Base64.encode(Array(data)))")
  }

  private func unwrap(_ attempt: Attempt, method: String, path: String) throws(GatewayError) -> JSONValue? {
    let response = attempt.response

    if response.status == 401 || response.status == 403 {
      throw GatewayError(.auth, "The gateway refused \(method) \(path) (HTTP \(response.status)).", status: response.status)
    }

    if response.status == 404 {
      throw GatewayError(.protocol, "The gateway has no \(method) \(path) endpoint (HTTP 404).", status: 404)
    }

    if response.status >= 500 {
      throw GatewayError(
        .server,
        "The gateway answered HTTP \(response.status) on \(method) \(path).",
        status: response.status
      )
    }

    if !response.ok {
      throw GatewayError(
        .protocol,
        "\(method) \(path) failed with HTTP \(response.status).",
        status: response.status,
        hint: Self.detail(of: response.text)
      )
    }

    if JSText.trim(response.text).isEmpty {
      return nil
    }

    return try FetchJSON.parseJSONBody(response.text, url: attempt.url, kind: .protocol)
  }

  /// A refusal's own sentence out of a JSON error body (`detailOf`): a
  /// non-blank string `detail` of an object, or nothing.
  static func detail(of text: String) -> String? {
    guard JSText.hasPrefix(JSText.trim(text), "{"), case .object(let body)? = try? JSONValue(parsing: text),
      case .string(let detail)? = body["detail"], !JSText.trim(detail).isEmpty
    else {
      return nil
    }

    return detail
  }
}
