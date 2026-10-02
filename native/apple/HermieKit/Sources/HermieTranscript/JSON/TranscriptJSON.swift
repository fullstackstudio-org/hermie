import HermieProtocol

// How the transcript model meets JSON
// ===================================
//
// The engine's state is native Swift: structs per item kind, an enum over them,
// and `ChatState` holding dictionaries of those. Every type maps itself to and from
// the exact JSON object the TypeScript engine builds, by hand, with the helpers in
// this file. Why native rather than JSON-backed views (what `HermieProtocol` does
// for wire payloads) is argued in the header of `ChatState.swift`.
//
// The mapping rules every type follows:
//
// - A known key is read into its typed property. A REQUIRED key that is missing or
//   of the wrong shape fails the decode with the path to it: a state the engine
//   built always has them, so a missing one is a bug worth hearing about.
// - An OPTIONAL key that is absent reads as `nil`. One that is present but does not
//   fit its type (`null` where the TypeScript would write a value, a fraction where
//   it counts, a malformed nested object) also reads as `nil`, and its raw value is
//   kept in the type's `extra`, so it re-encodes unchanged.
// - Every key the type does not know goes to `extra` and comes back out on encode.
// - Encoding writes `extra` first and the typed properties over it; a `nil`
//   property writes nothing (TypeScript's `undefined`), except where the TypeScript
//   type itself carries `null` (`Subagent.parentId`, `ParsedModelId.provider`).
//
// Numbers: every JavaScript `number` is a `Double`, except the values the engine
// counts itself or keys a map with — `seq`, `version`, `nextSeq`, `unreadCount`,
// `lastSeq`, `rowId`, `lastSeenRowId` — which are integral by construction and are
// `Int` (`String(rowId)` is then the same text in both languages). Decoding a
// fraction into one of those is an error (required) or lands in `extra`
// (optional), never a silent rounding.

/// Why a transcript value could not be decoded, and where.
public struct TranscriptDecodingError: Error, Sendable, Hashable, CustomStringConvertible {
  /// A JSON path from the decoded root: `items["a:2000"].text`.
  public let path: String
  public let message: String

  public init(path: String, message: String) {
    self.path = path
    self.message = message
  }

  public var description: String { "\(path.isEmpty ? "<root>" : path): \(message)" }
}

/// A type with a lossless JSON form in the shape the TypeScript engine writes.
public protocol TranscriptJSONCodable: JSONConvertible, Codable {
  init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError)
}

extension TranscriptJSONCodable {
  /// Decodes a value, failing with a path into it when the shape is wrong.
  public init(decoding json: JSONValue) throws(TranscriptDecodingError) {
    try self.init(decoding: json, at: "")
  }

  public init?(jsonValue: JSONValue) {
    guard let value = try? Self(decoding: jsonValue, at: "") else { return nil }
    self = value
  }

  /// Parses `text` and decodes it.
  public init(parsing text: String) throws {
    try self.init(decoding: JSONValue(parsing: text), at: "")
  }

  public init(from decoder: any Decoder) throws {
    try self.init(decoding: JSONValue(from: decoder), at: "")
  }

  public func encode(to encoder: any Encoder) throws {
    try jsonValue.encode(to: encoder)
  }

  /// For an enum's own `init(from:)`. An enum must spell its `Codable` members out:
  /// the compiler synthesises `Codable` for an enum whose payloads are all
  /// `Codable` (`{"other":{"_0":"x"}}`), and that synthesis wins over the defaults
  /// above. A struct takes the defaults.
  static func decoded(from decoder: any Decoder) throws -> Self {
    try Self(decoding: JSONValue(from: decoder), at: "")
  }

  /// The canonical text (`contract/README.md`), for logs and tests.
  public var canonicalJSON: String {
    (try? jsonValue.canonicalString()) ?? "<not canonical JSON>"
  }
}

// MARK: - Leaf conversions

/// How one property type reads and writes its JSON value. Internal: the typed
/// properties are the public surface.
protocol JSONField {
  /// `nil` when `json` does not have this type's shape.
  static func read(_ json: JSONValue, at path: String) -> Self?
  var json: JSONValue { get }
}

extension String: JSONField {
  static func read(_ json: JSONValue, at path: String) -> String? { json.stringValue }
  var json: JSONValue { .string(self) }
}

extension Bool: JSONField {
  static func read(_ json: JSONValue, at path: String) -> Bool? { json.boolValue }
  var json: JSONValue { .bool(self) }
}

extension Double: JSONField {
  static func read(_ json: JSONValue, at path: String) -> Double? { json.doubleValue }
  var json: JSONValue { .number(self) }
}

extension Int: JSONField {
  /// Integral numbers only.
  static func read(_ json: JSONValue, at path: String) -> Int? { json.intValue }
  var json: JSONValue { .number(Double(self)) }
}

extension JSONValue: JSONField {
  static func read(_ json: JSONValue, at path: String) -> JSONValue? { json }
  var json: JSONValue { self }
}

extension Array: JSONField where Element: JSONField {
  /// Every element must convert; one that does not makes the whole array not fit.
  static func read(_ json: JSONValue, at path: String) -> [Element]? {
    guard case .array(let values) = json else { return nil }
    var out: [Element] = []
    out.reserveCapacity(values.count)
    for (index, value) in values.enumerated() {
      guard let element = Element.read(value, at: "\(path)[\(index)]") else { return nil }
      out.append(element)
    }
    return out
  }

  var json: JSONValue { .array(map(\.json)) }
}

