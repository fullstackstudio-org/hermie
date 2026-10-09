import HermieProtocol

// The transcript item kinds of `types.ts`, one struct each, every one the full
// TypeScript interface: the shared `ItemBase` fields (read straight off the struct
// through `TranscriptItemProtocol`), the kind's own fields, and `extra` for keys this
// build does not know. JSON keys are the TypeScript property names; Swift spells
// `Id` as `ID`.

// MARK: - user

/// Who the GATEWAY said wrote a row — never a guess.
///
/// Absent means nobody knows: the turn was unattributed (a crash continuation,
/// a wake, a cron, a bot delivery), the session's identity was ambiguous, or the
/// row predates the gateway writing this at all. An absent author must stay
/// absent; it is never inferred from `origin`, `pending`, or anything else the
/// client already believes about the item.
public struct MessageAuthor: TranscriptJSONCodable, Hashable {
  /// `<provider>:<user_id>` exactly as the gateway spelled it. The identity.
  public var id: String
  /// The gateway's own display name for them, when it sent one. Untrusted text.
  public var name: String?
  /// Present when an AGENT sent the row on this person's behalf (`display_metadata.author.via`):
  /// `id` and `name` are still the person's, and this says it was not the person typing. Absent for
  /// a person's own turn and from a gateway that does not stamp it. Clients draw `authorLabel`.
  public var via: AuthorVia?
  public var extra: JSONObject

  public init(id: String, name: String? = nil, via: AuthorVia? = nil, extra: JSONObject = [:]) {
    self.id = id
    self.name = name
    self.via = via
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "MessageAuthor")
    id = try reader.required("id")
    name = reader.optional("name")
    via = reader.optional("via")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("id", id)
    writer.set("name", name)
    writer.set("via", via)
    return writer.json
  }
}

/// What sent a row on somebody's behalf. `kind` is `"mcp"` today; a reader treats any kind alike.
public struct AuthorVia: TranscriptJSONCodable, Hashable {
  public var kind: String
  /// The agent's own name (`Example Agent`), cleaned to one line of at most 80 characters. Untrusted text.
  public var client: String
  public var extra: JSONObject

  public init(kind: String, client: String, extra: JSONObject = [:]) {
    self.kind = kind
    self.client = client
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "AuthorVia")
    kind = try reader.required("kind")
    client = try reader.required("client")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("kind", kind)
    writer.set("client", client)
    return writer.json
  }
}

/// A human turn (or the bot's own steer / skill invocation projection).
public struct UserItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.user
  public var base: ItemBase
  public var text: String
  /// The `@file:` / `@image:` REFERENCE strings this turn carries — never display
  /// names. One contract, whichever transport built the item:
  ///
  /// - a persisted row: the directives `stripUserText` lifted out of its text;
  /// - a local submit: the same directives, as `beginLocalTurn` projects them out
  ///   of the body it was handed — plus, for an image, a reference whose path
  ///   position holds only the file name, because `image.attach_bytes` takes the
  ///   bytes out of band and the gateway alone decides where they land.
  ///
  /// Everything else derives from this, and nothing stores a second copy: the chip
  /// name (`attachmentName` in the chat kit) and the reconciliation key
  /// (`attachmentsMatchKey`) both read the name off the reference.
  public var attachments: [String]?
  /// Pictures the turn held in its own text (a `data:image/…;base64,…` blob the gateway kept beside its
  /// `[Image attached at: …]` handle), lifted out by `stripUserText` so the text never shows them. Only
  /// blobs that decode (type, size, first bytes) are here; a handle or a blob that cannot be shown is an
  /// `attachments` reference instead.
  public var inlineImages: [InlineImage]?
  /// Submitted locally, not yet acknowledged by the gateway.
  public var pending: Bool?
  public var displayKind: UserDisplayKind?
  /// A foreign turn started before we know who spoke; filled by `reconcileTail`.
  public var unknownAuthor: Bool?
  /// Who the gateway says wrote this row. See `MessageAuthor` — absent, never guessed.
  public var author: MessageAuthor?
  /// Who pressed retry, when it was somebody other than the author (`display_metadata.replayed_by`),
  /// with `via` when that was an agent. The row stays its author's.
  public var replayedBy: MessageAuthor?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    text: String,
    attachments: [String]? = nil,
    inlineImages: [InlineImage]? = nil,
    pending: Bool? = nil,
    displayKind: UserDisplayKind? = nil,
    unknownAuthor: Bool? = nil,
    author: MessageAuthor? = nil,
    replayedBy: MessageAuthor? = nil,
    turnID: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.text = text
    self.attachments = attachments
    self.inlineImages = inlineImages
    self.pending = pending
    self.displayKind = displayKind
    self.unknownAuthor = unknownAuthor
    self.author = author
    self.replayedBy = replayedBy
    self.extra = extra
    if let turnID { self.base.turnID = turnID }
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "UserItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    text = try reader.required("text")
    attachments = reader.optional("attachments")
    inlineImages = reader.optional("inlineImages")
    pending = reader.optional("pending")
    displayKind = reader.optional("displayKind")
    unknownAuthor = reader.optional("unknownAuthor")
    author = reader.optional("author")
    replayedBy = reader.optional("replayedBy")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("text", text)
    writer.set("attachments", attachments)
    writer.set("inlineImages", inlineImages)
    writer.set("pending", pending)
    writer.set("displayKind", displayKind)
    writer.set("unknownAuthor", unknownAuthor)
    writer.set("author", author)
    writer.set("replayedBy", replayedBy)
    return writer.json
  }
}

