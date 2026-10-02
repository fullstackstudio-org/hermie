import Foundation

/**
 Any JSON value, so a stored document can be read, edited in one place and written back with every
 field this build does not know about still in it.

 `HermieStore` depends on nothing, so it cannot use the protocol target's JSON type; this is the
 small private copy the stores need for exactly that job.
 */
enum StoredJSON: Sendable, Equatable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([StoredJSON])
  case object([String: StoredJSON])

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()

    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([StoredJSON].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: StoredJSON].self))
    }
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()

    switch self {
    case .null:
      try container.encodeNil()
    case let .bool(value):
      try container.encode(value)
    case let .number(value):
      // Whole numbers as integers, the way `JSON.stringify` writes epoch milliseconds.
      if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
        try container.encode(Int64(value))
      } else {
        try container.encode(value)
      }
    case let .string(value):
      try container.encode(value)
    case let .array(value):
      try container.encode(value)
    case let .object(value):
      try container.encode(value)
    }
  }

  static func parse(_ text: String) -> StoredJSON? {
    try? JSONDecoder().decode(StoredJSON.self, from: Data(text.utf8))
  }

  func serialized() throws -> String {
    let encoder = JSONEncoder()

    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]

    return String(decoding: try encoder.encode(self), as: UTF8.self)
  }

  var object: [String: StoredJSON]? {
    if case let .object(value) = self {
      return value
    }

    return nil
  }

  var string: String? {
    if case let .string(value) = self {
      return value
    }

    return nil
  }

  var number: Double? {
    if case let .number(value) = self {
      return value
    }

    return nil
  }

  var array: [StoredJSON]? {
    if case let .array(value) = self {
      return value
    }

    return nil
  }
}
