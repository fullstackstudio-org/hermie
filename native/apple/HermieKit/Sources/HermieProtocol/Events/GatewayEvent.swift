import Foundation

/// One gateway event: the `params` of an `event` notification, and the element of
/// `session.events.since`'s `events`. `{type, payload?, session_id?, seq?}`.
///
/// The envelope is the lossless carrier (see `JSONBacked.swift`); `body` is its typed reading.
public struct GatewayEvent: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// An event with a typed body. The payload is written as the body's object.
  public init(_ body: GatewayEventBody, sessionID: String? = nil, seq: Int? = nil, turnID: String? = nil) {
    self.init()
    self.type = body.type
    self.payload = body.payload
    self.sessionID = sessionID
    self.seq = seq
    self.turnID = turnID
  }

  public var type: String {
    get { json[field: "type"] ?? "" }
    set { json[field: "type"] = newValue }
  }

  /// The raw payload, any shape, `nil` when absent.
  public var payload: JSONValue? {
    get { json["payload"] }
    set { json["payload"] = newValue }
  }

  /// Absent on session-less broadcasts (`gateway.ready`, `sessions.changed`, …).
  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }

  /// Per-session monotonic counter; absent on session-less broadcasts.
  public var seq: Int? { get { json[field: "seq"] } set { json[field: "seq"] = newValue } }

  /// The gateway's id for the turn this frame belongs to. It rides the ENVELOPE of every
  /// turn-stream frame (`message.*`, `reasoning.*`, `thinking.delta`, `tool.*`, `error`) while
  /// a turn runs, and is absent on every other event and from a gateway that mints none.
  public var turnID: String? { get { json[field: "turn_id"] } set { json[field: "turn_id"] = newValue } }

  /// The typed reading of `type` and `payload`. A known type whose payload is absent or not
  /// an object reads as that type with an empty payload (the reference's `rec(payload)`);
  /// the envelope still holds the payload exactly as it came.
  public var body: GatewayEventBody { GatewayEventBody(type: type, payload: payload) }
}

/// Event type names. `all` is every type `GatewayEventBody` reads into a typed case.
public enum GatewayEventType {
  public static let messageStart = "message.start"
  public static let messageDelta = "message.delta"
  public static let messageInterim = "message.interim"
  public static let messageComplete = "message.complete"
  public static let messageReaction = "message.reaction"
  public static let reasoningAvailable = "reasoning.available"
  public static let reasoningDelta = "reasoning.delta"
  public static let thinkingDelta = "thinking.delta"
  public static let toolGenerating = "tool.generating"
  public static let toolStart = "tool.start"
  public static let toolComplete = "tool.complete"
  public static let toolOutputRisk = "tool.output_risk"
  public static let subagentSpawnRequested = "subagent.spawn_requested"
  public static let subagentStart = "subagent.start"
  public static let subagentProgress = "subagent.progress"
  public static let subagentThinking = "subagent.thinking"
  public static let subagentTool = "subagent.tool"
  public static let subagentComplete = "subagent.complete"
  public static let statusUpdate = "status.update"
  public static let todoUpdated = "todo.updated"
  public static let sessionInfo = "session.info"
  public static let sessionTitle = "session.title"
  public static let sessionUsage = "session.usage"
  public static let sessionReclaimed = "session.reclaimed"
  public static let requestCancel = "request.cancel"
  public static let backgroundComplete = "background.complete"
  public static let btwComplete = "btw.complete"
  public static let notice = "notice"
  public static let error = "error"
  public static let gatewayReady = "gateway.ready"
  public static let sessionsChanged = "sessions.changed"
  public static let cronChanged = "cron.changed"
  public static let notificationShow = "notification.show"
  public static let notificationClear = "notification.clear"
  public static let connectionRequest = "connection.request"
  public static let connectionUpdate = "connection.update"
  public static let sessionResumeProgress = "session.resume_progress"
  public static let sessionControlUpdate = "session.control.update"

