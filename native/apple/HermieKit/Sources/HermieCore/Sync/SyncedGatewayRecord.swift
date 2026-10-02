import Foundation
import HermieGateway
import HermieProtocol

// The record one gateway is synced as, through one iCloud Keychain item per gateway (ADR-0032,
// `.claude/plans/native-rewrite-icloud.md`, "Data model").
//
// Nothing in this file prints a value. Every description, debug description and mirror shows
// keys, field names, stamps and device tags only, because a register may hold a session token or
// a front-door secret and a description ends up in logs, crash reports and test failures.

// MARK: - Stamps

/// A hybrid timestamp: `t` in epoch milliseconds, `d` the device tag of the writer. Greater
/// `(t, d)` wins; device tags compare by their UTF-8 bytes.
public struct SyncStamp: Sendable, Hashable, Comparable {
  public var t: Double
  public var d: String

  public init(t: Double, d: String) {
    self.t = t
    self.d = d
  }

  /// The largest `t` a stamp may carry: 2^53 − 2^20, so `t + 1` stays an exact integer and a
  /// clock gone wild cannot write a stamp nobody can ever beat.
  public static let maximumT: Double = 9_007_199_254_740_992 - 1_048_576

  /// `t` clamped into `[0, maximumT]`.
  static func clamped(_ t: Double) -> Double {
    min(max(t, 0), maximumT)
  }

  public static func < (left: SyncStamp, right: SyncStamp) -> Bool {
    left.t != right.t ? left.t < right.t : left.d.utf8.lexicographicallyPrecedes(right.d.utf8)
  }

  var json: JSONValue {
    .object(["t": .number(t), "d": .string(d)])
  }

  init?(json: JSONValue?) {
    guard let object = json?.objectValue, let t = object["t"]?.doubleValue, t.isFinite, t >= 0,
      t <= Self.maximumT, let d = object["d"]?.stringValue
    else {
      return nil
    }

    self.init(t: t, d: d)
  }
}

extension SyncStamp: CustomStringConvertible {
  public var description: String { "\(ECMAScriptNumber.string(t))/\(d)" }
}

// MARK: - Fields

/// The synced fields of a gateway. Every case but `addedAt` is a register `{ v, t, d }` in the
/// record; `addedAt` is a plain number that merges to the smallest value.
public enum SyncField: String, Sendable, Hashable, CaseIterable, Comparable {
  case address
  case name
  case authKind
  case provider
  case user
  case frontDoor
  case headers
  case sessionToken
  case signIn
  case addedAt

  /// The fields stored as registers, in the order the record lists them.
  public static let registers: [SyncField] = [
    .address, .name, .authKind, .provider, .user, .frontDoor, .headers, .sessionToken, .signIn
  ]

  /// Fields whose value is a credential. They carry the origin they were stored for (I13).
  public var isSecret: Bool {
    switch self {
    case .frontDoor, .headers, .sessionToken, .signIn: true
    default: false
    }
  }

  public static func < (left: SyncField, right: SyncField) -> Bool {
    left.rawValue < right.rawValue
  }
}

// MARK: - Registers

/// One last-writer-wins register: a value (which may be `null`, an explicit clear) and the stamp
/// of the write. Fields of the register object this build does not know are carried.
public struct SyncRegister: Sendable, Hashable {
  public internal(set) var value: JSONValue
  public internal(set) var stamp: SyncStamp
  var extra: JSONObject = [:]

  public init(value: JSONValue, stamp: SyncStamp) {
    self.value = value
    self.stamp = stamp
  }

  var json: JSONValue {
    var object = extra
    object["v"] = value
    object["t"] = .number(stamp.t)
    object["d"] = .string(stamp.d)
    return .object(object)
  }

  /// A register object needs a finite `t` and a string `d`. A missing `v` reads as `null`.
  init?(json: JSONValue?) {
    guard let object = json?.objectValue, let stamp = SyncStamp(json: json) else {
      return nil
    }

    self.value = object["v"] ?? .null
    self.stamp = stamp
    self.extra = object.filter { !["v", "t", "d"].contains($0.key) }
  }

