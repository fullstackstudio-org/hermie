import Foundation

/// A bot as the indexer reads it.
public struct IndexedBot: Sendable, Equatable {
  public var name: String
  public var displayName: String

  public init(name: String, displayName: String) {
    self.name = name
    self.displayName = displayName
  }
}

/**
 Keeps the system's search up to date with the chats of the live gateway, under `ChatSpotlightPolicy`.

 It is asked often (whenever the chat list changes, which streaming does every frame) and does little:

 - **Titles** are listed per bot from the gateway (`session.list`), at most once every `titleInterval`
   and again at once when told the gateway's sessions changed (`force`), and only handed to the index
   when they differ from what it already has.
 - **Text** is read from what the app already holds (the chats in memory, else the cache), at most once
   every `textInterval`, and only handed to the index when it differs.
 - **Policy** is app-wide. When it stops allowing text, every gateway's text leaves the index in one call
   and the indexer forgets what it wrote, so a later policy that allows it again writes it all afresh,
   whichever gateway is live then.
 - **Purge** (a sign-out, a removal) takes one gateway's items out and forgets them.

 It never reads a gateway it is not given, and writes nothing for a gateway it was told to purge until it
 is given that gateway again.
 */
@MainActor
public final class ChatSpotlightIndexer {
  /// What one gateway's session offers to index. Closures, so a test hands in a script.
  public struct Source: Sendable {
    public var bots: [IndexedBot]
    /// A bot's conversations other than its Bot Chat, newest first.
    public var conversations: @Sendable (_ bot: String) async -> [IndexedConversation]
    /// The recent end of a bot's Bot Chat as text; nil or empty where there is none.
    public var text: @Sendable (_ bot: String) async -> String?

    public init(
      bots: [IndexedBot],
      conversations: @escaping @Sendable (String) async -> [IndexedConversation],
      text: @escaping @Sendable (String) async -> String?
    ) {
      self.bots = bots
      self.conversations = conversations
      self.text = text
    }
  }

  /// The most bots one gateway puts in the index.
  public static let maxBots = 40

  public let index: ChatSpotlightIndex
  public var titleInterval: Duration = .seconds(30 * 60)
  public var textInterval: Duration = .seconds(60)

  private let clock: @MainActor () -> ContinuousClock.Instant
  private var titleReads: [String: ContinuousClock.Instant] = [:]
  private var titleHashes: [String: Int] = [:]
  private var textReads: [String: ContinuousClock.Instant] = [:]
  private var textHashes: [String: Int] = [:]
  /// The policy the last call applied, app-wide.
  private var applied: ChatSpotlightPolicy?
  /// Moves when a gateway is purged, so a read that was in flight for it writes nothing afterwards.
  private var epochs: [String: Int] = [:]

  public init(index: ChatSpotlightIndex, clock: @escaping @MainActor () -> ContinuousClock.Instant = { .now }) {
    self.index = index
    self.clock = clock
  }

  /**
   Bring the index in line with `source` under `policy`.

   - Parameter force: read the conversations again now (the gateway said its sessions changed), whatever
     the interval says.
   */
  public func refresh(gatewayKey: String, source: Source, policy: ChatSpotlightPolicy, force: Bool = false) async {
    // One epoch for the whole run: a purge at any point in it ends it without a write.
    let epoch = epochs[gatewayKey, default: 0]

    await refreshTitles(gatewayKey: gatewayKey, source: source, force: force, epoch: epoch)

    guard !Task.isCancelled, epochs[gatewayKey, default: 0] == epoch else {
      return
    }

    await refreshText(gatewayKey: gatewayKey, source: source, policy: policy, epoch: epoch)
  }

  /// A gateway was signed out of or removed: what is indexed for it goes, and the indexer forgets it.
  public func purge(gatewayKey: String) {
    epochs[gatewayKey, default: 0] += 1
    index.purge(gatewayKey: gatewayKey)
    titleReads[gatewayKey] = nil
    titleHashes[gatewayKey] = nil
    textReads[gatewayKey] = nil
    textHashes[gatewayKey] = nil
  }

  // MARK: Titles

  private func refreshTitles(gatewayKey: String, source: Source, force: Bool, epoch: Int) async {
    let now = clock()

    if !force, let read = titleReads[gatewayKey], now - read < titleInterval {
      return
    }

    var conversations: [IndexedConversation] = []

    for bot in source.bots.prefix(Self.maxBots) {
      guard !Task.isCancelled else {
        return
      }

      conversations += await source.conversations(bot.name).prefix(ChatSpotlightIndex.conversationsPerBot)
    }

    guard !Task.isCancelled, epochs[gatewayKey, default: 0] == epoch else {
      return
    }

    titleReads[gatewayKey] = now

    let items = ChatSpotlightIndex.titleItems(conversations, gatewayKey: gatewayKey)
    let hash = items.hashValue

    if titleHashes[gatewayKey] != hash {
      titleHashes[gatewayKey] = hash
      index.replaceTitles(conversations, gatewayKey: gatewayKey)
    }
  }

  // MARK: Text

  private func refreshText(gatewayKey: String, source: Source, policy: ChatSpotlightPolicy, epoch: Int) async {
    let changed = applied != policy

    applied = policy

    guard policy.allowsText else {
      if changed {
        // Every gateway's text, not only this one's: the policy is the app's. What the indexer wrote is
        // forgotten, so allowing text again writes it afresh.
        index.purgeText()
        textReads = [:]
        textHashes = [:]
      }

      return
    }

    let now = clock()

    if !changed, let read = textReads[gatewayKey], now - read < textInterval {
      return
    }

    var chats: [IndexedChatText] = []

    for bot in source.bots.prefix(Self.maxBots) {
      guard !Task.isCancelled else {
        return
      }

      if let text = await source.text(bot.name), !text.isEmpty {
        chats.append(IndexedChatText(bot: bot.name, botName: bot.displayName, text: text))
      }
    }

    guard !Task.isCancelled, applied == policy, epochs[gatewayKey, default: 0] == epoch else {
      return
    }

    textReads[gatewayKey] = now

    let hash = ChatSpotlightIndex.textItems(chats, gatewayKey: gatewayKey).hashValue

    if textHashes[gatewayKey] != hash {
      textHashes[gatewayKey] = hash
      index.replaceText(chats, gatewayKey: gatewayKey)
    }
  }
}
