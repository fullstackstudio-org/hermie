import HermieProtocol

// The live reducer (`reducer.ts`)
// ===============================
//
// Gateway events, server requests, resume snapshots and the client's own actions
// → `ChatState`. A transliteration of the TypeScript, function by function, under
// the same names; the comments that explain a rule are carried over, because each
// of those rules was earned by a bug.
//
// The files, by family:
//
// - `Reducer.swift` — this: the container helpers every family shares
//   (`indexItem`, `addItem`, `patchItem`, `dropItem`, …) and the turn's own
//   bookkeeping (`currentAssistantId`, `clearTurn`, …);
// - `Reducer+Event.swift` — `applyEvent`, the dispatch over the event type;
// - `Reducer+Message.swift` — `message.*`, reasoning, status, notices, errors and
//   the session-level events;
// - `Reducer+Tool.swift` — `tool.*` and `todo.updated`;
// - `Reducer+Subagent.swift` — `subagent.*` and `applySubagentSnapshot`;
// - `Reducer+Request.swift` — `applyServerRequest`, `answerRequest`, `request.cancel`;
// - `Reducer+Resume.swift` — `applyResumeSnapshot`;
// - `Reducer+Turn.swift` — the client's own actions: `beginLocalTurn`,
//   `beginSteer`, `dropSteer`, `confirmSubmit`, `markInterrupted`,
//   `applyProcessCompletion`.
//
// The `rows-to-items.ts` helpers the reducer reads prompts through
// (`stripUserText`, `classifyUserRow`, `normalizeMatchText`,
// `attachmentsMatchKey`, `normalizedItemText`) are the public ones in
// `RowsToItems.swift` and `RowsToItemsMatching.swift`, as in the TypeScript.
//
// In place, not copied
// --------------------
//
// The TypeScript is immutable: every call copies each container it may touch
// (`editable`) and returns the copy. Here the core of every function is an
// `inout` function over `ChatState` (`applyEvent(into:…)`), and the TypeScript
// signature — `(state, …, now) -> state` — is a thin public wrapper over it. A
// store that owns its state calls the `inout` form and pays only for what an
// event touches: a `message.delta` appends to one string in place (see the header
// of `ChatState.swift` for why that is O(1) amortised). The result is the same
// state either way; the corpus replays the wrappers.
//
// `now` is always an explicit argument (milliseconds, like `Date.now()`); nothing
// here reads a clock.
//
// JavaScript semantics that survive the port
// ------------------------------------------
//
// - `rec`/`str`/`num` read the raw payload exactly as the TypeScript does, rather
//   than through `HermieProtocol`'s typed payload views, whose readings are close
//   but not identical (`num` refuses a non-finite number; a view's `Int` refuses a
//   fraction).
// - JavaScript's `a ? … : …` on a string is "non-empty": an empty id is as good as
//   none wherever the TypeScript tested an id for truthiness, and `JS.nonEmpty`
//   says so. Where the TypeScript used `??` instead, an empty string is kept.
// - The TypeScript's patch is unchecked (`patchItem<AssistantItem>` is a cast), so a
//   patch of an item of another kind still bumps its `version` and re-indexes it.
//   Every patch site here reaches only the kind it names (each is guarded by a kind
//   check or an index that holds only that kind), with one exception kept
//   faithfully: `tool.output_risk` (see `Reducer+Tool.swift`).

/// The reducer's internals, namespaced so they cannot collide with another
/// module-level helper of the same name.
enum TranscriptReducer {}

// MARK: - Reading payloads the way the TypeScript does

extension TranscriptReducer {
  /// `rec`: the value when it is a plain object, else `{}`.
  static func rec(_ value: JSONValue?) -> JSONObject {
    value?.objectValue ?? [:]
  }

  /// `str`: the value when it is a string, else `''`.
  static func str(_ value: JSONValue?) -> String {
    value?.stringValue ?? ""
  }

  /// `num`: the value when it is a finite number, else `undefined`.
  static func num(_ value: JSONValue?) -> Double? {
    guard case .number(let number)? = value, number.isFinite else { return nil }
    return number
  }