  /// The total order registers merge by: the stamp, then (for two different writes that somehow
  /// share a stamp) the canonical text, so every device picks the same one.
  static func winner(_ left: SyncRegister?, _ right: SyncRegister?) -> SyncRegister? {
    guard let left else { return right }
    guard let right else { return left }

    if left.stamp != right.stamp {
      return left.stamp > right.stamp ? left : right
    }

    return canonical(left.json).utf8.lexicographicallyPrecedes(canonical(right.json).utf8) ? right : left
  }
}

extension SyncRegister: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "SyncRegister(\(stamp), \(value.isNull ? "null" : "set"))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["stamp": stamp.description, "isNull": value.isNull], displayStyle: .struct)
  }
}

// MARK: - Typed values

/// The identity provider a gateway signs in with: `{ name, label }`.
public struct SyncProvider: Sendable, Hashable {
  public var name: String
  public var label: String?

  public init(name: String, label: String? = nil) {
    self.name = name
    self.label = label
  }

  var json: JSONValue {
    var object: JSONObject = ["name": .string(name)]
    if let label { object["label"] = .string(label) }
    return .object(object)
  }

  init?(json: JSONValue) {
    guard let object = json.objectValue, let name = object["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    let label = object["label"]
    guard label == nil || label == .null || label?.stringValue != nil else {
      return nil
    }

    self.init(name: name, label: label?.stringValue)
  }
}

/// A front-door credential pair (ADR-0021), bound to the origin it was entered for.
public struct SyncFrontDoor: Sendable, Hashable {
  public static let cloudflareAccess = "cloudflare-access"

  public var origin: String
  public var kind: String
  public var clientId: String
  public var clientSecret: String

  public init(origin: String, kind: String = SyncFrontDoor.cloudflareAccess, clientId: String, clientSecret: String) {
    self.origin = origin
    self.kind = kind
    self.clientId = clientId
    self.clientSecret = clientSecret
  }

  var json: JSONValue {
    .object([
      "origin": .string(origin), "kind": .string(kind), "clientId": .string(clientId),
      "clientSecret": .string(clientSecret)
    ])
  }

  /// The kinds this build knows how to present.
  public static let knownKinds: Set<String> = [cloudflareAccess]

  /// A known kind, a non-blank id and a non-empty secret, as `FrontDoor` requires to send one.
  init?(json: JSONValue) {
    guard let object = json.objectValue, let origin = object["origin"]?.stringValue,
      let kind = object["kind"]?.stringValue, Self.knownKinds.contains(kind),
      let clientId = object["clientId"]?.stringValue,
      !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let clientSecret = object["clientSecret"]?.stringValue, !clientSecret.isEmpty
    else {
      return nil
    }

    self.init(origin: origin, kind: kind, clientId: clientId, clientSecret: clientSecret)
  }
}

/// Custom headers, bound to the origin they were entered for.
public struct SyncHeaders: Sendable, Hashable {
  public var origin: String
  public var headers: [String: String]

  public init(origin: String, headers: [String: String]) {
    self.origin = origin
    self.headers = headers
  }

  var json: JSONValue {
    .object(["origin": .string(origin), "headers": .object(headers.mapValues(JSONValue.string))])
  }

  init?(json: JSONValue) {
    guard let object = json.objectValue, let origin = object["origin"]?.stringValue,
      let raw = object["headers"]?.objectValue
    else {
      return nil
    }

    var headers: [String: String] = [:]
    for (name, value) in raw {
      // Only what the wizard itself accepts: a token name the transport does not own, and a value
      // already free of CR, LF and surrounding blanks.
      guard let text = value.stringValue,
        let normalized = try? GatewayAddress.normalizeHeader(name: name, value: text),
        normalized.name == name, normalized.value == text
      else {
        return nil
      }
      headers[name] = text
    }

    self.init(origin: origin, headers: headers)
  }
}

/// An ungated gateway's static session token, bound to the origin it was entered for.
public struct SyncSessionToken: Sendable, Hashable {
  public var origin: String
  public var token: String

