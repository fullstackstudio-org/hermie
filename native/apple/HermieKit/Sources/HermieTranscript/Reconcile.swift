import HermieProtocol

// Reconciliation: fold a freshly hydrated transcript into the live state
// without losing the tail and without renaming items (`reconcile.ts`).
//
// Stable ids are the point. A UI keyed on `item.id` must not remount every row
// when a re-hydration lands, so a fresh item adopts the id of the current item
// it matches: durable `rowId` first, then the gateway's turn and call identities
// (`turnId`, `callKey`), then `tool_id`, then what the item says and carries
// (`itemMatchKey`).
//
// Ported from `apps/desktop/src/lib/chat-messages/reconciliation.ts`.
//
// The three operations are pure `(state, items) -> state`, as in the TypeScript:
// each rebuilds the whole id-keyed state through `rebuild` anyway, so there is no
// in-place variant to gain anything from.

/// `toolKeyOf`. Empty counts as no key, as everywhere the TypeScript tests it.
private func toolKeyOf(_ item: TranscriptItem) -> String? {
  let key: String? =
    switch item {
    case .tool(let tool): tool.toolID
    case .botDmOut(let outbound): outbound.toolID
    case .subagentGroup(let group): group.toolID
    default: nil
    }
  return key.flatMap { $0.isEmpty ? nil : $0 }
}

/// The gateway's call identity on an item kind that can carry one (`Identity.swift`).
///
/// `callKeyOfItem`. Empty counts as none, as the TypeScript's truthiness tests it.
private func callKeyOfItem(_ item: TranscriptItem) -> String? {
  JS.nonEmpty(item.callKey)
}

/// The gateway's turn identity on a prompt.
///
/// `turnIdOfItem`.
private func turnIDOfItem(_ item: TranscriptItem) -> String? {
  JS.nonEmpty(item.asUser?.turnID)
}

/// The turn a history row started when it did NOT become a bubble of the owner's:
/// a notice, a report or a bot message carries it as `turnID`, and a delivery row
/// that joined its dispatch card (so left no item of its own) lays it on the
/// card's `reply`. The turn's placeholder is settled by exactly this.
///
/// `turnOfOtherRow`.
private func turnOfOtherRow(_ item: TranscriptItem) -> String? {
  switch item {
  case .user: nil
  case .botDmOut(let outbound): JS.nonEmpty(outbound.turnID) ?? JS.nonEmpty(outbound.reply?.turnID)
  default: JS.nonEmpty(item.turnID)
  }
}

/// A placeholder `message.start` stood up for the author of a turn, not yet filled.
///
/// `isTurnPlaceholder`.
private func isTurnPlaceholder(_ item: TranscriptItem?) -> Bool {
  guard case .user(let user)? = item else { return false }
  return user.unknownAuthor == true && JS.nonEmpty(user.turnID) != nil
}

/// Whether `current`, found by a call key or a turn id, may be `fresh`.
///
/// The id says they are the same call or turn; a row id that says otherwise
/// wins, because two persisted rows are two rows whatever else they share.
///
/// `rowsAgree`.
private func rowsAgree(_ current: TranscriptItem, _ fresh: TranscriptItem) -> Bool {
  current.rowID == nil || fresh.rowID == nil || current.rowID == fresh.rowID
}

/// Whether two items the old keys paired may really be one, as far as the
/// gateway's identities go: two different calls, or two different turns, are
/// never one item, however alike their tool ids or words. An item without the
/// identity says nothing either way, which is every item from before it existed.
///
/// `identitiesAgree`.
private func identitiesAgree(_ a: TranscriptItem?, _ b: TranscriptItem) -> Bool {
  guard let a else { return true }

  let callA = callKeyOfItem(a)
  let callB = callKeyOfItem(b)
  let turnA = turnIDOfItem(a)
  let turnB = turnIDOfItem(b)

  return (callA == nil || callB == nil || JS.same(callA!, callB!))
    && (turnA == nil || turnB == nil || JS.same(turnA!, turnB!))
}

/// Whether two items that say the same thing may be the same turn, as far as
/// WHO said it goes (HERM-83).
///
/// In a group chat two people can both say "ok", and a key made of the words
/// alone paired the reader's optimistic "ok" with a colleague's persisted one —
/// handing the reader's bubble the colleague's row and author, and losing the
/// reader's own turn. So two items that each name an author pair only when it
/// is the same author.
///
/// One side without an author still pairs. That is a gateway that stamps nobody
/// answering a reader whose identity is known — the bubble carries an author,
/// its row does not — and they are one turn; refusing them would draw every
/// message that reader sends twice. It is also every row from before the stamp
/// existed, which is how pairing always worked.
private func authorsAgree(_ a: TranscriptItem?, _ b: TranscriptItem) -> Bool {
  let left = a?.asUser?.author?.id ?? ""
  let right = b.asUser?.author?.id ?? ""

  return left.isEmpty || right.isEmpty || JS.same(left, right)
}