// MARK: - bot_dm_in

/// An inbound bot-to-bot message: a `role:user` row that is NOT the human speaking.
public struct BotDmInItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.botDmIn
  public var base: ItemBase
  public var senderName: String
  public var senderHandle: String?
  public var text: String
  /// True when this chat dispatched a `message_agent` to that sender in the current exchange.
  public var answersOurDispatch: Bool?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    senderName: String,
    senderHandle: String? = nil,
    text: String,
    answersOurDispatch: Bool? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.senderName = senderName
    self.senderHandle = senderHandle
    self.text = text
    self.answersOurDispatch = answersOurDispatch
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "BotDmInItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    senderName = try reader.required("senderName")
    senderHandle = reader.optional("senderHandle")
    text = try reader.required("text")
    answersOurDispatch = reader.optional("answersOurDispatch")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("senderName", senderName)
    writer.set("senderHandle", senderHandle)
    writer.set("text", text)
    writer.set("answersOurDispatch", answersOurDispatch)
    return writer.json
  }
}

// MARK: - assistant

public struct AssistantFailure: TranscriptJSONCodable, Hashable {
  public var message: String
  /// `text` is streamed partial output worth keeping, not the error string.
  public var partial: Bool
  /// The backend retained the failed turn; a resume will replay it.
  public var recoverable: Bool?
  public var surface: ErrorSurface?
  public var extra: JSONObject

  public init(
    message: String,
    partial: Bool,
    recoverable: Bool? = nil,
    surface: ErrorSurface? = nil,
    extra: JSONObject = [:]
  ) {
    self.message = message
    self.partial = partial
    self.recoverable = recoverable
    self.surface = surface
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "AssistantFailure")
    message = try reader.required("message")
    partial = try reader.required("partial")
    recoverable = reader.optional("recoverable")
    surface = reader.optional("surface")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("message", message)
    writer.set("partial", partial)
    writer.set("recoverable", recoverable)
    writer.set("surface", surface)
    return writer.json
  }
}

