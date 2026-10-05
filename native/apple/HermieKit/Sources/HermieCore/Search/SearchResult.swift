import Foundation
import HermieProtocol

/// Which of a bot's conversations a search result is in. The listing the gateway keeps has no kind
/// field, so this is read the way the Conversations page reads it (`ConversationClassifier`): the
/// roster's id for the Bot Chat, the reader's lead for an own chat, the title for the rest.
public enum SearchResultKind: Sendable, Equatable, Hashable {
  /// The bot's shared Bot Chat: the one chat the app shows live.
  case botChat
  /// One of the reader's own chats with the bot.
  case ownChat
  /// A fork of another conversation.
  case branch
  /// Any other session of the profile: one `/new` put away, or one somebody named.
  case past
}

/// Where a search result came from. A result found in both is one result.
public struct SearchOrigins: OptionSet, Sendable, Hashable {
  public let rawValue: Int

  public init(rawValue: Int) {
    self.rawValue = rawValue
  }

  /// The gateway's full-text search (`GET /api/sessions/search`).
  public static let server = SearchOrigins(rawValue: 1)
  /// The transcript this device kept (`ChatCaching`).
  public static let cache = SearchOrigins(rawValue: 2)
}

/// Where tapping a result goes. Everything it needs is in the value: the router takes it as it is.
public struct SearchDestination: Sendable, Equatable, Hashable {
  public enum Target: Sendable, Equatable, Hashable {
    /// The bot's own chat, at the message.
    case botChat
    /// One of its other conversations, read in the viewer, at the message. `id` is the STORED id (the
    /// lineage root, where the gateway named one) and `resolvedID` the tip the REST transcript is read
    /// under; `title` is the gateway's text.
    case conversation(id: String, resolvedID: String, title: String)
  }

  /// The registry id (`g…`) of the gateway the result is on.
  public var gatewayID: String
  public var bot: String
  public var target: Target

  public init(gatewayID: String, bot: String, target: Target) {
    self.gatewayID = gatewayID
    self.bot = bot
    self.target = target
  }
}

/// One conversation that holds the words, on one gateway: the bot, the chat, a snippet and when.
///
/// Every text in it came from a gateway or a bot, so it is only ever drawn as characters
/// (`MessageSnippet`, `Text(verbatim:)`), never as Markdown.
public struct SearchResult: Sendable, Equatable, Identifiable {
  /// The registry id (`g…`).
  public var gatewayID: String
  /// The link key (sixteen hex digits), for a link that names the gateway; may be empty.
  public var gatewayKey: String
  public var gatewayName: String
  /// The profile name: what every call is scoped by.
  public var bot: String
  /// What this person calls the bot.
  public var botName: String
  /// The lineage TIP: the session id that is live today.
  public var sessionID: String
  public var lineageRoot: String?
  /// The gateway's title for the conversation; empty when it had none.
  public var title: String
  /// What the reader named one of their own chats (the title without the lead that finds it on every
  /// device); empty for any other conversation, and for an own chat that has no name of its own.
  public var ownLabel: String
  public var kind: SearchResultKind
  /// The gateway's snippet, markers (`>>>` / `<<<`) and all, or one cut from the local transcript the
  /// same way. Draw it with `MessageSnippet`.
  public var snippet: String
  /// Seconds since the epoch.
  public var at: Double?
  public var role: String?
  public var origins: SearchOrigins

  public init(
    gatewayID: String,
    gatewayKey: String = "",
    gatewayName: String = "",
    bot: String,
    botName: String? = nil,
    sessionID: String,
    lineageRoot: String? = nil,
    title: String = "",
    ownLabel: String = "",
    kind: SearchResultKind,
    snippet: String,
    at: Double? = nil,
    role: String? = nil,
    origins: SearchOrigins = .server
  ) {
    self.gatewayID = gatewayID
    self.gatewayKey = gatewayKey
    self.gatewayName = gatewayName
    self.bot = bot
    self.botName = botName ?? bot
    self.sessionID = sessionID
    self.lineageRoot = lineageRoot
    self.title = title
    self.ownLabel = ownLabel
    self.kind = kind
    self.snippet = snippet
    self.at = at
    self.role = role
    self.origins = origins
  }

  /// What makes two results the same conversation: the gateway, the bot, and the conversation. A Bot
  /// Chat is one conversation however many ids it has been known by (its stored id, its lineage tip, its
  /// root), so it is keyed by that and not by any of them.
  public var identity: String {
    let conversation = kind == .botChat ? "chat" : (lineageRoot ?? sessionID)

    return "\(gatewayID)\u{1F}\(bot)\u{1F}\(conversation)"
  }

  public var id: String { identity }

  /// Where a tap goes.
  public var destination: SearchDestination {
    switch kind {
    case .botChat:
      SearchDestination(gatewayID: gatewayID, bot: bot, target: .botChat)
    case .ownChat, .branch, .past:
      SearchDestination(
        gatewayID: gatewayID, bot: bot,
        target: .conversation(id: lineageRoot ?? sessionID, resolvedID: sessionID, title: title))
    }
  }

  /// Found in this device's own copy only: the gateway has not confirmed it.
  public var cacheOnly: Bool {
    origins == .cache
  }
}

/// A bot as a search sees it.
public struct SearchBot: Sendable, Equatable {
  public var name: String
  public var displayName: String
  /// The stored and tip ids of the bot's Bot Chat, as the roster knows them. Empty where the gateway
  /// resolved none: nothing is then recognised as the Bot Chat by id.
  public var canonicalIDs: [String]

  public init(name: String, displayName: String? = nil, canonicalIDs: [String] = []) {
    self.name = name
    self.displayName = displayName ?? name
    self.canonicalIDs = canonicalIDs.filter { !$0.isEmpty }
  }

  public init(_ bot: Bot, displayName: String? = nil) {
    self.init(
      name: bot.name, displayName: displayName ?? bot.displayName,
      canonicalIDs: [bot.canonical?.id, bot.canonical?.resolvedID].compactMap { $0 })
  }
}

/// One message of a locally kept transcript, as a search reads it.
public struct CachedMessage: Sendable, Equatable {
  public var id: String
  public var text: String
  /// Seconds since the epoch, when the item carried one.
  public var at: Double?

  public init(id: String, text: String, at: Double? = nil) {
    self.id = id
    self.text = text
    self.at = at
  }
}

/// What a search needs of one gateway, as plain values and closures: the live one's link, another
/// signed-in one's REST client, a test's script.
public struct SearchGateway: Sendable {
  /// One bot's search: the words, a ceiling on hits, a timeout in milliseconds.
  public typealias Search = @Sendable (_ profile: String, _ query: String, _ limit: Int, _ timeoutMs: Int) async throws
    -> [SessionSearchHit]
  /// The transcript this device kept for a bot's chat, newest last; nil where it kept none.
  public typealias CachedChat = @Sendable (_ bot: String) async -> [CachedMessage]?

  public var id: String
  public var key: String
  public var name: String
  /// The title the reader's own chats start with on this gateway; empty where nobody is named.
  public var ownLead: String
  public var bots: [SearchBot]
  /// nil: the gateway cannot be asked now (it is signed out). Its local copy is still searched.
  public var search: Search?
  public var cachedChat: CachedChat

  public init(
    id: String,
    key: String = "",
    name: String,
    ownLead: String = "",
    bots: [SearchBot],
    search: Search?,
    cachedChat: @escaping CachedChat = { _ in nil }
  ) {
    self.id = id
    self.key = key
    self.name = name
    self.ownLead = ownLead
    self.bots = bots
    self.search = search
    self.cachedChat = cachedChat
  }
}
