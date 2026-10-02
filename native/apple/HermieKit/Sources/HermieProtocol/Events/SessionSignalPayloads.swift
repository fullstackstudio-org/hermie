import Foundation

// The event payloads the session layer handles beside the transcript engine: out-of-band notices,
// the connector authorisation card, deferred resume progress and the goal / loop / heartbeat
// snapshot. Typed from the gateway's Python contract (`tui_gateway/contracts/events.py` and
// `connectors_operation.py`), which the emitters are checked against. Typed views; see
// `JSONBacked.swift`.

// MARK: - Notices

/// `notification.show`'s `level`: severity.
public enum NoticeLevel: OpenStringEnum {
  case info, warn, error, success
  case unknown(String)

  public static let knownCases: [NoticeLevel] = [.info, .warn, .error, .success]

  public var rawValue: String {
    switch self {
    case .info: "info"
    case .warn: "warn"
    case .error: "error"
    case .success: "success"
    case .unknown(let raw): raw
    }
  }
}

/// `notification.show`'s `kind`: lifetime. `sticky` stays until a clear, `ttl` expires after
/// `ttl_ms`, `agent` is the agent's own notice (no lifetime of its own).
public enum NoticeLifetime: OpenStringEnum {
  case sticky, ttl, agent
  case unknown(String)

  public static let knownCases: [NoticeLifetime] = [.sticky, .ttl, .agent]

  public var rawValue: String {
    switch self {
    case .sticky: "sticky"
    case .ttl: "ttl"
    case .agent: "agent"
    case .unknown(let raw): raw
    }
  }
}

/// `notification.show`: show or replace a keyed out-of-band notice (`agent/credits_tracker.py`
/// through the notice callback, and the gateway's slow agent-build notice).
public struct NotificationShowPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var level: NoticeLevel? { get { json[field: "level"] } set { json[field: "level"] = newValue } }
  public var kind: NoticeLifetime? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var ttlMs: Int? { get { json[field: "ttl_ms"] } set { json[field: "ttl_ms"] = newValue } }
  public var key: String? { get { json[field: "key"] } set { json[field: "key"] = newValue } }
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
}

/// `notification.clear`: withdraw the notice with this key.
public struct NotificationClearPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var key: String? { get { json[field: "key"] } set { json[field: "key"] = newValue } }
}

// MARK: - Connector authorisation

/// `ConnectionTargetState` (`tools/connectors/contract.py::TargetState`).
public enum ConnectionTargetState: OpenStringEnum {
  case pending, initiated, connected, skipped, failed, expired
  case notConnected
  case unknown(String)

  public static let knownCases: [ConnectionTargetState] = [
    .pending, .initiated, .connected, .skipped, .failed, .expired, .notConnected
  ]

  public var rawValue: String {
    switch self {
    case .pending: "pending"
    case .initiated: "initiated"
    case .connected: "connected"
    case .skipped: "skipped"
    case .failed: "failed"
    case .expired: "expired"
    case .notConnected: "not_connected"
    case .unknown(let raw): raw
    }
  }

  /// A row nobody has to act on any more.
  public var isResolved: Bool {
    switch self {
    case .connected, .skipped, .failed, .expired: true
    default: false
    }
  }
}

/// `ConnectionSettleReason`: why an operation ended.
public enum ConnectionSettleReason: OpenStringEnum {
  case allResolved
  case `continue`
  case deadline, interrupt
  case unknown(String)

  public static let knownCases: [ConnectionSettleReason] = [.allResolved, .continue, .deadline, .interrupt]

  public var rawValue: String {
    switch self {
    case .allResolved: "all_resolved"
    case .continue: "continue"
    case .deadline: "deadline"
    case .interrupt: "interrupt"
    case .unknown(let raw): raw
    }
  }
}

/// One credential an MCP install still needs (`ConnectionTargetEnvField`).
public struct ConnectionTargetEnvField: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var required: Bool? { get { json[field: "required"] } set { json[field: "required"] = newValue } }
  public var secret: Bool? { get { json[field: "secret"] } set { json[field: "secret"] = newValue } }
  /// The wire's `default`.
  public var defaultValue: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
  public var prompt: String? { get { json[field: "prompt"] } set { json[field: "prompt"] = newValue } }
}

/// The catalog's security scan of a pinned commit (`CatalogScan`).
public struct CatalogScan: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var summary: String? { get { json[field: "summary"] } set { json[field: "summary"] = newValue } }
}

