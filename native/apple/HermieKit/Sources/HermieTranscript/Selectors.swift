import Foundation
import HermieProtocol

// Read-time views over `ChatState` (`selectors.ts`)
// =================================================
//
// Verbosity and the bot-to-bot toggle live here and nowhere else: the reducer
// always keeps the full truth, so flipping a toggle never loses history and
// never needs a re-hydration.
//
// A demoted item is never removed. Hiding a DM would make the bot's own reply
// unexplainable, so `showBotToBot: false` collapses DM traffic to a one-line
// chip instead.
//
// The unread rules (`unreadCountSince`, `lastMessageAt`, `unreadBadgeLabel`) are
// in `Unread.swift`; they are the same TypeScript module.
//
// Cost
// ----
//
// `visibleItems` is what the transcript view asks on every state it is handed,
// so it is written to be one linear walk with no copies it can avoid:
//
// - one backward scan of `order` to find the newest status row and the newest
//   running tool (it stops as soon as it has both; a chat with neither walks the
//   whole order once), then one forward scan that decides every row. That is at
//   most 2·n dictionary lookups and one output array, reserved up front;
// - an item is handed out as the same `indirect` enum box the state holds — a
//   retain, not a copy. The one exception is the TypeScript's own: an assistant
//   row with a thought, while thinking is hidden, is rebuilt without it;
// - no string is built or compared except `text.trim()` emptiness checks on user
//   and assistant rows, which stop at the first non-blank code unit.
//
// It does not cache, as the TypeScript does not. A caller that wants to skip the
// walk keys a memo on `(itemsVersion(state), options)` — `itemsVersion` is itself
// O(n), but only additions — or, better, on the store's own publish counter; that
// memo belongs to the transcript view model (a later task), not to this module,
// which stays free of hidden state.

/// How a row is drawn. `Presentation` in `selectors.ts`.
public enum Presentation: String, Sendable, Hashable, CaseIterable {
  case full
  case collapsed
  case chip
  case hiddenPlaceholder = "hidden-placeholder"
}

/// One row the transcript draws, and how. `VisibleItem` in `selectors.ts`.
public struct VisibleItem: Sendable, Hashable {
  public var item: TranscriptItem
  public var presentation: Presentation

  public init(item: TranscriptItem, presentation: Presentation) {
    self.item = item
    self.presentation = presentation
  }

  /// `{ item, presentation }`, as the TypeScript returns it.
  public var jsonValue: JSONValue {
    .object(["item": item.jsonValue, "presentation": .string(presentation.rawValue)])
  }
}

/// `VisibilityOptions` in `selectors.ts`.
public struct VisibilityOptions: Sendable, Hashable {
  public var level: Verbosity
  public var showBotToBot: Bool
  public var showThinking: Bool

  public init(level: Verbosity, showBotToBot: Bool, showThinking: Bool) {
    self.level = level
    self.showBotToBot = showBotToBot
    self.showThinking = showThinking
  }
}

/// Cheap change key for memoization: every mutation bumps an item's `version`,
/// so a changed sum means a changed transcript. Callers are expected to memoize
/// `visibleItems` on `(itemsVersion(state), options)` — this module does not
/// cache, so it stays free of hidden state.
public func itemsVersion(_ state: ChatState) -> Int {
  var sum = state.order.count
  for id in state.order {
    sum &+= state.items[id]?.version ?? 0
  }
  return sum
}

private func isRunningTool(_ item: TranscriptItem) -> Bool {
  guard case .tool(let tool) = item else { return false }
  return tool.status == .running || tool.status == .generating
}

/// `visibleItems(state, { level, showBotToBot, showThinking })`.
public func visibleItems(
  _ state: ChatState,
  level: Verbosity,
  showBotToBot: Bool,
  showThinking: Bool
) -> [VisibleItem] {
  visibleItems(state, VisibilityOptions(level: level, showBotToBot: showBotToBot, showThinking: showThinking))
}