public struct AssistantItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.assistant
  public var base: ItemBase
  public var text: String
  public var reasoning: String?
  public var reasoningVerbose: Bool?
  public var streaming: Bool
  /// Sealed mid-turn commentary: rendered without the turn's action footer.
  public var interim: Bool
  public var status: AssistantStatus?
  public var error: AssistantFailure?
  public var usage: Usage?
  public var durationS: Double?
  /// Set when this reply answers an inbound DM rather than the human.
  public var replyToBotHandle: String?
  /// Pictures a persisted reply held as `data:` blobs in its text (see `UserItem.inlineImages`).
  public var inlineImages: [InlineImage]?
  /// `@image:` references for handles in a persisted reply whose picture it does not hold.
  public var attachments: [String]?
  /// The files the bot shared with this reply (`contract/outbox/`): validated by `OutboxAttachment.parseAll`,
  /// absent when it shared none. Fetched from each one's `url`, never named by a path.
  public var outbox: [OutboxAttachment]?
  /// The pages this reply used (`contract/sources/`): validated by `ReplySource.parseAll`, absent when the
  /// turn used no web tool. Shown beside the reply with their domain; nothing is loaded for them.
  public var sources: [ReplySource]?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    text: String,
    reasoning: String? = nil,
    reasoningVerbose: Bool? = nil,
    streaming: Bool,
    interim: Bool,
    status: AssistantStatus? = nil,
    error: AssistantFailure? = nil,
    usage: Usage? = nil,
    durationS: Double? = nil,
    replyToBotHandle: String? = nil,
    inlineImages: [InlineImage]? = nil,
    attachments: [String]? = nil,
    outbox: [OutboxAttachment]? = nil,
    sources: [ReplySource]? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.text = text
    self.inlineImages = inlineImages
    self.attachments = attachments
    self.outbox = outbox
    self.sources = sources
    self.reasoning = reasoning
    self.reasoningVerbose = reasoningVerbose
    self.streaming = streaming
    self.interim = interim
    self.status = status
    self.error = error
    self.usage = usage
    self.durationS = durationS
    self.replyToBotHandle = replyToBotHandle
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "AssistantItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    text = try reader.required("text")
    reasoning = reader.optional("reasoning")
    reasoningVerbose = reader.optional("reasoningVerbose")
    streaming = try reader.required("streaming")
    interim = try reader.required("interim")
    status = reader.optional("status")
    error = reader.optional("error")
    usage = reader.optional("usage")
    durationS = reader.optional("durationS")
    replyToBotHandle = reader.optional("replyToBotHandle")
    inlineImages = reader.optional("inlineImages")
    attachments = reader.optional("attachments")
    outbox = reader.optional("outbox")
    sources = reader.optional("sources")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("text", text)
    writer.set("reasoning", reasoning)
    writer.set("reasoningVerbose", reasoningVerbose)
    writer.set("streaming", streaming)
    writer.set("interim", interim)
    writer.set("status", status)
    writer.set("error", error)
    writer.set("usage", usage)
    writer.set("durationS", durationS)
    writer.set("replyToBotHandle", replyToBotHandle)
    writer.set("inlineImages", inlineImages)
    writer.set("attachments", attachments)
    writer.set("outbox", outbox)
    writer.set("sources", sources)
    return writer.json
  }
}

// MARK: - tool

public struct ToolOutputRisk: TranscriptJSONCodable, Hashable {
  public var risk: String
  public var findings: [String]
  public var redacted: Bool
  public var extra: JSONObject

  public init(risk: String, findings: [String], redacted: Bool, extra: JSONObject = [:]) {
    self.risk = risk
    self.findings = findings
    self.redacted = redacted
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ToolOutputRisk")
    risk = try reader.required("risk")
    findings = try reader.required("findings")
    redacted = try reader.required("redacted")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("risk", risk)
    writer.set("findings", findings)
    writer.set("redacted", redacted)
    return writer.json
  }
}

public struct ToolItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.tool
  public var base: ItemBase
  public var toolID: String
  public var name: String
  /// The gateway's ~80 char call preview.
  public var context: String?
  public var args: JSONObject?
  /// Only sent when the gateway runs at `display.tool_progress verbose`.
  public var argsText: String?
  /// `"<call_row_id>/<call_index>"`: the persisted assistant row holding this call
  /// and its position in that row's `tool_calls`. Unique per session whatever the
  /// provider's `toolID` looks like. Absent when the wire carried no call identity.
  public var callKey: String?
  public var status: ToolStatus
  /// False for a history row: the gateway does not persist tool results.
  public var resultKnown: Bool
  /// Any JSON, `null` included (`.some(.null)`); `nil` is absent.
  public var result: JSONValue?
  public var resultText: String?
  public var summary: String?
  public var inlineDiff: String?
  public var durationS: Double?
  public var isError: Bool?
  public var outputRisk: ToolOutputRisk?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    toolID: String,
    name: String,
    context: String? = nil,
    args: JSONObject? = nil,
    argsText: String? = nil,
    callKey: String? = nil,
    status: ToolStatus,
    resultKnown: Bool,
    result: JSONValue? = nil,
    resultText: String? = nil,
    summary: String? = nil,
    inlineDiff: String? = nil,
    durationS: Double? = nil,
    isError: Bool? = nil,
    outputRisk: ToolOutputRisk? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.toolID = toolID
    self.name = name
    self.context = context
    self.args = args
    self.argsText = argsText
    self.callKey = callKey
    self.status = status
    self.resultKnown = resultKnown
    self.result = result
    self.resultText = resultText
    self.summary = summary
    self.inlineDiff = inlineDiff
    self.durationS = durationS
    self.isError = isError
    self.outputRisk = outputRisk
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ToolItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    toolID = try reader.required("toolId")
    name = try reader.required("name")
    context = reader.optional("context")
    args = reader.optional("args")
    argsText = reader.optional("argsText")
    callKey = reader.optional("callKey")
    status = try reader.required("status")
    resultKnown = try reader.required("resultKnown")
    result = reader.optional("result")
    resultText = reader.optional("resultText")
    summary = reader.optional("summary")
    inlineDiff = reader.optional("inlineDiff")
    durationS = reader.optional("durationS")
    isError = reader.optional("isError")
    outputRisk = reader.optional("outputRisk")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("toolId", toolID)
    writer.set("name", name)
    writer.set("context", context)
    writer.set("args", args)
    writer.set("argsText", argsText)
    writer.set("callKey", callKey)
    writer.set("status", status)
    writer.set("resultKnown", resultKnown)
    writer.set("result", result)
    writer.set("resultText", resultText)
    writer.set("summary", summary)
    writer.set("inlineDiff", inlineDiff)
    writer.set("durationS", durationS)
    writer.set("isError", isError)
    writer.set("outputRisk", outputRisk)
    return writer.json
  }
}

