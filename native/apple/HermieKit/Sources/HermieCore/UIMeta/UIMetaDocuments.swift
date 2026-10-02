import Foundation
import HermieProtocol

/// What kind of local change an edit is, which decides whether it is sent and
/// whether it dates the app section (ADR-0016, "last writer wins needs a
/// definition of last").
public enum UIMetaEdit: Sendable, Hashable {
  /// Somebody chose it. Sent, and a change to the app section's choices moves
  /// its `updatedAt`.
  case choice
  /// Housekeeping nobody decided: the roster folded into the order, lapsed mutes
  /// swept, a stale id forgotten, this device's own push row. Sent, never dated.
  case chore
  /// What this device already holds (its disk, a store it was loaded from).
  /// Neither sent nor dated now; a gateway that lacks the section is still
  /// seeded from it on the next reconcile.
  case baseline
}

/// The device's own copy of its `ui_meta` sections: the thing the app paints
/// from, before and without a gateway.
///
/// Held RAW. Every field this build does not understand, and every row another
/// device wrote, is carried through untouched; an edit changes only what it names.
public struct UIMetaDocuments: Sendable, Hashable, Codable {
  public var app: JSONObject?
  public var bots: [String: JSONObject]

  public init(app: JSONObject? = nil, bots: [String: JSONObject] = [:]) {
    self.app = app
    self.bots = bots
  }

  /// The local copy as the sync reads it.
  public var snapshot: UIMetaSnapshot {
    UIMetaSnapshot(app: app, bots: bots)
  }

  // MARK: - Taking a gateway's copy

  /// The app fields a section written before them says nothing about, so an
  /// arriving section that lacks one (or carries `null`) leaves the device's
  /// value alone: exactly the fields `applySnapshot` treats that way. Reading
  /// "absent" as "empty" there would unpin, un-name or un-mute everything the
  /// moment an older device wrote.
  public static let keptWhenAbsent: Set<String> = [
    UIMetaField.entries, UIMetaField.folders, UIMetaField.pinned, UIMetaField.myChats, UIMetaField.current,
    UIMetaField.labels, UIMetaField.mutes, UIMetaField.defaults, UIMetaField.botNameOrder, UIMetaField.textSize,
    UIMetaField.themeChoice, UIMetaField.themes
  ]

  /// Fields no build writes any more. The reference's projection leaves them
  /// out, so its next write removes them; this copy never holds them either.
  /// `context` went with HERM-119 (`expo/hermie/src/store/device-context.ts`).
  public static let retired: Set<String> = [UIMeta.contextField]

  /// Put a gateway's copy in place of the device's (`applySnapshot`).
  ///
  /// - The bot sections are the snapshot's, whole: a bot the snapshot has no
  ///   section for has nothing archived and no colour.
  /// - The app section mirrors the arriving one: every field it carries is
  ///   taken as it came (unknown ones included, so they are carried), and a
  ///   field it no longer carries is gone, so any client can remove one. Only
  ///   `keptWhenAbsent` keeps the device's value when the arriving section is
  ///   silent about it, and the gateway's when the device has none either.
  /// - `updatedAt` is adopted as it arrived, absent included, so the comparison
  ///   stays transitive: a device that took a copy holds the date it was chosen.
  /// - `push` comes from where the notifier looks (`pushHome`, else `remote`),
  ///   never from the device's own copy: the rows another device wrote are
  ///   somebody else's, and a local fallback would resend rows the gateway has
  ///   dropped. This device's own rows are folded in afterwards by the sync.
  /// - No arriving app section leaves the held one as it was, push rows aside;
  ///   the sync then sends it to the gateway that lacks it.
  public mutating func take(_ snapshot: UIMetaSnapshot) {
    bots = snapshot.bots

    let push = Self.push(of: snapshot.pushHome ?? snapshot.remote)

    guard let arriving = snapshot.app else {
      if var held = app {
        held[UIMeta.pushField] = push
        app = Self.withoutRetired(held)
      }

      return
    }

    var merged: JSONObject = [:]

    for (key, value) in arriving where key != UIMeta.appUpdatedAt && key != UIMeta.pushField && value != .null {
      merged[key] = value
    }

    // Silent about a known field: the device's value, or, when the device's own
    // copy won and never set the field, the gateway's (a choice nobody here made
    // is not overruled by one this device never made either).
    for key in Self.keptWhenAbsent where merged[key] == nil {
      if let value = app?[key] ?? snapshot.remote?[key], value != .null {
        merged[key] = value
      }
    }

    if let date = arriving[UIMeta.appUpdatedAt], date != .null {
      merged[UIMeta.appUpdatedAt] = date
    }

    merged[UIMeta.pushField] = push
    merged["v"] = .number(Double(UIMeta.appSectionVersion))

    app = Self.withoutRetired(merged)
  }

  /// A section's push map, or `nil` (which removes the field) when it has none.
  private static func push(of section: JSONObject?) -> JSONValue? {
    guard let push = section?[UIMeta.pushField], push != .null else {
      return nil
    }

    return push
  }

  private static func withoutRetired(_ section: JSONObject) -> JSONObject {
    section.filter { !retired.contains($0.key) }
  }

