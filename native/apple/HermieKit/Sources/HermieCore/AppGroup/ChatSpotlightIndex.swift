import Foundation
import HermieShared

#if canImport(CoreSpotlight)
  import CoreSpotlight
  import UniformTypeIdentifiers
#endif

/**
 What the app may put in the system's search about the chats.

 The bots themselves are indexed by `BotSpotlightIndex` (their names, and their last line unless the
 app lock hides previews). This is the rest of what a person could type to find a chat from outside the
 app:

 - **Titles** of a bot's other conversations (a past one, a branch, a chat of the reader's own), which
   the roster has no row for. Always.
 - **Message text** of the bots' chats, so a word said in a chat is found from Spotlight. Only where this
   policy allows it: text on the system's index is shown on a locked device, in a search nobody
   authenticates, so it is left out wherever the app lock is configured (the same rule that blanks the
   widgets' and the bots' previews, `hidePreviews`), and wherever the person has switched the chat cache
   off (they asked this device not to keep what they have read, and the system's index is another copy).
 */
public enum ChatSpotlightPolicy: Sendable, Equatable {
  /// Titles of conversations, and no message text.
  case titlesOnly
  /// Titles, and the text of the bots' chats.
  case titlesAndText

  /// - Parameters:
  ///   - hidePreviews: the app lock is configured (or on). The surfaces' one rule for "do not show what
  ///     was said on a locked screen".
  ///   - transcriptCache: the person keeps what they have read on this device (Settings, Chats).
  public static func resolve(hidePreviews: Bool, transcriptCache: Bool) -> ChatSpotlightPolicy {
    hidePreviews || !transcriptCache ? .titlesOnly : .titlesAndText
  }

  public var allowsText: Bool {
    self == .titlesAndText
  }
}

/// One item as Spotlight is given it, without the framework's types, so what is indexed is tested on its own.
public struct SpotlightItem: Sendable, Hashable {
  public var identifier: String
  public var domain: String
  public var title: String
  /// Shown under the title; nil for none.
  public var summary: String?
  /// Searched and never shown.
  public var text: String?
  public var keywords: [String]

  public init(
    identifier: String, domain: String, title: String, summary: String? = nil, text: String? = nil,
    keywords: [String] = []
  ) {
    self.identifier = identifier
    self.domain = domain
    self.title = title
    self.summary = summary
    self.text = text
    self.keywords = keywords
  }
}

/// Where items go: the system's index in the app, a recorder in a test.
public protocol SpotlightSink: Sendable {
  /// Everything in `domain` becomes exactly `items`.
  func replace(domain: String, with items: [SpotlightItem])
  /// Take every item of these domains out of the index.
  func delete(domains: [String])
}

/// A conversation to index: the one thing the roster does not already say.
public struct IndexedConversation: Sendable, Equatable {
  public var bot: String
  public var botName: String
  /// The stored session id, which a link opens it by.
  public var session: String
  public var title: String

  public init(bot: String, botName: String, session: String, title: String) {
    self.bot = bot
    self.botName = botName
    self.session = session
    self.title = title
  }
}

/// A bot's chat as text to index.
public struct IndexedChatText: Sendable, Equatable {
  public var bot: String
  public var botName: String
  public var text: String

  public init(bot: String, botName: String, text: String) {
    self.bot = bot
    self.botName = botName
    self.text = text
  }
}

/**
 The conversation titles and the message text in Spotlight, per gateway.

 Each gateway has a domain of its own for each kind (`dev.hermie.app.conversations.<key>` and
 `dev.hermie.app.chattext.<key>`), so a sign-out takes one gateway's items out in one call
 (`purge(gatewayKey:)`) and a policy that turns text off takes every gateway's text out without
 touching a title (`purgeText()`).

 A tap on a result hands the app `CSSearchableItemActionType` with the item's identifier, which is a
 `hermie://` link the router already opens (`DeepLink`): a conversation by `hermie://conversation/…`, a
 bot's chat by `hermie://chat/…` (with a fragment, so a text item and the bot's own item never share an
 identifier).
 */
public struct ChatSpotlightIndex: Sendable {
  public static let conversationsDomain = "dev.hermie.app.conversations"
  public static let textDomain = "dev.hermie.app.chattext"

  /// The most conversations one bot puts in the index, newest first as the listing has them.
  public static let conversationsPerBot = 25
  /// The most of a chat's text one item holds, in characters: the recent end of the chat.
  public static let textLimit = 6000

  let sink: any SpotlightSink

  public init(sink: any SpotlightSink) {
    self.sink = sink
  }

  /// The real index.
  public static func live() -> ChatSpotlightIndex {
    ChatSpotlightIndex(sink: CoreSpotlightSink())
  }