  public init(origin: String, token: String) {
    self.origin = origin
    self.token = token
  }

  var json: JSONValue {
    .object(["origin": .string(origin), "token": .string(token)])
  }

  init?(json: JSONValue) {
    guard let object = json.objectValue, let origin = object["origin"]?.stringValue,
      let token = object["token"]?.stringValue, !token.isEmpty
    else {
      return nil
    }

    self.init(origin: origin, token: token)
  }
}

extension SyncProvider: CustomStringConvertible {
  public var description: String { "SyncProvider(\(name))" }
}

extension SyncFrontDoor: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "SyncFrontDoor(\(origin), \(kind), secret: present)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["origin": origin, "kind": kind], displayStyle: .struct)
  }
}

extension SyncHeaders: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "SyncHeaders(\(origin), \(headers.count) headers)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["origin": origin, "count": headers.count], displayStyle: .struct)
  }
}

extension SyncSessionToken: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "SyncSessionToken(\(origin), token: present)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["origin": origin], displayStyle: .struct)
  }
}

// MARK: - Errors

/// Why a record or the sync state could not be written. No case carries a value.
public enum SyncCodingError: Error, Sendable, Equatable, CustomStringConvertible {
  /// A number that JSON cannot hold (NaN or an infinity).
  case nonFiniteNumber

  public var description: String {
    switch self {
    case .nonFiniteNumber: "The sync record holds a number JSON cannot express."
    }
  }
}

// MARK: - Record

/**
 One gateway as stored in its synced item, version 1.

 `{ v: 1, key, addedAt, address, name, authKind, provider, user, frontDoor, headers, sessionToken,
 signIn, deleted }`, every field but `v`, `key` and `addedAt` a register (`deleted` is a bare stamp).
 A record is **live** when it has no `deleted`, or its address register was written after it
 (`address.t > deleted.t`); a tombstone is `{ v, key, deleted }` and nothing else.

 A record value read from the store is **normalised** before it takes part in a merge: registers
 that are malformed, secrets bound to another origin (or a front door on a cleartext origin), and
 anything written at or before `deleted.t` are dropped, and a record that is not live is reduced
 to its tombstone. A front door of an unknown kind or with a blank id, headers the wizard itself
 would refuse (a name the transport owns, CR or LF in a value), and stamps outside
 `[0, SyncStamp.maximumT]` count as malformed. Unknown top-level fields, unknown fields of a register and unknown fields inside
 a value are carried through every rewrite.

 A record this build must not touch (a `v` other than 1, text that is not a record object, a `key`
 that does not match the account, a live record whose address does not hash to its key) is
 **foreign**: it is kept as it was read, never applied and never rewritten.
 */
public struct SyncedGatewayRecord: Sendable, Equatable {
  public static let version = 1
  /// The keychain service of every synced item.
  public static let service = "hermie.sync.v1"
  public static let accountPrefix = "gw."
  /// At most this many synced items, tombstones included (I16).
  public static let maximumItems = 64
  /// A record larger than this drops its headers from the synced form (I16).
  public static let maximumBytes = 8 * 1024
  /// Tombstones older than this are deleted by any device (I16).
  public static let tombstoneLifetime: Double = 180 * 24 * 60 * 60 * 1000

  /// Why a record is left alone.
  public enum Foreign: Sendable, Equatable {
    /// Written by a newer build (`v` above 1).
    case newerVersion
    /// Not a record this build can read: not an object, no usable `v`, or a `key` that does not
    /// match its account.
    case unreadable
    /// A live record whose address is missing or does not hash to its key (I3).
    case invalid
  }

  public let key: String
  public internal(set) var addedAt: Double?
  public internal(set) var registers: [SyncField: SyncRegister]
  public internal(set) var deleted: SyncStamp?
  var extra: JSONObject