public func visibleItems(_ state: ChatState, _ options: VisibilityOptions) -> [VisibleItem] {
  let level = options.level
  let showBotToBot = options.showBotToBot
  let showThinking = options.showThinking
  let quiet = level == .quiet
  let verbose = level == .verbose

  // The TypeScript walks forwards and keeps the last of each; walking backwards
  // and stopping at the first of each finds the same two ids.
  var latestStatusID: String?
  var lastRunningToolID: String?

  for id in state.order.reversed() {
    guard let item = state.items[id] else { continue }
    if latestStatusID == nil, case .status = item { latestStatusID = id }
    if lastRunningToolID == nil, isRunningTool(item) { lastRunningToolID = id }
    if latestStatusID != nil && lastRunningToolID != nil { break }
  }

  var out: [VisibleItem] = []
  out.reserveCapacity(state.order.count)

  for id in state.order {
    guard let item = state.items[id] else { continue }

    switch item {
    case .approval, .clarify:
      // A question for the user is never filtered away.
      out.append(VisibleItem(item: item, presentation: .full))

    case .user(let user):
      if user.unknownAuthor == true && JS.trimsToEmpty(user.text) {
        out.append(VisibleItem(item: item, presentation: .hiddenPlaceholder))
        break
      }
      out.append(VisibleItem(item: item, presentation: .full))

    case .botDmIn, .botDmOut:
      /*
        ONE rule for both directions, `collapsed` and never `full`, at every
        level.

        A bot-to-bot row is drawn as an ASIDE — the silhouette a reply's
        thoughts have — and an aside starts closed whatever the verbosity. The
        reader opens one by tapping it, and the tap is remembered per row.
        `verbose` used to open the inbound ones, which put a teammate's whole
        message on screen for a reader who had turned verbosity up to see tool
        calls.

        The two used to have a case each, and they disagreed. `quiet` — the
        DEFAULT level — demoted a dispatch to a chip reading `Message to
        @writer` while the answer to it stayed an aside beside it, so the
        owner's report was about the one shape the shared design had not
        reached. A direction is not a verbosity: the same traffic gets the same
        row whichever way it went.

        The toggle still demotes rather than hides (ADR-0009): a DM the reader
        cannot see at all makes the bot's own reply unexplainable.
      */
      out.append(VisibleItem(item: item, presentation: showBotToBot ? .collapsed : .chip))

    case .cronDelivery:
      // A cron delivery survives `quiet`, and the bot-to-bot toggle does not
      // touch it.
      //
      // It is the RESULT of something the owner scheduled — the reason they
      // opened the chat — so dropping it at `quiet` would hide the one row they
      // came for, which is the same rule that keeps `user` and `assistant`
      // visible at every level. `quiet` folds the report instead of losing it.
      //
      // And it is not bot-to-bot traffic: the scheduler is not a peer bot, so
      // `showBotToBot: false` — which exists to quieten agents talking amongst
      // themselves — has no business demoting it to a chip.
      out.append(VisibleItem(item: item, presentation: quiet ? .collapsed : .full))

    case .subagentGroup:
      out.append(
        VisibleItem(item: item, presentation: !showBotToBot || quiet ? .chip : verbose ? .full : .collapsed)
      )

    case .assistant(let assistant):
      /*
        The copy is made only when there is a thought to take away. Stripping
        unconditionally rebuilt every assistant row in the transcript on every
        call — and this runs on every version bump, so on a four-hundred-row
        conversation that is four hundred allocations per streamed frame for
        rows that never had a `reasoning` to lose.
      */
      // A `reasoning` key the model could not type (kept in `extra`) is still a
      // key the TypeScript spread would have set to `undefined`.
      let hasThought =
        assistant.reasoning != nil || assistant.reasoningVerbose != nil
        || (!assistant.extra.isEmpty && (assistant.extra["reasoning"] != nil || assistant.extra["reasoningVerbose"] != nil))
      let shown: TranscriptItem
      if showThinking || !hasThought {
        shown = item
      } else {
        var stripped = assistant
        stripped.reasoning = nil
        stripped.reasoningVerbose = nil
        stripped.extra["reasoning"] = nil
        stripped.extra["reasoningVerbose"] = nil
        shown = .assistant(stripped)
      }
      let empty = JS.trimsToEmpty(assistant.text) && assistant.error == nil

      if empty && (!showThinking || JS.trimsToEmpty(assistant.reasoning ?? "") || quiet) {
        break
      }

      if assistant.error != nil {
        // An error card is always visible, at every level.
        out.append(VisibleItem(item: shown, presentation: .full))
        break
      }

      out.append(VisibleItem(item: shown, presentation: empty ? .collapsed : .full))

    case .tool:
      if quiet {
        if id == lastRunningToolID {
          // One "working" row stands in for the whole tool stream.
          out.append(VisibleItem(item: item, presentation: .hiddenPlaceholder))
        }
        break
      }
      out.append(VisibleItem(item: item, presentation: verbose ? .full : .collapsed))

    case .status:
      if verbose {
        out.append(VisibleItem(item: item, presentation: .full))
        break
      }
      if id != latestStatusID { break }
      if quiet && !state.turn.active { break }
      out.append(VisibleItem(item: item, presentation: .chip))

    case .notice(let notice):
      /*
        An error and a command answer are the two kinds no level may fold or
        drop.

        An error because a reader must not skim past it. A command answer
        because the owner TYPED the thing it answers: it is the payload of a
        request, in the same sense as the cron card above and the fan-out
        report further down (ADR-0013, amended), and a request whose answer is
        invisible at the level people leave the app on reads as a command that
        did nothing. `full` at every level, including `quiet`.
      */
      if notice.noticeKind == .error || notice.noticeKind == .command {
        out.append(VisibleItem(item: item, presentation: .full))
        break
      }

      if quiet {
        if notice.noticeKind == .reclaimed {
          out.append(VisibleItem(item: item, presentation: .chip))
          break
        }

        /*
          Work the owner dispatched, reporting back.

          Same rule as the cron card above, for the same reason (ADR-0013,
          amended 2026-09-21): a fan-out's results and a background process's
          output are not the machine narrating itself — they are the PAYLOAD of
          something the owner started and then walked away from, which is
          usually the row they reopened the chat for. `quiet` folds the report
          rather than losing it.

          The rest of the family stays hidden, because the rest of the family is
          narration: a model switch, a compaction handoff, a kanban event, the
          roster refreshing. Nobody asked for those.
        */
        if notice.noticeKind == .asyncDelegationComplete || notice.noticeKind == .processComplete {
          out.append(VisibleItem(item: item, presentation: .collapsed))
        }
        break
      }

      out.append(VisibleItem(item: item, presentation: verbose ? .full : .collapsed))

    case .unknown:
      // The TypeScript `switch` has no case for a kind it does not know, so the
      // row is not drawn.
      break
    }
  }

  return out
}

