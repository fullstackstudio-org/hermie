import Foundation

// Event payloads, as `packages/hermes-shared/src/gateway-contract.generated.ts` declares them
// (fields the fake gateway or this client adds are marked). Typed views; see `JSONBacked.swift`.

/// A payload with no fields of its own (`message.start`, `sessions.changed`, `cron.changed`).
public struct EmptyPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
}

/// `message.delta`, `reasoning.delta`, `reasoning.available`, `thinking.delta`.
public struct StreamDeltaPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var rendered: String? { get { json[field: "rendered"] } set { json[field: "rendered"] = newValue } }
  /// Rides only when the session's verbose reasoning mode is on.
  public var verbose: Bool? { get { json[field: "verbose"] } set { json[field: "verbose"] = newValue } }
}

/// `message.interim`: commentary beside tool calls, sealed as its own segment.
public struct MessageInterimPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var alreadyStreamed: Bool? {
    get { json[field: "already_streamed"] }
    set { json[field: "already_streamed"] = newValue }
  }
}

/// `prompt_turn._result_status`.
public enum TurnStatus: OpenStringEnum {
  case complete, error, interrupted
  case unknown(String)

  public static let knownCases: [TurnStatus] = [.complete, .error, .interrupted]

  public var rawValue: String {
    switch self {
    case .complete: "complete"
    case .error: "error"
    case .interrupted: "interrupted"
    case .unknown(let raw): raw
    }
  }
}

/// `message.complete`: the turn ended.
public struct MessageCompletePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The final text when it is a string (upstream types it `string | unknown`; the raw value
  /// stays in `json["text"]`).
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var usage: Usage? { get { json[field: "usage"] } set { json[field: "usage"] = newValue } }
  public var status: TurnStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var reasoning: String? { get { json[field: "reasoning"] } set { json[field: "reasoning"] = newValue } }
  public var warning: String? { get { json[field: "warning"] } set { json[field: "warning"] = newValue } }
  public var responsePreviewed: Bool? {
    get { json[field: "response_previewed"] }
    set { json[field: "response_previewed"] = newValue }
  }
  /// `BillingBlock`, kept raw.
  public var billing: JSONValue? { get { json["billing"] } set { json["billing"] = newValue } }
  public var failureReason: String? {
    get { json[field: "failure_reason"] }
    set { json[field: "failure_reason"] = newValue }
  }
  public var rendered: String? { get { json[field: "rendered"] } set { json[field: "rendered"] = newValue } }
  public var error: String? { get { json[field: "error"] } set { json[field: "error"] = newValue } }
  public var recoverable: Bool? { get { json[field: "recoverable"] } set { json[field: "recoverable"] = newValue } }
  public var errorSurface: ErrorSurface? {
    get { json[field: "error_surface"] }
    set { json[field: "error_surface"] = newValue }
  }
  public var partial: Bool? { get { json[field: "partial"] } set { json[field: "partial"] = newValue } }
}

