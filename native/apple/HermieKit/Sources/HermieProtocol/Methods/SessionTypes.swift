import Foundation

// Params and results of the chat-critical `session.*` and `prompt.*` methods.

/// One history row, in either shape a transport ships it: the RPC projection
/// (`session.history`, `session.resume` `messages`: `text`, `row_id`) and the REST row
/// (`GET /api/sessions/{id}/messages`: `content`, `id`). The reference's `TranscriptRow`;
/// also the seed rows `session.create` takes, which clients forward verbatim.
public struct TranscriptRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var role: String? { get { json[field: "role"] } set { json[field: "role"] = newValue } }
  /// RPC shape.
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  /// REST shape; any JSON (a string, or content parts).
  public var content: JSONValue? { get { json["content"] } set { json["content"] = newValue } }
  public var displayContent: JSONValue? { get { json["display_content"] } set { json["display_content"] = newValue } }
  public var displayKind: String? { get { json[field: "display_kind"] } set { json[field: "display_kind"] = newValue } }
  /// Any JSON; the reference validates it where it reads it (`author`, `display_text`).
  public var displayMetadata: JSONValue? { get { json["display_metadata"] } set { json["display_metadata"] = newValue } }
  /// Unix seconds.
  public var timestamp: Double? { get { json[field: "timestamp"] } set { json[field: "timestamp"] = newValue } }
  /// RPC shape: the durable `messages.id`.
  public var rowID: Int? { get { json[field: "row_id"] } set { json[field: "row_id"] = newValue } }
  /// REST shape: the durable `messages.id` (any JSON upstream).
  public var id: JSONValue? { get { json["id"] } set { json["id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var context: String? { get { json[field: "context"] } set { json[field: "context"] = newValue } }
  public var args: JSONObject? { get { json[field: "args"] } set { json[field: "args"] = newValue } }
  public var toolID: String? { get { json[field: "tool_id"] } set { json[field: "tool_id"] = newValue } }
  public var toolCallID: String? { get { json[field: "tool_call_id"] } set { json[field: "tool_call_id"] = newValue } }
  /// Tool rows: the persisted assistant row holding this call, and the call's position in its
  /// `tool_calls`. Absent when the gateway derived no call identity.
  public var callRowID: Int? { get { json[field: "call_row_id"] } set { json[field: "call_row_id"] = newValue } }
  public var callIndex: Int? { get { json[field: "call_index"] } set { json[field: "call_index"] = newValue } }
  public var reasoning: String? { get { json[field: "reasoning"] } set { json[field: "reasoning"] = newValue } }
  public var reasoningContent: String? {
    get { json[field: "reasoning_content"] }
    set { json[field: "reasoning_content"] = newValue }
  }
  public var reasoningDetails: JSONValue? { get { json["reasoning_details"] } set { json["reasoning_details"] = newValue } }
  public var codexMessageItems: JSONValue? {
    get { json["codex_message_items"] }
    set { json["codex_message_items"] = newValue }
  }
}

/// `session.create` params.
public struct SessionCreateParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var cols: Int? { get { json[field: "cols"] } set { json[field: "cols"] = newValue } }
  public var source: String? { get { json[field: "source"] } set { json[field: "source"] = newValue } }
  public var cwd: String? { get { json[field: "cwd"] } set { json[field: "cwd"] = newValue } }
  /// Seed transcript rows.
  public var messages: [TranscriptRow]? { get { json[field: "messages"] } set { json[field: "messages"] = newValue } }
  public var parentSessionID: String? {
    get { json[field: "parent_session_id"] }
    set { json[field: "parent_session_id"] = newValue }
  }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var reasoningEffort: String? {
    get { json[field: "reasoning_effort"] }
    set { json[field: "reasoning_effort"] = newValue }
  }
  public var fast: Bool? { get { json[field: "fast"] } set { json[field: "fast"] = newValue } }
  public var closeOnDisconnect: Bool? {
    get { json[field: "close_on_disconnect"] }
    set { json[field: "close_on_disconnect"] = newValue }
  }
  public var hidden: Bool? { get { json[field: "hidden"] } set { json[field: "hidden"] = newValue } }
  public var roomPlumbing: Bool? { get { json[field: "room_plumbing"] } set { json[field: "room_plumbing"] = newValue } }
  public var followProfileConfig: Bool? {
    get { json[field: "follow_profile_config"] }
    set { json[field: "follow_profile_config"] = newValue }
  }
}

/// `session.resume` params. `session_id` is the STORED id (or an exact title).
public struct SessionResumeParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, profile: String? = nil) {
    self.init()
    self.sessionID = sessionID
    self.profile = profile
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var cols: Int? { get { json[field: "cols"] } set { json[field: "cols"] = newValue } }
  public var source: String? { get { json[field: "source"] } set { json[field: "source"] = newValue } }
  public var lazy: Bool? { get { json[field: "lazy"] } set { json[field: "lazy"] = newValue } }
  public var deferHistory: Bool? { get { json[field: "defer_history"] } set { json[field: "defer_history"] = newValue } }
  public var omitMessages: Bool? { get { json[field: "omit_messages"] } set { json[field: "omit_messages"] = newValue } }
  public var eagerBuild: Bool? { get { json[field: "eager_build"] } set { json[field: "eager_build"] = newValue } }
  public var closeOnDisconnect: Bool? {
    get { json[field: "close_on_disconnect"] }
    set { json[field: "close_on_disconnect"] = newValue }
  }
}

