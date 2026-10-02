import Foundation

/**
 The bots a Shortcut can name, read out of the widgets' own snapshot.

 A Shortcut is configured while the app is not running, and Siri resolves a
 parameter before anything has been launched. Neither can ask a gateway
 anything, so the only roster available is the one the app last wrote down —
 which already exists, is already versioned, and is already what a home-screen
 widget draws from: `widget-snapshot.json`, in the App Group container.

 ## This is the third copy of that decoder, and that is the design

 `widget/HermieWidgetSnapshot.swift` belongs to the widget extension's target
 and `share/HermieShareRoster.swift` to the share extension's. This one belongs
 to the APP target. The three targets share no sources — a file compiled into
 two of them is one edit away from a duplicate symbol, and a framework holding
 them in common is machinery this app does not otherwise need. What they share
 is the FILE FORMAT, which is written down once in
 `src/features/widgets/snapshot.ts` and versioned there.

 Each copy is also smaller than the last, because each needs less. This one
 needs four fields and one derived number.

 ## The consequence worth knowing

 A bot added to the gateway does not appear in Shortcuts or Siri until the app
 has run once since. That is the same sentence the widget's own picker carries,
 for the same reason, and it is the price of a Shortcut that can be built
 without launching anything.
 */
struct HermieRosterBot: Hashable {
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
  static let appGroup = HermieIntentQueue.appGroup

  /** `WIDGET_SNAPSHOT_FILE`, and `WIDGET_SNAPSHOT_VERSION` beside it. */
  private static let snapshotFile = "widget-snapshot.json"
  private static let supportedVersion = 1

  /**
   The roster, or an empty list.

   Every failure answers empty rather than throwing, because the callers are a
   parameter resolver and an intent — neither has anywhere to report an error
   to that is better than "no bots". The three reasons it can be empty are the
   App Group entitlement missing from the signed app, the app never having run,
   and a snapshot version this build does not know.
   */
  static func load() -> [HermieRosterBot] {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
      let data = try? Data(contentsOf: container.appendingPathComponent(snapshotFile)),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (root["version"] as? Int) == supportedVersion,
      let bots = root["bots"] as? [[String: Any]] else {
      return []
    }

    return bots.compactMap { entry in
      guard let name = entry["name"] as? String, !name.isEmpty else {
        return nil
      }

      return HermieRosterBot(
        name: name,
        displayName: (entry["displayName"] as? String) ?? name,
        needsInput: (entry["needsInput"] as? Bool) ?? false,
        lastLine: (entry["lastLine"] as? String) ?? ""
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
