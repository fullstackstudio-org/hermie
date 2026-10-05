import Foundation
import Observation

/// A bot on a gateway: what a quick ask is addressed to, and what "Open in Hermie" opens.
public struct QuickAskTarget: Hashable, Sendable {
  /// The registry id of the gateway (`g…`).
  public var gatewayID: String
  /// The bot's profile name.
  public var bot: String

  public init(gatewayID: String, bot: String) {
    self.gatewayID = gatewayID
    self.bot = bot
  }
}

/**
 What the reader decided about the quick ask on this Mac: whether the menu bar item is there, the
 global shortcut that opens it, and the bot it was last used with. Device-wide, and not synced: a
 shortcut and a menu bar are facts about one Mac.

 Kept in `UserDefaults`, read when this is made, not through the database that `AppLaunch` opens
 asynchronously: the menu bar item is a scene that the system asks about before the first frame, and
 an item that appeared for a moment and went again, for a reader who switched it off, would be
 worse than none. A value that does not read back is the default for this launch and is left where it
 is.

 - `showInMenuBar` is on unless the reader switched it off.
 - `hotKey` is Option-Space unless the reader chose another or switched it off (`nil`).
 */
@MainActor
@Observable
public final class QuickAskSettings {
  public static let showKey = "hermie.quickAsk.showInMenuBar"
  public static let hotKeyKey = "hermie.quickAsk.hotKey"
  public static let lastBotKey = "hermie.quickAsk.lastBot"

  /// The menu bar item is in the menu bar.
  public private(set) var showInMenuBar: Bool
  /// The global shortcut, or nil for none.
  public private(set) var hotKey: HotKeyShortcut?
  /// The bot a quick ask was last sent to, for the next one.
  public private(set) var lastBot: QuickAskTarget?

  @ObservationIgnored private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    showInMenuBar = defaults.object(forKey: Self.showKey) as? Bool ?? true
    hotKey = Self.readHotKey(defaults)
    lastBot = Self.readLastBot(defaults)
  }

  public func setShowInMenuBar(_ show: Bool) {
    guard show != showInMenuBar else {
      return
    }

    showInMenuBar = show

    // Only the departure from the default is kept.
    if show {
      defaults.removeObject(forKey: Self.showKey)
    } else {
      defaults.set(false, forKey: Self.showKey)
    }
  }

  /// Choose the shortcut, or none with nil. One that `HotKeyShortcut.isValid` refuses is not taken.
  /// Answers whether it was.
  @discardableResult
  public func setHotKey(_ shortcut: HotKeyShortcut?) -> Bool {
    if let shortcut, !shortcut.isValid {
      return false
    }

    guard shortcut != hotKey else {
      return true
    }

    hotKey = shortcut

    if shortcut == .standard {
      defaults.removeObject(forKey: Self.hotKeyKey)
    } else {
      // "" is "none": absent is the default, so the two are not the same thing.
      defaults.set(shortcut?.storageString ?? "", forKey: Self.hotKeyKey)
    }

    return true
  }

  public func resetHotKey() {
    setHotKey(.standard)
  }

  public func setLastBot(_ target: QuickAskTarget) {
    guard target != lastBot else {
      return
    }

    lastBot = target
    defaults.set(["gateway": target.gatewayID, "bot": target.bot], forKey: Self.lastBotKey)
  }

  private static func readHotKey(_ defaults: UserDefaults) -> HotKeyShortcut? {
    guard let stored = defaults.string(forKey: hotKeyKey) else {
      return .standard
    }

    if stored.isEmpty {
      return nil
    }

    return HotKeyShortcut(storage: stored) ?? .standard
  }

  private static func readLastBot(_ defaults: UserDefaults) -> QuickAskTarget? {
    guard let stored = defaults.dictionary(forKey: lastBotKey) as? [String: String],
      let gateway = stored["gateway"], let bot = stored["bot"], !gateway.isEmpty, !bot.isEmpty
    else {
      return nil
    }

    return QuickAskTarget(gatewayID: gateway, bot: bot)
  }
}