  public static func conversationsDomain(for gatewayKey: String) -> String {
    gatewayKey.isEmpty ? conversationsDomain : "\(conversationsDomain).\(gatewayKey)"
  }

  public static func textDomain(for gatewayKey: String) -> String {
    gatewayKey.isEmpty ? textDomain : "\(textDomain).\(gatewayKey)"
  }

  // MARK: Items

  /// The items for these conversations: titles only, no preview and no text. One whose link cannot be
  /// built (a session id outside the alphabet) is left out.
  public static func titleItems(_ conversations: [IndexedConversation], gatewayKey: String) -> [SpotlightItem] {
    conversations.compactMap { conversation in
      let title = conversation.title.trimmingCharacters(in: .whitespacesAndNewlines)

      guard !title.isEmpty,
        let link = DeepLink.conversation(bot: conversation.bot, session: conversation.session, gatewayKey: gatewayKey)
          .string
      else {
        return nil
      }

      return SpotlightItem(
        identifier: link,
        domain: conversationsDomain(for: gatewayKey),
        title: title,
        summary: conversation.botName,
        keywords: [conversation.bot, conversation.botName, title]
      )
    }
  }

  /// The items for these chats' text, each cut to `textLimit` characters from the recent end. A chat with
  /// no words is left out.
  public static func textItems(_ chats: [IndexedChatText], gatewayKey: String) -> [SpotlightItem] {
    chats.compactMap { chat in
      let text = String(chat.text.suffix(textLimit)).trimmingCharacters(in: .whitespacesAndNewlines)

      guard !text.isEmpty,
        let link = DeepLink.chat(bot: chat.bot, gatewayKey: gatewayKey).string
      else {
        return nil
      }

      return SpotlightItem(
        identifier: link + "#text",
        domain: textDomain(for: gatewayKey),
        title: chat.botName,
        text: text,
        keywords: [chat.bot, chat.botName]
      )
    }
  }

  // MARK: Writing

  public func replaceTitles(_ conversations: [IndexedConversation], gatewayKey: String) {
    sink.replace(
      domain: Self.conversationsDomain(for: gatewayKey), with: Self.titleItems(conversations, gatewayKey: gatewayKey))
  }

  public func replaceText(_ chats: [IndexedChatText], gatewayKey: String) {
    sink.replace(domain: Self.textDomain(for: gatewayKey), with: Self.textItems(chats, gatewayKey: gatewayKey))
  }

  /// A gateway was signed out of or removed: everything of it goes.
  public func purge(gatewayKey: String) {
    sink.delete(domains: [Self.conversationsDomain(for: gatewayKey), Self.textDomain(for: gatewayKey)])
  }

  /// The policy no longer allows text: every gateway's text goes, the titles stay. (A domain's
  /// subdomains go with it, which is how each gateway's `chattext.<key>` is reached.)
  public func purgeText() {
    sink.delete(domains: [Self.textDomain])
  }

  /// Everything this index wrote, for every gateway.
  public func purgeAll() {
    sink.delete(domains: [Self.conversationsDomain, Self.textDomain])
  }

  // MARK: Taps

  /// The link behind a tap on a result: the item's identifier, when it is one of ours.
  public static func link(forIdentifier identifier: String?) -> DeepLink? {
    DeepLink(identifier)
  }
}

/// The system's index (`CSSearchableIndex`). A month's lifetime on every item: a gateway nobody opened in
/// a while does not linger in the system's search, and a refresh keeps a live one fresh.
public struct CoreSpotlightSink: SpotlightSink {
  public static let lifetime: TimeInterval = 30 * 24 * 60 * 60

  public init() {}

  public func replace(domain: String, with items: [SpotlightItem]) {
    #if canImport(CoreSpotlight)
      let index = CSSearchableIndex.default()
      let expiry = Date().addingTimeInterval(Self.lifetime)
      let searchable = items.map { item -> CSSearchableItem in
        let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)

        attributes.title = item.title
        attributes.contentDescription = item.summary
        attributes.textContent = item.text
        attributes.keywords = item.keywords

        let searchable = CSSearchableItem(
          uniqueIdentifier: item.identifier, domainIdentifier: item.domain, attributeSet: attributes)

        searchable.expirationDate = expiry

        return searchable
      }

      // The index applies calls in the order they are made: the domain is emptied, then filled.
      index.deleteSearchableItems(withDomainIdentifiers: [domain], completionHandler: nil)

      if !searchable.isEmpty {
        index.indexSearchableItems(searchable, completionHandler: nil)
      }
    #endif
  }

  public func delete(domains: [String]) {
    #if canImport(CoreSpotlight)
      CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: domains, completionHandler: nil)
    #endif
  }
}
