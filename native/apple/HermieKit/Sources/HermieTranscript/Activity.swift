import HermieProtocol

// The cross-bot activity timeline (`activity.ts`)
// ===============================================
//
// Activity is a VIEW, never a second copy of the truth. Every row here is
// derived from the `ChatState`s the chat store already holds, which is why the
// screen can show traffic between two bots the user has never opened: the
// controller loads their tails into the same store, and this reads them back.
//
// Three item kinds carry bot-to-bot traffic, and one of them is written twice
// on the wire:
//
//  - `bot_dm_out` lives in the SENDER's chat (`researcher → writer: …`), and
//    carries the teammate's answer once the delivery process reports back.
//  - `bot_dm_in` lives in the RECIPIENT's chat and is the SAME message seen
//    from the other side. Emitting both would double every conversation, so an
//    inbound row that matches a dispatch we already have is dropped and the
//    dispatch keeps the floor — it is the row that knows the delivery status.
//  - `subagent_group` is a `delegate_task` fan-out: `researcher spawned 3
//    agents · running`.
//
// The `status` labels (`Queued`, `Replied`, …) are English in the TypeScript too:
// they are the engine's own vocabulary, which the activity screen maps to its
// strings.

public enum ActivityKind: String, Sendable, Hashable, CaseIterable {
  case dmOut = "dm_out"
  case dmReply = "dm_reply"
  case dmIn = "dm_in"
  case delegation
}

public struct ActivityEntry: Sendable, Hashable {
  /// Unique across bots: one chat's item id is only unique within that chat.
  public var id: String
  /// The chat this row was derived from — tapping opens it.
  public var botName: String
  /// The item to scroll to once that chat is open.
  public var itemID: String
  public var kind: ActivityKind
  /// Unix seconds. Rows without a stamp inherit the newest one before them.
  public var at: Double
  /// Routing handle of whoever spoke.
  public var fromHandle: String
  /// Routing handle of whoever was addressed; absent for a delegation.
  public var toHandle: String?
  /// The message, the reply, or the delegation's goals joined.
  public var text: String
  /// `Queued`, `Delivered`, `done`, `running` — whatever the row can prove.
  public var status: String?
  /// True while the traffic this row describes has not landed yet.
  public var pending: Bool?
  /// True when the row describes something that failed.
  public var failed: Bool?
  /// `subagent_group` only: how many children the fan-out spawned.
  public var agentCount: Int?

  public init(
    id: String,
    botName: String,
    itemID: String,
    kind: ActivityKind,
    at: Double,
    fromHandle: String,
    toHandle: String? = nil,
    text: String,
    status: String? = nil,
    pending: Bool? = nil,
    failed: Bool? = nil,
    agentCount: Int? = nil
  ) {
    self.id = id
    self.botName = botName
    self.itemID = itemID
    self.kind = kind
    self.at = at
    self.fromHandle = fromHandle
    self.toHandle = toHandle
    self.text = text
    self.status = status
    self.pending = pending
    self.failed = failed
    self.agentCount = agentCount
  }

  public var jsonValue: JSONValue {
    var object: JSONObject = [
      "id": .string(id),
      "botName": .string(botName),
      "itemId": .string(itemID),
      "kind": .string(kind.rawValue),
      "at": .number(at),
      "fromHandle": .string(fromHandle),
      "text": .string(text)
    ]
    if let toHandle { object["toHandle"] = .string(toHandle) }
    if let status { object["status"] = .string(status) }
    if let pending { object["pending"] = .bool(pending) }
    if let failed { object["failed"] = .bool(failed) }
    if let agentCount { object["agentCount"] = .number(Double(agentCount)) }
    return .object(object)
  }
}

/// How far apart two views of the same delivery may be stamped and still be
/// recognised as one. The sender stamps the dispatch when the tool ran; the
/// recipient stamps the inbound row when its turn started, which is later by
/// however long the delivery process queued. `DM_MATCH_WINDOW_SECONDS`.
public let dmMatchWindowSeconds: Double = 900

/// `/\s+/gu`
private let whitespaceRun = JSRegExp(JSPattern.s + "+")

/// First line, whitespace collapsed — the timeline shows one line per row.
private func firstLine(_ text: String, _ max: Int = 140) -> String {
  let line = JS.trim(whitespaceRun.replaceAll(in: text, with: " "))

  return JS.length(line) > max ? "\(JS.slice(line, 0, max - 1))…" : line
}