/// Notice kinds this client mints itself and the gateway never writes as a row —
/// see the `'command'` case of `NoticeKind` in `types.ts` and `session.reclaimed`
/// (`reducer.ts`), which is a broadcast, not a persisted turn. A re-hydration has
/// nothing to match either against, ever, no matter how long the client waits.
private func isEphemeralNotice(_ item: TranscriptItem) -> Bool {
  guard case .notice(let notice) = item else { return false }
  return notice.noticeKind == .command || notice.noticeKind == .reclaimed
}

/// Items the backend never persists, so a re-hydration can never re-supply them.
private func isEphemeral(_ item: TranscriptItem) -> Bool {
  switch item {
  case .approval, .clarify, .request: true
  default: isEphemeralNotice(item)
  }
}

/// Something the reader has already settled, as opposed to a question still
/// open or a card still waiting on an answer.
///
/// It is the difference between a question and a record of one, and the two
/// belong in different places. An OPEN request is being asked NOW: it stands at
/// the tail whatever timestamp it carries, because that is where the reader is
/// looking and where the turn is waiting. An ANSWERED or CANCELLED one is a line
/// in the transcript like any other, and its place is the moment it happened.
///
/// Which is the whole of the owner's report. A card answered yesterday is cached
/// (`cache.ts` keeps everything but an open request), painted on a cold open, and
/// then survives the history re-hydration as an item history can never re-supply
/// — and was appended BEHIND every row that hydration brought back, including
/// this morning's. `layoutRows` stamps a date wherever the day changes between
/// neighbours, so the reader got `TODAY`, yesterday's card, and `TODAY` again.
///
/// A `command` or `reclaimed` notice is the same shape of problem with no "open"
/// state to protect: a slash command's answer and a reclaimed-session notice are
/// always a record of something that already happened, so they always belong
/// here rather than in the plain `kept` bucket `placeByTimestamp` never sorts.
private func isSettledRequest(_ item: TranscriptItem) -> Bool {
  switch item {
  case .approval(let approval): approval.state != .open
  case .clarify(let clarify): clarify.state != .open
  case .request(let request): request.state != .open
  default: isEphemeralNotice(item)
  }
}

/// Put items that carry their own moment back into it, rather than at the end.
///
/// Only for the handful of items a re-hydration keeps without being able to place
/// them: they have no row id, so `inRowOrder` has nothing to sort them by, and
/// the timestamp they were created with is the only thing that says where they
/// belong. Each one goes in front of the first item that is strictly NEWER than
/// it; an item carrying no timestamp of its own is passed over, because its
/// position is the one its neighbours gave it. Nothing newer than the whole list
/// moves at all, which is the ordinary live case — a card answered a moment ago
/// still lands at the tail, exactly as it did before.
///
/// Deliberately not a sort of the transcript. A streaming bubble, an interim note
/// and an optimistic submit each have ordering rules of their own that a
/// timestamp does not know about, and re-sorting the whole list by `ts` would
/// overrule every one of them.
private func placeByTimestamp(_ list: [TranscriptItem], _ floating: [TranscriptItem]) -> [TranscriptItem] {
  var placed = list

  for item in floating {
    guard let ts = item.ts else {
      placed.append(item)

      continue
    }

    let newer = placed.firstIndex { other in other.ts.map { $0 > ts } ?? false }

    placed.insert(item, at: newer ?? placed.count)
  }

  return placed
}

/// A row that opens a turn, and therefore names the author a foreign
/// `message.start` placeholder is standing in for.
///
/// A cron delivery counts: the scheduler's report runs on the `user` role and
/// starts a turn nobody local submitted, so it is exactly what such a placeholder
/// is waiting for. `mergeWithLive` needs no cron case of its own — the stream
/// learns nothing about a delivery that the persisted row does not also carry, so
/// the default "fresh wins, id is kept" merge is already correct.
///
/// A gateway-injected notice counts for the same reason: a fan-out's report or a
/// background process's completion is written on the `user` role and the gateway
/// runs a turn on it. Without this the placeholder had nothing to become and
/// stayed on screen as an empty bubble beside the card.
///
/// A STEER does not count, although it is a `user` row. It is handed to the turn
/// already running and starts none of its own, so letting it fill a placeholder
/// would draw a mid-turn correction as the prompt of somebody else's turn.
private func isAuthoredRow(_ item: TranscriptItem) -> Bool {
  switch item {
  case .user(let user): user.displayKind != .steer
  case .botDmIn, .cronDelivery: true
  default: isInjectedNotice(item)
  }
}

