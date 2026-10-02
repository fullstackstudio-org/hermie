import HermieProtocol

// Subagent grouping: the `subagent.*` events of `applyEvent`, and
// `applySubagentSnapshot`.

/// One `subagent.list` row, as thin as the reconcile needs it
/// (`SubagentSnapshotRow`). A view over the row's JSON object: every field is read
/// raw, because the fold below passes several of them on exactly as they came.
public struct SubagentSnapshotRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var subagentID: String? { get { json[field: "subagent_id"] } set { json[field: "subagent_id"] = newValue } }
  public var parentID: String? { get { json[field: "parent_id"] } set { json[field: "parent_id"] = newValue } }
  public var depth: Double? { get { json[field: "depth"] } set { json[field: "depth"] = newValue } }
  public var goal: String? { get { json[field: "goal"] } set { json[field: "goal"] = newValue } }
  public var delegationID: String? { get { json[field: "delegation_id"] } set { json[field: "delegation_id"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  /// Unix SECONDS (see `millisecondsOf`).
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var status: String? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var toolCount: Double? { get { json[field: "tool_count"] } set { json[field: "tool_count"] = newValue } }
  public var lastTool: String? { get { json[field: "last_tool"] } set { json[field: "last_tool"] = newValue } }
  public var acceptingSteer: Bool? {
    get { json[field: "accepting_steer"] }
    set { json[field: "accepting_steer"] = newValue }
  }
  public var childSessionID: String? {
    get { json[field: "child_session_id"] }
    set { json[field: "child_session_id"] = newValue }
  }
}

extension TranscriptReducer {
  /// `groupForSubagent`.
  static func groupForSubagent(_ next: inout ChatState, _ delegationID: String?, _ goal: String, _ now: Double) -> String {
    if let delegationID = nonEmpty(delegationID), let group = nonEmpty(next.byDelegationID[delegationID]) {
      return group
    }

    for id in next.order.reversed() {
      guard case .subagentGroup(let item)? = itemAt(next, id) else {
        continue
      }

      if item.status == .done || item.status == .failed {
        break
      }

      if let own = nonEmpty(item.delegationID), let wanted = nonEmpty(delegationID), !JS.same(own, wanted) {
        continue
      }

      return item.id
    }

    return addItem(&next, id: "g:\(next.turn.nextSeq)", ts: now / 1000) { base in
      .subagentGroup(
        SubagentGroupItem(
          base: base,
          delegationID: nonEmpty(delegationID),
          goals: goal.isEmpty ? [] : [goal],
          rootIDs: [],
          status: .dispatched
        )
      )
    }
  }

  /// `refreshGroup`.
  static func refreshGroup(_ next: inout ChatState, _ groupID: String) {
    let subagents = next.subagents

    patchSubagentGroup(&next, groupID) { draft in
      let members = draft.rootIDs.compactMap { subagents[$0] }

      if members.isEmpty {
        return
      }

      let active = members.contains { $0.status == .running || $0.status == .queued }
      let broken = members.contains { $0.status == .failed || $0.status == .interrupted }

      draft.status = active ? .running : broken ? .failed : .done
    }
  }

  /// Puts `child` on its group: `childID` into `rootIds`, its goal into `goals`,
  /// its delegation onto a group that has none yet; then refreshes the group's
  /// status. Shared by the events and the snapshot.
  static func joinGroup(_ next: inout ChatState, _ childID: String, _ child: Subagent, _ now: Double) {
    let groupID = groupForSubagent(&next, child.delegationID, child.goal, now)

    patchSubagentGroup(&next, groupID) { draft in
      if !draft.rootIDs.contains(where: { JS.same($0, childID) }) {
        draft.rootIDs.append(childID)
      }

      if !child.goal.isEmpty && !draft.goals.contains(where: { JS.same($0, child.goal) }) {
        draft.goals.append(child.goal)
      }

      if let delegationID = nonEmpty(child.delegationID), nonEmpty(draft.delegationID) == nil {
        draft.delegationID = delegationID
      }
    }
    refreshGroup(&next, groupID)
  }

  /// `case 'subagent.spawn_requested' | 'subagent.start' | 'subagent.progress' |
  /// 'subagent.thinking' | 'subagent.tool' | 'subagent.complete'`.
  static func subagentEvent(_ next: inout ChatState, _ payload: JSONObject, _ type: String, _ now: Double) {
    let childID = subagentIDOf(payload)
    let prev = next.subagents[childID]
    let createIfMissing = type == "subagent.spawn_requested" || type == "subagent.start"

    if (prev == nil && !createIfMissing) || (prev.map { terminalSubagentStatus.contains($0.status) } ?? false) {
      return
    }

    let child = carryRawAcceptingSteer(prev, toSubagent(payload, prev, type, now))

    next.subagents[childID] = child
    joinGroup(&next, childID, child, now)
  }

  /// `toSubagent` carries `prev.acceptingSteer` over, and in the TypeScript that is
  /// whatever a roster row put there — a non-boolean too (`applySubagentSnapshot`
  /// spreads `row.accepting_steer` in as it came). The typed field holds only a
  /// boolean, so such a value lives in `extra`; this carries it over the same way.
  static func carryRawAcceptingSteer(_ prev: Subagent?, _ child: Subagent) -> Subagent {
    guard child.acceptingSteer == nil, let raw = prev?.extra["acceptingSteer"] else { return child }

    var carried = child
    carried.extra["acceptingSteer"] = raw
    return carried
  }

  /// `millisecondsOf`: `started_at` on a roster row is unix SECONDS, while
  /// `Subagent.startedAt` is the millisecond clock the events are stamped with. A
  /// value already past the year-5138 mark in seconds is milliseconds somebody
  /// forgot to divide.
  static func millisecondsOf(_ value: JSONValue?) -> Double? {
    guard let value = num(value), value > 0 else { return nil }

    return value > 1e11 ? value : value * 1000
  }
}

/// Fold a `subagent.list` snapshot into the chat.
///
/// The `subagent.*` events are a stream, and a chat opened halfway through a
/// delegation missed the beginning of it — there is no replay for children. The
/// snapshot is the roster the gateway can still describe, so it CREATES children
/// the events never announced and refreshes the ones they did.
///
/// It deliberately does not remove anything: a child the gateway has forgotten
/// (it only lists live ones) has usually just finished, and dropping the row
/// would erase the summary the reader is looking at.
///
/// `applySubagentSnapshot`.
public func applySubagentSnapshot(_ state: ChatState, _ rows: [SubagentSnapshotRow], _ now: Double) -> ChatState {
  var next = state
  applySubagentSnapshot(into: &next, rows, now)
  return next
}

/// `applySubagentSnapshot`, in place.
public func applySubagentSnapshot(into next: inout ChatState, _ rows: [SubagentSnapshotRow], _ now: Double) {
  typealias R = TranscriptReducer

  for row in rows {
    let raw = row.json
    // `row.x ?? fallback`: `null` and absent both fall back; anything else is
    // passed on as it came.
    func orDefault(_ key: String, _ fallback: JSONValue) -> JSONValue {
      guard let value = raw[key], value != .null else { return fallback }
      return value
    }

    var payload: JSONObject = [
      "parent_id": orDefault("parent_id", .null),
      "goal": orDefault("goal", ""),
      "delegation_id": orDefault("delegation_id", ""),
      "model": orDefault("model", ""),
      "status": orDefault("status", "running")
    ]

    if let subagentID = raw["subagent_id"] {
      payload["subagent_id"] = subagentID
    }

    if let depth = raw["depth"], depth != .null {
      payload["depth"] = depth
    }

    if let toolCount = raw["tool_count"], toolCount != .null {
      payload["tool_count"] = toolCount
    }

    if R.truthy(raw["last_tool"]) {
      payload["tool_name"] = raw["last_tool"]
    }

    if R.truthy(raw["child_session_id"]) {
      payload["child_session_id"] = raw["child_session_id"]
    }

    let childID = subagentIDOf(payload)
    let prev = next.subagents[childID]

    if let prev, terminalSubagentStatus.contains(prev.status) {
      // The stream already saw this child finish; the roster is behind.
      continue
    }

    // `subagent.list` is a roster, not a progress frame: it carries no stream
    // line to append, so it is applied as a plain `start`-shaped update.
    let at = R.truthy(prev?.startedAt) ? prev!.updatedAt : now
    var child = R.carryRawAcceptingSteer(prev, toSubagent(payload, prev, "subagent.start", at))

    child.startedAt = prev?.startedAt ?? R.millisecondsOf(raw["started_at"]) ?? child.startedAt

    if case .bool(let accepting)? = raw["accepting_steer"] {
      child.acceptingSteer = accepting
    } else if let accepting = raw["accepting_steer"], accepting != .null {
      // `{ ...child, acceptingSteer: row.accepting_steer }` with a value that is not
      // a boolean: kept raw, as the TypeScript's spread would.
      child.acceptingSteer = nil
      child.extra["acceptingSteer"] = accepting
    }

    next.subagents[childID] = child
    R.joinGroup(&next, childID, child, now)
  }
}