/// `agent/error_surface.py::_surface`: advisory `{layer, code, retryable}`.
public struct ErrorSurface: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var layer: String? { get { json[field: "layer"] } set { json[field: "layer"] = newValue } }
  public var code: String? { get { json[field: "code"] } set { json[field: "code"] = newValue } }
  public var retryable: Bool? { get { json[field: "retryable"] } set { json[field: "retryable"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
}

/// Token and context accounting (`Usage`), on `message.complete`, `session.usage`, `session.info`.
public struct Usage: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var input: Int? { get { json[field: "input"] } set { json[field: "input"] = newValue } }
  public var output: Int? { get { json[field: "output"] } set { json[field: "output"] = newValue } }
  public var reasoning: Int? { get { json[field: "reasoning"] } set { json[field: "reasoning"] = newValue } }
  public var prompt: Int? { get { json[field: "prompt"] } set { json[field: "prompt"] = newValue } }
  public var completion: Int? { get { json[field: "completion"] } set { json[field: "completion"] = newValue } }
  public var total: Int? { get { json[field: "total"] } set { json[field: "total"] = newValue } }
  public var calls: Int? { get { json[field: "calls"] } set { json[field: "calls"] = newValue } }
  public var compressions: Int? { get { json[field: "compressions"] } set { json[field: "compressions"] = newValue } }
  public var contextUsed: Int? { get { json[field: "context_used"] } set { json[field: "context_used"] = newValue } }
  public var contextMax: Int? { get { json[field: "context_max"] } set { json[field: "context_max"] = newValue } }
  public var contextPercent: Double? {
    get { json[field: "context_percent"] }
    set { json[field: "context_percent"] = newValue }
  }
  public var contextSource: String? {
    get { json[field: "context_source"] }
    set { json[field: "context_source"] = newValue }
  }
  public var contextEstimated: Bool? {
    get { json[field: "context_estimated"] }
    set { json[field: "context_estimated"] = newValue }
  }
  public var cacheHitPct: Double? { get { json[field: "cache_hit_pct"] } set { json[field: "cache_hit_pct"] = newValue } }
  public var cacheRead: Int? { get { json[field: "cache_read"] } set { json[field: "cache_read"] = newValue } }
  public var cacheWrite: Int? { get { json[field: "cache_write"] } set { json[field: "cache_write"] = newValue } }
  public var avgLatencyS: Double? { get { json[field: "avg_latency_s"] } set { json[field: "avg_latency_s"] = newValue } }
  public var avgTps: Double? { get { json[field: "avg_tps"] } set { json[field: "avg_tps"] = newValue } }
  public var activeSubagents: Int? {
    get { json[field: "active_subagents"] }
    set { json[field: "active_subagents"] = newValue }
  }
  public var devCreditsSpentMicros: Int? {
    get { json[field: "dev_credits_spent_micros"] }
    set { json[field: "dev_credits_spent_micros"] = newValue }
  }
  public var costUSD: Double? { get { json[field: "cost_usd"] } set { json[field: "cost_usd"] = newValue } }
  public var costStatus: String? { get { json[field: "cost_status"] } set { json[field: "cost_status"] = newValue } }
}

/// One emoji reaction on a persisted row (`MessageReaction`).
public struct MessageReaction: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var emoji: String? { get { json[field: "emoji"] } set { json[field: "emoji"] = newValue } }
  public var author: String? { get { json[field: "author"] } set { json[field: "author"] = newValue } }
  public var at: Double? { get { json[field: "at"] } set { json[field: "at"] = newValue } }
  public var seen: Bool? { get { json[field: "seen"] } set { json[field: "seen"] = newValue } }
}

/// `message.reaction`: the agent reacted to a persisted row.
public struct MessageReactionPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var rowID: Int? { get { json[field: "row_id"] } set { json[field: "row_id"] = newValue } }
  public var reactions: [MessageReaction]? { get { json[field: "reactions"] } set { json[field: "reactions"] = newValue } }
  public var role: String? { get { json[field: "role"] } set { json[field: "role"] = newValue } }
}

/// `tool.generating`: the model is writing a tool call's arguments.
public struct ToolGeneratingPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
}

/// `tool.start`.
public struct ToolStartPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var toolID: String? { get { json[field: "tool_id"] } set { json[field: "tool_id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// The gateway's ~80 character call preview.
  public var context: String? { get { json[field: "context"] } set { json[field: "context"] = newValue } }
  public var args: JSONObject? { get { json[field: "args"] } set { json[field: "args"] = newValue } }
  public var argsText: String? { get { json[field: "args_text"] } set { json[field: "args_text"] = newValue } }
  public var preview: String? { get { json[field: "preview"] } set { json[field: "preview"] = newValue } }
}

/// `tool.complete`.
public struct ToolCompletePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var toolID: String? { get { json[field: "tool_id"] } set { json[field: "tool_id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var args: JSONObject? { get { json[field: "args"] } set { json[field: "args"] = newValue } }
  public var durationS: Double? { get { json[field: "duration_s"] } set { json[field: "duration_s"] = newValue } }
  /// The parsed tool result, any shape.
  public var result: JSONValue? { get { json["result"] } set { json["result"] = newValue } }
  public var summary: String? { get { json[field: "summary"] } set { json[field: "summary"] = newValue } }
  public var resultText: String? { get { json[field: "result_text"] } set { json[field: "result_text"] = newValue } }
  public var inlineDiff: String? { get { json[field: "inline_diff"] } set { json[field: "inline_diff"] = newValue } }
  public var todos: [JSONValue]? { get { json[field: "todos"] } set { json[field: "todos"] = newValue } }
  public var revision: Int? { get { json[field: "revision"] } set { json[field: "revision"] = newValue } }
  /// Not in the upstream contract; the reference reads it as a failure flag (`Boolean(payload.error)`).
  public var error: JSONValue? { get { json["error"] } set { json["error"] = newValue } }
}

/// `tool.output_risk`.
public struct ToolOutputRiskPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var toolID: String? { get { json[field: "tool_id"] } set { json[field: "tool_id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var risk: String? { get { json[field: "risk"] } set { json[field: "risk"] = newValue } }
  public var findings: [String]? { get { json[field: "findings"] } set { json[field: "findings"] = newValue } }
  public var redacted: Bool? { get { json[field: "redacted"] } set { json[field: "redacted"] = newValue } }
}

/// `SubagentStatus`.
public enum SubagentStatus: OpenStringEnum {
  case queued, running, completed, failed, error, timeout, interrupted
  case unknown(String)