/// Merge live knowledge onto a hydrated row: history is thinner than the stream.
private func mergeWithLive(_ fresh: TranscriptItem, _ current: TranscriptItem) -> TranscriptItem {
  var merged = fresh
  merged.id = current.id
  merged.version = current.version &+ 1

  if merged.kind != current.kind {
    return merged
  }

  // An identity either side learned is kept: a row from a history projection
  // that predates it, merged onto a card the stream named, still names its call.
  if let callKey = callKeyOfItem(current), callKeyOfItem(merged) == nil {
    merged.callKey = callKey
  }

  if let turnID = turnIDOfItem(current), case .user(var user) = merged, JS.nonEmpty(user.turnID) == nil {
    user.turnID = turnID
    merged = .user(user)
  }

  switch (merged, current) {
  case (.tool(var carried), .tool(let current)):
    // A history tool row has a name and a preview but never a result.
    if !carried.resultKnown && current.resultKnown {
      carried.resultKnown = true
      carried.result = current.result
      carried.status = current.status
      carried.isError = current.isError
      carried.resultText = current.resultText ?? carried.resultText
      carried.summary = carried.summary ?? current.summary
      carried.inlineDiff = current.inlineDiff ?? carried.inlineDiff
      carried.durationS = current.durationS ?? carried.durationS
      carried.argsText = current.argsText ?? carried.argsText
      carried.outputRisk = current.outputRisk ?? carried.outputRisk
    }

    return .tool(carried)

  case (.botDmOut(var carried), .botDmOut(let current)):
    if carried.dispatch.status == .unknown {
      carried.dispatch = current.dispatch
    }

    carried.reply = carried.reply ?? current.reply
    // A tool row carries no timestamp, so the moment the dispatch went out is
    // known only to the stream that watched it leave. Losing it on the merge
    // would take the row's date stamp with it.
    carried.ts = carried.ts ?? current.ts

    return .botDmOut(carried)

  case (.subagentGroup(var carried), .subagentGroup(let current)):
    carried.rootIDs = current.rootIDs.isEmpty ? carried.rootIDs : current.rootIDs
    carried.delegationID = carried.delegationID ?? current.delegationID
    carried.completion = carried.completion ?? current.completion

    if carried.status == .dispatched && current.status != .dispatched {
      carried.status = current.status
    }

    return .subagentGroup(carried)

  case (.assistant(var carried), .assistant(let current)):
    carried.reasoning = carried.reasoning ?? current.reasoning
    carried.reasoningVerbose = carried.reasoningVerbose ?? current.reasoningVerbose
    carried.durationS = carried.durationS ?? current.durationS
    carried.usage = carried.usage ?? current.usage
    carried.outbox = carried.outbox ?? current.outbox
    carried.sources = carried.sources ?? current.sources
    // A failed turn is not persisted as a failure; keep the local verdict.
    carried.error = carried.error ?? current.error
    carried.status = current.error != nil ? (current.status ?? carried.status) : carried.status

    return .assistant(carried)

  case (.user(var carried), .user(let current)):
    carried.attachments = carried.attachments ?? current.attachments
    carried.pending = false

    return .user(carried)

  default:
    return merged
  }
}

/// Put a merged list back into the gateway's own row order.
///
/// `reconcileTail` splices rows it has never seen in front of the live tail,
/// which is right whenever they were written after everything on screen — and
/// wrong the moment they were not. A teammate's delivery or a cron turn written
/// while the user was still typing carries a LOWER row id than the message they
/// then sent, so arrival order shows the two the wrong way round, and the ids
/// that say so only arrive with the tail.
///
/// Row ids are the order the gateway holds, so a persisted item sorts by its own.
/// An item with no row id yet sorts with the newest row above it, which keeps a
/// streaming bubble under the prompt it answers and keeps a row genuinely newer
/// than the whole live tail behind that tail, exactly as the splice intended.
private func inRowOrder(_ list: [TranscriptItem]) -> [TranscriptItem] {
  var newestAbove = -1
  var keyed: [(key: Int, index: Int)] = []
  keyed.reserveCapacity(list.count)

  for (index, item) in list.enumerated() {
    keyed.append((item.rowID ?? newestAbove, index))
    newestAbove = max(newestAbove, item.rowID ?? -1)
  }

  keyed.sort { $0.key != $1.key ? $0.key < $1.key : $0.index < $1.index }

  return keyed.map { list[$0.index] }
}

