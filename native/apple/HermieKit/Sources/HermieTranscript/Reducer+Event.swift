import HermieProtocol

// `applyEvent`: one gateway event onto the chat. The families live in
// `Reducer+Message.swift`, `Reducer+Tool.swift`, `Reducer+Subagent.swift` and
// `Reducer+Request.swift`; this is the dispatch.

/// Apply one gateway event. Events at or below `lastSeq` are replays and are
/// ignored; `now` (milliseconds) is explicit so the result is deterministic.
///
/// `applyEvent`. The store's form is `applyEvent(into:_:_:)`.
public func applyEvent(_ state: ChatState, _ event: GatewayEvent, _ now: Double) -> ChatState {
  var next = state
  applyEvent(into: &next, event, now)
  return next
}

/// `applyEvent`, in place: only what the event touches is written.
public func applyEvent(into state: inout ChatState, _ event: GatewayEvent, _ now: Double) {
  typealias R = TranscriptReducer

  // `typeof event.seq === 'number'`: any number counts, so read it raw.
  let seq = event.json["seq"]?.doubleValue

  if let seq, seq <= Double(state.lastSeq) {
    return
  }

  let payload = R.rec(event.payload)

  if let seq, let whole = Int(exactly: seq) {
    // A fractional `seq` cannot be held by the state model (`lastSeq` is an `Int`);
    // the gateway's counter is an integer, so that is a wire the TypeScript would
    // also be wrong on.
    state.lastSeq = whole
  }

  switch event.type {
  case "message.start":
    // `typeof event.turn_id === 'string' && event.turn_id`: the envelope's turn id,
    // read raw like `seq`, so a gateway that mints none sends the old path.
    R.messageStart(&state, JS.nonEmpty(event.json["turn_id"]?.stringValue), now)

  case "message.delta":
    R.messageDelta(&state, payload, now)

  case "reasoning.delta", "thinking.delta", "reasoning.available":
    R.reasoning(&state, payload, replace: event.type == "reasoning.available", now)

  case "message.interim":
    R.messageInterim(&state, payload, now)

  case "tool.generating":
    state.turn.draftingTool = R.str(payload["name"])

  case "tool.start":
    R.toolStart(&state, payload, now)

  case "tool.complete":
    R.toolComplete(&state, payload, now)

  case "todo.updated":
    if case .array(let todos)? = payload["todos"] {
      state.todo = TodoSnapshot(todos: todos, revision: R.num(payload["revision"]) ?? 0)
    }

  case "tool.output_risk":
    R.toolOutputRisk(&state, payload)

  case "subagent.spawn_requested", "subagent.start", "subagent.progress", "subagent.thinking", "subagent.tool",
    "subagent.complete":
    R.subagentEvent(&state, payload, event.type, now)

  case "status.update":
    R.statusUpdate(&state, payload, now)

  case "message.complete":
    R.messageComplete(&state, payload, now)

  case "session.info":
    R.sessionInfo(&state, payload)

  case "session.usage":
    if JS.truthy(payload["usage"]) {
      state.usage = Usage(json: R.rec(payload["usage"]))
    }

  case "session.title":
    let title = R.str(payload["title"])

    // A canonical Bot Chat is titled exactly `Bot Chat`; anything else means
    // this session drifted out of the canonical set and must be re-resolved.
    if !title.isEmpty && !JS.same(title, "Bot Chat") {
      state.hydration = .stale
    }

  case "error":
    R.errorEvent(&state, payload, now)

  case "notice":
    R.notice(&state, payload, now)

  case "request.cancel":
    R.requestCancel(&state, payload)

  case "message.reaction":
    R.messageReaction(&state, payload)

  case "session.reclaimed":
    state.runtimeSessionID = nil
    state.turn.active = false
    R.pushNotice(&state, .reclaimed, "Session reclaimed by the gateway", R.str(payload["reason"]), now)

  case "btw.complete", "background.complete":
    R.sideAgentComplete(&state, payload, now)

  default:
    break
  }
}
