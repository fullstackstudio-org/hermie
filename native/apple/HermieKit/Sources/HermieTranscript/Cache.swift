import HermieProtocol

// Offline cache shape (`cache.ts`).
//
// Only settled transcript goes in: an optimistic submit, a foreign placeholder
// and an unanswered request all describe a moment, not the chat, and restoring
// them from disk would resurrect a question the gateway already forgot.

/// `CACHE_ITEM_LIMIT`.
public let cacheItemLimit = 200
/// `CACHE_FORMAT`.
public let cacheFormat = 1

/// `CachedTranscript`: what goes to disk.
public struct CachedTranscript: TranscriptJSONCodable, Hashable {
  public var format: Int
  public var items: [TranscriptItem]
  public var subagents: [Subagent]
  public var lastRowID: Int?
  public var lastSeq: Int
  /// The runtime session id `lastSeq` was counted under.
  ///
  /// Without it a cached watermark is a number with no frame of reference: the
  /// gateway restarts event numbering at 1 for every runtime session it builds,
  /// so replaying "everything after 41" against a session that has only reached
  /// 12 silently drops the entire chat.
  public var lastSeqSessionID: String?
  public var epoch: String?
  /// The turn that was streaming when the snapshot was taken, written only for a
  /// turn the gateway named (`turn.id`). See `CachedTurn`.
  public var turn: CachedTurn?
  public var updatedAt: Double
  /// Keys this build does not know, kept so the snapshot re-encodes unchanged.
  public var extra: JSONObject

  public init(
    format: Int,
    items: [TranscriptItem],
    subagents: [Subagent],
    lastRowID: Int? = nil,
    lastSeq: Int,
    lastSeqSessionID: String? = nil,
    epoch: String? = nil,
    turn: CachedTurn? = nil,
    updatedAt: Double,
    extra: JSONObject = [:]
  ) {
    self.format = format
    self.items = items
    self.subagents = subagents
    self.lastRowID = lastRowID
    self.lastSeq = lastSeq
    self.lastSeqSessionID = lastSeqSessionID
    self.epoch = epoch
    self.turn = turn
    self.updatedAt = updatedAt
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "CachedTranscript")
    format = try reader.required("format")
    items = try Self.decodeArray(&reader, "items")
    subagents = try Self.decodeArray(&reader, "subagents")
    lastRowID = reader.optional("lastRowId")
    lastSeq = try reader.required("lastSeq")
    lastSeqSessionID = reader.optional("lastSeqSessionId")
    epoch = reader.optional("epoch")
    turn = reader.optional("turn")
    updatedAt = try reader.required("updatedAt")
    extra = reader.residue
  }

  /// Decodes an array element by element, so a malformed element is reported by its own path.
  private static func decodeArray<T: TranscriptJSONCodable>(
    _ reader: inout ObjectReader,
    _ key: String
  ) throws(TranscriptDecodingError) -> [T] {
    let raw: [JSONValue] = try reader.required(key)
    let path = JSONPath.member(reader.path, key)
    var out: [T] = []
    out.reserveCapacity(raw.count)
    for (index, value) in raw.enumerated() {
      out.append(try T(decoding: value, at: "\(path)[\(index)]"))
    }
    return out
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("format", format)
    writer.set("items", items)
    writer.set("subagents", subagents)
    writer.set("lastRowId", lastRowID)
    writer.set("lastSeq", lastSeq)
    writer.set("lastSeqSessionId", lastSeqSessionID)
    writer.set("epoch", epoch)
    writer.set("turn", turn)
    writer.set("updatedAt", updatedAt)
    return writer.json
  }
}

/// `CachedTurn`: where a turn cut off by the snapshot was writing.
///
/// A chat saved mid-stream holds a half-written bubble, and the frames that
/// finish it are replayed when the chat opens again. Without these pointers the
/// replay could not know that bubble was the one it was filling: it started a
/// second one, and the half-written first stayed on screen beside the row the
/// turn became (the owner's reopen, cut between two deltas, or right after a
/// thought with no words yet). With them the replay carries on where the stream
/// stopped, and the frame naming the row settles that bubble onto it.
///
/// Only the pointers the reducer appends through. Nothing that would make a
/// reopened chat claim a turn is running (`active`), or time one (`startedAt`).
public struct CachedTurn: TranscriptJSONCodable, Hashable {
  /// The gateway's id for the turn.
  public var id: String
  /// The bubble receiving deltas.
  public var assistantID: String?
  /// The item holding the turn's thought.
  public var reasoningID: String?
  /// Keys this build does not know, kept so the snapshot re-encodes unchanged.
  public var extra: JSONObject

  public init(id: String, assistantID: String? = nil, reasoningID: String? = nil, extra: JSONObject = [:]) {
    self.id = id
    self.assistantID = assistantID
    self.reasoningID = reasoningID
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "CachedTurn")
    id = try reader.required("id")
    assistantID = reader.optional("assistantId")
    reasoningID = reader.optional("reasoningId")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("id", id)
    writer.set("assistantId", assistantID)
    writer.set("reasoningId", reasoningID)
    return writer.json
  }
}

/// `SessionIds`: the two session ids a restored state is built under.
public struct SessionIDs: TranscriptJSONCodable, Hashable {
  public var storedSessionID: String
  public var resolvedSessionID: String

  public init(storedSessionID: String, resolvedSessionID: String) {
    self.storedSessionID = storedSessionID
    self.resolvedSessionID = resolvedSessionID
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "SessionIds")
    storedSessionID = try reader.required("storedSessionId")
    resolvedSessionID = try reader.required("resolvedSessionId")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("storedSessionId", storedSessionID)
    writer.set("resolvedSessionId", resolvedSessionID)
    return writer.json
  }
}

