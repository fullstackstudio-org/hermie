import Foundation

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
}
