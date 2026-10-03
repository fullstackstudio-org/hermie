import HermieProtocol

// Row, call and turn identity (`reducer.ts`, "row, call and turn identity")
// =========================================================================
//
// A gateway that knows which row a frame is about says so (`Identity.swift`), and
// then the frame is paired by that id and by nothing else. The owner's report is
// what this is for: a chat reopened from a cache saved mid-turn reads history
// first and replays the turn's frames after it, and every frame that described
// a row history had just brought stood its own bubble or card up beside it —
// every note twice, normal and then grey, every tool card twice. Words and
// stream position cannot tell "this note again" from "a new note saying the
// same"; the row id can. Every branch below is taken only when the frame carries
// the id, so a gateway that sends none keeps the paths elsewhere exactly as they
// were.

extension TranscriptReducer {
  /// The item standing for persisted row `rowID`, when one is actually on screen.
  ///
  /// `itemAtRow`.
  static func itemAtRow(_ next: ChatState, _ rowID: Int) -> TranscriptItem? {
    itemAt(next, next.byRowID[String(rowID)])
  }

  /// `itemAtRow` for a row id read raw off a payload (`num(payload.call_row_id)`),
  /// keyed the way JavaScript's `String(rowId)` spells the number.
  static func itemAtRow(_ next: ChatState, number rowID: Double) -> TranscriptItem? {
    itemAt(next, next.byRowID[JS.string(rowID)])
  }

  /// The card for call `callKey`, when one is actually on screen.
  ///
  /// `itemAtCall`.
  static func itemAtCall(_ next: ChatState, _ callKey: String) -> TranscriptItem? {
    guard let item = itemAt(next, next.byCallKey[callKey]), let held = item.callKey, JS.same(held, callKey) else {
      return nil
    }

    return item
  }

  /// The card a tool frame is about.
  ///
  /// Without a call identity this is `byToolId` and nothing else, as it always
  /// was. With one, the call key decides; `byToolId` is only asked after it, and
  /// its answer is refused when that card names a DIFFERENT call — a provider that
  /// numbers every turn's calls `call_0` would otherwise hand this turn's result to
  /// an earlier turn's card, which is exactly the clobbering a call key exists to
  /// end. A card that names no call at all (drawn before the gateway sent one) is
  /// still accepted: nothing says it is someone else's.
  ///
  /// `toolCardIdFor`.
  static func toolCardIDFor(_ next: ChatState, _ toolID: String, _ callKey: String?) -> String? {
    guard let callKey = JS.nonEmpty(callKey) else {
      return toolID.isEmpty ? nil : next.byToolID[toolID]
    }

    if let byCall = itemAtCall(next, callKey) {
      return byCall.id
    }

    guard !toolID.isEmpty, let candidate = itemAt(next, next.byToolID[toolID]) else {
      return nil
    }

    let candidateKey = candidate.callKey

    return candidateKey == nil || JS.same(candidateKey!, callKey) ? candidate.id : nil
  }

  /// Give `itemID` the persisted row id `rowID`, unless another item already
  /// stands for that row — then nothing changes and that item's id comes back, so
  /// one row can never be described by two items.
  ///
  /// `assignRowId`.
  @discardableResult
  static func assignRowID(_ next: inout ChatState, _ itemID: String, _ rowID: Int) -> String {
    if let holder = itemAtRow(next, rowID), !JS.same(holder.id, itemID) {
      return holder.id
    }

    guard let item = next.items[itemID], item.rowID != rowID else {
      return itemID
    }

    if let old = item.rowID, let indexed = next.byRowID[String(old)], JS.same(indexed, itemID) {
      next.byRowID[String(old)] = nil
    }

    patchAnyItem(&next, itemID) { draft in
      draft.rowID = rowID
    }

    return itemID
  }

  /// Fold the live bubble `liveID` onto the row that already stands for it.
  ///
  /// The row keeps its id, its place and its text: it is what the gateway wrote,
  /// and a reader may already be looking at it. It takes only what the stream
  /// alone knew and the row does not say — the thought, its verbosity, the usage.
  /// Never a duration: this reducer cannot tell a turn it timed from its own
  /// `message.start` from frames a replay is handing it minutes later, and a row
  /// stamped "took 4 minutes" for a 3-second turn is worse than a row with no
  /// stamp. The live bubble then goes, and the turn's pointers move with it.
  ///
  /// `settleOntoRow`.
  static func settleOntoRow(_ next: inout ChatState, _ liveID: String, _ rowItemID: String) {
    guard !JS.same(liveID, rowItemID), case .assistant(let live)? = next.items[liveID],
      case .assistant(let row)? = next.items[rowItemID]
    else {
      return
    }

    let reasoning = JS.nonEmpty(row.reasoning) == nil ? JS.nonEmpty(live.reasoning) : nil
    let verbose = row.reasoningVerbose == nil && live.reasoningVerbose == true ? true : nil
    let usage = row.usage == nil ? live.usage : nil

    if reasoning != nil || verbose != nil || usage != nil {
      patchAssistant(&next, rowItemID) { draft in
        if let reasoning {
          draft.reasoning = reasoning
        }

        if let verbose {
          draft.reasoningVerbose = verbose
        }

        if let usage {
          draft.usage = usage
        }
      }
    }

    dropItem(&next, liveID)
    next.turn.assistantID = nil

    // The turn's thought follows the bubble that held it. A pointer at some OTHER
    // item that is still there is left alone: that is where this turn's thinking
    // already lives (`reasoningTargetId`).
    let held = next.turn.reasoningID

    if held == nil || JS.same(held!, liveID) || next.items[held!] == nil {
      next.turn.reasoningID = rowItemID
    }
  }

