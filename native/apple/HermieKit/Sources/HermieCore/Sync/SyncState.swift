import Foundation
import HermieGateway
import HermieProtocol

/// Why a gateway on this device is not synced.
public enum SyncDetachment: Sendable, Hashable {
  /// The person switched "Sync this gateway" off.
  case user
  /// Its item was seen in iCloud Keychain and then vanished (I4). The only state that re-attaches
  /// by itself, when a live item for the key appears again.
  case absent
  /// Another local entry at the same origin is the synced one (I3).
  case duplicateOrigin
  /// A reason written by a newer build; treated as detached and kept.
  case other(String)

  public init(rawValue: String) {
    switch rawValue {
    case "user": self = .user
    case "absent": self = .absent
    case "duplicateOrigin": self = .duplicateOrigin
    default: self = .other(rawValue)
    }
  }

  public var rawValue: String {
    switch self {
    case .user: "user"
    case .absent: "absent"
    case .duplicateOrigin: "duplicateOrigin"
    case let .other(value): value
    }
  }
}

/// How far a removal reaches (I9).
public enum RemovalScope: String, Sendable, Hashable {
  case thisDevice
  case allDevices
}

/**
 What this device remembers about one local gateway's sync: the key it is synced under, whether
 its item has been seen in the store, why it is detached, whether the person signed out here, and
 for each field the stamp of the register the local value came from and a keyed print of that
 local value.

 Prints are opaque strings made by the snapshot's `SyncPrinter` (a keyed hash), so nothing in
 here is, or can be turned back into, a secret. A print that no longer matches the local value
 is how a change made outside the engine is noticed.
 */
public struct SyncEntry: Sendable, Equatable {
  public var key: String
  /// The item for `key` has been read back from the store while this entry was attached. Only an
  /// entry that has been seen becomes `absent` when the item is missing; one that has not is
  /// (re)published. A write of our own does not count until a later read shows it.
  public var seen: Bool
  public var detached: SyncDetachment?
  /// Signed out on this device: the session token and the user are neither published nor
  /// written back from iCloud until the person signs in again.
  public var signedOut: Bool
  /// Set by the engine, in the same transaction as the purge, when the person removes this
  /// gateway; acted on once the gateway is gone from the local list.
  public var removal: RemovalScope?
  /// Per field (`SyncField.rawValue`): the stamp of the register the local value matches.
  public var stamps: [String: SyncStamp]
  /// Per field: the print of the local value as of the last reconcile.
  public var prints: [String: String]

  var extra: JSONObject = [:]

  public init(
    key: String,
    seen: Bool = false,
    detached: SyncDetachment? = nil,
    signedOut: Bool = false,
    removal: RemovalScope? = nil,
    stamps: [String: SyncStamp] = [:],
    prints: [String: String] = [:]
  ) {
    self.key = key
    self.seen = seen
    self.detached = detached
    self.signedOut = signedOut
    self.removal = removal
    self.stamps = stamps
    self.prints = prints
  }

  public func stamp(_ field: SyncField) -> SyncStamp? { stamps[field.rawValue] }

  var json: JSONValue {
    var object = extra
    object["key"] = .string(key)
    object["seen"] = .bool(seen)
    object["detached"] = detached.map { .string($0.rawValue) } ?? .null
    object["signedOut"] = .bool(signedOut)
    if let removal { object["removal"] = .string(removal.rawValue) } else { object["removal"] = nil }
    object["stamps"] = .object(stamps.mapValues(\.json))
    object["prints"] = .object(prints.mapValues(JSONValue.string))
    return .object(object)
  }

  init?(json: JSONValue) {
    guard let object = json.objectValue, let key = object["key"]?.stringValue else {
      return nil
    }

    self.init(key: key)
    seen = object["seen"]?.boolValue ?? false
    detached = object["detached"]?.stringValue.map(SyncDetachment.init(rawValue:))
    signedOut = object["signedOut"]?.boolValue ?? false
    removal = object["removal"]?.stringValue.flatMap(RemovalScope.init(rawValue:))
    stamps = (object["stamps"]?.objectValue ?? [:]).compactMapValues { SyncStamp(json: $0) }
    prints = (object["prints"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
    extra = object.filter { !["key", "seen", "detached", "signedOut", "removal", "stamps", "prints"].contains($0.key) }
  }
}

extension SyncEntry: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    let fields = stamps.keys.sorted().map { "\($0)@\(stamps[$0]!)" }.joined(separator: ", ")
    let detachedText = detached.map { ", detached: \($0.rawValue)" } ?? ""
    let removalText = removal.map { ", removal: \($0.rawValue)" } ?? ""
    return
      "SyncEntry(\(key), seen: \(seen)\(detachedText), signedOut: \(signedOut)\(removalText), [\(fields)])"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "key": key, "seen": seen, "detached": detached?.rawValue as Any, "signedOut": signedOut,
        "removal": removal?.rawValue as Any, "stamps": stamps.keys.sorted().map { "\($0)@\(stamps[$0]!)" }
      ],
      displayStyle: .struct
    )
  }
}