/// The live (or retained failed) turn a reconnecting client rebuilds its bubbles from.
public struct InflightTurn: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var assistant: String? { get { json[field: "assistant"] } set { json[field: "assistant"] = newValue } }
  /// What `assistant` streamed after the last note delivered as `already_streamed`: the part no
  /// sealed note above already shows. Absent from a gateway that does not track it.
  public var assistantUnsealed: String? {
    get { json[field: "assistant_unsealed"] }
    set { json[field: "assistant_unsealed"] = newValue }
  }
  public var streaming: Bool? { get { json[field: "streaming"] } set { json[field: "streaming"] = newValue } }
  public var user: String? { get { json[field: "user"] } set { json[field: "user"] = newValue } }
  public var displayKind: String? { get { json[field: "display_kind"] } set { json[field: "display_kind"] = newValue } }
  public var displayMetadata: JSONObject? {
    get { json[field: "display_metadata"] }
    set { json[field: "display_metadata"] = newValue }
  }
  public var corrections: [String]? { get { json[field: "corrections"] } set { json[field: "corrections"] = newValue } }
  public var correctionOffsets: [Int]? {
    get { json[field: "correction_offsets"] }
    set { json[field: "correction_offsets"] = newValue }
  }
  public var error: String? { get { json[field: "error"] } set { json[field: "error"] = newValue } }
  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var recoverable: Bool? { get { json[field: "recoverable"] } set { json[field: "recoverable"] = newValue } }
  public var errorSurface: ErrorSurface? { get { json[field: "error_surface"] } set { json[field: "error_surface"] = newValue } }
}

/// A prompt parked behind the running turn, on a resume snapshot (`{user}`).
public struct QueuedPromptSnapshot: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var user: String? { get { json[field: "user"] } set { json[field: "user"] = newValue } }
}

/// A crash-interrupted turn scheduled to continue right after this resume.
public struct AutoContinue: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var attempt: Int? { get { json[field: "attempt"] } set { json[field: "attempt"] = newValue } }
  public var interruptedAt: Double? { get { json[field: "interrupted_at"] } set { json[field: "interrupted_at"] = newValue } }
}

