import Foundation

/**
 Which name of a bot leads, and whether its handle is shown at all (`store/bot-names.ts` and
 Settings › Chats & messages in the Expo app).

 A Hermes profile carries two names. The handle (`profiles.list`'s `name`: `lance-vance`) is the
 bot's identity: what `@`-addressing uses, what a cron names and the only one of the two that is
 unique. The display name ("Netwerkbeheerder") is a label somebody typed. The reader may also have
 given the bot a name of their own (`ui_meta` `labels`), which wins over the roster's.

 - **Name order** (`order`, the account's setting, synced): `display` leads with the name (the
   default: somebody who has given their bots names thinks of them by those names) and keeps the
   handle one line down; `profile` leads with the handle.
 - **Hide the handle** (`hideHandle`, this device's): a bot that HAS a name is shown by it alone and
   `order` stops mattering, because an order that still surfaced the handle one way round would be
   the setting lying about what it does. A bot with no name of its own is untouched: it has one
   name, and the setting is about which of two names shows, not about inventing a second.
 */
public struct BotNamePolicy: Sendable, Equatable {
  public var order: BotNameOrder
  public var hideHandle: Bool

  /// The defaults: the name leads, the handle is shown under it.
  public static let standard = BotNamePolicy(order: .display, hideHandle: false)

  public init(order: BotNameOrder = .display, hideHandle: Bool = false) {
    self.order = order
    self.hideHandle = hideHandle
  }
}

/// The two lines a bot is drawn with, already in the order the reader chose.
public struct BotNames: Sendable, Equatable {
  public var primary: String
  /// Empty when the bot has one name worth showing: a bot never given a name, one whose name is its
  /// handle in another case, or the handle hidden.
  public var secondary: String

  public init(primary: String, secondary: String = "") {
    self.primary = primary
    self.secondary = secondary
  }

  /// `botNames`: the lines for one bot. `label` is the name the reader gave it, `displayName` the
  /// roster's. An empty name is not a name, which is what makes clearing the field fall back rather
  /// than blank the row; the comparison with the handle ignores case and surrounding space, because
  /// `researcher` and `Researcher` are the same name capitalised differently and that pair is the
  /// commonest thing on a real gateway.
  public static func of(
    handle: String, displayName: String, label: String? = nil, policy: BotNamePolicy = .standard
  ) -> BotNames {
    let trimmedLabel = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let name = trimmedLabel.isEmpty ? displayName.trimmingCharacters(in: .whitespacesAndNewlines) : trimmedLabel
    let same = name.isEmpty || name.lowercased() == handle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    if same {
      return BotNames(primary: handle)
    }

    if policy.hideHandle {
      return BotNames(primary: name)
    }

    return policy.order == .display ? BotNames(primary: name, secondary: handle) : BotNames(primary: handle, secondary: name)
  }
}