  public static let all: [String] = [
    messageStart, messageDelta, messageInterim, messageComplete, messageReaction, reasoningAvailable,
    reasoningDelta, thinkingDelta, toolGenerating, toolStart, toolComplete, toolOutputRisk,
    subagentSpawnRequested, subagentStart, subagentProgress, subagentThinking, subagentTool, subagentComplete,
    statusUpdate, todoUpdated, sessionInfo, sessionTitle, sessionUsage, sessionReclaimed, requestCancel,
    backgroundComplete, btwComplete, notice, error, gatewayReady, sessionsChanged, cronChanged,
    notificationShow, notificationClear, connectionRequest, connectionUpdate, sessionResumeProgress,
    sessionControlUpdate
  ]

  /// `all`, for a membership test.
  public static let known: Set<String> = Set(all)
}

/// Every event type the app consumes, with its typed payload, and `unknown` for the rest
/// (`moa.*`, `voice.*`, `preview.*`, a type added tomorrow), which keeps the raw payload.
///
/// The transcript engine reads events by their type name, not through this enum: the
/// session-layer cases (`notification.*`, `connection.*`, `session.resume_progress`,
/// `session.control.update`) are handled beside it and change nothing in a transcript.
///
/// `bot_dm_in`, `bot_dm_reply` and `cron_delivery` are not here on purpose: they never
/// travel on the wire. The transcript engine derives them from the text of `user` rows.
public enum GatewayEventBody: Sendable, Hashable {
  /// A turn began streaming. Upstream sends `{}`.
  case messageStart(EmptyPayload)
  case messageDelta(StreamDeltaPayload)
  case messageInterim(MessageInterimPayload)
  case messageComplete(MessageCompletePayload)
  case messageReaction(MessageReactionPayload)
  case reasoningAvailable(StreamDeltaPayload)
  case reasoningDelta(StreamDeltaPayload)
  case thinkingDelta(StreamDeltaPayload)
  case toolGenerating(ToolGeneratingPayload)
  case toolStart(ToolStartPayload)
  case toolComplete(ToolCompletePayload)
  case toolOutputRisk(ToolOutputRiskPayload)
  case subagentSpawnRequested(SubagentEventPayload)
  case subagentStart(SubagentEventPayload)
  case subagentProgress(SubagentEventPayload)
  case subagentThinking(SubagentEventPayload)
  case subagentTool(SubagentEventPayload)
  case subagentComplete(SubagentEventPayload)
  case statusUpdate(StatusUpdatePayload)
  case todoUpdated(TodoUpdatedPayload)
  case sessionInfo(SessionLiveInfo)
  case sessionTitle(SessionTitlePayload)
  case sessionUsage(SessionUsagePayload)
  case sessionReclaimed(SessionReclaimedPayload)
  case requestCancel(RequestCancelPayload)
  case backgroundComplete(SideAgentCompletePayload)
  case btwComplete(SideAgentCompletePayload)
  case notice(NoticePayload)
  case error(ErrorPayload)
  /// The first frame of every connection.
  case gatewayReady(GatewayReadyPayload)
  /// The session list moved; refetch it. Upstream sends `{}`.
  case sessionsChanged(EmptyPayload)
  /// The cron list moved; refetch it. Upstream sends `{}`.
  case cronChanged(EmptyPayload)
  /// An out-of-band notice; the session's notices, not the transcript.
  case notificationShow(NotificationShowPayload)
  case notificationClear(NotificationClearPayload)
  /// A connector authorisation card opened; the session's connection requests, not the transcript.
  case connectionRequest(ConnectionRequestPayload)
  case connectionUpdate(ConnectionUpdatePayload)
  /// A deferred resume loading its transcript.
  case sessionResumeProgress(SessionResumeProgressPayload)
  /// The goal / loop / heartbeat state changed.
  case sessionControlUpdate(SessionControlUpdatePayload)
  case unknown(type: String, payload: JSONValue?)

