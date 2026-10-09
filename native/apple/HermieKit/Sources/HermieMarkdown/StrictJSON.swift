import Foundation

// A strict JSON reader for the blocks a model writes
// ===================================================
//
// `JSONSerialization` is lenient where `JSON.parse` (the web client's reader) is not: it takes a trailing
// comma and a byte order mark, and with a repeated key it keeps the first value where JavaScript keeps the
// last. A `hermie-cards` block must be drawn by the two clients on exactly the same text, so the Apple
// client reads it with this: RFC 8259 and nothing else, with a repeated key resolved the way
// `JSON.parse` does it.
//
// Pure and total: no Foundation parser, never traps, a nesting cap instead of a stack overflow.

enum StrictJSON {
  /// A parsed JSON value. A number is a `Double`; a boolean is a boolean (never a number).
  indirect enum Value: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([Value])
    case object([String: Value])
  }

  /// How deep a value may nest. A block of cards is four levels deep; the cap is far beyond any real one.
  static let maxDepth = 64

  /// The one JSON value `source` is, or `nil` when it is not exactly one JSON text.
  static func parse(_ source: String) -> Value? {
    var reader = Reader(bytes: Array(source.utf8))
    reader.skipSpace()
    guard let value = reader.value(depth: 0) else { return nil }
    reader.skipSpace()
    return reader.atEnd ? value : nil
  }

  private struct Reader {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) {
      self.bytes = bytes
    }

    static let replacement = Unicode.Scalar(UInt32(0xFFFD))!

    var atEnd: Bool { index >= bytes.count }

    mutating func skipSpace() {
      while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x09 || bytes[index] == 0x0A || bytes[index] == 0x0D {
        index += 1
      }
    }

    mutating func value(depth: Int) -> Value? {
      guard depth <= StrictJSON.maxDepth, index < bytes.count else { return nil }

      switch bytes[index] {
      case UInt8(ascii: "{"): return object(depth: depth)
      case UInt8(ascii: "["): return array(depth: depth)
      case UInt8(ascii: "\""): return string().map(Value.string)
      case UInt8(ascii: "t"): return literal("true", .bool(true))
      case UInt8(ascii: "f"): return literal("false", .bool(false))
      case UInt8(ascii: "n"): return literal("null", .null)
      default: return number()
      }
    }

    mutating func literal(_ word: String, _ value: Value) -> Value? {
      let expected = Array(word.utf8)
      guard index + expected.count <= bytes.count, Array(bytes[index..<index + expected.count]) == expected else {
        return nil
      }
      index += expected.count
      return value
    }

    mutating func object(depth: Int) -> Value? {
      index += 1
      var members: [String: Value] = [:]
      skipSpace()

      if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
        index += 1
        return .object(members)
      }

      while true {
        skipSpace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: "\""), let key = string() else { return nil }
        skipSpace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { return nil }
        index += 1
        skipSpace()
        guard let member = value(depth: depth + 1) else { return nil }
        // `JSON.parse` keeps the last of a repeated key.
        members[key] = member
        skipSpace()
        guard index < bytes.count else { return nil }

        if bytes[index] == UInt8(ascii: ",") {
          index += 1
        } else if bytes[index] == UInt8(ascii: "}") {
          index += 1
          return .object(members)
        } else {
          return nil
        }
      }
    }

    mutating func array(depth: Int) -> Value? {
      index += 1
      var items: [Value] = []
      skipSpace()

      if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
        index += 1
        return .array(items)
      }

      while true {
        skipSpace()
        guard let item = value(depth: depth + 1) else { return nil }
        items.append(item)
        skipSpace()
        guard index < bytes.count else { return nil }

        if bytes[index] == UInt8(ascii: ",") {
          index += 1
        } else if bytes[index] == UInt8(ascii: "]") {
          index += 1
          return .array(items)
        } else {
          return nil
        }
      }
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
    mutating func number() -> Value? {
      let start = index

      if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }

      guard index < bytes.count else { return nil }

      if bytes[index] == UInt8(ascii: "0") {
        index += 1
      } else if (0x31...0x39).contains(bytes[index]) {
        digits()
      } else {
        return nil
      }

      if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
        index += 1
        guard digits() else { return nil }
      }

      if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
        index += 1
        if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
        guard digits() else { return nil }
      }

      return Double(String(decoding: bytes[start..<index], as: UTF8.self)).map(Value.number)
    }

    @discardableResult
    mutating func digits() -> Bool {
      let start = index
      while index < bytes.count, (0x30...0x39).contains(bytes[index]) { index += 1 }
      return index > start
    }

    /// A string at the opening quote. A raw control character is refused; a lone surrogate escape becomes
    /// U+FFFD (a Swift string cannot hold one, and `JSON.parse` would draw a replacement glyph for it too).
    mutating func string() -> String? {
      index += 1
      var out: [UInt8] = []

      while index < bytes.count {
        let byte = bytes[index]
        index += 1

        switch byte {
        case UInt8(ascii: "\""):
          return String(decoding: out, as: UTF8.self)
        case 0x00..<0x20:
          return nil
        case UInt8(ascii: "\\"):
          guard index < bytes.count else { return nil }
          let escape = bytes[index]
          index += 1

          switch escape {
          case UInt8(ascii: "\""): out.append(0x22)
          case UInt8(ascii: "\\"): out.append(0x5C)
          case UInt8(ascii: "/"): out.append(0x2F)
          case UInt8(ascii: "b"): out.append(0x08)
          case UInt8(ascii: "f"): out.append(0x0C)
          case UInt8(ascii: "n"): out.append(0x0A)
          case UInt8(ascii: "r"): out.append(0x0D)
          case UInt8(ascii: "t"): out.append(0x09)
          case UInt8(ascii: "u"):
            guard let scalar = unicodeEscape() else { return nil }
            out.append(contentsOf: Array(String(Character(scalar)).utf8))
          default:
            return nil
          }
        default:
          out.append(byte)
        }
      }

      return nil
    }

    /// The four hex digits after `\u` (and a second escape when the first is a high surrogate).
    mutating func unicodeEscape() -> Unicode.Scalar? {
      guard let first = hex4() else { return nil }

      if (0xD800...0xDBFF).contains(first) {
        let save = index

        if index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") {
          index += 2

          if let second = hex4(), (0xDC00...0xDFFF).contains(second) {
            let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
            return Unicode.Scalar(combined) ?? Self.replacement
          }
        }

        index = save
        return Self.replacement
      }

      if (0xDC00...0xDFFF).contains(first) {
        return Self.replacement
      }

      return Unicode.Scalar(first)
    }

    mutating func hex4() -> UInt32? {
      guard index + 4 <= bytes.count else { return nil }
      var value: UInt32 = 0

      for offset in 0..<4 {
        let byte = bytes[index + offset]
        let digit: UInt32

        switch byte {
        case 0x30...0x39: digit = UInt32(byte - 0x30)
        case 0x41...0x46: digit = UInt32(byte - 0x41 + 10)
        case 0x61...0x66: digit = UInt32(byte - 0x61 + 10)
        default: return nil
        }

        value = value << 4 | digit
      }

      index += 4
      return value
    }
  }
}