private func rebuild(_ state: ChatState, _ list: [TranscriptItem]) -> ChatState {
  var next = state
  next.items = [:]
  next.items.reserveCapacity(list.count)
  next.order = []
  next.order.reserveCapacity(list.count)
  next.byToolID = [:]
  next.byCallKey = [:]
  next.byRowID = [:]
  next.byRequestID = [:]
  next.byApprovalID = [:]
  next.byProcessID = [:]
  next.byDelegationID = [:]

  for (index, item) in list.enumerated() {
    /*
      The id is re-checked here rather than assumed.

      A persisted item's id is its gateway ROW NUMBER, and a gateway that
      restarts under a live session numbers the rebuilt one from 1 again. So a
      freshly projected `r:4` and a live `r:4` kept from the tail are two
      different rows wearing one id, and this loop is the single funnel both
      reconcilers push `order` through. The earlier of the two keeps the id a
      list is keyed on; only the later is renamed.
    */
    var placed = item
    placed.id = freeItemID(next.items, item.id)
    placed.seq = index * seqStep
    let id = placed.id

    next.items[id] = placed
    next.order.append(id)

    if let rowID = placed.rowID {
      next.byRowID[String(rowID)] = id
    }

    if let toolKey = toolKeyOf(placed) {
      next.byToolID[toolKey] = id
    }

    if let callKey = JS.nonEmpty(placed.callKey) {
      next.byCallKey[callKey] = id
    }

    switch placed {
    case .botDmOut(let outbound):
      if let processID = outbound.dispatch.processID, !processID.isEmpty {
        next.byProcessID[processID] = id
      }
    case .subagentGroup(let group):
      if let delegationID = group.delegationID, !delegationID.isEmpty {
        next.byDelegationID[delegationID] = id
      }
    case .approval(let approval):
      next.byRequestID[approval.requestID] = id

      if !approval.approvalID.isEmpty {
        next.byApprovalID[approval.approvalID] = id
      }
    case .clarify(let clarify):
      next.byRequestID[clarify.requestID] = id
    case .request(let request):
      next.byRequestID[request.requestID] = id
    default:
      break
    }
  }

  /*
    `nextSeq` is a HIGH-WATER MARK, not a position.

    It was `list.length * SEQ_STEP`, which reads the counter off the transcript's
    current length — and a re-hydration is free to make the transcript SHORTER.
    Pull the gateway out from under a live session and the rebuilt one comes back
    with fewer rows than the client holds, so this line moved the counter
    BACKWARDS, onto seq values already spent on ids that are still in the list.
    The next send then minted an id the transcript already had: `order` is a
    list, so it grew a second entry pointing at the same item, which is React's
    "two children with the same key" and, on screen, the same user bubble twice.

    Seven seeded rows, a transcript that loses one on the rebuild, and sends the
    dead gateway never persisted is the arrangement that was reported, and it
    lands on `o:9000` exactly.

    The only thing the counter owes the order is to sit ABOVE every seq in the
    list, and `list.length * SEQ_STEP` still does that — so taking the larger of
    the two costs nothing and takes the collision away.
  */
  next.turn.nextSeq = max(state.turn.nextSeq, list.count * seqStep)

  if let assistantID = next.turn.assistantID, assistantID.isEmpty || next.items[assistantID] == nil {
    next.turn.assistantID = nil
  }

  return next
}

/// The ids of `matchKey`'s candidates, handed out first to last.
///
/// `byMatchKey.get(key)?.find(id => !used.has(id) && …)`, with a cursor that skips
/// the ids at the front already taken, so a history of a thousand identical "ok"s
/// does not rescan the taken ones for every row. Taken ids are never given back,
/// so skipping a taken prefix finds exactly what the scan would have found.
private struct MatchCandidates {
  private var ids: [String: [String]] = [:]
  private var cursor: [String: Int] = [:]

  mutating func append(_ id: String, for key: String) {
    ids[key, default: []].append(id)
  }

  mutating func first(for key: String, where acceptable: (String) -> Bool, isTaken: (String) -> Bool) -> String? {
    guard let list = ids[key] else { return nil }

    var start = cursor[key] ?? 0
    while start < list.count && isTaken(list[start]) { start += 1 }
    cursor[key] = start

    return list[start...].first { !isTaken($0) && acceptable($0) }
  }
}

