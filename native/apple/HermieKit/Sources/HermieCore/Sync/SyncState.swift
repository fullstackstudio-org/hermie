import Foundation
import HermieGateway
import HermieProtocol

/// Why a gateway on this device is not synced.
public enum SyncDetachment: Sendable, Hashable {
  /// The person switched "Sync this gateway" off.
  case user
  /// Its item was seen in iCloud Keychain and then vanished (I4), or it already existed here when
  /// it met a removal on all devices. The only state that re-attaches by itself, when a live item
  /// for the key appears again.
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
 its item has been seen in the store, why it is detached, whether the person signed out here, the
 intents the engine recorded and the reconcile has not yet acted on, and for each field the stamp
 of the register the local value came from and a keyed print of that local value.

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
  /// written back from iCloud until the person signs in again, and a front door or headers that
  /// went missing here are left missing.
  public var signedOut: Bool
  /// Set by the engine, in the same transaction as the purge, when the person removes this
  /// gateway; acted on once the gateway is gone from the local list.
  public var removal: RemovalScope?
  /// Set by the engine when the person added this gateway here (the add wizard completed, or the
  /// address moved to a new origin). Only such a gateway is published over a removal on all
  /// devices; one that merely existed here becomes `absent` instead. Consumed once published.
  public var addedHere: Bool
  /// Credentials the person cleared on purpose ("Sign Out on All Devices", removing a front door
  /// or headers). Only these go out as a cleared value; a credential that is simply missing here
  /// is never published as cleared, it is put back from iCloud. Consumed by the next reconcile.
  public var clearing: Set<SyncField>
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
    addedHere: Bool = false,
    clearing: Set<SyncField> = [],
    stamps: [String: SyncStamp] = [:],
    prints: [String: String] = [:]
  ) {
    self.key = key
    self.seen = seen
    self.detached = detached
    self.signedOut = signedOut
    self.removal = removal
    self.addedHere = addedHere
    self.clearing = clearing
    self.stamps = stamps
    self.prints = prints
  }

  public func stamp(_ field: SyncField) -> SyncStamp? { stamps[field.rawValue] }

  private static let knownKeys: Set<String> = [
    "key", "seen", "detached", "signedOut", "removal", "addedHere", "clearing", "stamps", "prints"
  ]

  var json: JSONValue {
    var object = extra
    object["key"] = .string(key)
    object["seen"] = .bool(seen)
    object["detached"] = detached.map { .string($0.rawValue) } ?? .null
    object["signedOut"] = .bool(signedOut)
    object["removal"] = removal.map { .string($0.rawValue) }
    object["addedHere"] = addedHere ? .bool(true) : Optional<JSONValue>.none
    object["clearing"] =
      clearing.isEmpty ? Optional<JSONValue>.none : .array(clearing.sorted().map { .string($0.rawValue) })
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
    addedHere = object["addedHere"]?.boolValue ?? false
    clearing = Set((object["clearing"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(SyncField.init(rawValue:)) })
    stamps = (object["stamps"]?.objectValue ?? [:]).compactMapValues { SyncStamp(json: $0) }
    prints = (object["prints"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
    extra = object.filter { !Self.knownKeys.contains($0.key) }
  }
}

extension SyncEntry: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    let fields = stamps.keys.sorted().map { "\($0)@\(stamps[$0]!)" }.joined(separator: ", ")
    let detachedText = detached.map { ", detached: \($0.rawValue)" } ?? ""
    let removalText = removal.map { ", removal: \($0.rawValue)" } ?? ""
    let addedText = addedHere ? ", addedHere" : ""
    let clearingText = clearing.isEmpty ? "" : ", clearing: \(clearing.sorted().map(\.rawValue))"
    return "SyncEntry(\(key), seen: \(seen)\(detachedText), signedOut: \(signedOut)\(removalText)\(addedText)"
      + "\(clearingText), [\(fields)])"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "key": key, "seen": seen, "detached": detached?.rawValue as Any, "signedOut": signedOut,
        "removal": removal?.rawValue as Any, "addedHere": addedHere, "clearing": clearing.sorted().map(\.rawValue),
        "stamps": stamps.keys.sorted().map { "\($0)@\(stamps[$0]!)" }
      ],
      displayStyle: .struct
    )
  }
}

/// A removal on all devices this device knows of: the tombstone's stamp, and when this device
/// first saw it, by its own clock. Ages are measured from `firstSeen`, never from another device's
/// stamp, so a wrong clock elsewhere cannot make a tombstone expire early.
public struct SyncTombstoneMemory: Sendable, Equatable {
  public var stamp: SyncStamp
  public var firstSeen: Double

  public init(stamp: SyncStamp, firstSeen: Double) {
    self.stamp = stamp
    self.firstSeen = firstSeen
  }

  var json: JSONValue {
    .object(["deleted": stamp.json, "firstSeen": .number(firstSeen)])
  }

  init?(json: JSONValue) {
    guard let object = json.objectValue, let stamp = SyncStamp(json: object["deleted"]),
      let firstSeen = object["firstSeen"]?.doubleValue, firstSeen.isFinite
    else {
      return nil
    }

    self.init(stamp: stamp, firstSeen: firstSeen)
  }
}