// MARK: - bot_dm_out

/// `BotDmDispatch`; also what `parseMessageAgentResult` answers (`ParsedDispatch`,
/// the same shape).
public struct BotDmDispatch: TranscriptJSONCodable, Hashable {
  public var status: DispatchStatus
  public var deliveryID: String?
  /// Background delivery process; the reply lands as a `process_complete` row with this id.
  public var processID: String?
  public var to: String?
  public var error: String?
  public var reason: String?
  public var extra: JSONObject

  public init(
    status: DispatchStatus,
    deliveryID: String? = nil,
    processID: String? = nil,
    to: String? = nil,
    error: String? = nil,
    reason: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.status = status
    self.deliveryID = deliveryID
    self.processID = processID
    self.to = to
    self.error = error
    self.reason = reason
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "BotDmDispatch")
    status = try reader.required("status")
    deliveryID = reader.optional("deliveryId")
    processID = reader.optional("processId")
    to = reader.optional("to")
    error = reader.optional("error")
    reason = reader.optional("reason")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("status", status)
    writer.set("deliveryId", deliveryID)
    writer.set("processId", processID)
    writer.set("to", to)
    writer.set("error", error)
    writer.set("reason", reason)
    return writer.json
  }
}

/// `ParsedDispatch` in `bot-dm.ts`: the same shape as `BotDmDispatch`.
public typealias ParsedDispatch = BotDmDispatch

public struct BotDmReply: TranscriptJSONCodable, Hashable {
  public var text: String
  public var ts: Double?
  public var rowID: Int?
  /// The turn the delivery row started (`display_metadata.turn_id`), when the row
  /// joined this card and so left no item of its own to carry it: the one thing
  /// that says a placeholder standing for that turn has had its row.
  public var turnID: String?
  public var error: String?
  public var reason: String?
  public var extra: JSONObject

  public init(
    text: String,
    ts: Double? = nil,
    rowID: Int? = nil,
    turnID: String? = nil,
    error: String? = nil,
    reason: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.text = text
    self.ts = ts
    self.rowID = rowID
    self.turnID = turnID
    self.error = error
    self.reason = reason
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "BotDmReply")
    text = try reader.required("text")
    ts = reader.optional("ts")
    rowID = reader.optional("rowId")
    turnID = reader.optional("turnId")
    error = reader.optional("error")
    reason = reader.optional("reason")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("text", text)
    writer.set("ts", ts)
    writer.set("rowId", rowID)
    writer.set("turnId", turnID)
    writer.set("error", error)
    writer.set("reason", reason)
    return writer.json
  }
}