/// Replace the transcript with `freshItems` (a full re-hydration), keeping ids
/// stable, keeping live knowledge history does not carry, and keeping the
/// not-yet-persisted tail plus any open request.
public func reconcile(_ state: ChatState, _ freshItems: [TranscriptItem]) -> ChatState {
  var byRowID: [Int: String] = [:]
  var byTurnID: [String: String] = [:]
  var byCallKey: [String: String] = [:]
  var byToolKey: [String: String] = [:]
  var byMatchKey = MatchCandidates()

  for id in state.order {
    guard let item = state.items[id] else {
      continue
    }

    if let rowID = item.rowID, byRowID[rowID] == nil {
      byRowID[rowID] = id
    }

    if let turnID = turnIDOfItem(item), byTurnID[turnID] == nil {
      byTurnID[turnID] = id
    }

    if let callKey = callKeyOfItem(item), byCallKey[callKey] == nil {
      byCallKey[callKey] = id
    }

    if let toolKey = toolKeyOf(item), byToolKey[toolKey] == nil {
      byToolKey[toolKey] = id
    }

    if let key = matchKeyIfMatchable(item) {
      byMatchKey.append(id, for: key)
    }
  }

  var used = Set<String>()
  var merged: [TranscriptItem] = []
  merged.reserveCapacity(freshItems.count)

  /// `!matchId || used.has(matchId)`.
  func unusable(_ id: String?) -> Bool {
    guard let id, !id.isEmpty else { return true }
    return used.contains(id)
  }

  /// A candidate found by an identity, when nothing has claimed it and no row id
  /// contradicts it.
  func byIdentity(_ id: String?, _ fresh: TranscriptItem) -> String? {
    guard let id, !id.isEmpty, !used.contains(id), let current = state.items[id] else { return nil }
    return rowsAgree(current, fresh) ? current.id : nil
  }

  /// Placeholders of a turn whose row history now brings, in whatever shape.
  var settledPlaceholders = Set<String>()

  for fresh in freshItems {
    // A row that opened a turn without becoming the owner's bubble is that turn's
    // placeholder's row: the placeholder has nothing left to wait for.
    if let rowTurnID = turnOfOtherRow(fresh), let standingID = byTurnID[rowTurnID], !standingID.isEmpty,
      !used.contains(standingID), isTurnPlaceholder(state.items[standingID])
    {
      used.insert(standingID)
      settledPlaceholders.insert(standingID)
    }

    var matchID = fresh.rowID.flatMap { byRowID[$0] }

    // The gateway's own identities next: the turn a prompt opened, the call a
    // card is. Each is unique where the words and the provider's tool ids are
    // not, so a pair made here needs nothing the reader can see to agree.
    if unusable(matchID) {
      matchID = turnIDOfItem(fresh).flatMap { byIdentity(byTurnID[$0], fresh) }
    }

    if unusable(matchID) {
      matchID = callKeyOfItem(fresh).flatMap { byIdentity(byCallKey[$0], fresh) }
    }

    if unusable(matchID) {
      matchID = toolKeyOf(fresh).flatMap { byToolKey[$0] }

      if let found = JS.nonEmpty(matchID), !identitiesAgree(state.items[found], fresh) {
        matchID = nil
      }
    }

    if unusable(matchID) {
      matchID = matchKeyIfMatchable(fresh).flatMap { key in
        byMatchKey.first(
          for: key,
          where: { authorsAgree(state.items[$0], fresh) && identitiesAgree(state.items[$0], fresh) },
          isTaken: { used.contains($0) }
        )
      }
    }

    if !unusable(matchID), let matchID, let current = state.items[matchID] {
      used.insert(current.id)
      merged.append(mergeWithLive(fresh, current))

      continue
    }

    merged.append(fresh)
  }

  let lastUsedIndex = state.order.lastIndex(where: used.contains) ?? -1
  var kept: [TranscriptItem] = []
  /// Kept, but with a moment of their own to be put back into — see `placeByTimestamp`.
  var settled: [TranscriptItem] = []

  for (index, id) in state.order.enumerated() {
    guard let item = state.items[id], !used.contains(id) else {
      continue
    }

    if !isEphemeral(item) && !(item.origin != .history && index > lastUsedIndex) {
      continue
    }

    if isSettledRequest(item) && item.ts != nil {
      settled.append(item)

      continue
    }

    kept.append(item)
  }

  var next = rebuild(state, placeByTimestamp(merged + kept, settled))

  next.hydration = .live

  // The tail fetch exists to fill placeholders; with the last of them settled by
  // this read there is nothing left for it to find.
  if !settledPlaceholders.isEmpty && next.turn.foreignReconcilePending == true
    && !next.items.values.contains(where: { $0.asUser?.unknownAuthor == true })
  {
    next.turn.foreignReconcilePending = nil
  }

  return next
}

