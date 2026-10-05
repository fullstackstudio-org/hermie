import Foundation
import HermieGateway
import HermieProtocol
import HermieStore

/**
 Every gateway this device is signed in to, as search sources.

 The app keeps one live session (ADR-0024), so only that gateway has a socket, a roster in memory and
 chats in memory. The others are searched the way the Accounts page reads them: a REST client built
 from the credentials stored for them (`GatewayAccounts.client(for:)`, the one token coordinator per
 gateway, so a refresh is never spent twice), the roster this device cached for them, and the chats it
 cached for them. A gateway with nothing to sign in with is still a source, with no way to ask, so the
 list can say it was not searched and the cache can still answer.

 What a gateway that is not live cannot give is a fresh roster: a bot created since the gateway was
 last live is not searched there until it is. The cached roster says what it knew.
 */
@MainActor
public struct SearchSources {
  let directory: GatewayDirectory
  let accounts: GatewayAccounts
  let live: LiveGateway
  let store: SQLiteStore
  let cacheSwitch: ChatCacheSwitch?

  public init(launch: AppLaunch, accounts: GatewayAccounts, live: LiveGateway) {
    self.directory = launch.gateways
    self.accounts = accounts
    self.live = live
    self.store = launch.store
    self.cacheSwitch = launch.settings.cacheSwitch
  }

  /// The gateways to search now: the live one first, then the others in the directory's order.
  public func gateways() async -> [SearchGateway] {
    var sources: [SearchGateway] = []
    var others: [SearchGateway] = []

    for entry in directory.entries {
      if let session = live.session, live.gatewayID == entry.id, session.gatewayID == entry.id {
        sources.append(session.searchGateway(key: entry.key, name: entry.displayLabel))
      } else {
        others.append(await stored(entry))
      }
    }

    return sources + others
  }

  /// A gateway that is not the live one, from what is stored for it.
  func stored(_ entry: GatewayDirectory.Entry) async -> SearchGateway {
    let cache = chatCache(for: entry.id)
    let bots = await Self.cachedBots(cache)
    let client = try? await accounts.client(for: entry.id)

    return SearchGateway(
      id: entry.id,
      key: entry.key,
      name: entry.displayLabel,
      ownLead: "",
      bots: bots,
      search: client.map(Self.search(over:)),
      cachedChat: { bot in await LocalChatSearch.read(cache: cache, bot: bot) }
    )
  }

  private func chatCache(for gatewayID: String) -> any ChatCaching {
    let cache = SQLiteChatCache(store: store, gatewayId: gatewayID)

    return cacheSwitch.map { GatedChatCache(cache, gate: $0) } ?? cache
  }

  /// The bots this device last saw on a gateway, in the roster's order. A row it cannot read is left out.
  static func cachedBots(_ cache: any ChatCaching) async -> [SearchBot] {
    guard let rows = try? await cache.readBots() else {
      return []
    }

    return rows.compactMap { row in
      (try? JSONValue(parsing: row.json)).flatMap(Bot.init(jsonValue:)).map { SearchBot($0) }
    }
  }

  /// One bot's search over a REST client: `GET /api/sessions/search`, scoped to the profile.
  static func search(over client: HTTPClient) -> SearchGateway.Search {
    { profile, query, limit, timeoutMs in
      guard let path = SessionSearch.path(query: query, profile: profile, limit: limit) else {
        return []
      }

      return SessionSearch.parse(try await client.get(path, timeoutMs: timeoutMs))
    }
  }
}
