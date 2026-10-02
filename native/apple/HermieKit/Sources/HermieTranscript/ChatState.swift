import HermieProtocol

// The transcript item model (`types.ts`)
// ======================================
//
// One chat with one bot is a normalised `ChatState`: an id-keyed `items` map, an
// `order` array and a handful of indices. History rows and live gateway events
// are projected into the SAME item kinds (see `rows-to-items.ts` and
// `reducer.ts`), so a loaded transcript and a streamed one render identically.
//
// Nothing here filters. Verbosity and the bot-to-bot toggle are selectors
// (`selectors.ts`); the reducer always keeps the full truth.
//
// Why native structs, not JSON-backed views
// -----------------------------------------
//
// `HermieProtocol` keeps every wire payload as a view over the JSON object it came
// in as. The state here is native: a struct per item kind, an `indirect` enum over
// them, typed fields, open enums for the vocabularies, and a hand-written JSON
// mapping per type (`JSON/TranscriptJSON.swift` has the rules). Because:
//
// - the reducer touches the state on every streamed token and the UI reads it on
//   every frame; a typed field is a load, a JSON view is a hash lookup plus an enum
//   unwrap, and appending to `text` through a view copies the whole string;
// - the reducer and the views want exhaustive `switch`es over the kinds and
//   compiler-checked field names, which a view over `[String: JSONValue]` cannot give;
// - losslessness, the reason views exist, does not need them: every type keeps the
//   keys it does not know (and known optional keys of an unexpected shape) in
//   `extra`, and writes them back, so a state the TypeScript engine wrote — or a
//   newer Swift engine — survives a round trip. The golden corpus proves it for
//   every state it holds.
//
// Wire payloads that the state merely carries (`Usage`, `SessionLiveInfo`,
// `ErrorSurface`, a tool's `args` and `result`, the todo list) stay as
// `HermieProtocol`'s JSON-backed types or raw `JSONValue`, untouched.
//
// Why copies are cheap
// --------------------
//
// Every collection in the state is a copy-on-write `Array`/`Dictionary`, and every
// item is one pointer (an `indirect` enum), so copying a `ChatState` is a dozen
// retains, whatever its size. A mutation pays only for what it touches:
//
// - on a UNIQUELY held state (the transcript store's own, mutated `inout`), setting
//   an item or appending to its text (`state.items[id]?.updateAssistant { … }`) is
//   O(1) amortised: nothing is copied;
// - on a state somebody else still holds (a snapshot already published to the main
//   actor), the first write to `items` copies that dictionary once — O(n) retains,
//   no deep copy — and every later write until the next publish is O(1) again. The
//   TypeScript engine pays O(n) on EVERY event (`{ ...state.items }`).
//
// So the reducer should be written as an `inout` function, with the pure
// `(state) -> state` signature of the TypeScript as a thin wrapper over it. The
// micro-benchmark in `Tests/HermieTranscriptTests/StateCopyBenchmarkTests.swift`
// measures both.
//
// Key order: `items` and the `by…` indices are only ever looked up by key in the
// TypeScript, never walked, so their order is not observable and they are plain
// dictionaries. `subagents` IS walked (`Object.values`), so it is a `JSRecord`, which
// enumerates the way a JavaScript object does.

/// Upstream's `MAX_STREAM` (`apps/desktop/src/store/subagents.ts`). `SUBAGENT_STREAM_CAP`.
public let subagentStreamCap = 24

/// The gap between history seqs; live items are handed the next multiple. `SEQ_STEP`.
public let seqStep = 1000

/// A prompt parked behind the running turn.
public struct QueuedPrompt: TranscriptJSONCodable, Hashable {
  public var text: String
  /// This client submitted it. The turn it eventually starts is ours, so the
  /// reducer must not stand a foreign-author placeholder in front of it.
  public var local: Bool?
  public var extra: JSONObject

  public init(text: String, local: Bool? = nil, extra: JSONObject = [:]) {
    self.text = text
    self.local = local
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "QueuedPrompt")
    text = try reader.required("text")
    local = reader.optional("local")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("text", text)
    writer.set("local", local)
    return writer.json
  }
}

/// Authoritative todo snapshot (`tool_progress._normalize_todo_state`).
public struct TodoSnapshot: TranscriptJSONCodable, Hashable {
  public var todos: [JSONValue]
  public var revision: Double
  public var extra: JSONObject