  /// The copy as it may be written to disk: without the push rows. Other
  /// installations' rows carry tokens and send secrets, which the reference
  /// keeps in memory only (`expo/hermie/src/store/push.ts`).
  public var persistable: UIMetaDocuments {
    var copy = self
    copy.app?.removeValue(forKey: UIMeta.pushField)
    return copy
  }

  /// Put this device's own push rows into the app section: `nil` removes a row.
  /// Every other row, and every other field, stays exactly as it is.
  public mutating func fold(pushRows: [String: JSONObject?]) {
    guard !pushRows.isEmpty, app != nil || pushRows.values.contains(where: { $0 != nil }) else {
      return
    }

    var section = app ?? ["v": .number(Double(UIMeta.appSectionVersion))]
    var push = section[UIMeta.pushField]?.objectValue ?? [:]
    var registrations = push[UIMetaPushRow.registrations]?.objectValue ?? [:]

    for (installation, row) in pushRows {
      registrations[installation] = row.map(JSONValue.object)
    }

    push[UIMetaPushRow.registrations] = .object(registrations)
    section[UIMeta.pushField] = .object(push)
    app = section
  }

  // MARK: - Local edits

  /// The app section minus what is not anybody's choice: the push rows (written
  /// by heartbeats) and the date itself (dating a change of date would loop).
  public static func choices(of app: JSONObject?) -> JSONObject? {
    guard var choices = app else {
      return nil
    }

    choices.removeValue(forKey: UIMeta.pushField)
    choices.removeValue(forKey: UIMeta.appUpdatedAt)
    return choices
  }

  /// Apply an edit to the app section. Answers whether it changed anything.
  ///
  /// A `.choice` that changed the section's choices dates it: never earlier than
  /// `now`, and always later than the date already held, so a choice made here
  /// is newer than the copy it replaces even on a clock that runs behind.
  public mutating func editApp(
    _ edit: UIMetaEdit,
    now: Double,
    _ change: (inout JSONObject) -> Void
  ) -> Bool {
    let before = app
    var section = before ?? [:]

    change(&section)
    section["v"] = .number(Double(UIMeta.appSectionVersion))

    guard section != before else {
      return false
    }

    if edit == .choice, Self.choices(of: section) != Self.choices(of: before) {
      let held = UIMeta.appStamp(of: before)
      let stamp = max(now.isFinite && now > 0 ? now.rounded(.down) : 0, held + 1)
      section[UIMeta.appUpdatedAt] = .number(stamp)
    }

    app = section
    return true
  }

  /// Apply an edit to one bot's section. Answers whether it changed anything.
  ///
  /// A section left with nothing but its version is REMOVED: a bot that is no
  /// longer archived and has no colour has nothing to say, and an empty object
  /// would be a key on somebody's profile that means nothing.
  public mutating func editBot(_ name: String, _ change: (inout JSONObject) -> Void) -> Bool {
    let before = bots[name]
    var section = before ?? [:]

    change(&section)
    section.removeValue(forKey: "v")

    let after: JSONObject? =
      section.isEmpty ? nil : section.merging(["v": .number(Double(UIMeta.botSectionVersion))]) { _, version in version }

    guard after != before else {
      return false
    }

    bots[name] = after
    return true
  }
}

/// One installation's push registration, as far as this layer writes it
/// (`push.registrations[<installation id>]`, ADR-0017 and D28).
///
/// Deliberately small and replaceable: the push client owns the real row. What
/// it pins is the boundary: a writer can set the transport, the relay origin,
/// the handle and the send secret, and carry what it does not know (`enc`, an
/// Expo `token`, web-push `keys`) as it came; it cannot reach any other row or
/// any other field of the section.
public struct UIMetaPushRow: Sendable, Hashable {
  /// The map the rows live in, inside `push`.
  public static let registrations = "registrations"
  /// The keys this type writes itself; `carried` cannot override them.
  public static let knownKeys: Set<String> = ["v", "transport", "relay", "handle", "sendSecret"]

  public var transport: String
  public var relay: String?
  public var handle: String?
  public var sendSecret: String?
  /// Every other key of the row, carried untouched.
  public var carried: JSONObject

  public init(transport: String, relay: String? = nil, handle: String? = nil, sendSecret: String? = nil, carried: JSONObject = [:]) {
    self.transport = transport
    self.relay = relay
    self.handle = handle
    self.sendSecret = sendSecret
    self.carried = carried.filter { !Self.knownKeys.contains($0.key) }
  }

  /// A row as another build wrote it.
  public init?(json: JSONObject) {
    guard let transport = json["transport"]?.stringValue else {
      return nil
    }

    self.init(
      transport: transport,
      relay: json["relay"]?.stringValue,
      handle: json["handle"]?.stringValue,
      sendSecret: json["sendSecret"]?.stringValue,
      carried: json
    )
  }

  /// The row as it goes into the section (`v: 1`, additive).
  public var json: JSONObject {
    var row = carried.filter { !Self.knownKeys.contains($0.key) }
    row["v"] = 1
    row["transport"] = .string(transport)

    if let relay { row["relay"] = .string(relay) }
    if let handle { row["handle"] = .string(handle) }
    if let sendSecret { row["sendSecret"] = .string(sendSecret) }

    return row
  }
}