/**
 The sync state of this device, stored under `hermie.sync.state` in the key-value table (not
 namespaced): `{ v: 1, device, enabled, disclosed, hidden, tombstones, entries }`.

 `device` is a random 8-hex tag minted for sync, never the push installation id. `hidden` lists
 keys removed from this device only, so they are not adopted again. `tombstones` remembers, per
 key, the newest "removed from all devices" this device has written or seen (a stamp, nothing
 else), so a tombstone the keychain loses to a concurrent whole-item write is written again, the
 way registers are; it is forgotten after 180 days, like the tombstone itself. `entries` is keyed
 by local gateway id. Unknown fields, at the top and inside an entry, are carried through a rewrite; a
 state written with a newer `v` decodes marked, and nothing must be written over it.
 */
public struct SyncState: Sendable, Equatable {
  public static let version = 1
  public static let storageKey = "hermie.sync.state"

  public var device: String
  public var enabled: Bool
  public var disclosed: Bool
  public var hidden: Set<String>
  public var tombstones: [String: SyncStamp]
  public var entries: [String: SyncEntry]

  /// The stored `v`, when it was not one this build understands.
  public private(set) var unsupportedVersion: String?

  var extra: JSONObject = [:]

  public init(
    device: String,
    enabled: Bool = true,
    disclosed: Bool = false,
    hidden: Set<String> = [],
    tombstones: [String: SyncStamp] = [:],
    entries: [String: SyncEntry] = [:]
  ) {
    self.device = device
    self.enabled = enabled
    self.disclosed = disclosed
    self.hidden = hidden
    self.tombstones = tombstones
    self.entries = entries
  }

  /// Eight lowercase hex digits.
  public static func isValidDevice(_ value: String) -> Bool {
    value.unicodeScalars.count == 8
      && value.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  // MARK: Engine helpers

  /// The person removed a gateway: remember the scope, so the reconcile after the purge knows
  /// whether to hide the key here or write a tombstone for every device.
  public mutating func markRemoved(gatewayId: String, key: String, scope: RemovalScope) {
    entries[gatewayId, default: SyncEntry(key: key)].removal = scope
  }

  /// Signed out on this device (`true`), or signed in again (`false`).
  public mutating func setSignedOut(_ signedOut: Bool, gatewayId: String, key: String) {
    entries[gatewayId, default: SyncEntry(key: key)].signedOut = signedOut
  }

  /// "Sync this gateway". Switching it off deletes the item at the next reconcile and forgets the
  /// stamps; switching it on attaches the gateway again as on first sight.
  public mutating func setGatewaySynced(_ synced: Bool, gatewayId: String, key: String) {
    var entry = entries[gatewayId] ?? SyncEntry(key: key)

    if synced {
      if entry.detached == .user { entry.detached = nil }
    } else {
      entry.detached = .user
    }

    entries[gatewayId] = entry
  }

  // MARK: Coding

  /// Read the stored text. `nil` when there is none or it is not a state at all (mint a new one).
  public static func decode(_ text: String?) -> SyncState? {
    guard let text, let root = (try? JSONValue(parsing: text))?.objectValue else {
      return nil
    }

    guard root["v"]?.doubleValue == Double(version) else {
      var foreign = SyncState(device: "", enabled: false, disclosed: false)
      foreign.unsupportedVersion = root["v"].map { canonical($0) } ?? "missing"
      return foreign
    }

    var state = SyncState(
      device: root["device"]?.stringValue ?? "",
      enabled: root["enabled"]?.boolValue ?? true,
      disclosed: root["disclosed"]?.boolValue ?? false
    )

    state.hidden = Set((root["hidden"]?.arrayValue ?? []).compactMap(\.stringValue).filter(GatewayKey.isValid))
    state.tombstones = (root["tombstones"]?.objectValue ?? [:]).filter { GatewayKey.isValid($0.key) }
      .compactMapValues { SyncStamp(json: $0) }
    state.entries = (root["entries"]?.objectValue ?? [:]).compactMapValues { SyncEntry(json: $0) }
    let known: Set<String> = ["v", "device", "enabled", "disclosed", "hidden", "tombstones", "entries"]
    state.extra = root.filter { !known.contains($0.key) }

    return state
  }

  /// Canonical JSON with every field kept from the read.
  public func encoded() throws(SyncCodingError) -> String {
    var root = extra
    root["v"] = .number(Double(Self.version))
    root["device"] = .string(device)
    root["enabled"] = .bool(enabled)
    root["disclosed"] = .bool(disclosed)
    root["hidden"] = .array(hidden.sorted().map(JSONValue.string))
    root["tombstones"] = .object(tombstones.mapValues(\.json))
    root["entries"] = .object(entries.mapValues(\.json))

    do {
      return try JSONValue.object(root).canonicalString()
    } catch {
      throw .nonFiniteNumber
    }
  }
}

extension SyncState: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "SyncState(device: \(device), enabled: \(enabled), disclosed: \(disclosed), hidden: \(hidden.count), "
      + "tombstones: \(tombstones.count), entries: \(entries.count))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "device": device, "enabled": enabled, "disclosed": disclosed, "hidden": hidden.sorted(),
        "tombstones": tombstones.keys.sorted().map { "\($0)@\(tombstones[$0]!)" },
        "entries": entries.keys.sorted().map { "\($0): \(entries[$0]!)" }
      ],
      displayStyle: .struct
    )
  }
}
