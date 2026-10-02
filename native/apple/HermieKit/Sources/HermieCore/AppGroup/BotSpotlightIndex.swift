import Foundation
import HermieShared

#if canImport(CoreSpotlight)
  import CoreSpotlight
  import UniformTypeIdentifiers
#endif

/**
 The roster in Spotlight, so typing a bot's name into system search offers its chat.

 What `HermieIntentsModule.indexBots` did. The whole roster is replaced each time rather than
 diffed: it is at most a dozen rows, and a diff would be a second model of which bots exist that goes
 wrong exactly when one is removed. Call it when the drawn roster changes, next to the widget
 snapshot write.

 Each item's identifier is its `hermie://chat/<bot>` link, so a tap on a result hands back (as
 `CSSearchableItemActionType` with that identifier) the link the app already opens.
 */
public struct BotSpotlightIndex: Sendable {
  /// One domain for every bot, so the old roster goes in one call.
  public static let domain = "dev.hermie.app.bots"
  /// A month: a roster nobody opened in a while stays searchable, an abandoned gateway does not linger.
  public static let lifetime: TimeInterval = 30 * 24 * 60 * 60

  /// One row as Spotlight shows it.
  public struct Entry: Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var subtitle: String
    public var keywords: [String]
  }

  public init() {}

  /// The rows for `bots`, in order; a bot whose link cannot be built is left out.
  public static func entries(for bots: [WidgetSnapshot.Bot]) -> [Entry] {
    bots.compactMap { bot in
      guard !bot.name.isEmpty, let link = DeepLink.chat(bot: bot.name, gatewayKey: "").string else {
        return nil
      }

      let title = bot.displayName.isEmpty ? bot.name : bot.displayName

      // The handle as well as the label: a search for the name the rest of the app uses finds it too.
      return Entry(identifier: link, title: title, subtitle: bot.lastLine, keywords: [bot.name, title])
    }
  }

  /// Replace the index with `bots`.
  public func replace(with bots: [WidgetSnapshot.Bot]) {
    #if canImport(CoreSpotlight)
      let index = CSSearchableIndex.default()
      let expiry = Date().addingTimeInterval(Self.lifetime)
      let items = Self.entries(for: bots).map { entry in
        let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)

        attributes.title = entry.title
        attributes.contentDescription = entry.subtitle.isEmpty ? nil : entry.subtitle
        attributes.keywords = entry.keywords

        let item = CSSearchableItem(
          uniqueIdentifier: entry.identifier,
          domainIdentifier: Self.domain,
          attributeSet: attributes
        )

        item.expirationDate = expiry

        return item
      }

      // The index applies calls in the order they are made, as the Expo module relied on.
      index.deleteSearchableItems(withDomainIdentifiers: [Self.domain], completionHandler: nil)

      if !items.isEmpty {
        index.indexSearchableItems(items, completionHandler: nil)
      }
    #endif
  }
}
