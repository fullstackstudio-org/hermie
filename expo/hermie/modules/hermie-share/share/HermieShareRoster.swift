import Foundation
import UIKit

/**
 The bots the share sheet offers, read out of the widgets' own snapshot.

 A share extension cannot ask a gateway anything. It has no socket, no keychain
 and about three seconds to live, so the only roster available to it is the one
 the app last wrote down — which already exists, is already versioned, and is
 already the list a home-screen widget draws from: `widget-snapshot.json`, in
 the same App Group container.

 ## Why this duplicates `HermieWidgetSnapshot.swift`

 It does, and deliberately. That file belongs to the WIDGET extension's target
 and this one belongs to the share extension's, and the two targets share no
 sources — a file compiled into both would be one edit away from a duplicate
 symbol, and a third target holding it in common is a framework this app does
 not otherwise need. What the two copies share is the FILE FORMAT, which is
 written down once in `src/features/widgets/snapshot.ts` and versioned there.

 The copy here is also much smaller, because a share sheet needs four of the
 snapshot's eleven fields. Everything about presence, unread and the clipped
 last line is skipped rather than decoded and ignored: this list is "which chat"
 and nothing else, and the ordering it inherits — most recently active first —
 is already the answer to "which one probably".

 ## The consequence worth knowing

 A bot added to the gateway does not appear here until the app has run once
 since. That is the same sentence `HermieBotIntent.swift` carries about the
 widget's picker, for the same reason, and it is the price of a sheet that
 opens instantly from inside somebody else's application.
 */
struct HermieShareBot: Identifiable, Hashable {
  /** The profile name: what `hermie://chat/<bot>` carries and what the manifest stores. */
  let name: String
  /** The primary line, per the app's own "Bot names" setting. A LABEL, not a key. */
  let displayName: String
  /** Relative to the container, when the app has written the file. */
  let avatarPath: String?
  let initials: String
  /** Hex from the app's accent table; white on it is AA. See `snapshot.ts`. */
  let colour: String

  var id: String { name }
}

enum HermieShareRoster {
  /** Must match `HermieShareOutbox.appGroup` and both entitlement files. */
  static let appGroup = HermieShareOutbox.appGroup

  /** `WIDGET_SNAPSHOT_FILE`, and `WIDGET_SNAPSHOT_VERSION` beside it. */
  private static let snapshotFile = "widget-snapshot.json"
  private static let supportedVersion = 1

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

      return HermieShareBot(
        name: name,
        displayName: (entry["displayName"] as? String) ?? name,
        avatarPath: entry["avatarPath"] as? String,
        initials: (entry["initials"] as? String) ?? String(name.prefix(1)).uppercased(),
        colour: (entry["colour"] as? String) ?? "#1668E3"
      )
    }
  }

  /**
   One bot's picture, or nil.

   The path came out of the snapshot, so it is already escaped; it is appended
   and then checked against the container's own path, so a snapshot that somehow
   named something outside the container reads nothing rather than reading a
   file this process should not.
   */
  static func avatar(at path: String?) -> UIImage? {
    guard let path,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }

    let url = container.appendingPathComponent(path).standardized

    guard url.path.hasPrefix(container.standardized.path) else {
      return nil
    }

    return UIImage(contentsOfFile: url.path)
  }
}

/**
 `#RRGGBB` as a colour, because the app decided the palette and this must not
 have one of its own.

 The same reasoning `snapshot.ts` states for writing hex at all: two native
 renderers with their own accent tables are two tables to drift. An unparseable
 string falls back to the app's default blue rather than to black, because a
 black circle with white initials is a bug that looks like a design.
 */
extension UIColor {
  convenience init(hermieHex hex: String) {
    let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    var value: UInt64 = 0

    guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else {
      self.init(red: 0.086, green: 0.408, blue: 0.890, alpha: 1)

      return
    }

    self.init(
      red: CGFloat((value & 0xFF0000) >> 16) / 255,
      green: CGFloat((value & 0x00FF00) >> 8) / 255,
      blue: CGFloat(value & 0x0000FF) / 255,
      alpha: 1
    )
  }
}