/// One row of a connection operation (`Target.snapshot`).
public struct ConnectionOperationTarget: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// `connector`, `mcp`, `plugin` or `skill`.
  public var kind: String? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  /// `authorize`, `connect`, `enable`, `install` or `reconnect`.
  public var action: String? { get { json[field: "action"] } set { json[field: "action"] = newValue } }
  public var state: ConnectionTargetState? { get { json[field: "state"] } set { json[field: "state"] = newValue } }
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
  public var instructions: String? { get { json[field: "instructions"] } set { json[field: "instructions"] = newValue } }
  public var discoveryError: String? {
    get { json[field: "discovery_error"] }
    set { json[field: "discovery_error"] = newValue }
  }
  /// The authorisation link, minted up front. Untrusted: validate before opening.
  public var connectURL: String? { get { json[field: "connect_url"] } set { json[field: "connect_url"] = newValue } }
  public var connectionID: String? { get { json[field: "connection_id"] } set { json[field: "connection_id"] = newValue } }
  public var attempt: String? { get { json[field: "attempt"] } set { json[field: "attempt"] = newValue } }
  public var requiredEnv: [ConnectionTargetEnvField]? {
    get { json[field: "required_env"] }
    set { json[field: "required_env"] = newValue }
  }
  public var tools: [String]? { get { json[field: "tools"] } set { json[field: "tools"] = newValue } }
  public var hint: String? { get { json[field: "hint"] } set { json[field: "hint"] = newValue } }
  public var display: String? { get { json[field: "display"] } set { json[field: "display"] = newValue } }
  /// The catalog row's `description` (`description` itself is the canonical text, as on every view).
  public var targetDescription: String? { get { json[field: "description"] } set { json[field: "description"] = newValue } }
  public var tier: String? { get { json[field: "tier"] } set { json[field: "tier"] = newValue } }
  public var platforms: [String]? { get { json[field: "platforms"] } set { json[field: "platforms"] = newValue } }
  public var repo: String? { get { json[field: "repo"] } set { json[field: "repo"] = newValue } }
  public var sha: String? { get { json[field: "sha"] } set { json[field: "sha"] = newValue } }
  public var subdir: String? { get { json[field: "subdir"] } set { json[field: "subdir"] = newValue } }
  public var scan: CatalogScan? { get { json[field: "scan"] } set { json[field: "scan"] = newValue } }
  public var requirements: [String]? { get { json[field: "requirements"] } set { json[field: "requirements"] = newValue } }
  public var hasDesktopHalf: Bool? {
    get { json[field: "has_desktop_half"] }
    set { json[field: "has_desktop_half"] = newValue }
  }
  public var targetProfile: String? { get { json[field: "target_profile"] } set { json[field: "target_profile"] = newValue } }
  public var appState: String? { get { json[field: "app_state"] } set { json[field: "app_state"] = newValue } }
  public var skill: String? { get { json[field: "skill"] } set { json[field: "skill"] = newValue } }
}

/// `connection.request`, and the `pending_connection` of a resume: a connection operation opened
/// on the session, with the server's deadline.
public struct ConnectionRequestPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var opID: String? { get { json[field: "op_id"] } set { json[field: "op_id"] = newValue } }
  /// The operation's own write counter: a frame whose `seq` is not higher than the one held is older.
  public var seq: Int? { get { json[field: "seq"] } set { json[field: "seq"] = newValue } }
  /// Unix seconds.
  public var deadlineAt: Double? { get { json[field: "deadline_at"] } set { json[field: "deadline_at"] = newValue } }
  public var timeoutSeconds: Double? {
    get { json[field: "timeout_seconds"] }
    set { json[field: "timeout_seconds"] = newValue }
  }
  public var targets: [ConnectionOperationTarget]? { get { json[field: "targets"] } set { json[field: "targets"] = newValue } }
  public var toolCallID: String? { get { json[field: "tool_call_id"] } set { json[field: "tool_call_id"] = newValue } }
}

/// `ConnectorOwner`: `{type: "session", session_id}` or `{type: "account"}`.
public struct ConnectorOwner: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// A session-owned operation, named by the RUNTIME session id.
  public init(sessionID: String) {
    self.init(json: ["type": "session", "session_id": .string(sessionID)])
  }

  public var type: String? { get { json[field: "type"] } set { json[field: "type"] = newValue } }
  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
}

/// `connection.update`: one target transition (`target`/`from`/`to`/`actor`) or the settlement,
/// each with the operation's full snapshot.
public struct ConnectionUpdatePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var opID: String? { get { json[field: "op_id"] } set { json[field: "op_id"] = newValue } }
  public var seq: Int? { get { json[field: "seq"] } set { json[field: "seq"] = newValue } }
  public var deadlineAt: Double? { get { json[field: "deadline_at"] } set { json[field: "deadline_at"] = newValue } }
  public var settled: Bool? { get { json[field: "settled"] } set { json[field: "settled"] = newValue } }
  public var settledAt: Double? { get { json[field: "settled_at"] } set { json[field: "settled_at"] = newValue } }
  public var settledBy: ConnectionSettleReason? {
    get { json[field: "settled_by"] }
    set { json[field: "settled_by"] = newValue }
  }
  public var targets: [ConnectionOperationTarget]? { get { json[field: "targets"] } set { json[field: "targets"] = newValue } }
  public var owner: ConnectorOwner? { get { json[field: "owner"] } set { json[field: "owner"] = newValue } }
  public var target: String? { get { json[field: "target"] } set { json[field: "target"] = newValue } }
  /// The wire's `from`.
  public var fromState: ConnectionTargetState? { get { json[field: "from"] } set { json[field: "from"] = newValue } }
  public var to: ConnectionTargetState? { get { json[field: "to"] } set { json[field: "to"] = newValue } }
  /// `user`, `backend_watcher` or `clock`.
  public var actor: String? { get { json[field: "actor"] } set { json[field: "actor"] = newValue } }
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
}