extension Dictionary: JSONField where Key == String, Value: JSONField {
  static func read(_ json: JSONValue, at path: String) -> [String: Value]? {
    guard case .object(let values) = json else { return nil }
    var out: [String: Value] = [:]
    out.reserveCapacity(values.count)
    for (key, value) in values {
      guard let element = Value.read(value, at: JSONPath.member(path, key)) else { return nil }
      out[key] = element
    }
    return out
  }

  var json: JSONValue { .object(mapValues(\.json)) }
}

extension Usage: JSONField {
  static func read(_ json: JSONValue, at path: String) -> Usage? { Usage(jsonValue: json) }
  var json: JSONValue { jsonValue }
}

extension SessionLiveInfo: JSONField {
  static func read(_ json: JSONValue, at path: String) -> SessionLiveInfo? { SessionLiveInfo(jsonValue: json) }
  var json: JSONValue { jsonValue }
}

extension ErrorSurface: JSONField {
  static func read(_ json: JSONValue, at path: String) -> ErrorSurface? { ErrorSurface(jsonValue: json) }
  var json: JSONValue { jsonValue }
}

/// Every transcript model type reads and writes itself as a property, too.
extension JSONField where Self: TranscriptJSONCodable {
  static func read(_ json: JSONValue, at path: String) -> Self? { try? Self(decoding: json, at: path) }
  var json: JSONValue { jsonValue }
}

// MARK: - Paths

enum JSONPath {
  /// `path.key`, or `path["key"]` when the key is not a plain identifier.
  static func member(_ path: String, _ key: String) -> String {
    func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
      (scalar >= "a" && scalar <= "z") || (scalar >= "A" && scalar <= "Z") || (scalar >= "0" && scalar <= "9") || scalar == "_"
    }
    let plain =
      !key.isEmpty && key.unicodeScalars.allSatisfy(isWordScalar)
      && !(key.unicodeScalars.first.map { $0 >= "0" && $0 <= "9" } ?? false)
    if plain { return path.isEmpty ? key : "\(path).\(key)" }
    return "\(path)[\(JSONValue.string(key).description)]"
  }
}

// MARK: - Reading an object

/// Reads one JSON object field by field. What it has not taken is the residue, which
/// a type stores as its `extra`.
struct ObjectReader {
  private(set) var residue: JSONObject
  let path: String

  init(_ json: JSONValue, at path: String, type: String) throws(TranscriptDecodingError) {
    guard case .object(let object) = json else {
      throw TranscriptDecodingError(path: path, message: "expected a \(type) object, found \(JSONKind.of(json))")
    }
    residue = object
    self.path = path
  }

  /// A key that must be present with the right shape.
  mutating func required<T: JSONField>(_ key: String, as type: T.Type = T.self) throws(TranscriptDecodingError) -> T {
    let at = JSONPath.member(path, key)
    guard let raw = residue[key] else {
      throw TranscriptDecodingError(path: at, message: "missing required \(T.self)")
    }
    guard let value = T.read(raw, at: at) else {
      throw TranscriptDecodingError(path: at, message: "expected \(T.self), found \(JSONKind.of(raw))")
    }
    residue[key] = nil
    return value
  }

  /// A required key whose nested type reports its own errors (so the message points
  /// inside it rather than at it).
  mutating func requiredNested<T: TranscriptJSONCodable>(
    _ key: String,
    as type: T.Type = T.self
  ) throws(TranscriptDecodingError) -> T {
    let at = JSONPath.member(path, key)
    guard let raw = residue[key] else {
      throw TranscriptDecodingError(path: at, message: "missing required \(T.self)")
    }
    let value = try T(decoding: raw, at: at)
    residue[key] = nil
    return value
  }

  /// A key that may be absent. Present but of another shape: `nil`, and the raw
  /// value stays in the residue.
  mutating func optional<T: JSONField>(_ key: String, as type: T.Type = T.self) -> T? {
    guard let raw = residue[key] else { return nil }
    guard let value = T.read(raw, at: JSONPath.member(path, key)) else { return nil }
    residue[key] = nil
    return value
  }

  /// A key the TypeScript type writes as `T | null` and always includes. `null`
  /// and absent both read as `nil`.
  mutating func nullable<T: JSONField>(_ key: String, as type: T.Type = T.self) -> T? {
    if residue[key] == .null {
      residue[key] = nil
      return nil
    }
    return optional(key)
  }
}

/// Builds one JSON object: the residue first, then every typed property over it.
struct ObjectWriter {
  private(set) var object: JSONObject

  init(extra: JSONObject) {
    object = extra
  }

  mutating func set<T: JSONField>(_ key: String, _ value: T) {
    object[key] = value.json
  }

  /// Writes nothing for `nil` (TypeScript's `undefined`).
  mutating func set<T: JSONField>(_ key: String, _ value: T?) {
    if let value { object[key] = value.json }
  }

  /// Writes `null` for `nil`.
  mutating func setNullable<T: JSONField>(_ key: String, _ value: T?) {
    object[key] = value?.json ?? .null
  }

  var json: JSONValue { .object(object) }
}

enum JSONKind {
  static func of(_ value: JSONValue) -> String {
    switch value {
    case .null: "null"
    case .bool: "a boolean"
    case .number(let number):
      !number.isFinite
        ? "the number \(number)"
        : number.rounded() == number ? "the number \(JS.string(number))" : "the fraction \(number)"
    case .string: "a string"
    case .array: "an array"
    case .object: "an object"
    }
  }
}