/// An outbound `message_agent` call plus, later, the teammate's answer.
public struct BotDmOutItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.botDmOut
  public var base: ItemBase
  public var toolID: String
  /// The target exactly as the model wrote it.
  public var target: String
  /// The routing alias: `@`-stripped, connection-stripped, last path segment, lowercased.
  public var targetHandle: String
  public var message: String
  /// The call identity, as on `ToolItem.callKey`.
  public var callKey: String?
  public var dispatch: BotDmDispatch
  public var reply: BotDmReply?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    toolID: String,
    target: String,
    targetHandle: String,
    message: String,
    callKey: String? = nil,
    dispatch: BotDmDispatch,
    reply: BotDmReply? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.toolID = toolID
    self.target = target
    self.targetHandle = targetHandle
    self.message = message
    self.callKey = callKey
    self.dispatch = dispatch
    self.reply = reply
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "BotDmOutItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    toolID = try reader.required("toolId")
    target = try reader.required("target")
    targetHandle = try reader.required("targetHandle")
    message = try reader.required("message")
    callKey = reader.optional("callKey")
    dispatch = try reader.requiredNested("dispatch")
    reply = reader.optional("reply")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("toolId", toolID)
    writer.set("target", target)
    writer.set("targetHandle", targetHandle)
    writer.set("message", message)
    writer.set("callKey", callKey)
    writer.set("dispatch", dispatch)
    writer.set("reply", reply)
    return writer.json
  }
}

// MARK: - subagent_group

/// One `delegate_task` fan-out. The children live in `ChatState.subagents`.
public struct SubagentGroupItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.subagentGroup
  public var base: ItemBase
  public var delegationID: String?
  public var toolID: String?
  /// The call identity of the `delegate_task` call, as on `ToolItem.callKey`.
  public var callKey: String?
  public var goals: [String]
  /// Subagent ids belonging to this fan-out.
  public var rootIDs: [String]
  public var status: SubagentGroupStatus
  public var completion: String?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    delegationID: String? = nil,
    toolID: String? = nil,
    callKey: String? = nil,
    goals: [String],
    rootIDs: [String],
    status: SubagentGroupStatus,
    completion: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.delegationID = delegationID
    self.toolID = toolID
    self.callKey = callKey
    self.goals = goals
    self.rootIDs = rootIDs
    self.status = status
    self.completion = completion
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "SubagentGroupItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    delegationID = reader.optional("delegationId")
    toolID = reader.optional("toolId")
    callKey = reader.optional("callKey")
    goals = try reader.required("goals")
    rootIDs = try reader.required("rootIds")
    status = try reader.required("status")
    completion = reader.optional("completion")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("delegationId", delegationID)
    writer.set("toolId", toolID)
    writer.set("callKey", callKey)
    writer.set("goals", goals)
    writer.set("rootIds", rootIDs)
    writer.set("status", status)
    writer.set("completion", completion)
    return writer.json
  }
}

// MARK: - status

/// Transient one-liner (`status.update`): compaction, goals, lifecycle, process.
public struct StatusItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.status
  public var base: ItemBase
  public var statusKind: String
  public var text: String
  public var extra: JSONObject

  public init(base: ItemBase, statusKind: String, text: String, extra: JSONObject = [:]) {
    self.base = base
    self.statusKind = statusKind
    self.text = text
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "StatusItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    statusKind = try reader.required("statusKind")
    text = try reader.required("text")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("statusKind", statusKind)
    writer.set("text", text)
    return writer.json
  }
}

// MARK: - notice

/// One `[IMPORTANT: Background process <sid> …]` block, kept so a later tail
/// reconcile can still join a DM reply onto the dispatch that spawned it. Also
/// `ProcessCompletion` in `bot-dm.ts`, the same shape.
public struct ProcessCompletionBlock: TranscriptJSONCodable, Hashable {
  public var sid: String
  public var command: String
  public var output: String
  public var extra: JSONObject

  public init(sid: String, command: String, output: String, extra: JSONObject = [:]) {
    self.sid = sid
    self.command = command
    self.output = output
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ProcessCompletionBlock")
    sid = try reader.required("sid")
    command = try reader.required("command")
    output = try reader.required("output")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("sid", sid)
    writer.set("command", command)
    writer.set("output", output)
    return writer.json
  }
}

/// `ProcessCompletion` in `bot-dm.ts`.
public typealias ProcessCompletion = ProcessCompletionBlock