extension CachedTranscript: JSONField {}
extension CachedTurn: JSONField {}
extension SessionIDs: JSONField {}

private func isCacheable(_ item: TranscriptItem) -> Bool {
  if item.origin == .optimistic || item.origin == .foreign {
    return false
  }

  switch item {
  case .approval(let approval): return approval.state != .open
  case .clarify(let clarify): return clarify.state != .open
  default: return true
  }
}

/// `snapshotForCache`: the last `cacheItemLimit` settled items and the watermarks.
public func snapshotForCache(_ state: ChatState, now: Double) -> CachedTranscript {
  let items = state.order
    .compactMap { state.items[$0] }
    .filter(isCacheable)
    .suffix(cacheItemLimit)
    // A bubble that was mid-stream when the app went away is finished as far as
    // the cache is concerned; nothing will ever append to it again.
    .map { item -> TranscriptItem in
      guard case .assistant(var assistant) = item, assistant.streaming else { return item }
      assistant.streaming = false
      return .assistant(assistant)
    }

  let lastRowID = items.last { $0.rowID != nil }?.rowID
  let turn = cachedTurn(of: state, items)

  return CachedTranscript(
    format: cacheFormat,
    items: items,
    subagents: state.subagents.values,
    lastRowID: lastRowID,
    lastSeq: state.lastSeq,
    lastSeqSessionID: state.lastSeqSessionID.flatMap { $0.isEmpty ? nil : $0 },
    epoch: state.epoch.flatMap { $0.isEmpty ? nil : $0 },
    turn: turn,
    updatedAt: now
  )
}

/// `cachedTurnOf`: the running turn's pointers, when the gateway named the turn
/// and they point into what is cached.
private func cachedTurn(of state: ChatState, _ items: [TranscriptItem]) -> CachedTurn? {
  guard let id = JS.nonEmpty(state.turn.id) else { return nil }

  let cached = Set(items.map(\.id))
  let assistantID = JS.nonEmpty(state.turn.assistantID).flatMap { cached.contains($0) ? $0 : nil }
  let reasoningID = JS.nonEmpty(state.turn.reasoningID).flatMap { cached.contains($0) ? $0 : nil }

  return CachedTurn(id: id, assistantID: assistantID, reasoningID: reasoningID)
}

/// `restoreTurn`: put a cached turn's pointers back, each only while it still
/// names what it named: a bubble that is there, an assistant one, and still open
/// - a pointer at anything else would send the next delta somewhere it does not
/// belong.
private func restoreTurn(_ state: inout ChatState, _ turn: CachedTurn?) {
  guard let turn, !turn.id.isEmpty else { return }

  state.turn.id = turn.id

  if let key = JS.nonEmpty(turn.assistantID), case .assistant(let live)? = state.items[key],
    !live.interim, live.rowID == nil
  {
    state.turn.assistantID = live.id
  }

  if let key = JS.nonEmpty(turn.reasoningID), case .assistant(let held)? = state.items[key] {
    state.turn.reasoningID = held.id
  }
}

/// Rebuild a paintable state from disk. Indices are derived, never stored.
public func stateFromCache(_ botName: String, _ ids: SessionIDs, _ snapshot: CachedTranscript) -> ChatState {
  var state = createChatState(botName, ids.storedSessionID, ids.resolvedSessionID)

  if snapshot.format != cacheFormat {
    return state
  }

  state.items.reserveCapacity(snapshot.items.count)
  state.order.reserveCapacity(snapshot.items.count)

  for (index, item) in snapshot.items.enumerated() {
    var placed = item
    placed.seq = index * seqStep
    let id = placed.id

    state.items[id] = placed
    state.order.append(id)

    if let rowID = placed.rowID {
      state.byRowID[String(rowID)] = id
    }

    if let callKey = JS.nonEmpty(placed.callKey) {
      state.byCallKey[callKey] = id
    }

    switch placed {
    case .tool(let tool):
      state.byToolID[tool.toolID] = id
    case .botDmOut(let outbound):
      state.byToolID[outbound.toolID] = id

      if let processID = outbound.dispatch.processID, !processID.isEmpty {
        state.byProcessID[processID] = id
      }
    case .subagentGroup(let group):
      if let toolID = group.toolID, !toolID.isEmpty {
        state.byToolID[toolID] = id
      }

      if let delegationID = group.delegationID, !delegationID.isEmpty {
        state.byDelegationID[delegationID] = id
      }
    case .approval(let approval):
      state.byRequestID[approval.requestID] = id
    case .clarify(let clarify):
      state.byRequestID[clarify.requestID] = id
    default:
      break
    }
  }

  for child in snapshot.subagents {
    state.subagents[child.id] = child
  }

  state.turn.nextSeq = snapshot.items.count * seqStep
  state.hydration = .cached

  if let sessionID = snapshot.lastSeqSessionID, !sessionID.isEmpty {
    state.lastSeq = snapshot.lastSeq
    state.lastSeqSessionID = sessionID

    if let epoch = snapshot.epoch, !epoch.isEmpty {
      state.epoch = epoch
    }

    // Only beside a watermark: the turn is continued by the frames replayed
    // after it, and a snapshot read as cold replays nothing.
    restoreTurn(&state, snapshot.turn)
  }
  // A snapshot from before the watermark carried its session id cannot say which
  // session it counted, so it is read as cold: one extra replay-free hydration
  // beats a silently truncated chat.

  if let lastRowID = snapshot.lastRowID {
    state.lastSeenRowID = lastRowID
  }

  return state
}
