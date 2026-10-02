import Foundation

// REST request and response bodies, as `packages/gateway-client/src` reads them and
// `packages/fake-gateway/src/upstream-shapes.test.ts` pins them. Typed views; see
// `JSONBacked.swift`. Cron (`/api/cron/*`) and plugin (`/api/plugins/*`) bodies stay
// `JSONValue` until the features that read them are ported.

/// The REST paths the app calls. Templated ones are functions.
public enum RESTPath {
  public static let status = "/api/status"
  public static let authProviders = "/api/auth/providers"
  public static let authMe = "/api/auth/me"
  public static let authPicture = "/api/auth/picture"
  public static let wsTicket = "/api/auth/ws-ticket"
  public static let nativeAuthorize = "/auth/native/authorize"
  public static let nativeToken = "/auth/native/token"
  public static let nativeRefresh = "/auth/native/refresh"
  public static let logout = "/auth/logout"
  public static let profiles = "/api/profiles"
  public static let sessionSearch = "/api/sessions/search"
  public static let fileUpload = "/api/files/upload-stream"
  public static let cronJobs = "/api/cron/jobs"
  public static let cronDeliveryTargets = "/api/cron/delivery-targets"
  public static let pluginContextTurn = "/api/plugins/hermie/context/turn"
  /// The WebSocket.
  public static let socket = "/api/ws"

  /// `PATCH` renames (or, for `default`, sets the display name of) a profile.
  public static func profile(_ name: String) -> String { "/api/profiles/\(segment(name))" }
  public static func sessionMessages(_ sessionID: String) -> String { "/api/sessions/\(segment(sessionID))/messages" }
  public static func cronJob(_ id: String) -> String { "/api/cron/jobs/\(segment(id))" }
  public static func pluginProfile(_ name: String) -> String { "/api/plugins/hermie/profiles/\(segment(name))" }

  /// One path segment, percent-encoded as `encodeURIComponent` would.
  static func segment(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
  }
}

/// The error body REST routes answer with: `{detail}` (FastAPI), and `{error, detail}` on
/// `/auth/native/refresh`'s 401.
public struct RESTErrorBody: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// A string on every route the app calls (FastAPI validation errors send an array; raw).
  public var detail: JSONValue? { get { json["detail"] } set { json["detail"] = newValue } }
  public var detailText: String? { json[field: "detail"] }
  public var error: String? { get { json[field: "error"] } set { json[field: "error"] = newValue } }
}

/// `GET /api/status`: public, the probe's first call.
public struct StatusResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var version: String? { get { json[field: "version"] } set { json[field: "version"] = newValue } }
  public var releaseDate: String? { get { json[field: "release_date"] } set { json[field: "release_date"] = newValue } }
  public var gatewayRunning: Bool? { get { json[field: "gateway_running"] } set { json[field: "gateway_running"] = newValue } }
  public var activeSessions: Int? { get { json[field: "active_sessions"] } set { json[field: "active_sessions"] = newValue } }
  /// Missing or not a boolean means "not a Hermes gateway".
  public var authRequired: Bool? { get { json[field: "auth_required"] } set { json[field: "auth_required"] = newValue } }
  public var authProviders: [String]? { get { json[field: "auth_providers"] } set { json[field: "auth_providers"] = newValue } }
  /// E.g. `["cookie", "native_pkce"]`.
  public var authFlows: [String]? { get { json[field: "auth_flows"] } set { json[field: "auth_flows"] = newValue } }
  /// Topology rows; nothing in the app reads them. Raw.
  public var profiles: JSONValue? { get { json["profiles"] } set { json["profiles"] = newValue } }
  public var overall: String? { get { json[field: "overall"] } set { json[field: "overall"] = newValue } }

  /// The flow id `/api/status` advertises for native PKCE sign-in.
  public static let nativePKCEFlow = "native_pkce"
}

/// `GET /api/auth/providers` (503 when no provider is usable).
public struct AuthProvidersResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var providers: [AuthProviderRow]? { get { json[field: "providers"] } set { json[field: "providers"] = newValue } }
}

public struct AuthProviderRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var displayName: String? { get { json[field: "display_name"] } set { json[field: "display_name"] = newValue } }
  public var supportsPassword: Bool? {
    get { json[field: "supports_password"] }
    set { json[field: "supports_password"] = newValue }
  }
}

/// `GET /api/auth/me`: the caller's identity.
public struct AuthMeResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var userID: String? { get { json[field: "user_id"] } set { json[field: "user_id"] = newValue } }
  public var email: String? { get { json[field: "email"] } set { json[field: "email"] = newValue } }
  public var displayName: String? { get { json[field: "display_name"] } set { json[field: "display_name"] = newValue } }
  public var orgID: String? { get { json[field: "org_id"] } set { json[field: "org_id"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  /// Unix seconds.
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  /// A relative path including the query (`/api/auth/picture?id=…`); only on the fork.
  public var pictureURL: String? { get { json[field: "picture_url"] } set { json[field: "picture_url"] = newValue } }
  /// Sent on some deployments only.
  public var roles: [String]? { get { json[field: "roles"] } set { json[field: "roles"] = newValue } }
}

/// `POST /api/auth/ws-ticket` response: single use, `ttl_seconds` (30) to dial with it.
public struct WSTicketResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var ticket: String? { get { json[field: "ticket"] } set { json[field: "ticket"] = newValue } }
  public var ttlSeconds: Double? { get { json[field: "ttl_seconds"] } set { json[field: "ttl_seconds"] = newValue } }
}

/// `POST /auth/native/token` body: redeem the loopback code.
public struct NativeTokenRequest: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(code: String, codeVerifier: String) {
    self.init()
    self.code = code
    self.codeVerifier = codeVerifier
  }

  public var code: String? { get { json[field: "code"] } set { json[field: "code"] = newValue } }
  public var codeVerifier: String? { get { json[field: "code_verifier"] } set { json[field: "code_verifier"] = newValue } }
}

