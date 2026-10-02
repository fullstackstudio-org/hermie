import Foundation

/// One JSON object: keys to values. Key order carries no meaning (see `canonicalString()`).
public typealias JSONObject = [String: JSONValue]

/// Any JSON value, exactly as the wire carried it.
///
/// Numbers are IEEE doubles, which is what the TypeScript reference and the gateway's
/// JavaScript clients hold too: every integer up to 2^53 is exact, an integral value is
/// written back without a decimal point, and two values compare the way JavaScript would
/// compare them after `JSON.parse` (`1`, `1.0` and `1e0` are one number; `-0` equals `0`).
///
/// Strings are Swift strings, so a lone UTF-16 surrogate cannot be held. `JSONValue(parsing:)`
/// replaces an unpaired `\uD8xx`/`\uDCxx` escape (and invalid UTF-8) with U+FFFD rather than
/// dropping the whole frame; the contract corpus never contains one.
public enum JSONValue: Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object(JSONObject)
}

// MARK: - Accessors

extension JSONValue {
  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }

  public var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var doubleValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  /// The number as an `Int`, only when it is integral and fits.
  public var intValue: Int? {
    if case .number(let value) = self { return Int(exactly: value) }
    return nil
  }

  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  public var objectValue: JSONObject? {
    if case .object(let value) = self { return value }
    return nil
  }

  /// The member `key` of an object; `nil` for an absent key or a value that is not an object.
  public subscript(key: String) -> JSONValue? {
    objectValue?[key]
  }

  /// The element at `index` of an array; `nil` out of range or for a value that is not an array.
  public subscript(index: Int) -> JSONValue? {
    guard let array = arrayValue, array.indices.contains(index) else { return nil }
    return array[index]
  }

  /// JavaScript truthiness (`Boolean(value)`), which the reference reads flags with.
  public var isTruthy: Bool {
    switch self {
    case .null: false
    case .bool(let value): value
    case .number(let value): value != 0 && !value.isNaN
    case .string(let value): !value.isEmpty
    case .array, .object: true
    }
  }
}

// MARK: - Literals

extension JSONValue: ExpressibleByNilLiteral {
  public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByBooleanLiteral {
  public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue: ExpressibleByFloatLiteral {
  public init(floatLiteral value: Double) { self = .number(value) }
}

extension JSONValue: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
  /// A repeated key keeps the last value, as `JSON.parse` does.
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(JSONObject(elements, uniquingKeysWith: { _, last in last }))
  }
}

// MARK: - Codable

extension JSONValue: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode(JSONObject.self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a JSON value")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null:
      try container.encodeNil()
    case .bool(let value):
      try container.encode(value)
    case .number(let value):
      // An integral value goes out as an integer, so no encoder writes `1.0` for `1`.
      if let integer = Int64(exactly: value), abs(value) <= JSONValue.maxSafeInteger {
        try container.encode(integer)
      } else {
        try container.encode(value)
      }
    case .string(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    }
  }

  /// 2^53 − 1, JavaScript's `Number.MAX_SAFE_INTEGER`.
  public static let maxSafeInteger: Double = 9_007_199_254_740_991
}

extension JSONValue: CustomStringConvertible {
  /// The canonical text, or a marker for a value that has none (a non-finite number).
  public var description: String {
    (try? canonicalString()) ?? "<not canonical JSON>"
  }
}