public struct NoticeItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.notice
  public var base: ItemBase
  public var noticeKind: NoticeKind
  public var title: String
  public var body: String?
  /// Only on `noticeKind: 'process_complete'`: the blocks not yet attributed.
  public var completions: [ProcessCompletionBlock]?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    noticeKind: NoticeKind,
    title: String,
    body: String? = nil,
    completions: [ProcessCompletionBlock]? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.noticeKind = noticeKind
    self.title = title
    self.body = body
    self.completions = completions
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "NoticeItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    noticeKind = try reader.required("noticeKind")
    title = try reader.required("title")
    body = reader.optional("body")
    completions = reader.optional("completions")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("noticeKind", noticeKind)
    writer.set("title", title)
    writer.set("body", body)
    writer.set("completions", completions)
    return writer.json
  }
}

// MARK: - cron_delivery

/// A scheduled job's report, delivered into this chat.
///
/// Notice-class, not speech: it arrives on the `user` role because the turn it
/// starts runs on that role, but nobody said it — the scheduler did. Detected
/// from the header alone (`CronDelivery.swift`), because the wire carries no marker.
public struct CronDeliveryItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.cronDelivery
  public var base: ItemBase
  /// The job name the header carried.
  public var jobName: String
  /// `jobName` is the redactor's placeholder, not a name; do not title a card with it.
  public var nameRedacted: Bool?
  /// The report itself, header removed. Empty when the header arrived without one.
  public var body: String
  /// Which header matched, so a card can say how it got here.
  public var shape: CronDeliveryShape
  public var extra: JSONObject

  public init(
    base: ItemBase,
    jobName: String,
    nameRedacted: Bool? = nil,
    body: String,
    shape: CronDeliveryShape,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.jobName = jobName
    self.nameRedacted = nameRedacted
    self.body = body
    self.shape = shape
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "CronDeliveryItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    jobName = try reader.required("jobName")
    nameRedacted = reader.optional("nameRedacted")
    body = try reader.required("body")
    shape = try reader.required("shape")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("jobName", jobName)
    writer.set("nameRedacted", nameRedacted)
    writer.set("body", body)
    writer.set("shape", shape)
    return writer.json
  }
}

// MARK: - approval

public struct ApprovalItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.approval
  public var base: ItemBase
  /// JSON-RPC server-request id (`srq-N`).
  public var requestID: String
  /// The approval queue's own id, which `approval.respond` addresses.
  public var approvalID: String
  public var command: String
  public var description: String?
  public var toolName: String?
  public var choices: [String]
  public var allowPermanent: Bool?
  public var allowSession: Bool?
  public var smartDenied: Bool?
  public var state: RequestState
  public var answer: String?
  public var cancelReason: String?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    requestID: String,
    approvalID: String,
    command: String,
    description: String? = nil,
    toolName: String? = nil,
    choices: [String],
    allowPermanent: Bool? = nil,
    allowSession: Bool? = nil,
    smartDenied: Bool? = nil,
    state: RequestState,
    answer: String? = nil,
    cancelReason: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.requestID = requestID
    self.approvalID = approvalID
    self.command = command
    self.description = description
    self.toolName = toolName
    self.choices = choices
    self.allowPermanent = allowPermanent
    self.allowSession = allowSession
    self.smartDenied = smartDenied
    self.state = state
    self.answer = answer
    self.cancelReason = cancelReason
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ApprovalItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    requestID = try reader.required("requestId")
    approvalID = try reader.required("approvalId")
    command = try reader.required("command")
    description = reader.optional("description")
    toolName = reader.optional("toolName")
    choices = try reader.required("choices")
    allowPermanent = reader.optional("allowPermanent")
    allowSession = reader.optional("allowSession")
    smartDenied = reader.optional("smartDenied")
    state = try reader.required("state")
    answer = reader.optional("answer")
    cancelReason = reader.optional("cancelReason")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("requestId", requestID)
    writer.set("approvalId", approvalID)
    writer.set("command", command)
    writer.set("description", description)
    writer.set("toolName", toolName)
    writer.set("choices", choices)
    writer.set("allowPermanent", allowPermanent)
    writer.set("allowSession", allowSession)
    writer.set("smartDenied", smartDenied)
    writer.set("state", state)
    writer.set("answer", answer)
    writer.set("cancelReason", cancelReason)
    return writer.json
  }
}

// MARK: - clarify

public struct ClarifyQuestionItem: TranscriptJSONCodable, Hashable {
  public var qid: String
  public var question: String
  public var choices: [String]?
  public var multiSelect: Bool
  public var extra: JSONObject

