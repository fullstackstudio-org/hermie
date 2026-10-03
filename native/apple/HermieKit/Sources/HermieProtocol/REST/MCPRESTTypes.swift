import Foundation

// The gateway's MCP endpoint, as the app's Settings page sees it (`contract/gateway/mcp.md`,
// sections 2 to 4). Hermie never speaks MCP and runs no server: it shows what the gateway says about
// its endpoint and the clients connected to it, and revokes one. Every string in these shapes is
// either the gateway's own prose or somebody else's text (a client's name, an address, a user
// agent), so a reader draws it as plain text and never logs it. Every object may grow: a reader
// ignores the keys it does not know.

extension RESTPath {
  /// `GET`: the caller's own view of the gateway's MCP endpoint and its grants.
  public static let mcp = "/api/auth/mcp"

  /// `POST`: end one grant of the caller's (`{}` body).
  public static func mcpGrantRevoke(_ id: String) -> String { "/api/auth/mcp/grants/\(segment(id))/revoke" }
}

/// `GET /api/auth/mcp`.
public struct MCPSettings: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `1`. Bumped only for a change a reader could not ignore.
  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  /// Always `true` on a 200: a gateway with MCP off answers 404.
  public var enabled: Bool? { get { json[field: "enabled"] } set { json[field: "enabled"] = newValue } }
  /// The URL an MCP client connects to. The app never builds it itself.
  public var endpointURL: String? { get { json[field: "endpoint_url"] } set { json[field: "endpoint_url"] = newValue } }
  /// The OAuth issuer. Shown, never used for a request.
  public var issuer: String? { get { json[field: "issuer"] } set { json[field: "issuer"] = newValue } }
  /// The server name used in the command and the config.
  public var label: String? { get { json[field: "label"] } set { json[field: "label"] = newValue } }
  /// `claude mcp add --transport http <label> <endpoint_url>`, ready to copy. Shown and copied as
  /// text, never run.
  public var claudeCommand: String? {
    get { json[field: "claude_command"] }
    set { json[field: "claude_command"] = newValue }
  }
  /// The `.mcp.json` fragment as pretty-printed JSON text. Copied verbatim.
  public var configJSON: String? { get { json[field: "config_json"] } set { json[field: "config_json"] = newValue } }
  /// English prose for the person, a few sentences.
  public var instructions: String? {
    get { json[field: "instructions"] }
    set { json[field: "instructions"] = newValue }
  }
  /// The caller's active grants, newest first.
  public var grants: [MCPGrant]? { get { json[field: "grants"] } set { json[field: "grants"] = newValue } }
}

/// One MCP client the person has allowed.
public struct MCPGrant: JSONObjectBacked, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// Opaque, `[A-Za-z0-9_-]{1,64}`: the key for revoking.
  public var id: String { json[field: "id"] ?? "" }
  /// The name the client registered under. Untrusted.
  public var clientName: String? { get { json[field: "client_name"] } set { json[field: "client_name"] = newValue } }
  /// The client's OAuth id. Untrusted.
  public var clientID: String? { get { json[field: "client_id"] } set { json[field: "client_id"] = newValue } }
  /// OAuth scope strings, possibly empty.
  public var scopes: [String]? { get { json[field: "scopes"] } set { json[field: "scopes"] = newValue } }
  /// When the person allowed it (Unix seconds).
  public var createdAt: Double? { get { json[field: "created_at"] } set { json[field: "created_at"] = newValue } }
  /// The address that consented, `null` when not recorded. Untrusted.
  public var createdIP: String? { get { json[field: "created_ip"] } set { json[field: "created_ip"] = newValue } }
  /// The consenting browser's user agent, `null` when not recorded. Untrusted.
  public var createdUserAgent: String? {
    get { json[field: "created_user_agent"] }
    set { json[field: "created_user_agent"] = newValue }
  }
  /// The last time the client used its token, `null` when it never has.
  public var lastUsedAt: Double? { get { json[field: "last_used_at"] } set { json[field: "last_used_at"] = newValue } }
  /// The address of that use. Untrusted.
  public var lastUsedIP: String? { get { json[field: "last_used_ip"] } set { json[field: "last_used_ip"] = newValue } }
  /// When the grant ends and the person must allow it again.
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
}

/// `mcp.changed`: a client was allowed or revoked. Sent to every live connection of the person, with
/// `session_id: ""`. A hint to reload, not the state.
public struct MCPChangedPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The event's type name. Not in `GatewayEventType.all`: it is read beside the transcript engine.
  public static let eventType = "mcp.changed"

  /// `granted` or `revoked`; any other value means "something changed".
  public var change: MCPChange? { get { json[field: "change"] } set { json[field: "change"] = newValue } }
  public var grant: MCPChangedGrant? { get { json[field: "grant"] } set { json[field: "grant"] = newValue } }
  public var at: Double? { get { json[field: "at"] } set { json[field: "at"] = newValue } }
}

public enum MCPChange: OpenStringEnum {
  case granted, revoked
  case unknown(String)

  public static let knownCases: [MCPChange] = [.granted, .revoked]

  public var rawValue: String {
    switch self {
    case .granted: "granted"
    case .revoked: "revoked"
    case .unknown(let raw): raw
    }
  }
}

public struct MCPChangedGrant: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  /// Untrusted.
  public var clientName: String? { get { json[field: "client_name"] } set { json[field: "client_name"] = newValue } }
}
