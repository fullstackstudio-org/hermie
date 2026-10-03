import HermieProtocol

// Turns, and the second description of a message inside one (`turns.ts`)
// =======================================================================
//
// A message the bot writes in the middle of a turn reaches a client more than
// once. The gateway streams it (`message.delta`), PERSISTS it as an assistant
// row, and only then announces it as `message.interim {text, already_streamed}`
// (`agent/turn_tool_round.py`: "emit interim commentary after the DB append").
// Neither frame carries a row id or a message id. Later the same words come back
// as a `session.history` row with a `row_id`, and — when a chat is opened from a
// cache saved mid-turn — the frames come back too, through `session.events.since`,
// on top of rows that already describe them.
//
// With no id in common, the words are the key, and the words are only a safe key
// inside one turn: the gateway never delivers the same interim text twice in a
// turn (`_delivered_interim_texts`, reset per user turn), while two turns are free
// to say "On it." each. So everything here is scoped to the turn an item belongs
// to, and nothing pairs across a prompt.

/// An item that opens a turn: the prompt it answers.
///
/// A cron delivery counts: the scheduler's report runs on the `user` role and
/// starts a turn nobody local submitted. A gateway-injected notice counts for the
/// same reason — the gateway runs a turn on it.
///
/// A STEER does not count, although it is a `user` row. It is handed to the turn
/// already running and starts none of its own, which is also why the gateway's
/// interim de-duplication carries on across it.
///
/// `opensTurn`.
func opensTurn(_ item: TranscriptItem) -> Bool {
  switch item {
  case .user(let user): user.displayKind != .steer
  case .botDmIn, .cronDelivery: true
  default: isInjectedNotice(item)
  }
}

/// Whether two texts are the same words, as the gateway's own de-duplication
/// compares them. `sameWords`.
func sameWords(_ a: String, _ b: String) -> Bool {
  let left = normalizeMatchText(a)

  return !left.isEmpty && JS.same(left, normalizeMatchText(b))
}

/// Whether a persisted item came from a projection that had no live item for it.
///
/// `reconcile` and `reconcileTail` keep the LIVE item's id when they pair it with
/// its row, so a persisted item whose id is still the projection's own `r:<row>`
/// was never anybody's live bubble. That is the one row a stray live copy may be
/// folded into: a row that already took over a live bubble was that bubble's
/// row, and a second live item with the same words beside it is a second message
/// (one whose row has not arrived yet), not a copy.
///
/// `fromHistoryOnly`.
func fromHistoryOnly(_ item: TranscriptItem) -> Bool {
  guard let rowID = item.rowID else { return false }

  return JS.same(item.id, "r:\(rowID)")
}

/// Tool-like items: the calls a turn's notes stand between. `isCall`.
func isCall(_ item: TranscriptItem) -> Bool {
  switch item {
  case .tool, .botDmOut, .subagentGroup: true
  default: false
  }
}

/// Whether an item is settled transcript rather than something a stream is still
/// building. `isSettled`.
private func isSettled(_ item: TranscriptItem) -> Bool {
  item.rowID != nil || item.origin == .history
}

/// A live assistant item that may be a second description of a row: written by
/// the stream, never paired with a row, and finished.
///
/// The bubble the stream is still filling is never one — its words are not final,
/// and pairing on a prefix is exactly how two different messages get merged.
///
/// `isLiveCopyCandidate`.
func liveCopyCandidate(_ item: TranscriptItem, activeID: String?) -> AssistantItem? {
  guard case .assistant(let assistant) = item, assistant.rowID == nil, assistant.origin != .history,
    !assistant.streaming, assistant.error == nil, activeID.map({ !JS.same(assistant.id, $0) }) ?? true,
    isMatchable(item)
  else { return nil }

  return assistant
}