/// `POST /auth/native/refresh` body.
public struct NativeRefreshRequest: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(refreshToken: String, provider: String) {
    self.init()
    self.refreshToken = refreshToken
    self.provider = provider
  }

  public var refreshToken: String? { get { json[field: "refresh_token"] } set { json[field: "refresh_token"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
}

/// The bearer payload both `/auth/native/token` and `/auth/native/refresh` answer with.
public struct NativeTokenResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var accessToken: String? { get { json[field: "access_token"] } set { json[field: "access_token"] = newValue } }
  /// Absent or empty when the provider's client registration grants no refresh scope.
  public var refreshToken: String? { get { json[field: "refresh_token"] } set { json[field: "refresh_token"] = newValue } }
  public var tokenType: String? { get { json[field: "token_type"] } set { json[field: "token_type"] = newValue } }
  /// Unix seconds.
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var userID: String? { get { json[field: "user_id"] } set { json[field: "user_id"] = newValue } }
}

/// `GET /api/profiles`.
public struct ProfilesResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profiles: [ProfileRow]? { get { json[field: "profiles"] } set { json[field: "profiles"] = newValue } }
}

/// `GET /api/sessions/{id}/messages` paging, echoed back.
public struct SessionMessagesPagination: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var limit: Int? { get { json[field: "limit"] } set { json[field: "limit"] = newValue } }
  public var offset: Int? { get { json[field: "offset"] } set { json[field: "offset"] = newValue } }
  /// `oldest` (the default) or `latest`.
  public var order: String? { get { json[field: "order"] } set { json[field: "order"] = newValue } }
  public var returned: Int? { get { json[field: "returned"] } set { json[field: "returned"] = newValue } }
}

/// `GET /api/sessions/{id}/messages`: one page of REST-shaped rows, oldest first.
public struct SessionMessagesResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The stored session it read.
  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var messages: [TranscriptRow]? { get { json[field: "messages"] } set { json[field: "messages"] = newValue } }
  public var pagination: SessionMessagesPagination? {
    get { json[field: "pagination"] }
    set { json[field: "pagination"] = newValue }
  }
}

/// `GET /api/sessions/search`: at most one hit per conversation, scoped to one profile.
public struct SessionSearchResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var results: [SessionSearchRow]? { get { json[field: "results"] } set { json[field: "results"] = newValue } }
}

/// One `results` row. It names a conversation, never a message.
public struct SessionSearchRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var lineageRoot: String? { get { json[field: "lineage_root"] } set { json[field: "lineage_root"] = newValue } }
  /// Matches wrapped in `>>>` / `<<<`.
  public var snippet: String? { get { json[field: "snippet"] } set { json[field: "snippet"] = newValue } }
  public var role: String? { get { json[field: "role"] } set { json[field: "role"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var source: String? { get { json[field: "source"] } set { json[field: "source"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var lastActive: Double? { get { json[field: "last_active"] } set { json[field: "last_active"] = newValue } }
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var sessionStarted: Double? { get { json[field: "session_started"] } set { json[field: "session_started"] = newValue } }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
  public var archived: Bool? { get { json[field: "archived"] } set { json[field: "archived"] = newValue } }
}

/// One file entry of the managed-files policy.
public struct FileEntry: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  public var isDirectory: Bool? { get { json[field: "is_directory"] } set { json[field: "is_directory"] = newValue } }
  public var size: Int? { get { json[field: "size"] } set { json[field: "size"] = newValue } }
  /// Unix seconds, fractional.
  public var mtime: Double? { get { json[field: "mtime"] } set { json[field: "mtime"] = newValue } }
  public var mimeType: String? { get { json[field: "mime_type"] } set { json[field: "mime_type"] = newValue } }
}

/// `POST /api/files/upload-stream` response (`files.py`).
public struct FileUploadResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var ok: Bool? { get { json[field: "ok"] } set { json[field: "ok"] = newValue } }
  /// The RESOLVED path the file landed at.
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  public var entry: FileEntry? { get { json[field: "entry"] } set { json[field: "entry"] = newValue } }
  public var root: String? { get { json[field: "root"] } set { json[field: "root"] = newValue } }
  public var lockedRoot: String? { get { json[field: "locked_root"] } set { json[field: "locked_root"] = newValue } }
  public var canChangePath: Bool? { get { json[field: "can_change_path"] } set { json[field: "can_change_path"] = newValue } }
}