private func isOpenRequest(_ item: TranscriptItem) -> Bool {
  switch item {
  case .approval(let approval): approval.state == .open
  case .clarify(let clarify): clarify.state == .open
  default: false
  }
}

/// Is a question waiting on a person in this chat?
///
/// The predicate on its own, because THREE surfaces answer with it and they have
/// to agree: the chat list's bead, the widget file's `needsInput`, and the chat
/// header. It used to be written out three times — the same `.some(...)` over
/// `order`, byte for byte, in `BotsScreen`, `widgets/snapshot.ts` and, as a
/// length check, in `ChatScreen`. Three copies of a predicate is three places a
/// new request kind has to be remembered, and the one that is forgotten is a
/// chat that quietly stops asking for attention.
///
/// It stops at the first open request rather than building the list, which is
/// what makes it cheap enough for a roster of forty on every store notification.
public func hasOpenRequest(_ state: ChatState) -> Bool {
  state.order.contains { id in state.items[id].map(isOpenRequest) ?? false }
}

/// Every unanswered question, oldest first — the bottom sheets read this.
public func openRequests(_ state: ChatState) -> [TranscriptItem] {
  state.order.compactMap { id in
    guard let item = state.items[id], isOpenRequest(item) else { return nil }
    return item
  }
}

public func runningSubagents(_ state: ChatState) -> [Subagent] {
  state.subagents.values.filter { $0.status == .running || $0.status == .queued }
}

/// One node of `subagentTree`: the child, and its own children (`SubagentNode`).
public struct SubagentNode: Sendable, Hashable {
  public var subagent: Subagent
  public var children: [SubagentNode]