  public init(todos: [JSONValue], revision: Double, extra: JSONObject = [:]) {
    self.todos = todos
    self.revision = revision
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "TodoSnapshot")
    todos = try reader.required("todos")
    revision = try reader.required("revision")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("todos", todos)
    writer.set("revision", revision)
    return writer.json
  }
}

public struct TurnState: TranscriptJSONCodable, Hashable {
  public var active: Bool
  public var startedAt: Double?
  /// The assistant item currently receiving deltas.
  public var assistantID: String?
  /// The item holding THIS turn's thought.
  ///
  /// One turn is one thought, and the events that carry it do not all arrive
  /// while the same bubble is live: `reasoning.delta` streams before the first
  /// token, and `reasoning.available` comes out of `tool_progress`, which means
  /// it lands AFTER a tool call has already sealed that bubble. Resolving the
  /// target through `turn.assistantId` alone therefore started a second bubble
  /// for the same thinking, and the reader saw `Thought for 1s` twice with the
  /// same block under each — see `reasoningTargetId`.
  ///
  /// Cleared with the rest of the turn, so the next one thinks afresh.
  public var reasoningID: String?
  /// True when WE submitted this turn; false means a foreign turn.
  public var local: Bool
  /// Next `seq` to hand out.
  public var nextSeq: Int
  /// A foreign turn started; the tail needs a REST reconcile to learn who spoke.
  public var foreignReconcilePending: Bool?
  public var interrupted: Bool?
  /// `tool.generating` announced a name before the call's id existed.
  public var draftingTool: String?
  public var extra: JSONObject

  public init(
    active: Bool,
    startedAt: Double? = nil,
    assistantID: String? = nil,
    reasoningID: String? = nil,
    local: Bool,
    nextSeq: Int,
    foreignReconcilePending: Bool? = nil,
    interrupted: Bool? = nil,
    draftingTool: String? = nil,
    extra: JSONObject = [:]
  ) {
    self.active = active
    self.startedAt = startedAt
    self.assistantID = assistantID
    self.reasoningID = reasoningID
    self.local = local
    self.nextSeq = nextSeq
    self.foreignReconcilePending = foreignReconcilePending
    self.interrupted = interrupted
    self.draftingTool = draftingTool
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "TurnState")
    active = try reader.required("active")
    startedAt = reader.optional("startedAt")
    assistantID = reader.optional("assistantId")
    reasoningID = reader.optional("reasoningId")
    local = try reader.required("local")
    nextSeq = try reader.required("nextSeq")
    foreignReconcilePending = reader.optional("foreignReconcilePending")
    interrupted = reader.optional("interrupted")
    draftingTool = reader.optional("draftingTool")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("active", active)
    writer.set("startedAt", startedAt)
    writer.set("assistantId", assistantID)
    writer.set("reasoningId", reasoningID)
    writer.set("local", local)
    writer.set("nextSeq", nextSeq)
    writer.set("foreignReconcilePending", foreignReconcilePending)
    writer.set("interrupted", interrupted)
    writer.set("draftingTool", draftingTool)
    return writer.json
  }
}

public struct ChatState: TranscriptJSONCodable, Hashable {
  public var botName: String
  /// The durable id we persist and resume on. Never the runtime id.
  public var storedSessionID: String
  /// The lineage tip; REST rows are read under this id.
  public var resolvedSessionID: String
  /// The gateway's runtime session id for the current attachment.
  public var runtimeSessionID: String?
  public var items: [String: TranscriptItem]
  public var order: [String]
  /// tool_id → item id.
  public var byToolID: [String: String]
  /// String(rowId) → item id; string-keyed so the cache round-trips as JSON.
  public var byRowID: [String: String]
  /// Server-request id → item id.
  public var byRequestID: [String: String]
  /// Approval-queue id → item id, for the open approvals only.
  ///
  /// The same queue entry reaches a client under more than one server-request
  /// id — live as `srq-N`, rebuilt from `pending_approval` as `pending:<id>`,
  /// polled out of `approval.pending` as `pending:<id>` again. They are one
  /// question, so the card is deduplicated on the queue's own id rather than on
  /// the transport's.
  public var byApprovalID: [String: String]
  /// Background delivery process id → `bot_dm_out` item id.
  public var byProcessID: [String: String]
  /// delegation_id → `subagent_group` item id.
  public var byDelegationID: [String: String]
  /// In JavaScript key order: `Object.values(state.subagents)` is observable.
  public var subagents: JSRecord<Subagent>
  public var turn: TurnState
  /// A prompt the backend parked behind the running turn.
  public var queued: QueuedPrompt?
  public var todo: TodoSnapshot?
  public var usage: Usage?
  public var info: SessionLiveInfo?
  /// Highest event `seq` applied; anything at or below it is a replay.
  public var lastSeq: Int
  /// The runtime session id `lastSeq` was counted under.
  ///
  /// The gateway numbers events per runtime session and restarts at 1 every time
  /// it rebuilds one, so a watermark carried across a rebuild would swallow the
  /// whole new session. `bindRuntime` compares this with the id it is binding
  /// and drops the watermark when they differ.
  public var lastSeqSessionID: String?
  /// `replay_epoch` from `gateway.ready`; a change forces full re-hydration.
  public var epoch: String?
  public var hydration: HydrationState
  public var unreadCount: Int
  public var lastSeenRowID: Int?
  public var draft: String
  public var compacting: Bool?
  /// Keys this build does not know, kept so the state re-encodes unchanged.
  public var extra: JSONObject