/// The result of `session.resume` (and `session.create`, which carries a subset; and
/// `session.activate`): the runtime binding plus everything a reconnecting client rebuilds from.
public struct SessionResumeResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The RUNTIME id this attachment runs under.
  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var storedSessionID: String? {
    get { json[field: "stored_session_id"] }
    set { json[field: "stored_session_id"] = newValue }
  }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
  public var messages: [TranscriptRow]? { get { json[field: "messages"] } set { json[field: "messages"] = newValue } }
  public var info: SessionLiveInfo? { get { json[field: "info"] } set { json[field: "info"] = newValue } }
  public var resumed: String? { get { json[field: "resumed"] } set { json[field: "resumed"] = newValue } }
  public var sessionKey: String? { get { json[field: "session_key"] } set { json[field: "session_key"] = newValue } }
  public var messagesOmitted: Bool? {
    get { json[field: "messages_omitted"] }
    set { json[field: "messages_omitted"] = newValue }
  }
  public var hydrating: Bool? { get { json[field: "hydrating"] } set { json[field: "hydrating"] = newValue } }
  public var running: Bool? { get { json[field: "running"] } set { json[field: "running"] = newValue } }
  public var turnStartedAt: Double? {
    get { json[field: "turn_started_at"] }
    set { json[field: "turn_started_at"] = newValue }
  }
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var inflight: InflightTurn? { get { json[field: "inflight"] } set { json[field: "inflight"] = newValue } }
  public var queued: QueuedPromptSnapshot? { get { json[field: "queued"] } set { json[field: "queued"] = newValue } }
  public var pendingApproval: PendingApproval? {
    get { json[field: "pending_approval"] }
    set { json[field: "pending_approval"] = newValue }
  }
  /// Server requests still waiting on this session; re-deliver them as if live.
  public var openRequests: [ServerRequest]? { get { json[field: "open_requests"] } set { json[field: "open_requests"] = newValue } }
  /// `ConnectionRequestPayload`, kept raw.
  public var pendingConnection: JSONValue? {
    get { json["pending_connection"] }
    set { json["pending_connection"] = newValue }
  }
  public var todoState: TodoUpdatedPayload? { get { json[field: "todo_state"] } set { json[field: "todo_state"] = newValue } }
  public var autoContinue: AutoContinue? { get { json[field: "auto_continue"] } set { json[field: "auto_continue"] = newValue } }
}

/// `session.create` answers the core of a resume: `session_id`, `stored_session_id`,
/// `message_count`, `messages`, `info`.
public typealias SessionCreateResult = SessionResumeResult

/// `session.list` params.
public struct SessionListParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var limit: Int? { get { json[field: "limit"] } set { json[field: "limit"] = newValue } }
  public var includeHidden: Bool? { get { json[field: "include_hidden"] } set { json[field: "include_hidden"] = newValue } }
}

/// One `session.list` row (`_session_row_summary`).
public struct SessionListRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  /// Only on a title lookup that followed a compression lineage to its tip.
  public var resolvedID: String? { get { json[field: "resolved_id"] } set { json[field: "resolved_id"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var preview: String? { get { json[field: "preview"] } set { json[field: "preview"] = newValue } }
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
  public var source: String? { get { json[field: "source"] } set { json[field: "source"] = newValue } }
}

public struct SessionListResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessions: [SessionListRow]? { get { json[field: "sessions"] } set { json[field: "sessions"] = newValue } }
}

/// `session.history` result.
public struct SessionHistoryResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var count: Int? { get { json[field: "count"] } set { json[field: "count"] = newValue } }
  public var messages: [TranscriptRow]? { get { json[field: "messages"] } set { json[field: "messages"] = newValue } }
}

/// `session.events.since` params: replay everything after `last_seen`.
public struct SessionEventsSinceParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, lastSeen: Int) {
    self.init()
    self.sessionID = sessionID
    self.lastSeen = lastSeen
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var lastSeen: Int? { get { json[field: "last_seen"] } set { json[field: "last_seen"] = newValue } }
}

/// `session.events.since` result.
public struct SessionEventsSinceResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var events: [GatewayEvent]? { get { json[field: "events"] } set { json[field: "events"] = newValue } }
  public var latestSeq: Int? { get { json[field: "latest_seq"] } set { json[field: "latest_seq"] = newValue } }
  public var truncated: Bool? { get { json[field: "truncated"] } set { json[field: "truncated"] = newValue } }
  public var count: Int? { get { json[field: "count"] } set { json[field: "count"] = newValue } }
  /// The server process identity; compare with `gateway.ready`'s `replay_epoch`.
  public var epoch: String? { get { json[field: "epoch"] } set { json[field: "epoch"] = newValue } }
  public var openRequests: [ServerRequest]? { get { json[field: "open_requests"] } set { json[field: "open_requests"] = newValue } }
}