  public init(qid: String, question: String, choices: [String]? = nil, multiSelect: Bool, extra: JSONObject = [:]) {
    self.qid = qid
    self.question = question
    self.choices = choices
    self.multiSelect = multiSelect
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ClarifyQuestionItem")
    qid = try reader.required("qid")
    question = try reader.required("question")
    choices = reader.optional("choices")
    multiSelect = try reader.required("multiSelect")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("qid", qid)
    writer.set("question", question)
    writer.set("choices", choices)
    writer.set("multiSelect", multiSelect)
    return writer.json
  }
}

public struct ClarifyItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.clarify
  public var base: ItemBase
  public var requestID: String
  public var questions: [ClarifyQuestionItem]
  /// The request carried a `questions` array rather than one bare `question`.
  ///
  /// It decides the shape of the answer: a batch resolves with `answers` keyed
  /// by qid, a single question with a bare `answer`. It is also the difference
  /// between a request `clarify.lock` can settle and one it reports `expired`
  /// for.
  public var batch: Bool?
  /// qid → answer, in JavaScript key order (`Object.keys(answers)` becomes `locked`).
  public var answers: JSRecord<String>
  /// qid set the server already accepted (locked); those may not be edited.
  public var locked: [String]
  public var state: RequestState
  public var cancelReason: String?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    requestID: String,
    questions: [ClarifyQuestionItem],
    batch: Bool? = nil,
    answers: JSRecord<String>,
    locked: [String],
    state: RequestState,
    cancelReason: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.requestID = requestID
    self.questions = questions
    self.batch = batch
    self.answers = answers
    self.locked = locked
    self.state = state
    self.cancelReason = cancelReason
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ClarifyItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    requestID = try reader.required("requestId")
    questions = try reader.required("questions")
    batch = reader.optional("batch")
    answers = try reader.required("answers")
    locked = try reader.required("locked")
    state = try reader.required("state")
    cancelReason = reader.optional("cancelReason")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("requestId", requestID)
    writer.set("questions", questions)
    writer.set("batch", batch)
    writer.set("answers", answers)
    writer.set("locked", locked)
    writer.set("state", state)
    writer.set("cancelReason", cancelReason)
    return writer.json
  }
}

// MARK: - request (an interactive server request)

/// How an interactive request ended, as KEYS and numbers only: never what was answered.
/// `RequestAnswerSummary`. `status` / `decision` / `precision` are the contract's strings,
/// kept as strings so an unknown one survives; the reducer admits only the closed ones.
public struct RequestAnswerSummary: TranscriptJSONCodable, Hashable {
  /// `answered` | `skipped` (`input.*`).
  public var status: String?
  /// `approved` | `rejected` (`review.*`).
  public var decision: String?
  public var count: Int?
  public var edited: Bool?
  /// `review.diff`: how many hunks the person approved.
  public var approvedHunks: Int?
  /// `review.diff`: how many hunks the person rejected.
  public var rejectedHunks: Int?
  /// A coarse key such as `approximate`.
  public var precision: String?
  /// `device.contact`: which fields the person shared, by the contract's names (`name`, `phones`, ...); never a value.
  public var fields: [String]?
  /// `device.scan`: the kind of code that was read (`qr`, `ean13`, ...); never what it said.
  public var symbology: String?
  /// `input.file` answered with a recording (a voice note); never the recording or its transcript.
  public var audio: Bool?
  public var extra: JSONObject

  public init(
    status: String? = nil,
    decision: String? = nil,
    count: Int? = nil,
    edited: Bool? = nil,
    approvedHunks: Int? = nil,
    rejectedHunks: Int? = nil,
    precision: String? = nil,
    fields: [String]? = nil,
    symbology: String? = nil,
    audio: Bool? = nil,
    extra: JSONObject = [:]
  ) {
    self.status = status
    self.decision = decision
    self.count = count
    self.edited = edited
    self.approvedHunks = approvedHunks
    self.rejectedHunks = rejectedHunks
    self.precision = precision
    self.fields = fields
    self.symbology = symbology
    self.audio = audio
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "RequestAnswerSummary")
    status = reader.optional("status")
    decision = reader.optional("decision")
    count = reader.optional("count")
    edited = reader.optional("edited")
    approvedHunks = reader.optional("approvedHunks")
    rejectedHunks = reader.optional("rejectedHunks")
    precision = reader.optional("precision")
    fields = reader.optional("fields")
    symbology = reader.optional("symbology")
    audio = reader.optional("audio")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("status", status)
    writer.set("decision", decision)
    writer.set("count", count)
    writer.set("edited", edited)
    writer.set("approvedHunks", approvedHunks)
    writer.set("rejectedHunks", rejectedHunks)
    writer.set("precision", precision)
    writer.set("fields", fields)
    writer.set("symbology", symbology)
    writer.set("audio", audio)
    return writer.json
  }
}