/// Put a page of OLDER rows in front of the transcript.
///
/// This is the other direction from `reconcile`, and it is a different operation
/// rather than the same one with a longer list. `reconcile` is a re-hydration: it
/// is handed what the server says the transcript IS, matches it against what is
/// on screen and keeps the live tail. Handing it a page that only covers rows
/// 400–600 would be telling it the conversation is those rows, and everything
/// newer that is not "live" would be dropped on the floor.
///
/// So a page arrives as what it is: rows strictly older than everything held,
/// placed at the front, with nothing in the existing list touched. The only
/// merging it does is a refusal — a row whose `rowId` is already in the list is
/// dropped rather than added twice, which is what makes a page that overlaps the
/// one before it harmless. Overlap is not hypothetical: the offset a page is
/// fetched at counts rows, and a turn that lands between two pages shifts every
/// older row by one.
///
/// Ordering is the server's. The route answers oldest-first whichever end it
/// counted from — measured against a real gateway, 2026-09-21 — so the page is
/// already in the order it belongs in.
///
/// Nothing about hydration changes. A transcript that was `live` is still live
/// with more of itself loaded, and one that was `stale` did not become fresh
/// because its far end grew.
public func prependHistory(_ state: ChatState, _ olderItems: [TranscriptItem]) -> ChatState {
  var known = Set<Int>()
  var knownCalls = Set<String>()

  for id in state.order {
    guard let item = state.items[id] else { continue }

    if let rowID = item.rowID {
      known.insert(rowID)
    }

    if let callKey = callKeyOfItem(item) {
      knownCalls.insert(callKey)
    }
  }

  // The call key is the belt to the row id's braces: a call is one card, so an
  // older page re-sending it is a page that overlaps, whatever its row says.
  let older = olderItems.filter { item in
    (item.rowID.map { !known.contains($0) } ?? true) && (callKeyOfItem(item).map { !knownCalls.contains($0) } ?? true)
  }

  if older.isEmpty {
    return state
  }

  /*
    `rebuild` frees a colliding id rather than letting `order` hold it twice, and
    that guard is load-bearing here rather than theoretical. A REST row with no
    `id` falls back to a POSITIONAL item id (`user:0`), and position is per page,
    so two pages can both produce `user:0`. Every row this route returns has an
    id in practice; the fallback is what happens when one does not.
  */
  return rebuild(state, older + state.orderedItems)
}