  /// `value === true`.
  static func isTrue(_ value: JSONValue?) -> Bool {
    value == .bool(true)
  }

  /// `value === false`.
  static func isFalse(_ value: JSONValue?) -> Bool {
    value == .bool(false)
  }

  /// `id ? state.items[id] : undefined`.
  static func itemAt(_ state: ChatState, _ id: String?) -> TranscriptItem? {
    guard let id = JS.nonEmpty(id) else { return nil }
    return state.items[id]
  }
}

// MARK: - Containers

extension TranscriptReducer {
  /// `indexItem`.
  static func indexItem(_ next: inout ChatState, _ item: TranscriptItem) {
    if let rowID = item.rowID {
      next.byRowID[String(rowID)] = item.id
    }

    switch item {
    case .tool(let tool):
      next.byToolID[tool.toolID] = tool.id

    case .botDmOut(let dispatch):
      next.byToolID[dispatch.toolID] = dispatch.id

      if let processID = JS.nonEmpty(dispatch.dispatch.processID) {
        next.byProcessID[processID] = dispatch.id
      }

    case .subagentGroup(let group):
      if let toolID = JS.nonEmpty(group.toolID) {
        next.byToolID[toolID] = group.id
      }

      if let delegationID = JS.nonEmpty(group.delegationID) {
        next.byDelegationID[delegationID] = group.id
      }

    case .approval(let approval):
      next.byRequestID[approval.requestID] = approval.id

      if !approval.approvalID.isEmpty {
        // Last one in wins: a card that replaces an earlier duplicate is the one a
        // cancel has to reach.
        next.byApprovalID[approval.approvalID] = approval.id
      }

    case .clarify(let clarify):
      next.byRequestID[clarify.requestID] = clarify.id

    default:
      break
    }
  }

  /// Re-indexes the item standing at `id`, if there is one.
  static func indexItem(_ next: inout ChatState, id: String) {
    if let item = next.items[id] {
      indexItem(&next, item)
    }
  }

  /// `addItem` (and `addAnyItem`, its runtime-kind twin): the draft gets a free id,
  /// the next `seq`, `version` 0 and its origin, and goes on the end of `order`.
  ///
  /// `make` builds the item from the `ItemBase` this hands it — the TypeScript's
  /// `{ ...draft, id, seq, version: 0, origin }`. Returns the id it was given.
  @discardableResult
  static func addItem(
    _ next: inout ChatState,
    id draftID: String,
    ts: Double?,
    origin: ItemOrigin = .live,
    _ make: (ItemBase) -> TranscriptItem
  ) -> String {
    let seq = next.turn.nextSeq
    let id = freeItemID(next.items, draftID)
    let item = make(ItemBase(id: id, seq: seq, ts: ts, origin: origin, version: 0))

    next.turn.nextSeq = seq + seqStep
    next.items[item.id] = item
    next.order.append(item.id)
    indexItem(&next, item)

    return item.id
  }

  /// `patchItem` for one kind: `body` runs on the payload in place, `version` goes
  /// up by one, and the item is re-indexed. A missing id is a no-op; an item of
  /// another kind only has its `version` bumped (the TypeScript's cast would also
  /// have written the fields onto it — see the header).
  ///
  /// The payload is reached through the kind's in-place accessor
  /// (`TranscriptItem.updateAssistant`, …), which takes it out of its box so a
  /// growing string is appended to without a copy.
  static func patchItem<Item: ReducerPatchable>(_ next: inout ChatState, _ id: String, _ body: (inout Item) -> Void) {
    guard next.items[id] != nil else { return }

    let applied = Item.update(&next.items[id]!) { item in
      body(&item)
      item.version += 1
    }

    if !applied {
      next.items[id]!.version += 1
    }

    indexItem(&next, id: id)
  }

