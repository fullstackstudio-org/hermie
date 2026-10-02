import Foundation

/// Why a text is not JSON.
public struct JSONParseError: Error, Sendable, Hashable, CustomStringConvertible {
  public enum Reason: String, Sendable, Hashable {
    case unexpectedEnd
    case unexpectedCharacter
    case invalidNumber
    /// A number literal too large for a double (`1e400`). JavaScript would read `Infinity`,
    /// which the contract does not allow, so it is refused here.
    case numberOutOfRange
    case invalidEscape
    case controlCharacterInString
    case trailingCharacters
    case tooDeep
  }

  public let reason: Reason
  /// Byte offset into the UTF-8 input.
  public let offset: Int

  public var description: String { "\(reason.rawValue) at byte \(offset)" }
}

extension JSONValue {
  /// Parses one JSON text (RFC 8259, the grammar `JSON.parse` accepts).
  ///
  /// - A repeated object key keeps the last value, as `JSON.parse` does.
  /// - An unpaired surrogate escape and invalid UTF-8 become U+FFFD (see `JSONValue`).
  /// - Nesting deeper than 256 levels is refused rather than risking the stack.
  public init(parsing data: Data) throws(JSONParseError) {
    var parser = JSONParser(bytes: [UInt8](data))
    self = try parser.parseDocument()
  }

  public init(parsing text: String) throws(JSONParseError) {
    var parser = JSONParser(bytes: Array(text.utf8))
    self = try parser.parseDocument()
  }
}

struct JSONParser {
  private let bytes: [UInt8]
  private var index = 0
  private var depth = 0
  static let maxDepth = 256

  init(bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func parseDocument() throws(JSONParseError) -> JSONValue {
    skipWhitespace()
    let value = try parseValue()
    skipWhitespace()
    guard index == bytes.count else { throw fail(.trailingCharacters) }
    return value
  }

  private func fail(_ reason: JSONParseError.Reason) -> JSONParseError {
    JSONParseError(reason: reason, offset: index)
  }

  private mutating func skipWhitespace() {
    while index < bytes.count {
      switch bytes[index] {
      case 0x20, 0x09, 0x0A, 0x0D: index += 1
      default: return
      }
    }
  }

  private mutating func parseValue() throws(JSONParseError) -> JSONValue {
    guard index < bytes.count else { throw fail(.unexpectedEnd) }
    switch bytes[index] {
    case UInt8(ascii: "{"): return try parseObject()
    case UInt8(ascii: "["): return try parseArray()
    case UInt8(ascii: "\""): return .string(try parseString())
    case UInt8(ascii: "t"):
      try expectLiteral("true")
      return .bool(true)
    case UInt8(ascii: "f"):
      try expectLiteral("false")
      return .bool(false)
    case UInt8(ascii: "n"):
      try expectLiteral("null")
      return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
      return try parseNumber()
    default:
      throw fail(.unexpectedCharacter)
    }
  }

  private mutating func expectLiteral(_ literal: StaticString) throws(JSONParseError) {
    let count = literal.utf8CodeUnitCount
    guard index + count <= bytes.count else { throw fail(.unexpectedEnd) }
    let expected = UnsafeBufferPointer(start: literal.utf8Start, count: count)
    for offset in 0..<count where bytes[index + offset] != expected[offset] {
      throw fail(.unexpectedCharacter)
    }
    index += count
  }

  private mutating func enter() throws(JSONParseError) {
    depth += 1
    if depth > Self.maxDepth { throw fail(.tooDeep) }
  }

  private mutating func parseObject() throws(JSONParseError) -> JSONValue {
    try enter()
    defer { depth -= 1 }
    index += 1
    var object = JSONObject()
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
      index += 1
      return .object(object)
    }
    while true {
      skipWhitespace()
      guard index < bytes.count else { throw fail(.unexpectedEnd) }
      guard bytes[index] == UInt8(ascii: "\"") else { throw fail(.unexpectedCharacter) }
      let key = try parseString()
      skipWhitespace()
      guard index < bytes.count else { throw fail(.unexpectedEnd) }
      guard bytes[index] == UInt8(ascii: ":") else { throw fail(.unexpectedCharacter) }
      index += 1
      skipWhitespace()
      object[key] = try parseValue()
      skipWhitespace()
      guard index < bytes.count else { throw fail(.unexpectedEnd) }
      switch bytes[index] {
      case UInt8(ascii: ","):
        index += 1
      case UInt8(ascii: "}"):
        index += 1
        return .object(object)
      default:
        throw fail(.unexpectedCharacter)
      }
    }
  }