/// One row's answer from the card (`ConnectionAnswerTarget`).
public struct ConnectionAnswerTarget: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(name: String, status: String) {
    self.init(json: ["name": .string(name), "status": .string(status)])
  }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// `approved` or `skipped`.
  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
}

/// The card's answer: per-target outcomes and an optional Continue (`ConnectionAnswer`).
public struct ConnectionAnswer: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var targets: [ConnectionAnswerTarget]? { get { json[field: "targets"] } set { json[field: "targets"] = newValue } }
  public var settledBy: ConnectionSettleReason? {
    get { json[field: "settled_by"] }
    set { json[field: "settled_by"] = newValue }
  }
}

/// `connection.respond` params.
public struct ConnectionRespondParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var owner: ConnectorOwner? { get { json[field: "owner"] } set { json[field: "owner"] = newValue } }
  public var opID: String? { get { json[field: "op_id"] } set { json[field: "op_id"] = newValue } }
  public var result: ConnectionAnswer? { get { json[field: "result"] } set { json[field: "result"] = newValue } }
}

/// `connection.respond` result.
public struct ConnectionRespondResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var settled: Bool? { get { json[field: "settled"] } set { json[field: "settled"] = newValue } }
}

// MARK: - Session lifecycle

/// `ResumePhaseStatus`.
public enum ResumePhaseStatus: OpenStringEnum {
  case loading, complete, failed
  case unknown(String)

  public static let knownCases: [ResumePhaseStatus] = [.loading, .complete, .failed]

  public var rawValue: String {
    switch self {
    case .loading: "loading"
    case .complete: "complete"
    case .failed: "failed"
    case .unknown(let raw): raw
    }
  }
}

/// `session.resume_progress`: a deferred resume loading its transcript off the response path
/// (`server._schedule_resume_hydration`).
public struct SessionResumeProgressPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `history` today.
  public var phase: String? { get { json[field: "phase"] } set { json[field: "phase"] = newValue } }
  public var status: ResumePhaseStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  /// On `complete`: how many rows the resumed transcript has.
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
  /// On `failed`: why.
  public var message: String? { get { json[field: "message"] } set { json[field: "message"] = newValue } }
}

/// `SessionControlSnapshot`: a live session's goal / loop / heartbeat state. The three parts keep
/// the shapes their own state files own, so they stay raw.
public struct SessionControlSnapshot: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var goal: JSONValue? { get { json["goal"] } set { json["goal"] = newValue } }
  public var loop: JSONValue? { get { json["loop"] } set { json["loop"] = newValue } }
  public var heartbeat: JSONValue? { get { json["heartbeat"] } set { json["heartbeat"] = newValue } }
  /// A hash of the visible state, `""` when empty.
  public var revision: String? { get { json[field: "revision"] } set { json[field: "revision"] = newValue } }
  public var updatedAt: Double? { get { json[field: "updated_at"] } set { json[field: "updated_at"] = newValue } }
}

/// `session.control.update`: the persisted goal / loop / heartbeat state changed.
public struct SessionControlUpdatePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var control: SessionControlSnapshot? { get { json[field: "control"] } set { json[field: "control"] = newValue } }
}

// MARK: - Methods

/// `gateway.capabilities` result: what THIS gateway build enforces. A client withholds a feature
/// unless it is advertised. `per_message_author` is answered by the gateway process
/// (`tui_gateway/methods_voice.py`) but not yet in the generated TypeScript contract.
public struct GatewayCapabilitiesResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var perSessionExclusiveSubmit: Bool? {
    get { json[field: "per_session_exclusive_submit"] }
    set { json[field: "per_session_exclusive_submit"] = newValue }
  }
  /// The gateway stamps who submitted a turn on its user row (`display_metadata.author`).
  /// Absent on a gateway whose running process does not stamp.
  public var perMessageAuthor: Bool? {
    get { json[field: "per_message_author"] }
    set { json[field: "per_message_author"] = newValue }
  }
}

/// `session.status` result: the TUI's `/status` report, as text.
public struct SessionStatusResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var output: String? { get { json[field: "output"] } set { json[field: "output"] = newValue } }
}

extension SessionResumeResult {
  /// `pending_connection`, typed: the open connection operation, so a client that missed the
  /// `connection.request` restores the card with the server's deadline.
  public var pendingConnectionRequest: ConnectionRequestPayload? {
    get { json[field: "pending_connection"] }
    set { json[field: "pending_connection"] = newValue }
  }
}