/**
 The sync state of this device, stored under `hermie.sync.state` in the key-value table (not
 namespaced): `{ v: 1, device, enabled, disclosed, generation, printCheck, hidden, tombstones,
 entries }`.

 `device` is a random 8-hex tag minted for sync, never the push installation id. `hidden` lists
 keys removed from this device only, so they are not adopted again. `tombstones` remembers, per
 key, the newest "removed from all devices" this device has written or seen and when it first saw
 it, so a tombstone the keychain loses to a concurrent whole-item write is written again, the way
 registers are, and a stale copy of the gateway turning up later does not bring it back; it is
 forgotten three years (by this device's clock) after it was first seen. `printCheck` is the
 print of a fixed text: when the print key changes, every stored print is void, and the next
 reconcile treats each gateway as on first attach. `generation` counts the intents the engine
 recorded, so it can tell that one arrived while a reconcile was running. `entries` is keyed by
 local gateway id. Unknown fields, at the top and inside an entry, are carried through a rewrite;
 a state written with a newer `v` decodes marked, and nothing must be written over it.
 */
public struct SyncState: Sendable, Equatable {
  public static let version = 1
  public static let storageKey = "hermie.sync.state"
  /// The text whose print tells whether the print key is still the one the prints were made with.
  public static let printCheckText = "hermie.sync.print-check"

  public var device: String
  public var enabled: Bool
  public var disclosed: Bool
  public var hidden: Set<String>
  public var tombstones: [String: SyncTombstoneMemory]
  public var entries: [String: SyncEntry]
  public var printCheck: String?
  /// Bumped by every intent helper below; a reconcile copies it through unchanged.
  public private(set) var generation: Int = 0

  /// The stored `v`, when it was not one this build understands.
  public private(set) var unsupportedVersion: String?

  var extra: JSONObject = [:]

  public init(
    device: String,
    enabled: Bool = true,
    disclosed: Bool = false,
    hidden: Set<String> = [],
    tombstones: [String: SyncTombstoneMemory] = [:],
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

  // MARK: Engine helpers (each records an intent and bumps `generation`)

  private mutating func intent(_ gatewayId: String, key: String, _ change: (inout SyncEntry) -> Void) {
    change(&entries[gatewayId, default: SyncEntry(key: key)])
    generation += 1
  }

  /// The person removed a gateway: remember the scope, so the reconcile after the purge knows
  /// whether to hide the key here or write a tombstone for every device.
  public mutating func markRemoved(gatewayId: String, key: String, scope: RemovalScope) {
    intent(gatewayId, key: key) { $0.removal = scope }
  }

  /// The person added this gateway here (the add wizard completed).
  public mutating func markAddedHere(gatewayId: String, key: String) {
    intent(gatewayId, key: key) { $0.addedHere = true }
  }

  /// The person cleared a credential on purpose and it should be cleared on every device:
  /// "Sign Out on All Devices" (`.sessionToken`), removing the front door or the headers.
  public mutating func markClearing(_ field: SyncField, gatewayId: String, key: String) {
    intent(gatewayId, key: key) { $0.clearing.insert(field) }
  }

  /// Signed out on this device (`true`), or signed in again (`false`).
  public mutating func setSignedOut(_ signedOut: Bool, gatewayId: String, key: String) {
    intent(gatewayId, key: key) { $0.signedOut = signedOut }
  }

  /// "Sync this gateway". Switching it off deletes the item at the next reconcile and forgets the
  /// stamps; switching it on attaches the gateway again as on first sight.
  public mutating func setGatewaySynced(_ synced: Bool, gatewayId: String, key: String) {
    intent(gatewayId, key: key) { entry in
      if synced {
        if entry.detached == .user { entry.detached = nil }
      } else {
        entry.detached = .user
      }
    }
  }

  /// Publish this gateway again at the next reconcile: an `absent` one is attached again and,
  /// with nothing in iCloud, written there.
  public mutating func resync(gatewayId: String) {
    guard entries[gatewayId] != nil else { return }
    intent(gatewayId, key: entries[gatewayId]!.key) { entry in
      if entry.detached == .absent { entry.detached = nil }
      entry.seen = false
    }
  }

  // MARK: Coding

  private static let knownKeys: Set<String> = [
    "v", "device", "enabled", "disclosed", "generation", "printCheck", "hidden", "tombstones", "entries"
  ]

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

    state.generation = root["generation"]?.intValue ?? 0
    state.printCheck = root["printCheck"]?.stringValue
    state.hidden = Set((root["hidden"]?.arrayValue ?? []).compactMap(\.stringValue).filter(GatewayKey.isValid))
    state.tombstones = (root["tombstones"]?.objectValue ?? [:]).filter { GatewayKey.isValid($0.key) }
      .compactMapValues { SyncTombstoneMemory(json: $0) }
    state.entries = (root["entries"]?.objectValue ?? [:]).compactMapValues { SyncEntry(json: $0) }
    state.extra = root.filter { !knownKeys.contains($0.key) }

    return state
  }

  /// Canonical JSON with every field kept from the read.
  public func encoded() throws(SyncCodingError) -> String {
    var root = extra
    root["v"] = .number(Double(Self.version))
    root["device"] = .string(device)
    root["enabled"] = .bool(enabled)
    root["disclosed"] = .bool(disclosed)
    root["generation"] = .number(Double(generation))
    root["printCheck"] = printCheck.map(JSONValue.string)
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
    "SyncState(device: \(device), enabled: \(enabled), disclosed: \(disclosed), generation: \(generation), "
      + "hidden: \(hidden.count), tombstones: \(tombstones.count), entries: \(entries.count))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "device": device, "enabled": enabled, "disclosed": disclosed, "generation": generation,
        "hidden": hidden.sorted(),
        "tombstones": tombstones.keys.sorted().map { "\($0)@\(tombstones[$0]!.stamp)" },
        "entries": entries.keys.sorted().map { "\($0): \(entries[$0]!)" }
      ],
      displayStyle: .struct
    )
  }
}