  public init(type: String, payload: JSONValue?) {
    let object = payload?.objectValue ?? [:]
    typealias T = GatewayEventType
    switch type {
    case T.messageStart: self = .messageStart(EmptyPayload(json: object))
    case T.messageDelta: self = .messageDelta(StreamDeltaPayload(json: object))
    case T.messageInterim: self = .messageInterim(MessageInterimPayload(json: object))
    case T.messageComplete: self = .messageComplete(MessageCompletePayload(json: object))
    case T.messageReaction: self = .messageReaction(MessageReactionPayload(json: object))
    case T.reasoningAvailable: self = .reasoningAvailable(StreamDeltaPayload(json: object))
    case T.reasoningDelta: self = .reasoningDelta(StreamDeltaPayload(json: object))
    case T.thinkingDelta: self = .thinkingDelta(StreamDeltaPayload(json: object))
    case T.toolGenerating: self = .toolGenerating(ToolGeneratingPayload(json: object))
    case T.toolStart: self = .toolStart(ToolStartPayload(json: object))
    case T.toolComplete: self = .toolComplete(ToolCompletePayload(json: object))
    case T.toolOutputRisk: self = .toolOutputRisk(ToolOutputRiskPayload(json: object))
    case T.subagentSpawnRequested: self = .subagentSpawnRequested(SubagentEventPayload(json: object))
    case T.subagentStart: self = .subagentStart(SubagentEventPayload(json: object))
    case T.subagentProgress: self = .subagentProgress(SubagentEventPayload(json: object))
    case T.subagentThinking: self = .subagentThinking(SubagentEventPayload(json: object))
    case T.subagentTool: self = .subagentTool(SubagentEventPayload(json: object))
    case T.subagentComplete: self = .subagentComplete(SubagentEventPayload(json: object))
    case T.statusUpdate: self = .statusUpdate(StatusUpdatePayload(json: object))
    case T.todoUpdated: self = .todoUpdated(TodoUpdatedPayload(json: object))
    case T.sessionInfo: self = .sessionInfo(SessionLiveInfo(json: object))
    case T.sessionTitle: self = .sessionTitle(SessionTitlePayload(json: object))
    case T.sessionUsage: self = .sessionUsage(SessionUsagePayload(json: object))
    case T.sessionReclaimed: self = .sessionReclaimed(SessionReclaimedPayload(json: object))
    case T.requestCancel: self = .requestCancel(RequestCancelPayload(json: object))
    case T.backgroundComplete: self = .backgroundComplete(SideAgentCompletePayload(json: object))
    case T.btwComplete: self = .btwComplete(SideAgentCompletePayload(json: object))
    case T.notice: self = .notice(NoticePayload(json: object))
    case T.error: self = .error(ErrorPayload(json: object))
    case T.gatewayReady: self = .gatewayReady(GatewayReadyPayload(json: object))
    case T.sessionsChanged: self = .sessionsChanged(EmptyPayload(json: object))
    case T.cronChanged: self = .cronChanged(EmptyPayload(json: object))
    case T.notificationShow: self = .notificationShow(NotificationShowPayload(json: object))
    case T.notificationClear: self = .notificationClear(NotificationClearPayload(json: object))
    case T.connectionRequest: self = .connectionRequest(ConnectionRequestPayload(json: object))
    case T.connectionUpdate: self = .connectionUpdate(ConnectionUpdatePayload(json: object))
    case T.sessionResumeProgress: self = .sessionResumeProgress(SessionResumeProgressPayload(json: object))
    case T.sessionControlUpdate: self = .sessionControlUpdate(SessionControlUpdatePayload(json: object))
    default: self = .unknown(type: type, payload: payload)
    }
  }