  public static let knownCases: [SubagentStatus] = [.queued, .running, .completed, .failed, .error, .timeout, .interrupted]

  public var rawValue: String {
    switch self {
    case .queued: "queued"
    case .running: "running"
    case .completed: "completed"
    case .failed: "failed"
    case .error: "error"
    case .timeout: "timeout"
    case .interrupted: "interrupted"
    case .unknown(let raw): raw
    }
  }
}

/// One `output_tail` row of a finished child.
public struct SubagentOutputTailEntry: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var tool: String? { get { json[field: "tool"] } set { json[field: "tool"] = newValue } }
  public var preview: String? { get { json[field: "preview"] } set { json[field: "preview"] = newValue } }
  public var isError: Bool? { get { json[field: "is_error"] } set { json[field: "is_error"] = newValue } }
}

/// Every `subagent.*` frame (`tool_progress._progress_subagent`).
public struct SubagentEventPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var goal: String? { get { json[field: "goal"] } set { json[field: "goal"] = newValue } }
  public var taskCount: Int? { get { json[field: "task_count"] } set { json[field: "task_count"] = newValue } }
  public var taskIndex: Int? { get { json[field: "task_index"] } set { json[field: "task_index"] = newValue } }
  public var subagentID: String? { get { json[field: "subagent_id"] } set { json[field: "subagent_id"] = newValue } }
  /// `null` for a child the turn itself spawned (depth 1); `.value` reads it as a `String?`.
  public var parentID: Nullable<String>? { get { json[field: "parent_id"] } set { json[field: "parent_id"] = newValue } }
  public var childSessionID: String? {
    get { json[field: "child_session_id"] }
    set { json[field: "child_session_id"] = newValue }
  }
  public var delegationID: String? { get { json[field: "delegation_id"] } set { json[field: "delegation_id"] = newValue } }
  public var depth: Int? { get { json[field: "depth"] } set { json[field: "depth"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var toolCount: Int? { get { json[field: "tool_count"] } set { json[field: "tool_count"] = newValue } }
  public var toolsets: [String]? { get { json[field: "toolsets"] } set { json[field: "toolsets"] = newValue } }
  public var inputTokens: Int? { get { json[field: "input_tokens"] } set { json[field: "input_tokens"] = newValue } }
  public var outputTokens: Int? { get { json[field: "output_tokens"] } set { json[field: "output_tokens"] = newValue } }
  public var reasoningTokens: Int? {
    get { json[field: "reasoning_tokens"] }
    set { json[field: "reasoning_tokens"] = newValue }
  }
  public var apiCalls: Int? { get { json[field: "api_calls"] } set { json[field: "api_calls"] = newValue } }
  public var filesRead: [String]? { get { json[field: "files_read"] } set { json[field: "files_read"] = newValue } }
  public var filesWritten: [String]? { get { json[field: "files_written"] } set { json[field: "files_written"] = newValue } }
  public var outputTail: [SubagentOutputTailEntry]? {
    get { json[field: "output_tail"] }
    set { json[field: "output_tail"] = newValue }
  }
  public var toolName: String? { get { json[field: "tool_name"] } set { json[field: "tool_name"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var status: SubagentStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var summary: String? { get { json[field: "summary"] } set { json[field: "summary"] = newValue } }
  public var durationSeconds: Double? {
    get { json[field: "duration_seconds"] }
    set { json[field: "duration_seconds"] = newValue }
  }
  public var toolPreview: String? { get { json[field: "tool_preview"] } set { json[field: "tool_preview"] = newValue } }
  /// Not in the upstream contract; the reference's `toSubagent` reads it.
  public var error: JSONValue? { get { json["error"] } set { json["error"] = newValue } }
}

/// `status.update`: a transient one-liner (`kind`: status, lifecycle, compacting, goal, …).
public struct StatusUpdatePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var kind: String? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
}

/// `todo.updated`, and the `todo_state` of a resume snapshot.
public struct TodoUpdatedPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var todos: [JSONValue]? { get { json[field: "todos"] } set { json[field: "todos"] = newValue } }
  public var revision: Int? { get { json[field: "revision"] } set { json[field: "revision"] = newValue } }
}

/// `ProjectRef`.
public struct ProjectRef: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var slug: String? { get { json[field: "slug"] } set { json[field: "slug"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var primaryPath: String? { get { json[field: "primary_path"] } set { json[field: "primary_path"] = newValue } }
}

/// `McpServerStatus`, one row of `SessionLiveInfo.mcp_servers`.
public struct McpServerStatus: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var toolCount: Int? { get { json[field: "tool_count"] } set { json[field: "tool_count"] = newValue } }
  public var error: String? { get { json[field: "error"] } set { json[field: "error"] = newValue } }
}

/// `session.info`, and the `info` of create / resume / branch: the live session settings.
public struct SessionLiveInfo: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var reasoningEffort: String? {
    get { json[field: "reasoning_effort"] }
    set { json[field: "reasoning_effort"] = newValue }
  }
  public var serviceTier: String? { get { json[field: "service_tier"] } set { json[field: "service_tier"] = newValue } }
  public var fast: Bool? { get { json[field: "fast"] } set { json[field: "fast"] = newValue } }
  public var yolo: Bool? { get { json[field: "yolo"] } set { json[field: "yolo"] = newValue } }
  public var approvalMode: String? { get { json[field: "approval_mode"] } set { json[field: "approval_mode"] = newValue } }
  public var tools: [String: [String]]? { get { json[field: "tools"] } set { json[field: "tools"] = newValue } }
  public var skills: [String: [String]]? { get { json[field: "skills"] } set { json[field: "skills"] = newValue } }
  public var cwd: String? { get { json[field: "cwd"] } set { json[field: "cwd"] = newValue } }
  public var branch: String? { get { json[field: "branch"] } set { json[field: "branch"] = newValue } }
  public var project: ProjectRef? { get { json[field: "project"] } set { json[field: "project"] = newValue } }
  public var terminalBackend: String? {
    get { json[field: "terminal_backend"] }
    set { json[field: "terminal_backend"] = newValue }
  }
  public var personality: String? { get { json[field: "personality"] } set { json[field: "personality"] = newValue } }
  public var running: Bool? { get { json[field: "running"] } set { json[field: "running"] = newValue } }
  public var turnStartedAt: Double? {
    get { json[field: "turn_started_at"] }
    set { json[field: "turn_started_at"] = newValue }
  }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var storedSessionID: String? {
    get { json[field: "stored_session_id"] }
    set { json[field: "stored_session_id"] = newValue }
  }
  /// A number or a string upstream; kept raw.
  public var desktopContract: JSONValue? { get { json["desktop_contract"] } set { json["desktop_contract"] = newValue } }
  public var version: String? { get { json[field: "version"] } set { json[field: "version"] = newValue } }
  public var releaseDate: String? { get { json[field: "release_date"] } set { json[field: "release_date"] = newValue } }
  public var updateBehind: JSONValue? { get { json["update_behind"] } set { json["update_behind"] = newValue } }
  public var updateCommand: String? { get { json[field: "update_command"] } set { json[field: "update_command"] = newValue } }
  public var usage: Usage? { get { json[field: "usage"] } set { json[field: "usage"] = newValue } }
  public var profileName: String? { get { json[field: "profile_name"] } set { json[field: "profile_name"] = newValue } }
  public var mcpServers: [McpServerStatus]? { get { json[field: "mcp_servers"] } set { json[field: "mcp_servers"] = newValue } }
  public var systemPrompt: String? { get { json[field: "system_prompt"] } set { json[field: "system_prompt"] = newValue } }
  public var credentialWarning: String? {
    get { json[field: "credential_warning"] }
    set { json[field: "credential_warning"] = newValue }
  }
  public var lazy: Bool? { get { json[field: "lazy"] } set { json[field: "lazy"] = newValue } }
}

/// `session.title`: auto-titling renamed the session (`session_id` is the stored key).
public struct SessionTitlePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
}

/// `session.usage`: a mid-turn usage tick.
public struct SessionUsagePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var usage: Usage? { get { json[field: "usage"] } set { json[field: "usage"] = newValue } }
}

/// `session.reclaimed`: the backend took a live session away from its clients.
public struct SessionReclaimedPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var storedSessionID: String? {
    get { json[field: "stored_session_id"] }
    set { json[field: "stored_session_id"] = newValue }
  }
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
}

/// `request.cancel`: the backend withdrew an open server request (by transport or queue id).
public struct RequestCancelPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var method: String? { get { json[field: "method"] } set { json[field: "method"] = newValue } }
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
}

/// `background.complete` and `btw.complete`: a side agent finished.
public struct SideAgentCompletePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var taskID: String? { get { json[field: "task_id"] } set { json[field: "task_id"] = newValue } }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  /// `btw.complete` only.
  public var question: String? { get { json[field: "question"] } set { json[field: "question"] = newValue } }
}

/// `notice`. Upstream sends `message` only; `detail` and `noticeKind` are this client's own
/// additions, which the reference reads (only `noticeKind: "command"` means anything).
public struct NoticePayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var message: String? { get { json[field: "message"] } set { json[field: "message"] = newValue } }
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
  public var noticeKind: String? { get { json[field: "noticeKind"] } set { json[field: "noticeKind"] = newValue } }
}

/// `error`: a session-level failure outside a turn.
public struct ErrorPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var message: String? { get { json[field: "message"] } set { json[field: "message"] = newValue } }
}

/// `SkinPayload`: the resolved active skin, `{}` when the skin engine failed to load.
public struct SkinPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// The skin's `description` field (`description` itself is the canonical text, as on every view).
  public var skinDescription: String? { get { json[field: "description"] } set { json[field: "description"] = newValue } }
  public var colors: [String: String]? { get { json[field: "colors"] } set { json[field: "colors"] = newValue } }
  public var lightColors: [String: String]? { get { json[field: "light_colors"] } set { json[field: "light_colors"] = newValue } }
  public var darkColors: [String: String]? { get { json[field: "dark_colors"] } set { json[field: "dark_colors"] = newValue } }
  public var branding: [String: String]? { get { json[field: "branding"] } set { json[field: "branding"] = newValue } }
  public var bannerLogo: String? { get { json[field: "banner_logo"] } set { json[field: "banner_logo"] = newValue } }
  public var bannerHero: String? { get { json[field: "banner_hero"] } set { json[field: "banner_hero"] = newValue } }
  public var toolPrefix: String? { get { json[field: "tool_prefix"] } set { json[field: "tool_prefix"] = newValue } }
  public var helpHeader: String? { get { json[field: "help_header"] } set { json[field: "help_header"] = newValue } }
}

/// `gateway.ready`: the first frame of a connection.
public struct GatewayReadyPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var skin: SkinPayload? { get { json[field: "skin"] } set { json[field: "skin"] = newValue } }
  public var changeEvents: Bool? { get { json[field: "change_events"] } set { json[field: "change_events"] = newValue } }
  /// The server process identity; a change means every seq watermark is void.
  public var replayEpoch: String? { get { json[field: "replay_epoch"] } set { json[field: "replay_epoch"] = newValue } }
  /// `true` when the gateway answers `gateway.ping`, so the client may run the heartbeat.
  public var heartbeat: Bool? { get { json[field: "heartbeat"] } set { json[field: "heartbeat"] = newValue } }
}
