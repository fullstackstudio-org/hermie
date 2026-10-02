/// The handful of JavaScript string behaviours the reference relies on,
/// spelled out so the port answers exactly what the TypeScript answers.
///
/// Everything here works on Unicode scalars, never on `Character`s: a
/// `Character` merges `\r\n` into one grapheme and glues a combining mark onto
/// the character before it, so `"/\u{307}"` would hide its slash from a
/// `firstIndex(of: "/")`. JavaScript sees code units, and for every ASCII
/// delimiter the reference searches for, scalars give the same answer.
enum JSText {
  /// `String.prototype.trim`'s set: ECMAScript WhiteSpace and LineTerminator.
  ///
  /// Foundation's `.whitespacesAndNewlines` differs at the edges (it includes
  /// U+0085 and U+180E, and leaves out U+FEFF), so the set is written out.
  static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F,
      0x3000, 0xFEFF:
      return true
    default:
      return false
    }
  }

  /// `String.prototype.trim`.
  static func trim(_ value: String) -> String {
    strip(value, where: isWhitespace)
  }

  /// Both ends of `value` with every scalar matching `predicate` removed.
  static func strip(_ value: String, where predicate: (Unicode.Scalar) -> Bool) -> String {
    let scalars = Array(value.unicodeScalars)
    var start = 0
    var end = scalars.count

    while start < end, predicate(scalars[start]) {
      start += 1
    }

    while end > start, predicate(scalars[end - 1]) {
      end -= 1
    }

    return string(scalars[start..<end])
  }

  static func string<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars)
    return String(view)
  }

  /// `startsWith`, code point for code point (Swift's `hasPrefix` compares graphemes).
  static func hasPrefix(_ value: String, _ prefix: String) -> Bool {
    value.unicodeScalars.starts(with: prefix.unicodeScalars)
  }

  /// `endsWith`, code point for code point.
  static func hasSuffix(_ value: String, _ suffix: String) -> Bool {
    value.unicodeScalars.reversed().starts(with: suffix.unicodeScalars.reversed())
  }

  /// `===` on strings: code points, not canonical equivalence.
  static func same(_ lhs: String, _ rhs: String) -> Bool {
    lhs.unicodeScalars.elementsEqual(rhs.unicodeScalars)
  }

  static func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
    scalar.value >= 0x30 && scalar.value <= 0x39
  }

  static func isASCIIAlpha(_ scalar: Unicode.Scalar) -> Bool {
    (scalar.value >= 0x41 && scalar.value <= 0x5A) || (scalar.value >= 0x61 && scalar.value <= 0x7A)
  }

  static func isASCIIHexDigit(_ scalar: Unicode.Scalar) -> Bool {
    isASCIIDigit(scalar) || (scalar.value >= 0x41 && scalar.value <= 0x46) || (scalar.value >= 0x61 && scalar.value <= 0x66)
  }

  static func hexValue(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 0x30...0x39: byte - 0x30
    case 0x41...0x46: byte - 0x41 + 10
    case 0x61...0x66: byte - 0x61 + 10
    default: nil
    }
  }

  /// ASCII-only lowercasing, which is what the URL parser does to a scheme.
  static func asciiLowercased(_ value: String) -> String {
    string(
      value.unicodeScalars.map { scalar in
        scalar.value >= 0x41 && scalar.value <= 0x5A ? Unicode.Scalar(scalar.value + 0x20)! : scalar
      }
    )
  }

  private static let upperHex = Array("0123456789ABCDEF".utf8)

  /// `%XX` for one byte, uppercase hex, as every URL serialiser writes it.
  static func percentEscape(_ byte: UInt8, into out: inout String) {
    out.unicodeScalars.append("%")
    out.unicodeScalars.append(Unicode.Scalar(upperHex[Int(byte >> 4)]))
    out.unicodeScalars.append(Unicode.Scalar(upperHex[Int(byte & 0x0F)]))
  }

  /// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 `%XX`.
  static func encodeURIComponent(_ value: String) -> String {
    var out = ""

    for byte in value.utf8 {
      let unreserved =
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || "-_.!~*'()".utf8.contains(byte)

      if unreserved {
        out.unicodeScalars.append(Unicode.Scalar(byte))
      } else {
        percentEscape(byte, into: &out)
      }
    }

    return out
  }

  /// The `application/x-www-form-urlencoded` serialiser `URLSearchParams.toString` uses:
  /// space is `+`, only `A-Z a-z 0-9 * - . _` stay as they are, the rest is UTF-8 `%XX`.
  static func formEncode(_ value: String) -> String {
    var out = ""

    for byte in value.utf8 {
      if byte == 0x20 {
        out.unicodeScalars.append("+")
      } else if (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || byte == 0x2A || byte == 0x2D || byte == 0x2E || byte == 0x5F
      {
        out.unicodeScalars.append(Unicode.Scalar(byte))
      } else {
        percentEscape(byte, into: &out)
      }
    }

    return out
  }

  /// `URLSearchParams.toString()` over pairs, in order.
  static func formSerialize(_ pairs: [(String, String)]) -> String {
    pairs.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
  }

  /// Percent-decoding as the URL standard defines it: a `%` not followed by two
  /// hex digits is kept literally.
  static func percentDecode(_ bytes: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(bytes.count)
    var index = 0

    while index < bytes.count {
      let byte = bytes[index]

      if byte == 0x25, index + 2 < bytes.count, let high = hexValue(bytes[index + 1]),
        let low = hexValue(bytes[index + 2])
      {
        out.append(high << 4 | low)
        index += 3
      } else {
        out.append(byte)
        index += 1
      }
    }

    return out
  }

  /// The `application/x-www-form-urlencoded` parser `new URLSearchParams(query)` runs:
  /// split on `&`, drop empty pieces, split each at its first `=`, `+` is a
  /// space, then percent-decode and read the bytes as UTF-8 (invalid sequences
  /// become U+FFFD; a leading BOM is kept).
  static func formParse(_ query: String) -> [(String, String)] {
    var pairs: [(String, String)] = []

    for piece in query.utf8.split(separator: 0x26, omittingEmptySubsequences: true) {
      let bytes = Array(piece)
      let nameBytes: [UInt8]
      let valueBytes: [UInt8]

      if let equals = bytes.firstIndex(of: 0x3D) {
        nameBytes = Array(bytes[..<equals])
        valueBytes = Array(bytes[(equals + 1)...])
      } else {
        nameBytes = bytes
        valueBytes = []
      }

      func decode(_ raw: [UInt8]) -> String {
        String(decoding: percentDecode(raw.map { $0 == 0x2B ? 0x20 : $0 }), as: UTF8.self)
      }

      pairs.append((decode(nameBytes), decode(valueBytes)))
    }

    return pairs
  }

  /// `JSON.stringify` of a string: `"` `\` and control characters escaped
  /// (`\b \f \n \r \t`, else lowercase `\u00xx`); everything else, including
  /// `/`, U+2028 and all non-ASCII, written as is.
  static func jsonStringLiteral(_ value: String) -> String {
    var out = "\""

    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x08: out += "\\b"
      case 0x0C: out += "\\f"
      case 0x0A: out += "\\n"
      case 0x0D: out += "\\r"
      case 0x09: out += "\\t"
      case 0x00..<0x20:
        let hex = String(scalar.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
      default:
        out.unicodeScalars.append(scalar)
      }
    }

    return out + "\""
  }

  /// `Number.prototype.toString` for the values a message embeds.
  ///
  /// Integers below 1e21 are written without a decimal point, `-0` as `0`;
  /// anything else falls back to Swift's shortest round-trip form, which agrees
  /// with ECMAScript except for exponent spelling at extreme magnitudes — no
  /// message here carries one.
  static func numberString(_ value: Double) -> String {
    if value == 0 {
      return "0"
    }

    if value.rounded(.towardZero) == value, abs(value) < 1e21 {
      if abs(value) < 9.2e18 {
        return String(Int64(value))
      }
    }

    return "\(value)"
  }

  /// `Number.parseInt(value, 10)`: leading whitespace skipped, an optional sign,
  /// then as many ASCII digits as there are; `nil` (NaN) when there are none.
  static func parseInt(_ value: String) -> Double? {
    var scalars = Substring(value).unicodeScalars.drop(while: isWhitespace)
    var sign = 1.0

    if let first = scalars.first, first == "-" || first == "+" {
      sign = first == "-" ? -1 : 1
      scalars = scalars.dropFirst()
    }

    var result = 0.0
    var sawDigit = false

    for scalar in scalars {
      guard isASCIIDigit(scalar) else {
        break
      }

      sawDigit = true
      result = result * 10 + Double(scalar.value - 0x30)
    }

    return sawDigit ? sign * result : nil
  }
}
