import Foundation
import HermieShared

/**
 The bots the share sheet offers, read out of the widgets' own snapshot.

 A share extension cannot ask a gateway anything. It has no socket of its own
 until "Send" is tapped and about three seconds to live, so the only roster
 available to it is the one the app last wrote down — which already exists, is
 already versioned, and is already the list a home-screen widget draws from:
 `widget-snapshot.json`, in the same App Group container, read with the same
 `WidgetSnapshot` type the app writes it with.

 A share sheet needs four of the snapshot's fields. Everything about presence,
 unread and the clipped last line is ignored: this list is "which chat" and
 nothing else, and the ordering it inherits — most recently active first — is
 already the answer to "which one probably".

 ## The consequence worth knowing

 A bot added to the gateway does not appear here until the app has run once
 since. That is the same sentence the widget's picker carries, for the same
 reason, and it is the price of a sheet that opens instantly from inside somebody
 else's application.
 */
struct HermieShareBot: Identifiable, Hashable, Sendable {
  /** The profile name: what `hermie://chat/<bot>` carries and what the manifest stores. */
  let name: String
  /** The primary line, per the app's own "Bot names" setting. A LABEL, not a key. */
  let displayName: String
  /** Relative to the container, when the app has written the file. */
  let avatarPath: String?
  let initials: String
  /** Hex from the app's accent table; white on it is AA. */
  let colour: String

  var id: String { name }
}

enum HermieShareRoster {
  /**
   The roster, or an empty list.

   Every failure answers empty rather than throwing, for the reason the widget
   store gives: there is nowhere to report an error to. A sheet with no bots in
   it says so in words and offers nothing to tap, which is both true and the
   only honest thing to draw — the three reasons it can happen are the App Group
   entitlement missing from one of the two signed binaries, the app never having
   run since the extension was installed, and a snapshot version this build does
   not know.
   */
  static func load() -> [HermieShareBot] {
    snapshot().bots
  }

  /**
   The roster and the gateway it belongs to. The key goes into every entry the sheet writes, so the
   app delivers it to this gateway's bot and to no other gateway's bot of the same name.
   */
  static func snapshot() -> (bots: [HermieShareBot], gatewayKey: String?) {
    guard let container = SharedContainer.url(),
      let data = try? Data(contentsOf: container.appendingPathComponent(SharedContainer.widgetSnapshotFile)),
      let snapshot = WidgetSnapshot.decodeUsable(data) else {
      return ([], nil)
    }

    let key = snapshot.gatewayKey.flatMap { Identifiers.isGatewayKey($0) ? $0 : nil }
    let bots = snapshot.bots.compactMap { bot -> HermieShareBot? in
      guard !bot.name.isEmpty else {
        return nil
      }

      return HermieShareBot(
        name: bot.name,
        displayName: bot.displayName.isEmpty ? bot.name : bot.displayName,
        avatarPath: bot.avatarPath,
        initials: bot.initials.isEmpty ? String(bot.name.prefix(1)).uppercased() : bot.initials,
        colour: bot.colour
      )
    }

    return (bots, key)
  }
}