  /// Set when this build must leave the record alone.
  public let foreign: Foreign?
  /// The text the record was read from, for a foreign record the only thing that is kept.
  let sourceText: String?

  /// An empty record for a key: no registers, not deleted, so not live until it has an address.
  public init(key: String) {
    self.key = key
    self.addedAt = nil
    self.registers = [:]
    self.deleted = nil
    self.extra = [:]
    self.foreign = nil
    self.sourceText = nil
  }

  private init(key: String, foreign: Foreign?, text: String?) {
    self.key = key
    self.addedAt = nil
    self.registers = [:]
    self.deleted = nil
    self.extra = [:]
    self.foreign = foreign
    self.sourceText = text
  }

  public static func == (left: SyncedGatewayRecord, right: SyncedGatewayRecord) -> Bool {
    if left.foreign != nil || right.foreign != nil {
      return left.key == right.key && left.foreign == right.foreign && left.sourceText == right.sourceText
    }

    return left.key == right.key && left.addedAt == right.addedAt && left.registers == right.registers
      && left.deleted == right.deleted && left.extra == right.extra
  }

  // MARK: Accounts

  public static func account(forKey key: String) -> String {
    accountPrefix + key
  }

  /// The gateway key an account names, or `nil` for an account that is not one of ours.
  public static func key(forAccount account: String) -> String? {
    guard account.hasPrefix(accountPrefix) else {
      return nil
    }

    let key = String(account.dropFirst(accountPrefix.count))
    return GatewayKey.isValid(key) ? key : nil
  }

  public var account: String { Self.account(forKey: key) }

  // MARK: State

  public var isSupported: Bool { foreign == nil }

  public var isLive: Bool {
    guard foreign == nil, let address = registers[.address] else {
      return false
    }

    guard let deleted else {
      return true
    }

    return address.stamp.t > deleted.t
  }

  public var isTombstone: Bool { foreign == nil && deleted != nil && !isLive }

  /// The highest `t` anywhere in the record: every register, `deleted`, and register-shaped
  /// unknown fields. A new write stamps above it (I4).
  var highestT: Double? {
    var values = registers.values.map(\.stamp.t)
    if let deleted { values.append(deleted.t) }
    values.append(contentsOf: extra.values.compactMap { SyncRegister(json: $0)?.stamp.t })
    return values.max()
  }

  // MARK: Typed reads

  public var address: String? { registers[.address]?.value.stringValue }
  public var name: String? { registers[.name]?.value.stringValue }
  public var authKind: String? { registers[.authKind]?.value.stringValue }
  public var provider: SyncProvider? { registers[.provider].flatMap { SyncProvider(json: $0.value) } }
  public var user: String? { registers[.user]?.value.stringValue }
  public var frontDoor: SyncFrontDoor? { registers[.frontDoor].flatMap { SyncFrontDoor(json: $0.value) } }
  public var headers: SyncHeaders? { registers[.headers].flatMap { SyncHeaders(json: $0.value) } }
  public var sessionToken: SyncSessionToken? {
    registers[.sessionToken].flatMap { SyncSessionToken(json: $0.value) }
  }

  /// The origin of the record's address, or `nil` without one.
  public var origin: String? {
    address.map(GatewayAddress.origin(of:))
  }

  // MARK: Coding

  private static let knownKeys: Set<String> = Set(
    ["v", "key", "addedAt", "deleted"] + SyncField.registers.map(\.rawValue))

  /// Read an item's value. `nil` for an account that is not one of ours; a record that cannot be
  /// used comes back foreign, so it is left alone rather than overwritten.
  public static func decode(account: String, value: String) -> SyncedGatewayRecord? {
    guard let key = key(forAccount: account) else {
      return nil
    }

    return decode(value, expectedKey: key)
  }