  public init(
    botName: String,
    storedSessionID: String,
    resolvedSessionID: String,
    runtimeSessionID: String? = nil,
    items: [String: TranscriptItem] = [:],
    order: [String] = [],
    byToolID: [String: String] = [:],
    byRowID: [String: String] = [:],
    byRequestID: [String: String] = [:],
    byApprovalID: [String: String] = [:],
    byProcessID: [String: String] = [:],
    byDelegationID: [String: String] = [:],
    subagents: JSRecord<Subagent> = [:],
    turn: TurnState,
    queued: QueuedPrompt? = nil,
    todo: TodoSnapshot? = nil,
    usage: Usage? = nil,
    info: SessionLiveInfo? = nil,
    lastSeq: Int,
    lastSeqSessionID: String? = nil,
    epoch: String? = nil,
    hydration: HydrationState,
    unreadCount: Int,
    lastSeenRowID: Int? = nil,
    draft: String,
    compacting: Bool? = nil,
    extra: JSONObject = [:]
  ) {
    self.botName = botName
    self.storedSessionID = storedSessionID
    self.resolvedSessionID = resolvedSessionID
    self.runtimeSessionID = runtimeSessionID
    self.items = items
    self.order = order
    self.byToolID = byToolID
    self.byRowID = byRowID
    self.byRequestID = byRequestID
    self.byApprovalID = byApprovalID
    self.byProcessID = byProcessID
    self.byDelegationID = byDelegationID
    self.subagents = subagents
    self.turn = turn
    self.queued = queued
    self.todo = todo
    self.usage = usage
    self.info = info
    self.lastSeq = lastSeq
    self.lastSeqSessionID = lastSeqSessionID
    self.epoch = epoch
    self.hydration = hydration
    self.unreadCount = unreadCount
    self.lastSeenRowID = lastSeenRowID
    self.draft = draft
    self.compacting = compacting
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ChatState")
    botName = try reader.required("botName")
    storedSessionID = try reader.required("storedSessionId")
    resolvedSessionID = try reader.required("resolvedSessionId")
    runtimeSessionID = reader.optional("runtimeSessionId")
    items = try Self.decodeItems(&reader)
    order = try reader.required("order")
    byToolID = try reader.required("byToolId")
    byRowID = try reader.required("byRowId")
    byRequestID = try reader.required("byRequestId")
    byApprovalID = try reader.required("byApprovalId")
    byProcessID = try reader.required("byProcessId")
    byDelegationID = try reader.required("byDelegationId")
    subagents = try Self.decodeSubagents(&reader)
    turn = try reader.requiredNested("turn")
    queued = reader.optional("queued")
    todo = reader.optional("todo")
    usage = reader.optional("usage")
    info = reader.optional("info")
    lastSeq = try reader.required("lastSeq")
    lastSeqSessionID = reader.optional("lastSeqSessionId")
    epoch = reader.optional("epoch")
    hydration = try reader.required("hydration")
    unreadCount = try reader.required("unreadCount")
    lastSeenRowID = reader.optional("lastSeenRowId")
    draft = try reader.required("draft")
    compacting = reader.optional("compacting")
    extra = reader.residue
  }