/// Fold live copies into the rows they describe, one turn at a time.
///
/// The rows a re-hydration brings are matched by row id first, so a live item a
/// replay stood up NEXT to a row that was already on screen is never matched by
/// anything and survives beside it — the muted copy under the real note. This is
/// the pass that pairs those: same turn, same words, one copy per row, in order.
///
/// Conservative on purpose, because the same words can be two messages:
///
/// - Only a row that came from history alone can take a copy (`fromHistoryOnly`).
///   A row that already absorbed a live bubble has its live description.
/// - A sealed note (`interim`) pairs with any such row of its turn: the gateway
///   never sends one interim text twice in a turn.
/// - A finished reply pairs only with the turn's LAST settled assistant row, and
///   only when no settled call follows that row: that is where a turn's reply is,
///   and a note with the same words sits before a call.
///
/// `foldLiveCopies`.
func foldLiveCopies(_ list: [TranscriptItem], activeID: String?) -> [TranscriptItem] {
  var dropped = Set<Int>()
  var replaced: [Int: AssistantItem] = [:]

  func foldTurn(_ from: Int, _ to: Int) {
    let rows = (from..<to).filter { index in
      if case .assistant = list[index] { fromHistoryOnly(list[index]) } else { false }
    }

    if rows.isEmpty {
      return
    }

    // The turn's reply: its last settled assistant row, unless a settled call
    // comes after it.
    var reply: Int?

    for index in stride(from: to - 1, through: from, by: -1) {
      let item = list[index]

      if isCall(item) && isSettled(item) {
        break
      }

      if case .assistant = item, isSettled(item) {
        reply = fromHistoryOnly(item) ? index : nil
        break
      }
    }

    var taken = Set<Int>()
    let wordsAt = { (index: Int) in list[index].asAssistant?.text ?? "" }

    for index in from..<to {
      guard let item = liveCopyCandidate(list[index], activeID: activeID) else { continue }

      let row: Int? =
        item.interim
        ? rows.first { !taken.contains($0) && sameWords(wordsAt($0), item.text) }
        : reply.flatMap { !taken.contains($0) && sameWords(wordsAt($0), item.text) ? $0 : nil }

      guard let row, let persisted = list[row].asAssistant else { continue }

      taken.insert(row)
      dropped.insert(index)
      replaced[row] = carryLiveKnowledge(persisted, item)
    }
  }

  var start = 0

  for (index, item) in list.enumerated() where opensTurn(item) {
    foldTurn(start, index)
    start = index + 1
  }

  foldTurn(start, list.count)

  if dropped.isEmpty {
    return list
  }

  return list.enumerated().compactMap { index, item in
    if dropped.contains(index) {
      return nil
    }

    return replaced[index].map(TranscriptItem.assistant) ?? item
  }
}

/// The row, with whatever only the live copy knew: history carries no duration,
/// no usage, and on older gateways no reasoning. `carryLiveKnowledge`.
func carryLiveKnowledge(_ row: AssistantItem, _ live: AssistantItem) -> AssistantItem {
  var carried = row

  carried.reasoning = row.reasoning ?? live.reasoning
  carried.reasoningVerbose = row.reasoningVerbose ?? live.reasoningVerbose
  carried.durationS = row.durationS ?? live.durationS
  carried.usage = row.usage ?? live.usage
  carried.version = row.version &+ 1

  return carried
}

/// What of a resume's flattened reply the transcript does not already show.
///
/// `inflight.assistant` is every `message.delta` of the running turn run together
/// (`_append_inflight_delta`), so once a tool round has sealed a note, the note's
/// words are at the head of it. `earlier` is the turn's assistant items above the
/// bubble being resumed, in order. Each one whose words open what is left is cut
/// off; one that does not (a note that was never streamed, such as Codex
/// commentary) is passed over. Nothing in the middle is ever removed.
///
/// `nil` when nothing was cut, so a caller can keep its old behaviour to the
/// letter. `unshownTail`.
func unshownTail(_ flat: String, _ earlier: [AssistantItem]) -> String? {
  var rest = flat
  var cut = false

  for item in earlier {
    let words = JS.trim(item.text)
    let head = JS.trimStart(rest)

    if !words.isEmpty && JS.hasPrefix(head, words) {
      rest = JS.slice(head, JS.length(words))
      cut = true
    }
  }

  return cut ? JS.trimStart(rest) : nil
}