  /// A tool call names the assistant row that holds it (`call_row_id`), and that
  /// row IS the bubble the call interrupts: the words streamed in the same model
  /// call, persisted with the call before the call ran. So the bubble a tool call
  /// is about to seal is folded onto that row when it is on screen — a chat whose
  /// gateway sends no `message.interim` (interims off, or a note whose words it had
  /// already delivered once) has nothing else that says which row the note became
  /// — and is stamped with it when it is not, so the row pairs with it by id later.
  ///
  /// `settleLiveOntoCallRow`. `callRowID` is read raw (`num`), as the TypeScript
  /// reads it; a row id the model cannot hold as an integer stamps nothing.
  static func settleLiveOntoCallRow(_ next: inout ChatState, _ callRowID: Double) {
    guard case .assistant(let live)? = itemAt(next, next.turn.assistantID), live.rowID == nil else {
      return
    }

    if let row = itemAtRow(next, number: callRowID) {
      if case .assistant = row {
        settleOntoRow(&next, live.id, row.id)
      }

      return
    }

    // An empty bubble is dropped by the seal that follows; it has nothing to stamp.
    if !JS.trim(live.text).isEmpty || !JS.trim(live.reasoning ?? "").isEmpty, let rowID = Int(exactly: callRowID) {
      assignRowID(&next, live.id, rowID)
    }
  }

  /// `message.interim` for a note the gateway has already persisted as row `rowID`.
  ///
  /// Returns false only when the row id is held by something that is not a note —
  /// a renumbered store, not this note — and the frame then takes the path a
  /// gateway without row ids takes.
  ///
  /// `interimOntoRow`.
  static func interimOntoRow(_ next: inout ChatState, _ text: String, _ rowID: Int, _ now: Double) -> Bool {
    let live = itemAt(next, next.turn.assistantID)
    let row = itemAtRow(next, rowID)

    if let row, row.kind != .assistant {
      return false
    }

    if let row {
      // The note is on screen already (history brought it): the bubble that was
      // streaming it IS that row. The row's own text and shape stay as written.
      if case .assistant(let streaming)? = live, !JS.same(streaming.id, row.id), streaming.rowID == nil {
        settleOntoRow(&next, streaming.id, row.id)
      }

      next.turn.assistantID = nil

      return true
    }

    if case .assistant(let streaming)? = live {
      patchAssistant(&next, streaming.id) { draft in
        if !text.isEmpty {
          draft.text = text
        }

        draft.streaming = false
        draft.interim = true

        if draft.rowID == nil {
          draft.rowID = rowID
        }
      }
      next.turn.assistantID = nil

      return true
    }

    if text.isEmpty {
      return true
    }

    // An open note with no row of its own is this note delivered before the
    // gateway had a row id for it; a note that names a DIFFERENT row is another
    // note, and gets a bubble of its own.
    if let open = JS.nonEmpty(openInterimID(next)), next.items[open]?.rowID == nil {
      patchAssistant(&next, open) { draft in
        draft.text = text
        draft.rowID = rowID
      }

      return true
    }

    addItem(&next, id: "a:\(next.turn.nextSeq)", ts: now / 1000) { base in
      var base = base
      base.rowID = rowID

      return .assistant(AssistantItem(base: base, text: text, streaming: false, interim: true))
    }

    return true
  }

  /// `id`, when it names an assistant bubble that does not yet stand for any row.
  ///
  /// `unpersistedNote`.
  static func unpersistedNote(_ next: ChatState, _ id: String?) -> String? {
    guard case .assistant(let item)? = itemAt(next, id), item.rowID == nil else { return nil }
    return item.id
  }

  /// Give our own prompt the id of the turn it started.
  ///
  /// `message.start` names no author, so which prompt a turn belongs to is
  /// known only when there is exactly one candidate: a local, still-optimistic
  /// prompt that names no turn yet (a steer starts none). Two or more — an earlier
  /// send that never came back, say — and nothing is stamped; the prompt then pairs
  /// with its row the way it always did.
  ///
  /// `stampLocalPrompt`.
  static func stampLocalPrompt(_ next: inout ChatState, _ turnID: String) {
    var candidate: String?

    for id in next.order {
      guard case .user(let item)? = next.items[id], item.origin == .optimistic, JS.nonEmpty(item.turnID) == nil,
        item.rowID == nil, item.displayKind != .steer
      else {
        continue
      }

      if candidate != nil {
        return
      }

      candidate = item.id
    }

    if let candidate, userItemOfTurn(next, turnID) == nil {
      patchUser(&next, candidate) { draft in
        draft.turnID = turnID
      }
    }
  }

  /// The user item that opened turn `turnID`, when one is on screen.
  ///
  /// `userItemOfTurn`.
  static func userItemOfTurn(_ next: ChatState, _ turnID: String) -> UserItem? {
    for id in next.order {
      if case .user(let item)? = next.items[id], let held = item.turnID, JS.same(held, turnID) {
        return item
      }
    }

    return nil
  }
}