  public var type: String {
    typealias T = GatewayEventType
    switch self {
    case .messageStart: return T.messageStart
    case .messageDelta: return T.messageDelta
    case .messageInterim: return T.messageInterim
    case .messageComplete: return T.messageComplete
    case .messageReaction: return T.messageReaction
    case .reasoningAvailable: return T.reasoningAvailable
    case .reasoningDelta: return T.reasoningDelta
    case .thinkingDelta: return T.thinkingDelta
    case .toolGenerating: return T.toolGenerating
    case .toolStart: return T.toolStart
    case .toolComplete: return T.toolComplete
    case .toolOutputRisk: return T.toolOutputRisk
    case .subagentSpawnRequested: return T.subagentSpawnRequested
    case .subagentStart: return T.subagentStart
    case .subagentProgress: return T.subagentProgress
    case .subagentThinking: return T.subagentThinking
    case .subagentTool: return T.subagentTool
    case .subagentComplete: return T.subagentComplete
    case .statusUpdate: return T.statusUpdate
    case .todoUpdated: return T.todoUpdated
    case .sessionInfo: return T.sessionInfo
    case .sessionTitle: return T.sessionTitle
    case .sessionUsage: return T.sessionUsage
    case .sessionReclaimed: return T.sessionReclaimed
    case .requestCancel: return T.requestCancel
    case .backgroundComplete: return T.backgroundComplete
    case .btwComplete: return T.btwComplete
    case .notice: return T.notice
    case .error: return T.error
    case .gatewayReady: return T.gatewayReady
    case .sessionsChanged: return T.sessionsChanged
    case .cronChanged: return T.cronChanged
    case .notificationShow: return T.notificationShow
    case .notificationClear: return T.notificationClear
    case .connectionRequest: return T.connectionRequest
    case .connectionUpdate: return T.connectionUpdate
    case .sessionResumeProgress: return T.sessionResumeProgress
    case .sessionControlUpdate: return T.sessionControlUpdate
    case .unknown(let type, _): return type
    }
  }

  /// The payload as JSON: the typed payload's object, or the raw payload of `unknown`.
  public var payload: JSONValue? {
    switch self {
    case .messageStart(let p), .sessionsChanged(let p), .cronChanged(let p): p.jsonValue
    case .messageDelta(let p), .reasoningAvailable(let p), .reasoningDelta(let p), .thinkingDelta(let p): p.jsonValue
    case .messageInterim(let p): p.jsonValue
    case .messageComplete(let p): p.jsonValue
    case .messageReaction(let p): p.jsonValue
    case .toolGenerating(let p): p.jsonValue
    case .toolStart(let p): p.jsonValue
    case .toolComplete(let p): p.jsonValue
    case .toolOutputRisk(let p): p.jsonValue
    case .subagentSpawnRequested(let p), .subagentStart(let p), .subagentProgress(let p),
      .subagentThinking(let p), .subagentTool(let p), .subagentComplete(let p):
      p.jsonValue
    case .statusUpdate(let p): p.jsonValue
    case .todoUpdated(let p): p.jsonValue
    case .sessionInfo(let p): p.jsonValue
    case .sessionTitle(let p): p.jsonValue
    case .sessionUsage(let p): p.jsonValue
    case .sessionReclaimed(let p): p.jsonValue
    case .requestCancel(let p): p.jsonValue
    case .backgroundComplete(let p), .btwComplete(let p): p.jsonValue
    case .notice(let p): p.jsonValue
    case .error(let p): p.jsonValue
    case .gatewayReady(let p): p.jsonValue
    case .notificationShow(let p): p.jsonValue
    case .notificationClear(let p): p.jsonValue
    case .connectionRequest(let p): p.jsonValue
    case .connectionUpdate(let p): p.jsonValue
    case .sessionResumeProgress(let p): p.jsonValue
    case .sessionControlUpdate(let p): p.jsonValue
    case .unknown(_, let payload): payload
    }
  }

  public var isUnknown: Bool {
    if case .unknown = self { return true }
    return false
  }
}
