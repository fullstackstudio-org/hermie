import Foundation

/// A JSON value as the vector files hold it, for semantic comparison.
///
/// Private to these tests on purpose: `HermieProtocol` owns the app's JSON
/// value type, and the vectors must not depend on it.
///
/// Decoded with `JSONDecoder`, not `JSONSerialization`: the latter silently
/// drops a U+FEFF that opens a string value (literal or `﻿` escape alike),
/// and `author-id.json` records exactly such strings, because Python's
/// `str.strip()` keeps U+FEFF where JavaScript's `trim` removes it.
enum VectorValue: Equatable, CustomStringConvertible, Decodable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([VectorValue])
  case object([String: VectorValue])

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
    } else if let value = try? container.decode([VectorValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: VectorValue].self))
    }
  }

  /// Strings compare code point for code point: the reference's `===`, not
  /// Swift's canonical equivalence (which would call `é` and `e\u{301}` equal).
  static func == (lhs: VectorValue, rhs: VectorValue) -> Bool {
    switch (lhs, rhs) {
    case (.null, .null):
      true
    case (.bool(let a), .bool(let b)):
      a == b
    case (.number(let a), .number(let b)):
      a == b
    case (.string(let a), .string(let b)):
      a.unicodeScalars.elementsEqual(b.unicodeScalars)
    case (.array(let a), .array(let b)):
      a == b
    case (.object(let a), .object(let b)):
      a.count == b.count
        && a.allSatisfy { key, value in
          b.first { $0.key.unicodeScalars.elementsEqual(key.unicodeScalars) }.map { $0.value == value } ?? false
        }
    default:
      false
    }
  }

  var description: String {
    switch self {
    case .null: "null"
    case .bool(let value): "\(value)"
    case .number(let value): "\(value)"
    case .string(let value): "\"\(value.debugDescription.dropFirst().dropLast())\""
    case .array(let values): "[" + values.map(\.description).joined(separator: ",") + "]"
    case .object(let object):
      "{" + object.keys.sorted().map { "\"\($0)\":\(object[$0]!.description)" }.joined(separator: ",") + "}"
    }
  }

  // MARK: - Reading arguments

  var string: String? {
    if case .string(let value) = self { value } else { nil }
  }

  var number: Double? {
    if case .number(let value) = self { value } else { nil }
  }

  var bool: Bool? {
    if case .bool(let value) = self { value } else { nil }
  }

  var object: [String: VectorValue]? {
    if case .object(let value) = self { value } else { nil }
  }

  subscript(key: String) -> VectorValue? {
    object?[key]
  }

  /// A `{name: string}` map.
  var stringMap: [String: String]? {
    object?.compactMapValues(\.string)
  }

  // MARK: - Building results

  init(_ value: String?) {
    self = value.map(VectorValue.string) ?? .null
  }

  init(_ value: Bool) {
    self = .bool(value)
  }

  init(_ value: Int) {
    self = .number(Double(value))
  }

  init(_ value: Double?) {
    self = value.map(VectorValue.number) ?? .null
  }

  init(_ map: [String: String]) {
    self = .object(map.mapValues(VectorValue.string))
  }
}

/// One `{fn, args, result | throws, error?, random?, note?}` entry.
struct Vector {
  var file: String
  var index: Int
  var fn: String
  var args: [VectorValue]
  /// `nil` when the entry has no `result` (the function returned `undefined`, or threw).
  var result: VectorValue?
  var throwsError: Bool
  var errorKind: String?
  var errorMessage: String?
  var random: Double?

  /// Positional argument; a missing one reads as `null` ("not supplied").
  func arg(_ position: Int) -> VectorValue {
    position < args.count ? args[position] : .null
  }
}

enum VectorLoader {
  /// The ten files this target ports.
  static let files = [
    "url", "host-privacy", "gateway-key", "front-door", "backoff", "pkce", "probe-hints", "author-id", "base64",
    "fetch-json"
  ]

  /// `contract/gateway/vectors`, found by walking up from this source file.
  static func vectorsDirectory(from filePath: String = #filePath) -> URL? {
    var directory = URL(fileURLWithPath: filePath).deletingLastPathComponent()

    while directory.path != "/" {
      let candidate = directory.appendingPathComponent("contract/gateway/vectors")

      if FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }

      directory.deleteLastPathComponent()
    }

    return nil
  }

  static func load(_ file: String) throws -> [Vector] {
    guard let directory = vectorsDirectory() else {
      throw LoadError.noContract
    }

    let data = try Data(contentsOf: directory.appendingPathComponent("\(file).json"))
    let entries = try JSONDecoder().decode([[String: VectorValue]].self, from: data)

    return entries.enumerated().map { index, entry in
      let error = entry["error"]

      return Vector(
        file: file,
        index: index,
        fn: entry["fn"]?.string ?? "",
        args: { if case .array(let args)? = entry["args"] { args } else { [] } }(),
        // Present-and-null stays `.null`; an absent key is `nil` (the function returned `undefined`).
        result: entry["result"],
        throwsError: entry["throws"] == .bool(true),
        errorKind: error?["kind"]?.string,
        errorMessage: error?["message"]?.string,
        random: entry["random"]?.number
      )
    }
  }

  enum LoadError: Error {
    case noContract
  }
}