/// One interactive request (`input.form`, `input.file`, `review.draft`, `review.diff`, `input.signature`,
/// `device.location`, `device.contact`, `device.calendar`, `device.scan`): that a
/// question was asked and how it ended, never what was answered. `RequestItem`.
/// There is no field that could hold a value.
public struct RequestItem: TranscriptItemProtocol {
  public static let kind = TranscriptItemKind.request
  public var base: ItemBase
  public var requestID: String
  /// The wire method, e.g. `input.form`.
  public var method: String
  /// The agent's heading (at most 80 UTF-16 units).
  public var title: String
  /// The agent's words (at most 500 UTF-16 units).
  public var summary: String
  /// Skip is offered.
  public var optional: Bool
  public var state: RequestState
  public var answerSummary: RequestAnswerSummary?
  public var cancelReason: String?
  public var extra: JSONObject

  public init(
    base: ItemBase,
    requestID: String,
    method: String,
    title: String,
    summary: String,
    optional: Bool,
    state: RequestState,
    answerSummary: RequestAnswerSummary? = nil,
    cancelReason: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.base = base
    self.requestID = requestID
    self.method = method
    self.title = title
    self.summary = summary
    self.optional = optional
    self.state = state
    self.answerSummary = answerSummary
    self.cancelReason = cancelReason
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "RequestItem")
    try reader.expectKind(Self.kind)
    base = try ItemBase(reading: &reader)
    requestID = try reader.required("requestId")
    method = try reader.required("method")
    title = try reader.required("title")
    summary = try reader.required("summary")
    optional = try reader.required("optional")
    state = try reader.required("state")
    answerSummary = reader.optional("answerSummary")
    cancelReason = reader.optional("cancelReason")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter.item(Self.kind, base, extra: extra)
    writer.set("requestId", requestID)
    writer.set("method", method)
    writer.set("title", title)
    writer.set("summary", summary)
    writer.set("optional", optional)
    writer.set("state", state)
    writer.set("answerSummary", answerSummary)
    writer.set("cancelReason", cancelReason)
    return writer.json
  }
}

// MARK: - a kind this build does not know

/// An item whose `kind` is none of the above (written by a newer engine). Its shared
/// fields are read like any other item's; everything else is kept raw.
public struct UnknownItem: Sendable, Hashable {
  /// The `kind` it carried.
  public var kindName: String
  public var base: ItemBase
  public var extra: JSONObject

  public init(kindName: String, base: ItemBase, extra: JSONObject = [:]) {
    self.kindName = kindName
    self.base = base
    self.extra = extra
  }

  init(decoding json: JSONValue, kind: String, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "transcript item")
    reader.take("kind")
    kindName = kind
    base = try ItemBase(reading: &reader)
    extra = reader.residue
  }

  var jsonValue: JSONValue {
    ObjectWriter.item(.other(kindName), base, extra: extra).json
  }
}

extension ObjectReader {
  /// Drops `key` from the residue (it has been read some other way).
  mutating func take(_ key: String) {
    _ = optional(key, as: JSONValue.self)
  }
}

extension MessageAuthor: JSONField {}
extension AuthorVia: JSONField {}
extension UserItem: JSONField {}
extension BotDmInItem: JSONField {}
extension AssistantFailure: JSONField {}
extension AssistantItem: JSONField {}
extension ToolOutputRisk: JSONField {}
extension ToolItem: JSONField {}
extension BotDmDispatch: JSONField {}
extension BotDmReply: JSONField {}
extension BotDmOutItem: JSONField {}
extension SubagentGroupItem: JSONField {}
extension StatusItem: JSONField {}
extension ProcessCompletionBlock: JSONField {}
extension NoticeItem: JSONField {}
extension CronDeliveryItem: JSONField {}
extension ApprovalItem: JSONField {}
extension ClarifyQuestionItem: JSONField {}
extension ClarifyItem: JSONField {}
extension RequestAnswerSummary: JSONField {}
extension RequestItem: JSONField {}
