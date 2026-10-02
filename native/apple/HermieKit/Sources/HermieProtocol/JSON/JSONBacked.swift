import Foundation

// How every typed wire type in this module is built
// ==================================================
//
// One mechanism, used for every frame, payload, params, result and REST body: a typed
// struct is a VIEW over the JSON object it was decoded from. It stores that object
// (`json`) and nothing else; each typed property reads its key out of it and writes its key
// back into it. So:
//
// - Re-encoding is lossless by construction: unknown keys, `null` versus an absent key,
//   integer versus fractional numbers and key spelling all survive, because the object
//   that goes out is the object that came in, plus whatever was set through a property.
// - Decoding never fails on a field. A key that is missing, `null` or of the wrong type
//   reads as `nil` (an array or map keeps only the elements that convert), the way the
//   TypeScript reference reads payloads through `str()`/`num()`/`rec()`. Only a value that
//   is not an object at all fails to become a view (`init?(jsonValue:)` returns `nil`).
// - Setting a property to `nil` removes its key.
// - Closed vocabularies (`TurnStatus`, `ApprovalChoice`, …) are `OpenStringEnum`s: a value
//   this build has never heard of decodes as `.unknown(raw)` and re-encodes unchanged.

/// A type with a JSON form, read tolerantly.
public protocol JSONConvertible: Sendable {
  /// `nil` when `jsonValue` has the wrong shape for this type.
  init?(jsonValue: JSONValue)
  var jsonValue: JSONValue { get }
}

extension JSONValue: JSONConvertible {
  public init?(jsonValue: JSONValue) { self = jsonValue }
  public var jsonValue: JSONValue { self }
}

extension String: JSONConvertible {
  public init?(jsonValue: JSONValue) {
    guard case .string(let value) = jsonValue else { return nil }
    self = value
  }

  public var jsonValue: JSONValue { .string(self) }
}

extension Bool: JSONConvertible {
  public init?(jsonValue: JSONValue) {
    guard case .bool(let value) = jsonValue else { return nil }
    self = value
  }

  public var jsonValue: JSONValue { .bool(self) }
}

extension Double: JSONConvertible {
  public init?(jsonValue: JSONValue) {
    guard case .number(let value) = jsonValue else { return nil }
    self = value
  }

  public var jsonValue: JSONValue { .number(self) }
}

extension Int: JSONConvertible {
  /// Only an integral number that fits.
  public init?(jsonValue: JSONValue) {
    guard case .number(let value) = jsonValue, let integer = Int(exactly: value) else { return nil }
    self = integer
  }

  public var jsonValue: JSONValue { .number(Double(self)) }
}

extension Array: JSONConvertible where Element: JSONConvertible {
  /// An array, keeping the elements that convert.
  public init?(jsonValue: JSONValue) {
    guard case .array(let values) = jsonValue else { return nil }
    self = values.compactMap(Element.init(jsonValue:))
  }

  public var jsonValue: JSONValue { .array(map(\.jsonValue)) }
}

extension Dictionary: JSONConvertible where Key == String, Value: JSONConvertible {
  /// An object, keeping the members that convert.
  public init?(jsonValue: JSONValue) {
    guard case .object(let values) = jsonValue else { return nil }
    self = values.compactMapValues(Value.init(jsonValue:))
  }

  public var jsonValue: JSONValue { .object(mapValues(\.jsonValue)) }
}

extension Dictionary where Key == String, Value == JSONValue {
  /// The member `key` as `T`, or `nil` when absent or of another shape. Setting `nil`
  /// removes the key. The one accessor every typed property is written with.
  public subscript<T: JSONConvertible>(field key: String) -> T? {
    get { self[key].flatMap(T.init(jsonValue:)) }
    set { self[key] = newValue?.jsonValue }
  }
}

/// A field whose explicit `null` is part of what the emitter sends (`parent_id: null` on a
/// top-level child). As a property type, `Nullable<T>?` reads an absent key as `nil`, `null`
/// as `.null` and a value as `.some`, so a typed rewrite keeps the `null`. Every other
/// nullable field reads `null` as `nil` like an absent key (the raw object still keeps it).
public enum Nullable<Wrapped: JSONConvertible>: JSONConvertible {
  case null
  case some(Wrapped)

  /// `nil` for `null`.
  public var value: Wrapped? {
    if case .some(let wrapped) = self { return wrapped }
    return nil
  }

  public init?(jsonValue: JSONValue) {
    if case .null = jsonValue {
      self = .null
    } else if let wrapped = Wrapped(jsonValue: jsonValue) {
      self = .some(wrapped)
    } else {
      return nil
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .null: .null
    case .some(let wrapped): wrapped.jsonValue
    }
  }
}

extension Nullable: Equatable where Wrapped: Equatable {}
extension Nullable: Hashable where Wrapped: Hashable {}

/// A typed view over one JSON object. See the header of this file.
public protocol JSONObjectBacked: JSONConvertible, Codable, Hashable, CustomStringConvertible {
  /// The object as decoded, with every write through a typed property applied.
  var json: JSONObject { get set }
  init(json: JSONObject)
}

extension JSONObjectBacked {
  /// An empty object, to fill through the typed properties.
  public init() {
    self.init(json: [:])
  }

  public init?(jsonValue: JSONValue) {
    guard case .object(let object) = jsonValue else { return nil }
    self.init(json: object)
  }

  public var jsonValue: JSONValue { .object(json) }

  /// Parses `data` and views it as this type. Throws when it is not JSON or not an object.
  public init(parsing data: Data) throws(JSONDecodeFailure) {
    let value: JSONValue
    do {
      value = try JSONValue(parsing: data)
    } catch {
      throw .notJSON(error)
    }
    guard case .object(let object) = value else { throw .notAnObject }
    self.init(json: object)
  }

  public init(from decoder: any Decoder) throws {
    let value = try JSONValue(from: decoder)
    guard case .object(let object) = value else {
      throw DecodingError.typeMismatch(
        JSONObject.self,
        DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected a JSON object")
      )
    }
    self.init(json: object)
  }

  public func encode(to encoder: any Encoder) throws {
    try jsonValue.encode(to: encoder)
  }

  /// The canonical text of the object.
  public var description: String { jsonValue.description }
}

/// Why `init(parsing:)` of a typed view failed.
public enum JSONDecodeFailure: Error, Sendable, Hashable {
  case notJSON(JSONParseError)
  case notAnObject
}

/// A string vocabulary that stays open: a value this build does not know decodes as
/// `.unknown(raw)` and re-encodes unchanged. Build values with `init(rawValue:)` so a known
/// spelling always lands on its named case (`.unknown("complete")` is not `.complete`).
public protocol OpenStringEnum: JSONConvertible, Hashable, Codable, RawRepresentable, CustomStringConvertible
where RawValue == String {
  static var knownCases: [Self] { get }
  static func unknown(_ rawValue: String) -> Self
}

extension OpenStringEnum {
  public init(rawValue: String) {
    self = Self.named(rawValue)
  }

  /// The named case for `rawValue`, else `.unknown(rawValue)`.
  public static func named(_ rawValue: String) -> Self {
    knownCases.first { $0.rawValue == rawValue } ?? .unknown(rawValue)
  }

  public init?(jsonValue: JSONValue) {
    guard case .string(let raw) = jsonValue else { return nil }
    self = Self.named(raw)
  }

  public var jsonValue: JSONValue { .string(rawValue) }

  public init(from decoder: any Decoder) throws {
    self = Self.named(try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var isKnown: Bool { Self.knownCases.contains(self) }

  public var description: String { rawValue }
}