  public init(subagent: Subagent, children: [SubagentNode] = []) {
    self.subagent = subagent
    self.children = children
  }

  /// `{ ...child, children }`.
  public var jsonValue: JSONValue {
    var object = subagent.jsonValue.objectValue ?? [:]
    object["children"] = .array(children.map(\.jsonValue))
    return .object(object)
  }
}

/// How many ancestors a node of `subagentTree` may have. A node deeper than this
/// is listed as a root of its own, its subtree under it.
///
/// Not in the TypeScript, whose tree nests as deep as the parent links go. Here
/// a value that deep would be freed, hashed and encoded by recursion, and the
/// subagents are restored from the cache on launch, so a long chain of parent
/// links (a runaway delegation, a corrupt cache) would crash the app every time
/// it opened the chat. Real fan-outs are a few levels deep, so no tree the
/// TypeScript draws differently is one a person can read anyway.
public let subagentTreeMaxDepth = 32

/// Parent/child tree of this chat's subagents, ported from `buildSubagentTree`.
///
/// Built without recursion, and no deeper than `subagentTreeMaxDepth`.
public func subagentTree(_ state: ChatState) -> [SubagentNode] {
  // A JavaScript `Map` keyed by id: insertion order, and a later child with the
  // same id replaces the value but keeps the first one's place.
  var ids: [String] = []
  var children: [String: [String]] = [:]
  var nodes: [String: Subagent] = [:]

  for child in state.subagents.values {
    if nodes.updateValue(child, forKey: child.id) == nil { ids.append(child.id) }
  }

  var roots: [String] = []
  for id in ids {
    let node = nodes[id]!
    if let parentID = node.parentID, !parentID.isEmpty, nodes[parentID] != nil {
      children[parentID, default: []].append(id)
    } else {
      roots.append(id)
    }
  }

  func ordered(_ list: [String]) -> [String] {
    list.jsStableSorted { a, b in
      let lhs = nodes[a]!
      let rhs = nodes[b]!
      if lhs.startedAt != rhs.startedAt { return lhs.startedAt < rhs.startedAt ? -1 : 1 }
      if lhs.taskIndex != rhs.taskIndex { return lhs.taskIndex < rhs.taskIndex ? -1 : 1 }
      return JS.localeCompare(lhs.goal, rhs.goal)
    }
  }

  // Walked from the roots down, breadth first, which is everything the
  // TypeScript's walk reaches: children on a cycle of parents hang under no root
  // and are dropped by both. Each node has one parent, so the walk meets each
  // node once. A node past the depth limit is promoted to a root and its subtree
  // counted from there.
  var walk: [String] = []
  var depth: [String: Int] = [:]
  walk.reserveCapacity(ids.count)
  for id in roots {
    depth[id] = 0
    walk.append(id)
  }

  var next = 0
  while next < walk.count {
    let id = walk[next]
    next += 1

    var kept: [String] = []
    for child in children[id] ?? [] {
      if depth[id]! < subagentTreeMaxDepth {
        depth[child] = depth[id]! + 1
        kept.append(child)
      } else {
        depth[child] = 0
        roots.append(child)
      }
      walk.append(child)
    }
    children[id] = kept
  }

  // Children before parents: every node's children are built when it is.
  var built: [String: SubagentNode] = [:]
  for id in walk.reversed() {
    let kids = ordered(children[id] ?? []).map { built.removeValue(forKey: $0)! }
    built[id] = SubagentNode(subagent: nodes[id]!, children: kids)
  }

  return ordered(roots).map { built.removeValue(forKey: $0)! }
}

public func latestStatus(_ state: ChatState) -> StatusItem? {
  for id in state.order.reversed() {
    if case .status(let status)? = state.items[id] { return status }
  }
  return nil
}

/// Is anything still running for this chat — the turn, a tool, or a child?
public func isBusy(_ state: ChatState) -> Bool {
  if state.turn.active || state.compacting == true {
    return true
  }

  if state.subagents.values.contains(where: { $0.status == .running || $0.status == .queued }) {
    return true
  }

  return state.order.contains { id in state.items[id].map(isRunningTool) ?? false }
}