  private mutating func parseArray() throws(JSONParseError) -> JSONValue {
    try enter()
    defer { depth -= 1 }
    index += 1
    var array: [JSONValue] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
      index += 1
      return .array(array)
    }
    while true {
      skipWhitespace()
      array.append(try parseValue())
      skipWhitespace()
      guard index < bytes.count else { throw fail(.unexpectedEnd) }
      switch bytes[index] {
      case UInt8(ascii: ","):
        index += 1
      case UInt8(ascii: "]"):
        index += 1
        return .array(array)
      default:
        throw fail(.unexpectedCharacter)
      }
    }
  }

  private mutating func parseNumber() throws(JSONParseError) -> JSONValue {
    let start = index
    func isDigit(_ byte: UInt8) -> Bool { byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") }

    if bytes[index] == UInt8(ascii: "-") { index += 1 }
    guard index < bytes.count else { throw fail(.invalidNumber) }
    if bytes[index] == UInt8(ascii: "0") {
      index += 1
    } else if isDigit(bytes[index]) {
      while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    } else {
      throw fail(.invalidNumber)
    }
    if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
      index += 1
      guard index < bytes.count, isDigit(bytes[index]) else { throw fail(.invalidNumber) }
      while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    }
    if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
      index += 1
      if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
        index += 1
      }
      guard index < bytes.count, isDigit(bytes[index]) else { throw fail(.invalidNumber) }
      while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    }

    // The grammar is checked above; the conversion is the standard library's correctly
    // rounded decimal-to-double, the same result `JSON.parse` gives.
    let text = String(decoding: bytes[start..<index], as: UTF8.self)
    guard let value = Double(text) else { throw JSONParseError(reason: .invalidNumber, offset: start) }
    guard value.isFinite else { throw JSONParseError(reason: .numberOutOfRange, offset: start) }
    return .number(value)
  }

  private mutating func parseString() throws(JSONParseError) -> String {
    index += 1  // opening quote
    var result = ""
    var runStart = index

    func flushRun(_ end: Int) {
      if end > runStart {
        result += String(decoding: bytes[runStart..<end], as: UTF8.self)
      }
    }

    while true {
      guard index < bytes.count else { throw fail(.unexpectedEnd) }
      let byte = bytes[index]
      switch byte {
      case UInt8(ascii: "\""):
        flushRun(index)
        index += 1
        return result
      case UInt8(ascii: "\\"):
        flushRun(index)
        index += 1
        guard index < bytes.count else { throw fail(.unexpectedEnd) }
        let escape = bytes[index]
        index += 1
        switch escape {
        case UInt8(ascii: "\""): result.append("\"")
        case UInt8(ascii: "\\"): result.append("\\")
        case UInt8(ascii: "/"): result.append("/")
        case UInt8(ascii: "b"): result.append("\u{08}")
        case UInt8(ascii: "f"): result.append("\u{0C}")
        case UInt8(ascii: "n"): result.append("\n")
        case UInt8(ascii: "r"): result.append("\r")
        case UInt8(ascii: "t"): result.append("\t")
        case UInt8(ascii: "u"):
          result.unicodeScalars.append(try parseUnicodeEscape())
        default:
          index -= 1
          throw fail(.invalidEscape)
        }
        runStart = index
      case 0x00..<0x20:
        throw fail(.controlCharacterInString)
      default:
        index += 1
      }
    }
  }

  private mutating func readHex4() throws(JSONParseError) -> UInt16 {
    guard index + 4 <= bytes.count else { throw fail(.unexpectedEnd) }
    var value: UInt16 = 0
    for _ in 0..<4 {
      let byte = bytes[index]
      let digit: UInt16
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt16(byte - UInt8(ascii: "0"))
      case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt16(byte - UInt8(ascii: "a") + 10)
      case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt16(byte - UInt8(ascii: "A") + 10)
      default: throw fail(.invalidEscape)
      }
      value = value << 4 | digit
      index += 1
    }
    return value
  }

  /// After `\u`: one scalar, joining a surrogate pair written as two escapes.
  private mutating func parseUnicodeEscape() throws(JSONParseError) -> Unicode.Scalar {
    let unit = try readHex4()
    switch unit {
    case 0xD800...0xDBFF:
      // A high surrogate counts only when a `\uDC00`…`\uDFFF` escape follows at once.
      if index + 6 <= bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") {
        let save = index
        index += 2
        let low = try readHex4()
        if (0xDC00...0xDFFF).contains(low) {
          let scalar = 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
          return Unicode.Scalar(scalar) ?? "\u{FFFD}"
        }
        index = save
      }
      return "\u{FFFD}"
    case 0xDC00...0xDFFF:
      return "\u{FFFD}"
    default:
      return Unicode.Scalar(unit) ?? "\u{FFFD}"
    }
  }
}
