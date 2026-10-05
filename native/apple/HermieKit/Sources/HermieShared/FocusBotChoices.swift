import Foundation

/// One bot as the Focus filter's picker offers it: who it is (`FocusFilter.Bot`) and the name to show.
public struct FocusBotChoice: Sendable, Equatable, Identifiable {
  public var bot: FocusFilter.Bot
  /// What the person calls the bot (the primary line per "Bot names"); the handle when it has none.
  public var displayName: String

  public init(bot: FocusFilter.Bot, displayName: String) {
    self.bot = bot
    self.displayName = displayName.isEmpty ? bot.handle : displayName
  }

  /// `<gateway key>/<handle>`: what the picker's entity is identified by (`FocusFilter.Bot.id`).
  public var id: String {
    bot.id
  }
}

/**
 The bots a Focus filter can name, as the picker lists them.

 A Focus is configured in the Settings app while Hermie is not running, so the list cannot come from
 a gateway: it is the roster the app last wrote for the widgets (`widget-snapshot.json`), which is
 the live gateway's. A bot added since, or on another gateway, appears once the app has run with that
 gateway live; a bot chosen earlier stays in the filter either way (`resolve` keeps what it cannot
 find), because a filter is a list of identities and not a copy of the roster.
 */
public enum FocusBotChoices {
  /// The roster of `snapshot`, in its order (most recently active first). Empty for a snapshot that
  /// names no valid gateway, and bots whose handle is not one a link may carry are left out.
  public static func list(in snapshot: WidgetSnapshot?) -> [FocusBotChoice] {
    guard let snapshot, let key = snapshot.gatewayKey, Identifiers.isGatewayKey(key) else {
      return []
    }

    var seen = Set<String>()

    return snapshot.bots.compactMap { row in
      guard Identifiers.isBotName(row.name), seen.insert(row.name).inserted else {
        return nil
      }

      return FocusBotChoice(bot: FocusFilter.Bot(gatewayKey: key, handle: row.name), displayName: row.displayName)
    }
  }

  /// The roster in a container's `widget-snapshot.json`, or empty when there is none, it cannot be
  /// read, or it is of a version this build does not know.
  public static func load(container: URL?) -> [FocusBotChoice] {
    guard let container,
      let data = try? Data(contentsOf: container.appendingPathComponent(SharedContainer.widgetSnapshotFile))
    else {
      return []
    }

    return list(in: WidgetSnapshot.decodeUsable(data))
  }

  /// The bots these identifiers name, in the order asked: the choice from `choices` when there is
  /// one, else the bot by its handle alone. An identifier that names no bot is dropped.
  public static func resolve(_ identifiers: [String], in choices: [FocusBotChoice]) -> [FocusBotChoice] {
    identifiers.compactMap { identifier in
      if let known = choices.first(where: { $0.id == identifier }) {
        return known
      }

      return FocusFilter.Bot(id: identifier).map { FocusBotChoice(bot: $0, displayName: "") }
    }
  }
}