  static func patchAssistant(_ next: inout ChatState, _ id: String, _ body: (inout AssistantItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchTool(_ next: inout ChatState, _ id: String, _ body: (inout ToolItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchUser(_ next: inout ChatState, _ id: String, _ body: (inout UserItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchBotDmOut(_ next: inout ChatState, _ id: String, _ body: (inout BotDmOutItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchSubagentGroup(_ next: inout ChatState, _ id: String, _ body: (inout SubagentGroupItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchStatus(_ next: inout ChatState, _ id: String, _ body: (inout StatusItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchApproval(_ next: inout ChatState, _ id: String, _ body: (inout ApprovalItem) -> Void) {
    patchItem(&next, id, body)
  }

  static func patchClarify(_ next: inout ChatState, _ id: String, _ body: (inout ClarifyItem) -> Void) {
    patchItem(&next, id, body)
  }

  /// `patchItem` writing `state` and `cancelReason`, the two fields an approval and
  /// a clarify share (`(draft as ApprovalItem | ClarifyItem).state = …`).
  static func patchRequest(_ next: inout ChatState, _ id: String, state: RequestState, cancelReason: String) {
    guard let item = next.items[id] else { return }

    switch item {
    case .approval:
      patchApproval(&next, id) { draft in
        draft.state = state
        draft.cancelReason = cancelReason
      }
    case .clarify:
      patchClarify(&next, id) { draft in
        draft.state = state
        draft.cancelReason = cancelReason
      }
    default:
      next.items[id]!.version += 1
      indexItem(&next, id: id)
    }
  }

  /// `patchItem` on whatever kind stands at `id`, through the shared fields only.
  static func patchAnyItem(_ next: inout ChatState, _ id: String, _ body: (inout TranscriptItem) -> Void) {
    guard next.items[id] != nil else { return }

    let version = next.items[id]!.version
    body(&next.items[id]!)
    next.items[id]!.version = version + 1
    indexItem(&next, id: id)
  }

  /// `recastItem`: turn the item already standing at `id` into a different item,
  /// in place.
  ///
  /// Used for exactly one thing: a resume that can identify the prompt a foreign
  /// `message.start` left a blank placeholder for. Appending the identified prompt
  /// instead would put it AFTER the reply it started, because the placeholder is
  /// already above the streaming bubble — so the item is replaced where it stands,
  /// keeping its id (a UI keyed on it does not remount) and its `seq` (the order
  /// does not move).
  static func recastItem(
    _ next: inout ChatState,
    _ id: String,
    ts: Double?,
    origin: ItemOrigin,
    _ make: (ItemBase) -> TranscriptItem
  ) {
    guard let current = next.items[id] else { return }

    let item = make(ItemBase(id: id, seq: current.seq, ts: ts, origin: origin, version: current.version + 1))

    next.items[id] = item
    indexItem(&next, item)
  }

  /// `dropItem`.
  static func dropItem(_ next: inout ChatState, _ id: String) {
    next.items[id] = nil

    if let at = next.order.firstIndex(where: { JS.same($0, id) }) {
      next.order.remove(at: at)
    }
  }
}

// MARK: - The turn

extension TranscriptReducer {
  /// The oldest prompt of ours the gateway has parked, if any.
  ///
  /// Oldest first, because the gateway drains its queue in order. `pending` is set
  /// by `beginLocalTurn` and cleared by `confirmSubmit` for anything the gateway
  /// took straight away, so what is left marked is exactly the parked queue.
  ///
  /// `firstParkedPromptId`.
  static func firstParkedPromptID(_ next: ChatState) -> String? {
    for id in next.order {
      if case .user(let item)? = next.items[id], item.origin == .optimistic, item.pending == true {
        return item.id
      }
    }

    return nil
  }

  /// `lastAssistantId`.
  static func lastAssistantID(_ next: ChatState) -> String? {
    for id in next.order.reversed() where !id.isEmpty {
      if case .assistant? = next.items[id] {
        return id
      }
    }

    return nil
  }

  /// `lastItem`.
  static func lastItem(_ next: ChatState) -> TranscriptItem? {
    itemAt(next, next.order.last)
  }

  /// The assistant bubble currently receiving deltas, created on first need.
  ///
  /// `currentAssistantId`.
  static func currentAssistantID(_ next: inout ChatState, _ now: Double) -> String {
    if case .assistant(let existing)? = itemAt(next, next.turn.assistantID), !existing.interim {
      return existing.id
    }

    let id = addItem(&next, id: "a:\(next.turn.nextSeq)", ts: now / 1000) { base in
      .assistant(AssistantItem(base: base, text: "", streaming: true, interim: false))
    }

    next.turn.assistantID = id

    return id
  }

  /// Where this turn's thinking goes. One turn, one thought.
  ///
  /// The three events that carry reasoning do not all arrive while the same bubble
  /// is live. `reasoning.delta` streams before the first token, so it lands on the
  /// bubble the turn is building. `reasoning.available` is sent by
  /// `tool_progress._progress_reasoning` — which is to say AFTER a tool call has
  /// already sealed that bubble as an interim note — so resolving it through
  /// `turn.assistantId` alone opened a SECOND bubble carrying the same block. That
  /// is the owner's "every thought appears twice": one `Thought for 1s` above the
  /// sealed note, an identical one above the reply.
  ///
  /// So the turn remembers which item holds its thought, and every later frame of
  /// the same thinking goes back to it — including onto an item that has since been
  /// sealed, which is exactly right: the thought belongs to the moment it happened,
  /// not to whichever bubble happens to be open when the gateway gets round to
  /// summarising it.
  ///
  /// `reasoningTargetId`.
  static func reasoningTargetID(_ next: inout ChatState, _ now: Double) -> String {
    if case .assistant(let live)? = itemAt(next, next.turn.assistantID), !live.interim {
      next.turn.reasoningID = live.id

      return live.id
    }

    if case .assistant(let held)? = itemAt(next, next.turn.reasoningID) {
      return held.id
    }

    let id = currentAssistantID(&next, now)

    next.turn.reasoningID = id

    return id
  }

  /// The sealed interim the next preview should overwrite, if there is one.
  ///
  /// `message.interim` is the reply SO FAR, not a message of its own: the gateway
  /// sends one per mid-turn assistant message and each carries the whole text it
  /// has, so appending them stacked three muted bubbles of the same growing
  /// sentence above the answer. The next interim replaces the last one.
  ///
  /// "The last one" is deliberately narrow — the last assistant item, and only
  /// while nothing but a `status` line has been appended after it. A tool card
  /// between two interims means the second one is genuinely a second piece of
  /// commentary, with the call it follows standing between them, and merging those
  /// would drop text the reader watched arrive.
  ///
  /// `openInterimId`.
  static func openInterimID(_ next: ChatState) -> String? {
    for id in next.order.reversed() {
      guard let item = itemAt(next, id) else { continue }

      if case .status = item {
        continue
      }

      if case .assistant(let assistant) = item, assistant.interim, assistant.error == nil {
        return assistant.id
      }

      return nil
    }

    return nil
  }

  /// The bubble a mid-turn seal left behind, when this completion is plainly that
  /// same reply finishing rather than a new one.
  ///
  /// A tool call seals the streaming bubble as interim (`sealAssistantForTool`),
  /// so `message.complete` arrives with no live bubble to settle onto. Painting
  /// the final text as a NEW bubble then shows the reply twice — once partially
  /// streamed, once clean — while the gateway stored a single row. Upstream hit
  /// exactly this (`hermes-agent` #63679, and #74560 for the chained-turn variant)
  /// and settles the final onto the interim instead.
  ///
  /// The test is continuity, not equality: streaming can drop characters and the
  /// final can add a trailing delta, so either text being a prefix of the other
  /// means the same message. Two different replies cannot satisfy that, which is
  /// why this needs no boundary flag to be safe.
  ///
  /// `interimContinuedBy`.
  static func interimContinuedBy(_ next: ChatState, _ finalText: String) -> String? {
    let id = lastAssistantID(next)

    guard case .assistant(let item)? = itemAt(next, id), item.interim, item.error == nil else {
      return nil
    }

    let sealed = JS.trim(item.text)
    let final = JS.trim(finalText)

    if sealed.isEmpty || final.isEmpty {
      return nil
    }

    return JS.same(final, sealed) || JS.hasPrefix(final, sealed) || JS.hasPrefix(sealed, final) ? id : nil
  }

  /// A tool call interrupts the reply: seal what the bubble already said as
  /// mid-turn commentary so the tool card lands after it, and drop an empty one
  /// rather than strand a blank bubble.
  ///
  /// `sealAssistantForTool`.
  static func sealAssistantForTool(_ next: inout ChatState) {
    guard let id = JS.nonEmpty(next.turn.assistantID) else { return }

    let item = next.items[id]

    next.turn.assistantID = nil

    guard case .assistant(let assistant)? = item else { return }

    if JS.trim(assistant.text).isEmpty && JS.trim(assistant.reasoning ?? "").isEmpty {
      dropItem(&next, id)

      return
    }

    patchAssistant(&next, id) { draft in
      draft.streaming = false
      draft.interim = true
    }
  }

  /// `cancelOpenRequests`.
  static func cancelOpenRequests(_ next: inout ChatState, _ reason: String) {
    for id in next.order {
      switch next.items[id] {
      case .approval(let item)? where item.state == .open:
        patchRequest(&next, id, state: .cancelled, cancelReason: reason)
      case .clarify(let item)? where item.state == .open:
        patchRequest(&next, id, state: .cancelled, cancelReason: reason)
      default:
        break
      }
    }
  }

  /// `clearTurn`.
  static func clearTurn(_ next: inout ChatState) {
    next.turn.active = false
    // A prompt WE queued starts the next turn, and that turn is still ours. Going
    // non-local here is what used to make our own message arrive as a foreign
    // placeholder the moment the turn ahead of it finished.
    next.turn.local = next.queued?.local == true
    next.turn.assistantID = nil
    next.turn.reasoningID = nil
    next.turn.startedAt = nil
    next.turn.draftingTool = nil
    next.turn.interrupted = false
    next.queued = nil
    next.compacting = false
  }

  /// The one `noticeKind` a `notice` event may name; see the `notice` case in
  /// `Reducer+Message.swift`. `commandKind`.
  static func commandKind(_ value: JSONValue?) -> NoticeKind {
    value == .string("command") ? .command : .notice
  }

  /// `pushNotice`.
  @discardableResult
  static func pushNotice(
    _ next: inout ChatState,
    _ noticeKind: NoticeKind,
    _ title: String,
    _ body: String,
    _ now: Double
  ) -> String {
    addItem(&next, id: "n:\(next.turn.nextSeq)", ts: now / 1000) { base in
      .notice(NoticeItem(base: base, noticeKind: noticeKind, title: title, body: body.isEmpty ? nil : body))
    }
  }
}

// MARK: - In-place access per kind

/// An item kind `patchItem` can reach in place: `update` runs `body` on the payload
/// when `item` is of this kind and answers whether it was.
protocol ReducerPatchable: TranscriptItemProtocol {
  static func update(_ item: inout TranscriptItem, _ body: (inout Self) -> Void) -> Bool
}

extension AssistantItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout AssistantItem) -> Void) -> Bool {
    item.updateAssistant(body) != nil
  }
}

extension ToolItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout ToolItem) -> Void) -> Bool {
    item.updateTool(body) != nil
  }
}

extension UserItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout UserItem) -> Void) -> Bool {
    item.updateUser(body) != nil
  }
}

extension BotDmOutItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout BotDmOutItem) -> Void) -> Bool {
    item.updateBotDmOut(body) != nil
  }
}

extension SubagentGroupItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout SubagentGroupItem) -> Void) -> Bool {
    item.updateSubagentGroup(body) != nil
  }
}

extension StatusItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout StatusItem) -> Void) -> Bool {
    item.updateStatus(body) != nil
  }
}

extension ApprovalItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout ApprovalItem) -> Void) -> Bool {
    item.updateApproval(body) != nil
  }
}

extension ClarifyItem: ReducerPatchable {
  static func update(_ item: inout TranscriptItem, _ body: (inout ClarifyItem) -> Void) -> Bool {
    item.updateClarify(body) != nil
  }
}