/// The shape a dedupe compares on: who, to whom, and the opening of the text.
private func deliveryKey(_ from: String, _ to: String, _ text: String) -> String {
  "\(from)>\(to)>\(JS.lower(firstLine(text, 64)))"
}

private func dispatchStatusLabel(_ item: BotDmOutItem) -> (status: String, pending: Bool, failed: Bool) {
  if let error = item.reply?.error, !error.isEmpty {
    return ("Failed", false, true)
  }

  if item.reply != nil {
    return ("Replied", false, false)
  }

  switch item.dispatch.status {
  case .failed: return ("Failed", false, true)
  case .ambiguous: return ("Ambiguous target", false, true)
  case .sending: return ("Sending", true, false)
  case .queued: return ("Queued", true, false)
  default: return ("Sent", false, false)
  }
}

/// Walk one chat in order, handing every item the newest stamp at or before it.
///
/// A tool row carries no timestamp on the wire, so a `bot_dm_out` derived from
/// one has none either. Sorting those to 1970 would bury the newest traffic in
/// the app at the bottom of the timeline, so they inherit the stamp of the row
/// they follow — which is where they happened.
private func stampedItems(_ chat: ChatState) -> [(item: TranscriptItem, at: Double)] {
  var out: [(item: TranscriptItem, at: Double)] = []
  out.reserveCapacity(chat.order.count)
  var carried: Double = 0

  for id in chat.order {
    guard let item = chat.items[id] else { continue }

    if let ts = item.ts, ts != 0, ts > carried {
      carried = ts
    }

    out.append((item, item.ts ?? carried))
  }

  return out
}

private func ownHandle(_ chat: ChatState) -> String {
  let handle = normalizeAgentTarget(chat.botName)
  return handle.isEmpty ? JS.lower(chat.botName) : handle
}

/// `a || b` on strings.
private func or(_ value: String?, _ fallback: @autoclosure () -> String) -> String {
  if let value, !value.isEmpty { return value }
  return fallback()
}

public struct ActivityOptions: Sendable, Hashable {
  /// Rows older than this many seconds are dropped. Omitted (or 0) keeps everything.
  public var sinceSeconds: Double?

  public init(sinceSeconds: Double? = nil) {
    self.sinceSeconds = sinceSeconds
  }
}

/// Every bot-to-bot row across every loaded chat, newest last.
///
/// Deterministic: equal stamps fall back to the bot name and the item id, so a
/// re-render never reshuffles rows that happened in the same second.
///
/// `chats` is `Object.values(chats)` of the TypeScript's record, in that order.
/// `now` (milliseconds, as `Date.now()`) is read only for the `sinceSeconds`
/// cutoff, which the TypeScript takes from the clock itself.
public func activityEntries(
  _ chats: [ChatState],
  _ options: ActivityOptions = ActivityOptions(),
  now: Double
) -> [ActivityEntry] {
  var dispatched = Set<String>()
  var entries: [ActivityEntry] = []

  // Pass one: the sender side. It is authoritative for a delivery's status, so
  // it claims the key an inbound row would otherwise repeat.
  for chat in chats {
    let from = ownHandle(chat)

    for (item, at) in stampedItems(chat) {
      guard case .botDmOut(let dm) = item else { continue }

      let to = or(dm.targetHandle, normalizeAgentTarget(dm.target))
      let label = dispatchStatusLabel(dm)

      dispatched.insert(deliveryKey(from, to, dm.message))
      entries.append(
        ActivityEntry(
          id: "\(chat.botName):\(dm.id)",
          botName: chat.botName,
          itemID: dm.id,
          kind: .dmOut,
          at: at,
          fromHandle: from,
          toHandle: to,
          text: firstLine(dm.message),
          status: label.status,
          pending: label.pending ? true : nil,
          failed: label.failed ? true : nil
        )
      )

      if let reply = dm.reply, !reply.text.isEmpty || !(reply.error ?? "").isEmpty {
        let failed = !(reply.error ?? "").isEmpty
        entries.append(
          ActivityEntry(
            id: "\(chat.botName):\(dm.id):reply",
            botName: chat.botName,
            itemID: dm.id,
            kind: .dmReply,
            at: reply.ts ?? at,
            fromHandle: to,
            toHandle: from,
            text: firstLine(or(reply.text, or(reply.error, ""))),
            status: failed ? "Failed" : nil,
            failed: failed ? true : nil
          )
        )
      }
    }
  }

  // Pass two: the recipient side, for traffic whose sender chat is not loaded
  // (or whose dispatch row the gateway never persisted).
  for chat in chats {
    let to = ownHandle(chat)

    for (item, at) in stampedItems(chat) {
      switch item {
      case .botDmIn(let dm):
        let from = or(dm.senderHandle, normalizeAgentTarget(dm.senderName))

        if dispatched.contains(deliveryKey(from, to, dm.text)) {
          continue
        }

        entries.append(
          ActivityEntry(
            id: "\(chat.botName):\(dm.id)",
            botName: chat.botName,
            itemID: dm.id,
            kind: dm.answersOurDispatch == true ? .dmReply : .dmIn,
            at: at,
            fromHandle: from,
            toHandle: to,
            text: firstLine(dm.text)
          )
        )

      case .subagentGroup(let group):
        let count = group.rootIDs.isEmpty ? group.goals.count : group.rootIDs.count

        if count == 0 {
          continue
        }

        entries.append(
          ActivityEntry(
            id: "\(chat.botName):\(group.id)",
            botName: chat.botName,
            itemID: group.id,
            kind: .delegation,
            at: at,
            fromHandle: to,
            text: firstLine(or(group.completion, group.goals.joined(separator: " · "))),
            status: group.status.rawValue,
            pending: group.status == .running || group.status == .dispatched ? true : nil,
            failed: group.status == .failed ? true : nil,
            agentCount: count
          )
        )

      default:
        continue
      }
    }
  }

  let since = options.sinceSeconds ?? 0
  let cutoff = since != 0 && !since.isNaN ? now / 1000 - since : 0

  return entries
    .filter { $0.at >= cutoff }
    .jsStableSorted { a, b in
      if a.at != b.at { return a.at < b.at ? -1 : 1 }
      let byBot = JS.localeCompare(a.botName, b.botName)
      return byBot != 0 ? byBot : JS.localeCompare(a.id, b.id)
    }
}

