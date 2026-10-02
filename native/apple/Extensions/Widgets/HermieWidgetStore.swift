import Foundation
import HermieShared
import SwiftUI

/*
 The file the app writes, as the extension reads it, is `WidgetSnapshot` in `HermieShared`: the
 type the app encodes with is the type this decodes with, so the two cannot drift. These names keep
 the widget code reading as it did when the decoder lived here.
 */
typealias HermieSnapshot = WidgetSnapshot
typealias HermieBot = WidgetSnapshot.Bot
typealias HermieFolder = WidgetSnapshot.Folder

/**
 Reads the snapshot and the avatars out of the shared container.

 This is the whole of what a widget knows. There is no gateway here, no socket, no keychain and no
 store: the extension wakes up, reads one JSON file out of the App Group container, draws, and is
 killed again. Everything derived — presence, unread, the clipped last line, the colour initials
 are drawn on — was derived by the app while it still had the state to derive it from.

 Every failure answers the empty snapshot rather than throwing: a timeline provider has nowhere to
 report an error to, and a widget with nothing in it is a widget that says "Open Hermie", which is
 both true and actionable. The three reasons it can be empty are worth keeping apart in your head,
 because only the first is a bug: the App Group entitlement did not make it onto one of the two
 signed binaries; the app has never run since the widget was added; or the version moved
 (`WidgetSnapshot.isUsable`).
 */
enum HermieWidgetStore {
  static func load() -> HermieSnapshot {
    guard let container = SharedContainer.url(),
      let data = try? Data(contentsOf: container.appendingPathComponent(SharedContainer.widgetSnapshotFile)),
      let snapshot = WidgetSnapshot.decodeUsable(data) else {
      return .empty
    }

    // `decodeUsable` stamps the snapshot's gateway key on every row, so a row's tap can name it.
    return snapshot
  }

  /// One bot's picture, or nil. See `ContainerImage`.
  static func avatar(at path: String?) -> Image? {
    ContainerImage.load(path)
  }
}
