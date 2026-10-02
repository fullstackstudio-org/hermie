import Foundation

/// A value the canonical text cannot express: only a non-finite number, since a Swift string
/// cannot hold the lone surrogate the reference also refuses.
public enum CanonicalJSONError: Error, Sendable, Hashable {
  case nonFiniteNumber
}

/// The order object keys are written in.
public enum CanonicalKeyOrder: Sendable, Hashable {
  /// By UTF-16 code unit at every depth: rule 2 of `contract/README.md`, and the default.
  case utf16CodeUnits
  /// The order `JSON.stringify` actually walks a JavaScript object in, which is what
  /// `scripts/golden/canonical-json.ts` (and so every file under `contract/`) writes: keys that
  /// are array indices (`"0"` … `"4294967294"`) first in numeric order, then every other key
  /// by UTF-16 code unit. It differs from `utf16CodeUnits` only for objects with index-like
  /// keys (`byRowId`, say). Both orders give the same equality; this one exists to compare a
  /// text byte for byte with one the TypeScript side wrote.
  case ecmaScriptObject
}

extension JSONValue {
  /// The canonical text of `contract/README.md` ("Canonical JSON"): no whitespace, keys
  /// sorted, numbers as ECMAScript `Number.prototype.toString` writes them (`-0` as `0`),
  /// strings escaped as `JSON.stringify` escapes them. Two values are equal for the contract
  /// exactly when their canonical texts are equal.
  public func canonicalString(keyOrder: CanonicalKeyOrder = .utf16CodeUnits) throws(CanonicalJSONError) -> String {
    var output: [UInt8] = []
    output.reserveCapacity(256)
    try CanonicalWriter(keyOrder: keyOrder).write(self, into: &output)
    return String(decoding: output, as: UTF8.self)
  }

  /// The canonical text as UTF-8, which is also how a frame goes out on the wire.
  public func canonicalData(keyOrder: CanonicalKeyOrder = .utf16CodeUnits) throws(CanonicalJSONError) -> Data {
    var output: [UInt8] = []
    try CanonicalWriter(keyOrder: keyOrder).write(self, into: &output)
    return Data(output)
  }
}

struct CanonicalWriter {
  let keyOrder: CanonicalKeyOrder

  func write(_ value: JSONValue, into output: inout [UInt8]) throws(CanonicalJSONError) {
    switch value {
    case .null:
      output.append(contentsOf: "null".utf8)
    case .bool(let flag):
      output.append(contentsOf: (flag ? "true" : "false").utf8)
    case .number(let number):
      guard number.isFinite else { throw .nonFiniteNumber }
      output.append(contentsOf: ECMAScriptNumber.string(number).utf8)
    case .string(let text):
      Self.writeString(text, into: &output)
    case .array(let elements):
      output.append(UInt8(ascii: "["))
      for (offset, element) in elements.enumerated() {
        if offset > 0 { output.append(UInt8(ascii: ",")) }
        try write(element, into: &output)
      }
      output.append(UInt8(ascii: "]"))
    case .object(let object):
      output.append(UInt8(ascii: "{"))
      for (offset, key) in sortedKeys(object).enumerated() {
        if offset > 0 { output.append(UInt8(ascii: ",")) }
        Self.writeString(key, into: &output)
        output.append(UInt8(ascii: ":"))
        try write(object[key]!, into: &output)
      }
      output.append(UInt8(ascii: "}"))
    }
  }

  private func sortedKeys(_ object: JSONObject) -> [String] {
    let byCodeUnits = object.keys.sorted(by: Self.utf16Precedes)
    switch keyOrder {
    case .utf16CodeUnits:
      return byCodeUnits
    case .ecmaScriptObject:
      var indices: [(UInt32, String)] = []
      var others: [String] = []
      for key in byCodeUnits {
        if let index = Self.arrayIndex(key) { indices.append((index, key)) } else { others.append(key) }
      }
      return indices.sorted { $0.0 < $1.0 }.map(\.1) + others
    }
  }

  /// JavaScript's default string order: UTF-16 code units, lexicographically.
  static func utf16Precedes(_ lhs: String, _ rhs: String) -> Bool {
    lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
  }

