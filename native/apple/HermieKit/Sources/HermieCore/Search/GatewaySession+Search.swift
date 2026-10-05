import Foundation
import HermieTranscript

extension GatewaySession {
  /// The message search over this session's gateway: one model per list screen, driven by its field.
  /// A model is bound to the session's link, so a screen builds a new one for another session.
  public func messageSearch() -> MessageSearchModel {
    let link = self.link

    return MessageSearchModel { profile, query, limit, timeoutMs in
      try await link.searchSessions(profile: profile, query: query, limit: limit, timeoutMs: timeoutMs)
    }
  }

  /// The bots a message search covers: the whole roster in its own order, archived chats included
  /// (a match is never hidden behind the archive).
  public var searchableBots: [Bot] {
    chatList.names.compactMap { chatList.rows[$0]?.bot }
  }

  /**
   This session's gateway as a search source for the all-conversations search: its bots under the
   names the reader gave them, the live link as the way to ask, and the chats this session holds (what
   it has in memory, else what the cache kept) as the local half.

   - Parameters:
     - key: the gateway's link key (`GatewayDirectory`), which the session does not know.
     - name: the gateway's label as the person sees it.
   */
  public func searchGateway(key: String, name: String) -> SearchGateway {
    let link = self.link
    let store = self.store

    return SearchGateway(
      id: gatewayID,
      key: key,
      name: name,
      ownLead: ownChatLead,
      bots: searchableBots.map { SearchBot($0, displayName: chatName($0.name)) },
      search: { profile, query, limit, timeoutMs in
        try await link.searchSessions(profile: profile, query: query, limit: limit, timeoutMs: timeoutMs)
      },
      cachedChat: { bot in await store.searchableMessages(bot) }
    )
  }
}

extension GatewaySession {
  /**
   What the system's search is given about this session's gateway (`ChatSpotlightIndexer`): the bots
   under the names the reader gave them, each bot's other conversations from the gateway's listing, and
   the recent end of each Bot Chat as text, from what the app already holds.
   */
  public func spotlightSource() -> ChatSpotlightIndexer.Source {
    let service = conversationService
    let store = self.store
    let names = searchableBots.map { IndexedBot(name: $0.name, displayName: chatName($0.name)) }
    let byName = Dictionary(names.map { ($0.name, $0.displayName) }, uniquingKeysWith: { first, _ in first })

    return ChatSpotlightIndexer.Source(
      bots: names,
      conversations: { bot in
        guard let groups = try? await service.list(bot: bot) else {
          return []
        }

        let others = ConversationClassifier.sorted(groups.mine + groups.branches + groups.past)

        return others.map {
          IndexedConversation(bot: bot, botName: byName[bot] ?? bot, session: $0.id, title: $0.displayTitle)
        }
      },
      text: { bot in await store.recentText(bot) }
    )
  }
}

extension TranscriptStore {
  /// The recent end of a bot's Bot Chat as one text: the last `items` messages with words in them, one
  /// to a line. Nil where the app holds none.
  func recentText(_ bot: String, items: Int = 60) async -> String? {
    guard let messages = await searchableMessages(bot), !messages.isEmpty else {
      return nil
    }

    return messages.suffix(items).map(\.text).joined(separator: "\n")
  }

  /**
   What a local search reads of a bot's Bot Chat: the rows the chat holds in memory (what a cold start
   painted from the cache, plus what has arrived since), else the cache itself. Nil where neither has
   anything.

   An own chat the reader has open in place of the shared one is not the Bot Chat, and a search that
   named it as such would open the wrong conversation: such a bot falls back to the cache, which keeps
   the shared chat only (`ownKeys`).
   */
  func searchableMessages(_ bot: String) async -> [CachedMessage]? {
    if !ownKeys.contains(bot), let state = chats[bot]?.state, !state.order.isEmpty {
      let messages: [CachedMessage] = state.order.compactMap { id in
        guard let item = state.items[id] else {
          return nil
        }

        let text = FindInChat.text(of: item)

        return text.isEmpty ? nil : CachedMessage(id: id, text: text, at: item.base.ts)
      }

      if !messages.isEmpty {
        return messages
      }
    }

    guard let cache else {
      return nil
    }

    return await LocalChatSearch.read(cache: cache, bot: bot)
  }
}