  /// Read a record's text on its own. `nil` when it does not name a valid key.
  public static func decode(_ text: String) -> SyncedGatewayRecord? {
    guard let root = (try? JSONValue(parsing: text))?.objectValue, let key = root["key"]?.stringValue,
      GatewayKey.isValid(key)
    else {
      return nil
    }

    return decode(text, expectedKey: key)
  }

  private static func decode(_ text: String, expectedKey key: String) -> SyncedGatewayRecord {
    guard let root = (try? JSONValue(parsing: text))?.objectValue, let version = root["v"]?.doubleValue else {
      return SyncedGatewayRecord(key: key, foreign: .unreadable, text: text)
    }

    if version > Double(Self.version) {
      return SyncedGatewayRecord(key: key, foreign: .newerVersion, text: text)
    }

    guard version == Double(Self.version), root["key"]?.stringValue == key else {
      return SyncedGatewayRecord(key: key, foreign: .unreadable, text: text)
    }

    var record = SyncedGatewayRecord(key: key, foreign: nil, text: text)

    if let addedAt = root["addedAt"]?.doubleValue, addedAt.isFinite {
      record.addedAt = addedAt
    }

    record.deleted = SyncStamp(json: root["deleted"])

    for field in SyncField.registers {
      if let register = SyncRegister(json: root[field.rawValue]) {
        record.registers[field] = register
      }
    }

    record.extra = root.filter { !knownKeys.contains($0.key) }

    // I3: a live record must carry an address that hashes to its key.
    let liveByStamps: Bool = {
      guard let address = record.registers[.address] else { return record.deleted == nil }
      return record.deleted.map { address.stamp.t > $0.t } ?? true
    }()

    if liveByStamps, !Self.isValidAddress(record.registers[.address]?.value, key: key) {
      return SyncedGatewayRecord(key: key, foreign: .invalid, text: text)
    }

    return record
  }

  /// The canonical JSON text (sorted keys, no whitespace). A foreign record is its original text.
  public func encoded() throws(SyncCodingError) -> String {
    if foreign != nil, let sourceText {
      return sourceText
    }

    var root = extra
    root["v"] = .number(Double(Self.version))
    root["key"] = .string(key)
    if let addedAt { root["addedAt"] = .number(addedAt) }
    for (field, register) in registers { root[field.rawValue] = register.json }
    if let deleted { root["deleted"] = deleted.json }

    do {
      return try JSONValue.object(root).canonicalString()
    } catch {
      throw .nonFiniteNumber
    }
  }

  /// The UTF-8 size of the canonical text.
  var encodedSize: Int {
    ((try? encoded()) ?? "").utf8.count
  }

  /// The text as it stands in the store: what it was read from, or its encoding.
  var storedText: String? {
    sourceText ?? (try? encoded())
  }

  // MARK: Normalising and merging

  static func isValidAddress(_ value: JSONValue?, key: String) -> Bool {
    guard let address = value?.stringValue, !address.isEmpty else {
      return false
    }

    return GatewayKey.of(address) == key
  }

  /// The value of a register as this build understands it: the known fields of a valid value, or
  /// `.null`; `nil` for a value that is not valid for this field and origin. Two values are the
  /// same for sync exactly when their projections are equal.
  static func projection(_ field: SyncField, _ value: JSONValue, key: String, origin: String?) -> JSONValue? {
    if value.isNull {
      switch field {
      case .address, .name, .authKind: return nil
      default: return .null
      }
    }

    switch field {
    case .address:
      return isValidAddress(value, key: key) ? value : nil
    case .name, .authKind:
      guard let text = value.stringValue, !text.isEmpty else { return nil }
      return value
    case .user:
      guard let text = value.stringValue, !text.isEmpty else { return nil }
      return value
    case .provider:
      return SyncProvider(json: value)?.json
    case .frontDoor:
      guard let origin, origin.hasPrefix("https://"), let door = SyncFrontDoor(json: value), door.origin == origin
      else {
        return nil
      }
      return door.json
    case .headers:
      guard let origin, let headers = SyncHeaders(json: value), headers.origin == origin else { return nil }
      return headers.json
    case .sessionToken:
      guard let origin, let token = SyncSessionToken(json: value), token.origin == origin else { return nil }
      return token.json
    case .signIn:
      guard let origin, let object = value.objectValue, object["origin"]?.stringValue == origin else { return nil }
      return value
    case .addedAt:
      return nil
    }
  }

