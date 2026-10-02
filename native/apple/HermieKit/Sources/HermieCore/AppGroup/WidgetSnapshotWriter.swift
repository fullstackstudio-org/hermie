import Foundation
import HermieShared
import HermieStore

#if canImport(WidgetKit)
  import WidgetKit
#endif

/**
 Puts the widget snapshot and the avatars where the widgets, the share sheet and the Shortcuts read
 them, then asks every widget to redraw.

 What `HermieWidgetsModule` (`writeSnapshot`, `writeAvatar`, `pruneAvatars`) did for the Expo app.
 The snapshot itself is built elsewhere; this only writes it.

 - The snapshot is replaced atomically: a widget can be woken to draw at any moment, and a rename
   means it sees the old file or the new one, never half of each.
 - Timelines are reloaded only after a write that changed the file. Every widget kind reads this one
   file, so all of them are reloaded; a write that failed, or bytes that did not change, spend none
   of the day's reload budget.
 - An avatar is written before the snapshot that names it, and causes no reload of its own.
 */
public struct WidgetSnapshotWriter: Sendable {
  public let container: AppGroupContainer
  private let reloadTimelines: @Sendable () -> Void

  /// A writer into `container` that calls `reloadTimelines` after each changed snapshot.
  public init(container: AppGroupContainer, reloadTimelines: @escaping @Sendable () -> Void) {
    self.container = container
    self.reloadTimelines = reloadTimelines
  }

  /// The real container and `WidgetCenter`, or nil when the App Group entitlement is missing.
  public static func live() -> WidgetSnapshotWriter? {
    AppGroupContainer.system().map { container in
      WidgetSnapshotWriter(container: container) {
        #if canImport(WidgetKit)
          WidgetCenter.shared.reloadAllTimelines()
        #endif
      }
    }
  }

  /**
   Replace the snapshot. Answers whether the file now holds it.

   Unchanged bytes are not rewritten and reload nothing, so calling this after every roster change
   is cheap.
   */
  @discardableResult
  public func write(_ snapshot: WidgetSnapshot) -> Bool {
    guard let data = try? snapshot.encoded() else {
      return false
    }

    let url = container.widgetSnapshotURL

    if let existing = try? container.read(url, maxBytes: Int.max), existing == data {
      return true
    }

    do {
      try container.write(data, to: url)
    } catch {
      return false
    }

    reloadTimelines()

    return true
  }

  /// One bot's picture, as PNG bytes, at `avatars/<encodeURIComponent(bot)>.png`. Empty bytes are refused.
  @discardableResult
  public func writeAvatar(_ png: Data, forBot bot: String) -> Bool {
    guard !png.isEmpty, !bot.isEmpty else {
      return false
    }

    return (try? container.write(png, to: container.avatarURL(forBot: bot))) != nil
  }

  /**
   Delete every avatar whose bot is not in `bots`, and answer how many went.

   `bots` is the roster the app holds now, so this forgets pictures of bots that no longer exist;
   an avatar of a bot that still exists is never deleted, however old.
   */
  @discardableResult
  public func pruneAvatars(keeping bots: [String]) -> Int {
    let wanted = Set(bots.map { container.avatarURL(forBot: $0).lastPathComponent })
    var removed = 0

    for name in container.contents(of: container.avatarsURL) where !wanted.contains(name) {
      if container.remove(container.avatarsURL.appendingPathComponent(name)) {
        removed += 1
      }
    }

    return removed
  }
}