/// `prompt.submit` params.
public struct PromptSubmitParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, text: String) {
    self.init()
    self.sessionID = sessionID
    self.text = text
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  /// The prompt when it is a string (upstream types it `unknown`; the raw value stays in `json`).
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var displayKind: String? { get { json[field: "display_kind"] } set { json[field: "display_kind"] = newValue } }
  public var interrupted: Bool? { get { json[field: "interrupted"] } set { json[field: "interrupted"] = newValue } }
  public var queued: Bool? { get { json[field: "queued"] } set { json[field: "queued"] = newValue } }
  public var surface: String? { get { json[field: "surface"] } set { json[field: "surface"] = newValue } }
  public var voiceContext: String? { get { json[field: "voice_context"] } set { json[field: "voice_context"] = newValue } }
  public var titlePreview: String? { get { json[field: "title_preview"] } set { json[field: "title_preview"] = newValue } }
  public var truncateBeforeUserOrdinal: Int? {
    get { json[field: "truncate_before_user_ordinal"] }
    set { json[field: "truncate_before_user_ordinal"] = newValue }
  }
  public var truncateBeforeRowID: Int? {
    get { json[field: "truncate_before_row_id"] }
    set { json[field: "truncate_before_row_id"] = newValue }
  }
  public var truncateBeforeMessageID: String? {
    get { json[field: "truncate_before_message_id"] }
    set { json[field: "truncate_before_message_id"] = newValue }
  }
  public var confirmTruncate: Bool? { get { json[field: "confirm_truncate"] } set { json[field: "confirm_truncate"] = newValue } }
  public var confirmEmptyTruncate: Bool? {
    get { json[field: "confirm_empty_truncate"] }
    set { json[field: "confirm_empty_truncate"] = newValue }
  }
  public var rebindSurvivorRowIDs: [Int]? {
    get { json[field: "rebind_survivor_row_ids"] }
    set { json[field: "rebind_survivor_row_ids"] = newValue }
  }
}

/// `PromptSubmitStatus`.
public enum PromptSubmitStatus: OpenStringEnum {
  case streaming, queued, steered, redirected
  case unknown(String)

  public static let knownCases: [PromptSubmitStatus] = [.streaming, .queued, .steered, .redirected]

  public var rawValue: String {
    switch self {
    case .streaming: "streaming"
    case .queued: "queued"
    case .steered: "steered"
    case .redirected: "redirected"
    case .unknown(let raw): raw
    }
  }
}

/// `prompt.submit` result.
public struct PromptSubmitResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: PromptSubmitStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var voiceStopped: Bool? { get { json[field: "voice_stopped"] } set { json[field: "voice_stopped"] = newValue } }
  /// Raw: elements may be `null`.
  public var survivorUserRowIDs: JSONValue? {
    get { json["survivor_user_row_ids"] }
    set { json["survivor_user_row_ids"] = newValue }
  }
  /// Raw: values may be `null`.
  public var survivorRowIDMap: JSONValue? { get { json["survivor_row_id_map"] } set { json["survivor_row_id_map"] = newValue } }
  public var turnIsolation: Bool? { get { json[field: "turn_isolation"] } set { json[field: "turn_isolation"] = newValue } }
}

/// `session.interrupt` params.
public struct SessionInterruptParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String) {
    self.init()
    self.sessionID = sessionID
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var expectedHostedTaskID: String? {
    get { json[field: "expected_hosted_task_id"] }
    set { json[field: "expected_hosted_task_id"] = newValue }
  }
}

/// `InterruptStatus`.
public enum InterruptStatus: OpenStringEnum {
  case interrupted
  case notInterrupted
  case unknown(String)

  public static let knownCases: [InterruptStatus] = [.interrupted, .notInterrupted]

  public var rawValue: String {
    switch self {
    case .interrupted: "interrupted"
    case .notInterrupted: "not_interrupted"
    case .unknown(let raw): raw
    }
  }
}

public struct SessionInterruptResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: InterruptStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var interrupted: Bool? { get { json[field: "interrupted"] } set { json[field: "interrupted"] = newValue } }
  public var turnIsolation: Bool? { get { json[field: "turn_isolation"] } set { json[field: "turn_isolation"] = newValue } }
}

/// `session.steer` (and `session.redirect`) params: `SessionCorrectionParams`.
public struct SessionCorrectionParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, text: String) {
    self.init()
    self.sessionID = sessionID
    self.text = text
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
}

/// `CorrectionStatus`.
public enum CorrectionStatus: OpenStringEnum {
  case queued, redirected, rejected
  case unknown(String)

  public static let knownCases: [CorrectionStatus] = [.queued, .redirected, .rejected]

  public var rawValue: String {
    switch self {
    case .queued: "queued"
    case .redirected: "redirected"
    case .rejected: "rejected"
    case .unknown(let raw): raw
    }
  }
}

public struct SessionCorrectionResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: CorrectionStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
}

