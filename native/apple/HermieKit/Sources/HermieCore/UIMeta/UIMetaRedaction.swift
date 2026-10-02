import Foundation
import HermieProtocol

// The app section carries every device's push row, and every row a send secret (and an Expo token
// or a Web Push endpoint for older devices). None of these types may print one: each describes
// itself by shape (which sections, how many rows, which fields a row has), never by value, in
// `description`, `debugDescription` and the mirror `dump` reads.

/// What a JSON object may say about itself: its keys, sorted. Never a value.
private func keysOf(_ object: JSONObject?) -> String {
  object.map { "[" + $0.keys.sorted().joined(separator: ", ") + "]" } ?? "nil"
}

/// What the push section may say about itself: how many rows and stamps.
private func pushShape(_ app: JSONObject?) -> String {
  let push = app?[UIMeta.pushField]?.objectValue
  let rows = push?[UIMetaPushRow.registrations]?.objectValue?.count ?? 0
  let seen = push?[PushRows.seenKey]?.objectValue?.count ?? 0
  return "push: \(rows) rows, \(seen) seen"
}

extension UIMetaPushRow: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "UIMetaPushRow(transport: \(transport), relay: \(relay ?? "nil"), "
      + "handle: \(handle.map { PushRelay.handlePrefix($0) + "…" } ?? "nil"), "
      + "secret: \(sendSecret == nil ? "nil" : "<redacted>"), carried: \(keysOf(carried)))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

extension UIMetaDocuments: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "UIMetaDocuments(app: \(keysOf(app)), \(pushShape(app)), bots: \(bots.keys.sorted()))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

extension UIMetaSnapshot: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "UIMetaSnapshot(app: \(keysOf(app)), \(pushShape(app)), remote: \(keysOf(remote)), "
      + "pushHome: \(keysOf(pushHome)), bots: \(bots.keys.sorted()), migrated: \(migrated))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

extension UIMetaChange: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "UIMetaChange(documents: \(documents), snapshot: \(snapshot))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}