/// Fold a short tail fetch into the existing transcript: fill the placeholder a
/// foreign `message.start` left behind, join DM replies onto their dispatch, and
/// append rows we had not seen. Nothing live is ever dropped — a tail fetch that
/// races the turn it is describing must not delete the bubble being streamed.
public func reconcileTail(_ state: ChatState, _ tailItems: [TranscriptItem]) -> ChatState {
  let list = state.orderedItems
  let placeholders = list.compactMap { item in item.asUser?.unknownAuthor == true ? item.id : nil }
  // Every row on screen, including a delivery row that joined a dispatch card and
  // so is held only as the card's `reply`: a page without the dispatch must not
  // add that row again as a notice.
  let knownRowIDs = Set(list.flatMap { promptRowsOf($0).compactMap { $0.rowID } })
  var byID = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, later in later })
  var appended: [TranscriptItem] = []
  var placeholderCursor = 0

  /**
   * The live tail, indexed by what each item says and carries.
   *
   * A turn we sent ourselves exists twice for a moment: as the optimistic
   * bubble and the streamed reply the reducer built (no `rowId`, because
   * nothing persisted them yet), and as the rows the gateway wrote. There is no
   * id in common — `prompt.submit` does not answer with one — so this key is the
   * only thing that can pair them, exactly as `reconcile` already does for a
   * full re-hydration. Without it the next `sessions.changed` sweep appends the
   * persisted copies and every sent message shows up twice.
   *
   * Indexing on TEXT alone was that bug's second half: a send carrying only a
   * file has no text, so the bubble was never a candidate and the row landed
   * beside it.
   */
  var liveByMatchKey = MatchCandidates()

  for item in list where item.rowID == nil {
    if let key = matchKeyIfMatchable(item) {
      liveByMatchKey.append(item.id, for: key)
    }
  }

  /**
   * The live prompts that know which turn they opened: a parked prompt the
   * turn's `message.start` claimed, and a foreign placeholder standing in for a
   * turn's author. A row naming that turn is theirs and nobody else's.
   */
  var liveByTurnID: [String: String] = [:]

  for item in list {
    if let turnID = turnIDOfItem(item), item.rowID == nil, liveByTurnID[turnID] == nil {
      liveByTurnID[turnID] = item.id
    }
  }

  var pairedLive = Set<String>()
  /// Placeholders already given their row, by turn id or by position.
  var filled = Set<String>()
  /**
   * The tail carried an authored row that belonged to a bubble already on
   * screen — our own optimistic submit coming back persisted. It is the only
   * evidence that says a placeholder standing beside it was never anybody
   * else's turn, as opposed to a turn whose row the tail has not reached yet.
   */
  var pairedAuthoredRow = false

  for fresh in tailItems {
    // A delivery row that found its dispatch inside this very page left no item
    // of its own: the reply it joined onto the card carries its turn id. That is
    // the turn's row, so the placeholder standing for it goes — the card shows
    // the answer, and there is no author's bubble to fill.
    if case .botDmOut(let outbound) = fresh, let deliveredTurnID = JS.nonEmpty(outbound.reply?.turnID),
      let deliveredID = liveByTurnID[deliveredTurnID], !deliveredID.isEmpty, !pairedLive.contains(deliveredID),
      isTurnPlaceholder(byID[deliveredID])
    {
      pairedLive.insert(deliveredID)
      filled.insert(deliveredID)
      byID[deliveredID] = nil
    }

    if let rowID = fresh.rowID, knownRowIDs.contains(rowID) {
      if let existingID = state.byRowID[String(rowID)], !existingID.isEmpty, let current = byID[existingID] {
        byID[current.id] = mergeWithLive(fresh, current)
      }

      // The row is on screen already, so whatever turn it opened has had it.
      if let heldTurnID = turnOfOtherRow(fresh), let heldID = liveByTurnID[heldTurnID], !heldID.isEmpty,
        !pairedLive.contains(heldID), isTurnPlaceholder(byID[heldID])
      {
        pairedLive.insert(heldID)
        filled.insert(heldID)
        byID[heldID] = nil
      }

      continue
    }

    // A prompt that names its turn goes to the live item standing for that
    // turn: the claimed prompt, or the placeholder that turn put up — that one,
    // never the next placeholder along.
    let turnID = turnIDOfItem(fresh)
    let turnMatch = turnID.flatMap { liveByTurnID[$0] }.flatMap { id in
      id.isEmpty || pairedLive.contains(id) ? nil : byID[id]
    }

    if let turnMatch, turnMatch.asUser?.unknownAuthor != true || isAuthoredRow(fresh) {
      pairedLive.insert(turnMatch.id)

      if turnMatch.asUser?.unknownAuthor == true {
        filled.insert(turnMatch.id)

        var claimed = fresh
        claimed.id = turnMatch.id
        claimed.version = turnMatch.version &+ 1
        byID[turnMatch.id] = claimed
      } else {
        byID[turnMatch.id] = mergeWithLive(fresh, turnMatch)
        pairedAuthoredRow = true
      }

      continue
    }

    // A turn the gateway started itself (an auto-continue, a notification) has a
    // `role:user` row that is no bubble of the owner's: it projects to a notice,
    // a report or a bot message, and still names its turn. That row is what the
    // turn's placeholder was standing in for, so it takes the placeholder's place
    // — or, when it only joins a dispatch and leaves nothing to show, the
    // placeholder goes. Either way the turn's row has arrived and nothing is
    // left pending for it.
    if fresh.asUser == nil, let noticeTurnID = JS.nonEmpty(fresh.turnID),
      let noticeTurnMatchID = liveByTurnID[noticeTurnID], !noticeTurnMatchID.isEmpty,
      !pairedLive.contains(noticeTurnMatchID),
      let noticeTurnMatch = byID[noticeTurnMatchID], noticeTurnMatch.asUser?.unknownAuthor == true
    {
      pairedLive.insert(noticeTurnMatch.id)
      filled.insert(noticeTurnMatch.id)

      var standing: TranscriptItem? = fresh

      if case .notice(let notice) = fresh, notice.noticeKind == .processComplete, !(notice.completions ?? []).isEmpty {
        standing = joinDeliveries(state, &byID, notice).map { .notice($0) }
      }

      if var standing {
        standing.id = noticeTurnMatch.id
        standing.version = noticeTurnMatch.version &+ 1
        byID[noticeTurnMatch.id] = standing
      } else {
        byID[noticeTurnMatch.id] = nil
      }

      continue
    }

    // A call is one card: its key first, then the provider's tool id — and not
    // a tool id whose card names another call.
    if let callKey = callKeyOfItem(fresh), let callMatchID = JS.nonEmpty(state.byCallKey[callKey]),
      let callMatch = byID[callMatchID], callKeyOfItem(callMatch).map({ JS.same($0, callKey) }) == true,
      rowsAgree(callMatch, fresh)
    {
      byID[callMatch.id] = mergeWithLive(fresh, callMatch)

      continue
    }

    if let toolKey = toolKeyOf(fresh), let toolMatchID = state.byToolID[toolKey], !toolMatchID.isEmpty,
      let toolMatch = byID[toolMatchID], identitiesAgree(toolMatch, fresh)
    {
      byID[toolMatch.id] = mergeWithLive(fresh, toolMatch)

      continue
    }

    let liveID = matchKeyIfMatchable(fresh).flatMap { key in
      liveByMatchKey.first(
        for: key,
        where: { authorsAgree(byID[$0], fresh) && identitiesAgree(byID[$0], fresh) },
        isTaken: { pairedLive.contains($0) }
      )
    }

    if let liveID, !liveID.isEmpty, let liveMatch = byID[liveID] {
      pairedLive.insert(liveMatch.id)
      byID[liveMatch.id] = mergeWithLive(fresh, liveMatch)

      if isAuthoredRow(fresh) {
        pairedAuthoredRow = true
      }

      continue
    }

    if case .notice(let notice) = fresh, notice.noticeKind == .processComplete, !(notice.completions ?? []).isEmpty {
      if let leftover = joinDeliveries(state, &byID, notice) {
        appended.append(.notice(leftover))
      }

      continue
    }

    // By position, for a row that names no turn: the next placeholder nobody has
    // filled. A row that names its turn and found no item for it is simply new.
    while placeholderCursor < placeholders.count && filled.contains(placeholders[placeholderCursor]) {
      placeholderCursor += 1
    }

    if turnID == nil && isAuthoredRow(fresh) && placeholderCursor < placeholders.count {
      let placeholderID = placeholders[placeholderCursor]

      placeholderCursor += 1

      if !placeholderID.isEmpty, let placeholder = byID[placeholderID] {
        filled.insert(placeholderID)

        var claimed = fresh
        claimed.id = placeholderID
        claimed.version = placeholder.version &+ 1
        byID[placeholderID] = claimed

        continue
      }
    }

    appended.append(fresh)
  }

  // A placeholder that names its turn waits for that turn's row, which is
  // written when the turn starts. Once the turn is over (it ended, or another
  // one runs) a tail that paired nothing for it never will: the row projected to
  // nothing of its own, or this chat never had it. Keeping the placeholder would
  // keep `foreignReconcilePending` true, and a tail fetch on every sweep after.
  var closed = Set<String>()

  for id in placeholders where !filled.contains(id) {
    guard case .user(let standing)? = byID[id], isTurnPlaceholder(.user(standing)),
      !state.turn.active || state.turn.id.map({ !JS.same($0, standing.turnID ?? "") }) ?? true
    else {
      continue
    }

    closed.insert(id)
    byID[id] = nil
  }

  // Splice new rows in front of the live tail (the bubbles of a turn that is
  // still running) instead of behind it.
  let ordered = state.order.compactMap { byID[$0] }
  var insertAt = ordered.count

  while insertAt > 0 {
    let candidate = ordered[insertAt - 1]

    if candidate.origin == .history || candidate.rowID != nil {
      break
    }

    insertAt -= 1
  }

  var merged = Array(ordered[..<insertAt]) + appended + Array(ordered[insertAt...])
  var stillPending = placeholders.contains { !filled.contains($0) && !closed.contains($0) }

  if pairedAuthoredRow && filled.isEmpty {
    // The tail described this turn without needing a placeholder, which means
    // the turn was ours all along: the row paired with the optimistic bubble
    // above. An empty placeholder nobody will ever fill is an empty bubble the
    // reader has to explain to themselves, so it goes. A tail that simply has
    // not reached the foreign row yet pairs nothing and leaves it standing —
    // and so does a placeholder that names its turn, which only that turn's
    // row may fill.
    let stale = Set(
      placeholders.filter { id in
        guard case .user(let item)? = byID[id] else { return false }
        return item.unknownAuthor == true && JS.trim(item.text).isEmpty && JS.nonEmpty(item.turnID) == nil
      }
    )

    if !stale.isEmpty {
      merged.removeAll { stale.contains($0.id) }
      stillPending = stillPending && stale.count < placeholders.count
    }
  }

  var next = rebuild(state, inRowOrder(merged))

  next.turn.foreignReconcilePending = stillPending ? true : nil

  return next
}

/// Attach every delivery block on a notice to the dispatch that spawned it.
private func joinDeliveries(
  _ state: ChatState,
  _ byID: inout [String: TranscriptItem],
  _ notice: NoticeItem
) -> NoticeItem? {
  var leftovers: [ProcessCompletionBlock] = []

  for block in notice.completions ?? [] {
    guard let dispatchID = state.byProcessID[block.sid], !dispatchID.isEmpty,
      case .botDmOut(var dispatch)? = byID[dispatchID]
    else {
      leftovers.append(block)

      continue
    }

    let outcome = replyFromDeliveryOutput(block.output)
    let error = outcome.error.flatMap { $0.isEmpty ? nil : $0 }

    dispatch.version &+= 1
    dispatch.reply = BotDmReply(
      text: outcome.text ?? "",
      ts: notice.ts,
      rowID: notice.rowID,
      error: error,
      reason: outcome.reason.flatMap { $0.isEmpty ? nil : $0 }
    )

    if let error {
      dispatch.dispatch.status = .failed
      dispatch.dispatch.error = error
    }

    byID[dispatch.id] = .botDmOut(dispatch)
  }

  if leftovers.isEmpty {
    return nil
  }

  var leftover = notice
  leftover.completions = leftovers

  return leftover
}