/// `image.attach_bytes` params: the bytes travel base64 in `content_base64` (or `data`).
public struct ImageAttachBytesParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var contentBase64: String? { get { json[field: "content_base64"] } set { json[field: "content_base64"] = newValue } }
  public var data: String? { get { json[field: "data"] } set { json[field: "data"] = newValue } }
  public var filename: String? { get { json[field: "filename"] } set { json[field: "filename"] = newValue } }
  public var ext: String? { get { json[field: "ext"] } set { json[field: "ext"] = newValue } }
}

/// `image.attach_bytes` result (`AttachedImageResult`).
public struct AttachedImageResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var attached: Bool? { get { json[field: "attached"] } set { json[field: "attached"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var width: Int? { get { json[field: "width"] } set { json[field: "width"] = newValue } }
  public var height: Int? { get { json[field: "height"] } set { json[field: "height"] = newValue } }
  public var tokenEstimate: Int? { get { json[field: "token_estimate"] } set { json[field: "token_estimate"] = newValue } }
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  public var count: Int? { get { json[field: "count"] } set { json[field: "count"] = newValue } }
  public var remainder: String? { get { json[field: "remainder"] } set { json[field: "remainder"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var bytes: Int? { get { json[field: "bytes"] } set { json[field: "bytes"] = newValue } }
  public var message: String? { get { json[field: "message"] } set { json[field: "message"] = newValue } }
}

/// `session.title` params (`title` absent reads the current title).
public struct SessionTitleParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
}

public struct SessionTitleResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var sessionKey: String? { get { json[field: "session_key"] } set { json[field: "session_key"] = newValue } }
  public var pending: Bool? { get { json[field: "pending"] } set { json[field: "pending"] = newValue } }
}

/// `session.branch` params: start a new stored child from a LIVE session. `session_id` is the RUNTIME
/// id (a stored id answers 4001). `count` is how many of the parent's messages the child starts
/// with, counted from the start; absent, the whole history.
public struct SessionBranchParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, profile: String? = nil, name: String? = nil, count: Int? = nil) {
    self.init()
    self.sessionID = sessionID
    self.profile = profile
    self.name = name
    self.count = count
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var count: Int? { get { json[field: "count"] } set { json[field: "count"] = newValue } }
}

/// `session.branch` result: the child, live (`session_id`, runtime) and stored (`stored_session_id`,
/// the durable row a listing hands out). `title` is the one the gateway settled on, which is not the
/// one asked for when that name was already worn.
public struct SessionBranchResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var storedSessionID: String? {
    get { json[field: "stored_session_id"] }
    set { json[field: "stored_session_id"] = newValue }
  }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  /// The stored id of the session it was taken from.
  public var parent: String? { get { json[field: "parent"] } set { json[field: "parent"] = newValue } }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
  public var messages: [TranscriptRow]? { get { json[field: "messages"] } set { json[field: "messages"] = newValue } }
  public var info: SessionLiveInfo? { get { json[field: "info"] } set { json[field: "info"] = newValue } }
}

/// `session.set_hidden` params.
public struct SessionSetHiddenParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var hidden: Bool? { get { json[field: "hidden"] } set { json[field: "hidden"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
}

public struct SessionSetHiddenResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var hidden: Bool? { get { json[field: "hidden"] } set { json[field: "hidden"] = newValue } }
  public var sessionKey: String? { get { json[field: "session_key"] } set { json[field: "session_key"] = newValue } }
}

public struct SessionCloseResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var closed: Bool? { get { json[field: "closed"] } set { json[field: "closed"] = newValue } }
}

public struct SessionDeleteResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The stored id that was deleted.
  public var deleted: String? { get { json[field: "deleted"] } set { json[field: "deleted"] = newValue } }
}

/// `gateway.ping` result.
public struct PingResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var pong: Bool? { get { json[field: "pong"] } set { json[field: "pong"] = newValue } }
}

/// `client.capabilities` params: the client answers server→client requests.
public struct ClientCapabilitiesParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(serverRequests: Bool) {
    self.init()
    self.serverRequests = serverRequests
  }

  public var serverRequests: Bool? { get { json[field: "server_requests"] } set { json[field: "server_requests"] = newValue } }
}

public struct ClientCapabilitiesResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var serverRequests: [String]? { get { json[field: "server_requests"] } set { json[field: "server_requests"] = newValue } }
}
