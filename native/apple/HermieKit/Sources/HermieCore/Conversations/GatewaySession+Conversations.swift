import Foundation
import HermieTranscript

extension GatewaySession {
  /// The gateway calls behind the Conversations page and the conversation viewer, over this
  /// session's link, store and roster.
  public var conversationService: ConversationService {
    ConversationService(
      link: link, store: store, roster: roster, ownLead: ownChatLead,
      selectOwn: { [weak self] bot, chat in try await self?.useOwnChat(bot, chat) },
      selectShared: { [weak self] bot in try await self?.chooseChat(bot, mine: false) })
  }

  /// The model behind one bot's Conversations page. A screen builds one per time it is opened.
  public func conversations(for bot: String) -> ConversationsModel {
    ConversationsModel(bot: bot, backend: conversationService)
  }

  /// The model behind the read-only viewer of one of a bot's other conversations. It starts at the
  /// visibility the bot's chat is at, so a conversation reads the way the chat does.
  public func conversationViewer(bot: String, conversation: Conversation) -> ConversationViewerModel {
    ConversationViewerModel(
      bot: bot,
      conversation: conversation,
      backend: conversationService,
      visibility: models[bot]?.visibility ?? defaultVisibility
    )
  }
}
