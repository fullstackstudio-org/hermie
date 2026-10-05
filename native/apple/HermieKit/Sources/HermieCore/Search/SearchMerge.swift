import Foundation
import HermieProtocol

/// How the two halves of the search, the gateway's and this device's, become one list.
public enum SearchMerge {
  /// The most results one search keeps, so a broad word on a gateway with many bots stays a list.
  public static let limit = 100

  // MARK: Classifying

  /// Which of the bot's conversations a hit is in.
  ///
  /// The Bot Chat is recognised by id, as `MessageSearchModel.isCanonical` does: the roster knows it
  /// under two ids and the search answers with the tip plus the root it came from, and any of them
  /// agreeing is the same conversation. A bot with no resolved Bot Chat has none to recognise (and an
  /// own chat or a branch is told apart by its title alone, which is the listing's own limit).
  public static func kind(of hit: SessionSearchHit, bot: SearchBot, ownLead: String) -> SearchResultKind {
    if bot.canonicalIDs.contains(hit.sessionID) || (hit.lineageRoot.map { bot.canonicalIDs.contains($0) } ?? false) {
      return .botChat
    }

    let title = hit.title ?? ""

    if OwnChatTitle.isOwn(title, lead: ownLead) {
      return .ownChat
    }

    return ConversationClassifier.isBranchTitle(title) ? .branch : .past
  }

  /// A server hit as a result.
  public static func result(of hit: SessionSearchHit, bot: SearchBot, in gateway: SearchGateway) -> SearchResult {
    let kind = Self.kind(of: hit, bot: bot, ownLead: gateway.ownLead)

    return SearchResult(
      gatewayID: gateway.id,
      gatewayKey: gateway.key,
      gatewayName: gateway.name,
      bot: bot.name,
      botName: bot.displayName,
      sessionID: hit.sessionID,
      lineageRoot: hit.lineageRoot,
      title: hit.title ?? "",
      ownLabel: kind == .ownChat ? OwnChatTitle.label(of: hit.title ?? "", lead: gateway.ownLead) : "",
      kind: kind,
      snippet: hit.snippet,
      at: hit.at,
      role: hit.role,
      origins: .server
    )
  }

  /// A hit in a bot's locally kept chat as a result: it is always the Bot Chat, the one conversation
  /// the cache keeps. Without a resolved id there is nothing to name it by, so there is no result.
  public static func result(of hit: LocalChatHit, bot: SearchBot, in gateway: SearchGateway) -> SearchResult? {
    guard let canonical = bot.canonicalIDs.first else {
      return nil
    }

    return SearchResult(
      gatewayID: gateway.id,
      gatewayKey: gateway.key,
      gatewayName: gateway.name,
      bot: bot.name,
      botName: bot.displayName,
      sessionID: bot.canonicalIDs.last ?? canonical,
      lineageRoot: nil,
      title: "",
      kind: .botChat,
      snippet: hit.snippet,
      at: hit.at,
      origins: .cache
    )
  }

  // MARK: Merging

  /**
   One list from the gateway's results and the local ones.

   - **Dedup.** Two results with the same `identity` (the same bot's Bot Chat on the same gateway, or
     the same lineage root) are one: the gateway's wording wins (its snippet is the index's account of
     what matched, and its date is `last_active`), the local one contributes only what the gateway left
     out, and `origins` says both saw it.
   - **Order.** Newest first, then by gateway, bot and title, so the order never depends on which
     request landed first.
   - **Bounded** to `limit`.
   */
  public static func merge(server: [SearchResult], local: [SearchResult], limit: Int = Self.limit) -> [SearchResult] {
    var byIdentity: [String: SearchResult] = [:]

    for result in server {
      if let held = byIdentity[result.identity] {
        byIdentity[result.identity] = best(held, result)
      } else {
        byIdentity[result.identity] = result
      }
    }

    for result in local {
      guard var held = byIdentity[result.identity] else {
        byIdentity[result.identity] = result
        continue
      }

      held.origins.formUnion(result.origins)

      if held.at == nil {
        held.at = result.at
      }

      byIdentity[result.identity] = held
    }

    return Array(order(Array(byIdentity.values)).prefix(max(0, limit)))
  }

  /// Newest first, then gateway name, bot name, title, identity.
  public static func order(_ results: [SearchResult]) -> [SearchResult] {
    results.sorted { lhs, rhs in
      let (a, b) = (lhs.at ?? 0, rhs.at ?? 0)

      if a != b {
        return a > b
      }

      for (left, right) in [(lhs.gatewayName, rhs.gatewayName), (lhs.botName, rhs.botName), (lhs.title, rhs.title)] {
        switch left.localizedCompare(right) {
        case .orderedAscending: return true
        case .orderedDescending: return false
        case .orderedSame: continue
        }
      }

      return lhs.identity < rhs.identity
    }
  }

  /// Of two gateway results for one conversation (a compression lineage seen from two of its sessions),
  /// the one that was active last.
  private static func best(_ left: SearchResult, _ right: SearchResult) -> SearchResult {
    (right.at ?? 0) > (left.at ?? 0) ? right : left
  }
}