  /// Decodes `items` one by one, so a malformed item is reported by its own path.
  private static func decodeItems(_ reader: inout ObjectReader) throws(TranscriptDecodingError) -> [String: TranscriptItem] {
    let raw: JSONObject = try reader.required("items")
    let path = JSONPath.member(reader.path, "items")
    var items: [String: TranscriptItem] = [:]
    items.reserveCapacity(raw.count)
    for (key, value) in raw {
      items[key] = try TranscriptItem(decoding: value, at: JSONPath.member(path, key))
    }
    return items
  }

  /// Decodes `subagents` in the canonical key order (see `JSRecord`), reporting a
  /// malformed child by its own path.
  private static func decodeSubagents(_ reader: inout ObjectReader) throws(TranscriptDecodingError) -> JSRecord<Subagent> {
    let raw: JSONObject = try reader.required("subagents")
    let path = JSONPath.member(reader.path, "subagents")
    var record = JSRecord<Subagent>()
    for key in raw.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
      record[key] = try Subagent(decoding: raw[key]!, at: JSONPath.member(path, key))
    }
    return record
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("botName", botName)
    writer.set("storedSessionId", storedSessionID)
    writer.set("resolvedSessionId", resolvedSessionID)
    writer.set("runtimeSessionId", runtimeSessionID)
    writer.set("items", items)
    writer.set("order", order)
    writer.set("byToolId", byToolID)
    writer.set("byRowId", byRowID)
    writer.set("byRequestId", byRequestID)
    writer.set("byApprovalId", byApprovalID)
    writer.set("byProcessId", byProcessID)
    writer.set("byDelegationId", byDelegationID)
    writer.set("subagents", subagents)
    writer.set("turn", turn)
    writer.set("queued", queued)
    writer.set("todo", todo)
    writer.set("usage", usage)
    writer.set("info", info)
    writer.set("lastSeq", lastSeq)
    writer.set("lastSeqSessionId", lastSeqSessionID)
    writer.set("epoch", epoch)
    writer.set("hydration", hydration)
    writer.set("unreadCount", unreadCount)
    writer.set("lastSeenRowId", lastSeenRowID)
    writer.set("draft", draft)
    writer.set("compacting", compacting)
    return writer.json
  }

  /// `state.order.map(id => state.items[id])`, skipping a dangling id.
  public var orderedItems: [TranscriptItem] {
    order.compactMap { items[$0] }
  }
}

extension QueuedPrompt: JSONField {}
extension TodoSnapshot: JSONField {}
extension TurnState: JSONField {}
extension ChatState: JSONField {}

/// `id`, or the nearest spelling of it no item in `taken` is already using.
///
/// `order` is a LIST, so an id it already holds becomes a SECOND entry pointing
/// at one item: React reports "Encountered two children with the same key" and
/// the reader sees the same bubble twice. No id in this package is unique on its
/// own — a live one is minted from a counter, a persisted one from the gateway's
/// row number, a tool one from `tool_id` — and a gateway that restarts under a
/// live session hands all three out again from the beginning. So every id is put
/// through here on its way into a transcript rather than trusted.
///
/// The suffix is deliberately one an id never carries otherwise, and it only
/// ever lands on the LATER of the two: an item already on screen keeps the id a
/// list is keyed on, so nothing remounts.
///
/// `freeItemId`. The TypeScript tests `!taken[id]` (truthiness); every map it is
/// handed holds objects, so presence is the same test.
public func freeItemID<Value>(_ taken: [String: Value], _ id: String) -> String {
  if taken[id] == nil {
    return id
  }

  var attempt = 2

  while taken["\(id)#\(attempt)"] != nil {
    attempt += 1
  }

  return "\(id)#\(attempt)"
}

/// `createChatState`.
public func createChatState(_ botName: String, _ storedSessionID: String, _ resolvedSessionID: String) -> ChatState {
  ChatState(
    botName: botName,
    storedSessionID: storedSessionID,
    resolvedSessionID: resolvedSessionID,
    items: [:],
    order: [],
    byToolID: [:],
    byRowID: [:],
    byRequestID: [:],
    byApprovalID: [:],
    byProcessID: [:],
    byDelegationID: [:],
    subagents: [:],
    turn: TurnState(active: false, local: false, nextSeq: seqStep),
    lastSeq: 0,
    hydration: .cold,
    unreadCount: 0,
    draft: ""
  )
}