/// Which side of a DM `findDmCounterpart` looks for.
public enum DmCounterpartKind: String, Sendable, Hashable, CaseIterable {
  case botDmIn = "bot_dm_in"
  case botDmOut = "bot_dm_out"
}

/// The `query` of `findDmCounterpart`.
public struct DmCounterpartQuery: Sendable, Hashable {
  public var kind: DmCounterpartKind
  public var handle: String
  public var at: Double?
  public var text: String?

  public init(kind: DmCounterpartKind, handle: String, at: Double? = nil, text: String? = nil) {
    self.kind = kind
    self.handle = handle
    self.at = at
    self.text = text
  }
}

/// The counterpart of one DM in another bot's chat.
///
/// Tapping `researcher → writer: …` should land on the message as WRITER saw it,
/// not at the bottom of Writer's chat. The two rows share a sender, a recipient
/// and a body but nothing the gateway keys them by, so the match is handle plus
/// nearest stamp, and it refuses rather than guesses when nothing is close.
public func findDmCounterpart(_ chat: ChatState?, _ query: DmCounterpartQuery) -> String? {
  guard let chat else {
    return nil
  }

  let wanted = normalizeAgentTarget(query.handle)

  if wanted.isEmpty {
    return nil
  }

  let body = (query.text ?? "").isEmpty ? "" : JS.lower(firstLine(query.text!, 64))
  // `query.at` is read for truthiness: `0` is no stamp.
  let queryAt = query.at.flatMap { $0 == 0 || $0.isNaN ? nil : $0 }
  var best: (id: String, distance: Double, exact: Bool)?
  var carried: Double = 0

  for id in chat.order {
    let item = chat.items[id]

    if let ts = item?.ts, ts != 0, ts > carried {
      carried = ts
    }

    let handle: String
    let text: String

    switch (item, query.kind) {
    case (.botDmIn(let dm)?, .botDmIn):
      handle = or(dm.senderHandle, normalizeAgentTarget(dm.senderName))
      text = dm.text
    case (.botDmOut(let dm)?, .botDmOut):
      handle = or(dm.targetHandle, normalizeAgentTarget(dm.target))
      text = dm.message
    default:
      continue
    }

    if !JS.same(handle, wanted) {
      continue
    }

    let exact = !body.isEmpty && JS.same(JS.lower(firstLine(text, 64)), body)
    let distance = queryAt.map { abs((item?.ts ?? carried) - $0) } ?? 0

    // An exact body match wins outright; otherwise the nearest stamp does.
    if best == nil || (exact && !best!.exact) || (exact == best!.exact && distance < best!.distance) {
      best = (id, distance, exact)
    }
  }

  guard let best else {
    return nil
  }

  return best.exact || queryAt == nil || best.distance <= dmMatchWindowSeconds ? best.id : nil
}
