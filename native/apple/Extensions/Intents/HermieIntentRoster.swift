import Foundation
import HermieShared

/**
 The bots a Shortcut can name, read out of the widgets' own snapshot.

 A Shortcut is configured while the app is not running, and Siri resolves a
 parameter before anything has been launched. Neither can ask a gateway
 anything, so the only roster available is the one the app last wrote down —
 which already exists, is already versioned, and is already what a home-screen
 widget draws from: `widget-snapshot.json`, in the App Group container, read
 with the `WidgetSnapshot` type the app writes it with.

 ## The consequence worth knowing

 A bot added to the gateway does not appear in Shortcuts or Siri until the app
 has run once since. That is the same sentence the widget's own picker carries,
 for the same reason, and it is the price of a Shortcut that can be built
 without launching anything.
 */
struct HermieRosterBot: Hashable, Sendable {
  /** The profile name: the handle, which is what a request carries. */
  let name: String
  /** The primary line, per the app's "Bot names" setting. A LABEL, not a key. */
  let displayName: String
  /** Whether this bot is waiting on a person right now. */
  let needsInput: Bool
  /** One clipped line of what was last said. */
  let lastLine: String
}

enum HermieIntentRoster {
  /**
   The roster, or an empty list.

   Every failure answers empty rather than throwing, because the callers are a
   parameter resolver and an intent — neither has anywhere to report an error
   to that is better than "no bots". The three reasons it can be empty are the
   App Group entitlement missing from the signed app, the app never having run,
   and a snapshot version this build does not know.
   */
  static func load() -> [HermieRosterBot] {
    guard let container = SharedContainer.url(),
      let data = try? Data(contentsOf: container.appendingPathComponent(SharedContainer.widgetSnapshotFile)),
      let snapshot = WidgetSnapshot.decodeUsable(data) else {
      return []
    }

    return snapshot.bots.compactMap { bot in
      guard !bot.name.isEmpty else {
        return nil
      }

      return HermieRosterBot(
        name: bot.name,
        displayName: bot.displayName.isEmpty ? bot.name : bot.displayName,
        needsInput: bot.needsInput,
        lastLine: bot.lastLine
      )
    }
  }

  /**
   Find a bot by whatever somebody said.

   The handle first and exactly, because that is the identity and the only one
   of the two names that is unique. Then the display name, then a
   case-insensitive pass over both — Siri hands over what it heard, capitalised
   the way it felt like, and "ask researcher" should not fail because the
   profile is called `Researcher`.

   No fuzzy matching beyond that, deliberately. Sending somebody's message to
   the wrong agent because two names were similar is a worse outcome than being
   told a name was not recognised.
   */
  static func find(_ query: String, in bots: [HermieRosterBot]) -> HermieRosterBot? {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)

    if let exact = bots.first(where: { $0.name == trimmed }) {
      return exact
    }

    if let byLabel = bots.first(where: { $0.displayName == trimmed }) {
      return byLabel
    }

    let lowered = trimmed.lowercased()

    return bots.first { $0.name.lowercased() == lowered || $0.displayName.lowercased() == lowered }
  }
}