  /// Drop what cannot take part in a merge (see the type's documentation). Idempotent.
  func normalized() -> SyncedGatewayRecord {
    guard foreign == nil else {
      return self
    }

    var record = self

    if let address = record.registers[.address],
      Self.projection(.address, address.value, key: key, origin: nil) == nil {
      record.registers[.address] = nil
    }

    let origin = record.origin

    for (field, register) in record.registers where field != .address {
      if Self.projection(field, register.value, key: key, origin: origin) == nil {
        record.registers[field] = nil
      }
    }

    if let deleted = record.deleted {
      record.registers = record.registers.filter { $0.value.stamp.t > deleted.t }
      record.extra = record.extra.filter { entry in
        SyncRegister(json: entry.value).map { $0.stamp.t > deleted.t } ?? true
      }

      if record.registers[.address] == nil {
        record.registers = [:]
        record.extra = [:]
        record.addedAt = nil
      }
    }

    return record
  }

  /// Field by field: registers by stamp, `deleted` by stamp, `addedAt` to the smallest, unknown
  /// fields by the same total order. Both records must be supported and share a key.
  static func join(_ left: SyncedGatewayRecord, _ right: SyncedGatewayRecord) -> SyncedGatewayRecord {
    var record = left

    for field in SyncField.registers {
      record.registers[field] = SyncRegister.winner(left.registers[field], right.registers[field])
    }

    switch (left.deleted, right.deleted) {
    case let (.some(a), .some(b)): record.deleted = max(a, b)
    case let (a, b): record.deleted = a ?? b
    }

    switch (left.addedAt, right.addedAt) {
    case let (.some(a), .some(b)): record.addedAt = min(a, b)
    case let (a, b): record.addedAt = a ?? b
    }

    for (name, value) in right.extra {
      record.extra[name] = record.extra[name].map { joinUnknown($0, value) } ?? value
    }

    return record.normalized()
  }

  /// A total order on unknown fields: register-shaped values above everything else and by
  /// stamp, the rest by canonical text. Taking the maximum is a join, so it converges.
  private static func joinUnknown(_ left: JSONValue, _ right: JSONValue) -> JSONValue {
    switch (SyncRegister(json: left), SyncRegister(json: right)) {
    case let (.some(a), .some(b)):
      return SyncRegister.winner(a, b) == a ? left : right
    case (.some, nil):
      return left
    case (nil, .some):
      return right
    case (nil, nil):
      return canonical(left).utf8.lexicographicallyPrecedes(canonical(right).utf8) ? right : left
    }
  }
}

extension SyncedGatewayRecord: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    if let foreign {
      return "SyncedGatewayRecord(\(key), foreign: \(foreign))"
    }

    let state = isLive ? "live" : (isTombstone ? "tombstone" : "incomplete")
    let fields = registers.keys.sorted().map { "\($0.rawValue)@\(registers[$0]!.stamp)" }
    let deletedText = deleted.map { ", deleted@\($0)" } ?? ""

    return "SyncedGatewayRecord(\(key), \(state), [\(fields.joined(separator: ", "))]\(deletedText))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "key": key,
        "live": isLive,
        "fields": registers.keys.sorted().map { "\($0.rawValue)@\(registers[$0]!.stamp)" },
        "deleted": deleted.map(\.description) as Any
      ],
      displayStyle: .struct
    )
  }
}

/// Canonical text for ordering and comparing. Values here come from the parser or from this
/// module, so they are always finite; the fallback only keeps the order total.
func canonical(_ value: JSONValue) -> String {
  (try? value.canonicalString()) ?? ""
}
