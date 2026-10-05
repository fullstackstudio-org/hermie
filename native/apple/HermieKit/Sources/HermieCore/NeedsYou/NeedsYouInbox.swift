import Foundation
import Observation

/**
 Everything that waits for the person, across the bots of every gateway the app is connected to
 (NX-17): approvals, questions, secure prompts, confirmations, forms, drafts, device requests and
 connector authorisations. One list, oldest first, with the count the toolbar badge shows.

 It adds no wire call of its own. The live wiring hands it what `RequestAlerts` is handed already
 (`GatewaySession.openRequests(from:)`: the transcript's approvals and questions, the secure
 prompts, the interactive requests and the passkey confirmations, one entry per request), plus the
 connector cards (`ConnectionRequestsModel`), whenever any of them moves. The inbox keeps each
 gateway's part apart (a request id is only unique on its gateway) and merges them for the view.

 **One gateway is live at a time** (ADR-0024): the app holds one socket, so today the list is the
 live gateway's. The inbox itself is per gateway on purpose, so a second session feeding it adds its
 own part and takes it away again (`sessionEnded`) without a rewrite; what waits on a gateway the
 app has no socket to is not guessed at.

 How long a request has waited is when this device first saw it open (`NeedsYouItem.since`): the
 request models carry no arrival time of their own. It is kept for as long as the request is listed.
 */
@MainActor
@Observable
public final class NeedsYouInbox {
  /// Everything waiting, oldest first; a tie is broken by the bot's name, then by the id, so the order
  /// never jumps between two reads of the same state.
  public private(set) var items: [NeedsYouItem] = []

  @ObservationIgnored private var parts: [String: [NeedsYouItem]] = [:]
  @ObservationIgnored private var firstSeen: [String: Date] = [:]
  @ObservationIgnored private let now: @MainActor () -> Date

  /// - Parameter now: the clock, which a test sets.
  public init(now: @escaping @MainActor () -> Date = { Date() }) {
    self.now = now
  }

  /// How many things wait: the number on the toolbar's badge and on the app icon.
  public var count: Int { items.count }

  public var isEmpty: Bool { items.isEmpty }

  /// How many things wait on one gateway.
  public func count(for gatewayId: String) -> Int {
    parts[gatewayId]?.count ?? 0
  }

  /// The gateways that have something waiting, in the order the list reaches them.
  public var gatewayIds: [String] {
    var seen = Set<String>()
    return items.map(\.gatewayId).filter { seen.insert($0).inserted }
  }

  // MARK: What the session says

  /**
   The requests one gateway's session holds open now (all of them, not only the new ones).

   - Parameters:
     - gatewayName: what the person calls the gateway.
     - gatewayKey: the gateway's link key.
     - requests: `GatewaySession.openRequests(from:)`.
     - connections: the connector cards open on the session; one whose rows are all resolved is not
       waiting for anyone and is left out.
     - chatName: what the person calls a bot, for the cards (a request already carries its own).
     - authoritative: the list can be trusted to say what is over. Pass `false` while the connection
       is not ready: a request missing from a list read mid-reconnect is not an answered one, and it
       stays until a list that can be trusted says it is gone.
   */
  public func update(
    gatewayId: String,
    gatewayName: String,
    gatewayKey: String,
    requests: [OpenRequest],
    connections: [ConnectionRequest] = [],
    chatName: (String) -> String = { $0 },
    authoritative: Bool = true
  ) {
    let seenAt = now()
    var next: [NeedsYouItem] = []
    var listed = Set<String>()

    func add(_ item: NeedsYouItem) {
      guard listed.insert(item.id).inserted else {
        return
      }

      next.append(item)
    }

    for request in requests where request.gatewayId == gatewayId {
      let id = request.key

      add(
        NeedsYouItem(
          id: id,
          gatewayId: gatewayId,
          gatewayName: gatewayName,
          gatewayKey: gatewayKey,
          bot: request.chat,
          botName: request.chatName,
          kind: NeedsYouKind(method: request.method),
          method: request.method,
          requestId: request.requestId,
          level: request.level,
          // Only an approval's or a question's own line is ever put there (`PushRequestMethod.carriesPreview`).
          text: PushRequestMethod(rawValue: request.method)?.carriesPreview == true ? request.text : "",
          since: firstSeen[id] ?? seenAt
        ))
    }

    for card in connections where card.targets.contains(where: { !$0.state.isResolved }) {
      let id = "\(gatewayId)\u{1F}connection:\(card.opID)"

      add(
        NeedsYouItem(
          id: id,
          gatewayId: gatewayId,
          gatewayName: gatewayName,
          gatewayKey: gatewayKey,
          bot: card.chat,
          botName: chatName(card.chat),
          kind: .connector,
          method: NeedsYouItem.connectionMethod,
          requestId: card.opID,
          targets: card.targets.filter { !$0.state.isResolved }.map {
            SecurePrompt.displayText($0.name, limit: SecurePrompt.nameLimit)
          },
          since: firstSeen[id] ?? seenAt
        ))
    }

    if !authoritative {
      // What was listed before and is not now is kept: this list is not one to say it is over.
      for old in parts[gatewayId] ?? [] where !listed.contains(old.id) {
        add(old)
      }
    }

    for item in next where firstSeen[item.id] == nil {
      firstSeen[item.id] = item.since
    }

    for old in parts[gatewayId] ?? [] where !listed.contains(old.id) {
      firstSeen[old.id] = nil
    }

    set(next, for: gatewayId)
  }

  /// The session to this gateway ended (a sign-out, another gateway went live): what waited on it can
  /// no longer be answered from here, so it leaves the list.
  public func sessionEnded(gatewayId: String) {
    for old in parts[gatewayId] ?? [] {
      firstSeen[old.id] = nil
    }

    set([], for: gatewayId)
  }

  private func set(_ part: [NeedsYouItem], for gatewayId: String) {
    parts[gatewayId] = part.isEmpty ? nil : part

    let merged = parts.values.flatMap { $0 }.sorted(by: Self.isBefore)

    if merged != items {
      items = merged
    }
  }

  private static func isBefore(_ lhs: NeedsYouItem, _ rhs: NeedsYouItem) -> Bool {
    if lhs.since != rhs.since {
      return lhs.since < rhs.since
    }

    if lhs.displayBot != rhs.displayBot {
      return lhs.displayBot.localizedStandardCompare(rhs.displayBot) == .orderedAscending
    }

    return lhs.id < rhs.id
  }
}
