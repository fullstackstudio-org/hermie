import ExpoModulesCore
import WidgetKit

/**
 The app's half of the home-screen widgets: put bytes where another process can read them.

 A widget is not the app. It runs in its own sandbox, with its own memory budget, and it cannot
 see anything the app writes into the app's own container — so the snapshot goes into the App
 Group container (`group.dev.hermie.app`), which is the one place both sandboxes are allowed to
 reach. That group is declared by `plugin/with-hermie-widgets.js` on BOTH targets' entitlements;
 without it on either side `containerURL(forSecurityApplicationGroupIdentifier:)` answers nil and
 everything here degrades to `false`.

 Deliberately the dumb half. It decodes nothing, derives nothing and has no model of a bot: the
 JSON it is handed was produced by `src/features/widgets/snapshot.ts`, which is pure and tested,
 and the only thing that reads it back is the extension. Two consequences worth stating:

  - There is no shared Swift between this module and the extension, and so nothing to keep in
    step across a target boundary. The file format is the contract, and it is versioned.
  - A malformed snapshot is the extension's problem, not this module's. It writes what it is
    given, which is what makes "the app wrote it and the widget did not draw it" a question with
    exactly one place to look.

 **Nothing here throws.** Every function answers a value, including the failures: no container,
 no disk space, a name that cannot be encoded. A widget that is one turn out of date is a widget;
 a message that failed to send because a picture could not be written is a bug.
 */
public class HermieWidgetsModule: Module {
  /**
   The App Group, spelled once.

   It has to match `plugin/with-hermie-widgets.js` exactly, and there is no compiler that will say
   so — a typo here is a nil container and a widget that silently never fills in. The plugin
   asserts the pairing from the other side by writing this same literal into both entitlement
   files, and `docs/platform-notes.md` names it a third time for the person who has to check it in
   the Developer portal.
   */
  private static let appGroup = "group.dev.hermie.app"

  /** The file the extension reads. Also spelled in `snapshot.ts` as `WIDGET_SNAPSHOT_FILE`. */
  private static let snapshotFile = "widget-snapshot.json"

  private static let avatarsDirectory = "avatars"

  /**
   The characters `encodeURIComponent` leaves alone.

   A bot name comes from the gateway and can be anything a profile is called, so it is escaped
   before it becomes a file name — otherwise a name with a slash in it writes outside the
   directory, and one with `..` in it writes outside the container. The set is
   `encodeURIComponent`'s exactly, because `snapshot.ts` writes the SAME path into the JSON with
   that function: the widget looks up `avatars/<name>.png` by the string in the snapshot, and the
   two would silently stop matching if this set drifted. Non-ASCII is percent-encoded per UTF-8
   byte in uppercase hex by both.
   */
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
  )

  public func definition() -> ModuleDefinition {
    Name("HermieWidgets")

    /**
     Replace the snapshot, then ask every widget to redraw.

     Written `.atomic`, which is not decoration here: the extension can be woken to draw at any
     moment, including halfway through this write, and a JSON file read at that moment would
     decode as nothing. Atomic makes the swap a rename, so a reader sees the old file or the new
     one and never a partial one.

     `reloadAllTimelines()` rather than per-kind reloads, because the three widget kinds all read
     this one file and there is no change that could affect only one of them. It is called only
     after a successful write, so a failed write does not spend a reload out of the day's budget
     on content that did not change.
     */
    AsyncFunction("writeSnapshot") { (json: String) -> Bool in
      guard let container = Self.container(), let data = json.data(using: .utf8) else {
        return false
      }

      do {
        try data.write(to: container.appendingPathComponent(Self.snapshotFile), options: .atomic)
      } catch {
        return false
      }

      WidgetCenter.shared.reloadAllTimelines()

      return true
    }

    /**
     One bot's picture, as raw base64 with no data-URL prefix.

     The caller strips the prefix because it is the side that knows what the gateway sent; this
     side only decodes. Bytes that are not valid base64 answer `false` rather than writing an
     empty file, which would make the widget draw an empty circle instead of falling back to the
     initials it draws for a missing one.

     No reload. An avatar is always written just before the snapshot that names it, and that write
     does the reloading for both.
     */
    AsyncFunction("writeAvatar") { (botName: String, base64: String) -> Bool in
      guard let container = Self.container(),
        let fileName = Self.avatarFileName(for: botName),
        let data = Data(base64Encoded: base64), !data.isEmpty else {
        return false
      }

      let directory = container.appendingPathComponent(Self.avatarsDirectory, isDirectory: true)

      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent(fileName), options: .atomic)
      } catch {
        return false
      }

      return true
    }

    /**
     Delete every avatar whose bot is not in `keep`, and answer how many went.

     A shared container is not somewhere to accumulate files nobody will read: a gateway whose
     roster turns over leaves a picture behind for every bot that ever existed, and the container
     counts against the app's storage on a device its owner cannot inspect. `keep` is the roster
     the app currently holds, so this is "forget what is no longer a bot" and not a cache eviction
     — an avatar for a bot that still exists is never deleted, however old it is.
     */
    AsyncFunction("pruneAvatars") { (keep: [String]) -> Int in
      guard let container = Self.container() else {
        return 0
      }

      let directory = container.appendingPathComponent(Self.avatarsDirectory, isDirectory: true)
      let wanted = Set(keep.compactMap { Self.avatarFileName(for: $0) })

      guard let files = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: nil
      ) else {
        return 0
      }

      var removed = 0

      for file in files where !wanted.contains(file.lastPathComponent) {
        if (try? FileManager.default.removeItem(at: file)) != nil {
          removed += 1
        }
      }

      return removed
    }

    /**
     Whether a container was actually obtained. Reported on the developer screen.

     A separate question from whether the module exists: the module is linked into every iOS
     build, and the container is nil whenever the App Group entitlement did not make it onto the
     signed binary — a provisioning profile minted before the capability was added, most often.
     That failure is invisible from JavaScript otherwise, because every function above answers
     `false` for it exactly as it answers `false` for a full disk.
     */
    Function("hasSharedContainer") { () -> Bool in
      Self.container() != nil
    }
  }

  private static func container() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
  }

  /** `<escaped name>.png`, or nil for a name that cannot be escaped at all. */
  private static func avatarFileName(for botName: String) -> String? {
    guard let escaped = botName.addingPercentEncoding(withAllowedCharacters: unreserved), !escaped.isEmpty else {
      return nil
    }

    return "\(escaped).png"
  }
}