  /// An ECMAScript array index: the canonical decimal form of an integer below 2^32 − 1.
  static func arrayIndex(_ key: String) -> UInt32? {
    let utf8 = key.utf8
    guard let first = utf8.first, utf8.count <= 10 else { return nil }
    if first == UInt8(ascii: "0") { return utf8.count == 1 ? 0 : nil }
    var value: UInt64 = 0
    for byte in utf8 {
      guard byte >= UInt8(ascii: "0"), byte <= UInt8(ascii: "9") else { return nil }
      value = value * 10 + UInt64(byte - UInt8(ascii: "0"))
    }
    return value < 4_294_967_295 ? UInt32(value) : nil
  }

  private static let hexDigits = Array("0123456789abcdef".utf8)

  /// `JSON.stringify`'s escaping (ES2019 well-formed stringify, minus the lone-surrogate
  /// branch a Swift string can never reach).
  static func writeString(_ text: String, into output: inout [UInt8]) {
    output.append(UInt8(ascii: "\""))
    for byte in text.utf8 {
      switch byte {
      case UInt8(ascii: "\""): output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "\"")])
      case UInt8(ascii: "\\"): output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "\\")])
      case 0x08: output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "b")])
      case 0x0C: output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "f")])
      case 0x0A: output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "n")])
      case 0x0D: output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "r")])
      case 0x09: output.append(contentsOf: [UInt8(ascii: "\\"), UInt8(ascii: "t")])
      case 0x00..<0x20:
        output.append(contentsOf: Array("\\u00".utf8))
        output.append(hexDigits[Int(byte >> 4)])
        output.append(hexDigits[Int(byte & 0x0F)])
      default:
        // Every byte of a multi-byte sequence is >= 0x80, so UTF-8 passes through whole.
        output.append(byte)
      }
    }
    output.append(UInt8(ascii: "\""))
  }
}

/// ECMAScript `Number::toString(x)` for a finite double (ECMA-262, 6.1.6.1.20), radix 10.
public enum ECMAScriptNumber {
  /// The text JavaScript's `String(x)` gives. `x` must be finite; `-0` gives `"0"`.
  public static func string(_ value: Double) -> String {
    precondition(value.isFinite, "ECMAScriptNumber.string needs a finite number")
    if value == 0 { return "0" }

    // Swift's `description` is the shortest digit string that round-trips, the nearest such
    // when several qualify: exactly the `s`/`k` the specification asks for. Only the layout
    // differs, so take the digits and the exponent out of it and lay them out the ECMAScript way.
    let (digits, pointPosition) = decimalDigits(of: value.magnitude)
    let k = digits.count
    let n = pointPosition
    var result = value < 0 ? "-" : ""

    if k <= n && n <= 21 {
      result += digits + String(repeating: "0", count: n - k)
    } else if 0 < n && n <= 21 {
      let split = digits.index(digits.startIndex, offsetBy: n)
      result += digits[..<split] + "." + digits[split...]
    } else if -6 < n && n <= 0 {
      result += "0." + String(repeating: "0", count: -n) + digits
    } else {
      let exponent = n - 1
      let sign = exponent < 0 ? "-" : "+"
      let mantissa = k == 1 ? digits : String(digits.prefix(1)) + "." + digits.dropFirst()
      result += mantissa + "e" + sign + String(exponent.magnitude)
    }
    return result
  }

  /// The significant digits `d1…dk` (no leading or trailing zeros) and `n` such that the
  /// value is `0.d1…dk × 10^n`.
  static func decimalDigits(of magnitude: Double) -> (digits: String, pointPosition: Int) {
    let text = magnitude.description
    var mantissa = Substring(text)
    var exponent = 0
    if let marker = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      mantissa = text[..<marker]
      exponent = Int(text[text.index(after: marker)...]) ?? 0
    }
    let integerPart: Substring
    let fractionPart: Substring
    if let dot = mantissa.firstIndex(of: ".") {
      integerPart = mantissa[..<dot]
      fractionPart = mantissa[mantissa.index(after: dot)...]
    } else {
      integerPart = mantissa
      fractionPart = ""
    }
    var digits = Array(integerPart + fractionPart)
    var point = integerPart.count + exponent
    while let first = digits.first, first == "0" {
      digits.removeFirst()
      point -= 1
    }
    while let last = digits.last, last == "0" {
      digits.removeLast()
    }
    return (String(digits), point)
  }
}
