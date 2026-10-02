import Foundation
import HermieProtocol

/// The JavaScript string behaviours the engine relies on, spelled out so the port
/// answers exactly what the TypeScript answers.
///
/// JavaScript strings are UTF-16 code units: `length`, `slice`, `search` and every
/// regular-expression index count code units. Swift's `String.count` counts
/// grapheme clusters, which merges `\r\n` into one character and glues a combining
/// mark onto the letter before it. So every length and offset here is a UTF-16
/// offset, and slicing goes through `utf16`. `HermieGateway` has a sibling of this
/// file for the gateway client's needs; the targets may not import each other.
enum JS {
  /// `String.prototype.trim`'s set: ECMAScript WhiteSpace and LineTerminator, which is
  /// also what `\s` matches. Foundation's `.whitespacesAndNewlines` differs at the
  /// edges (it has U+0085 and U+180E, and lacks U+FEFF), so the set is written out.
  static func isWhitespace(_ unit: UInt16) -> Bool {
    switch unit {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F,
      0x3000, 0xFEFF:
      return true
    default:
      return false
    }
  }

  /// `value.length`.
  static func length(_ value: String) -> Int {
    value.utf16.count
  }

  /// The code units `[from, to)` as a string. Offsets are clamped like `slice`'s; a
  /// cut through a surrogate pair becomes U+FFFD (JavaScript would keep a lone
  /// surrogate, which the contract can never carry anyway).
  static func substring(_ value: String, _ from: Int, _ to: Int? = nil) -> String {
    let units = value.utf16
    let count = units.count
    let start = min(max(from, 0), count)
    let end = max(min(to ?? count, count), start)
    if start == 0 && end == count { return value }
    let lower = units.index(units.startIndex, offsetBy: start)
    let upper = units.index(lower, offsetBy: end - start)
    return String(decoding: units[lower..<upper], as: UTF16.self)
  }

  /// `value.slice(start, end)`, negative offsets counting from the end.
  static func slice(_ value: String, _ start: Int, _ end: Int? = nil) -> String {
    let count = length(value)
    func resolve(_ offset: Int) -> Int { offset < 0 ? max(count + offset, 0) : min(offset, count) }
    return substring(value, resolve(start), end.map(resolve) ?? count)
  }

  /// `String.prototype.trim`.
  static func trim(_ value: String) -> String {
    trimEnd(trimStart(value))
  }

  /// `String.prototype.trimStart` (and `replace(/^\s+/u, '')`).
  static func trimStart(_ value: String) -> String {
    let units = value.utf16
    guard let first = units.firstIndex(where: { !isWhitespace($0) }) else { return "" }
    if first == units.startIndex { return value }
    return String(decoding: units[first...], as: UTF16.self)
  }

  /// `String.prototype.trimEnd`.
  static func trimEnd(_ value: String) -> String {
    let units = value.utf16
    guard let last = units.lastIndex(where: { !isWhitespace($0) }) else { return "" }
    let end = units.index(after: last)
    if end == units.endIndex { return value }
    return String(decoding: units[..<end], as: UTF16.self)
  }

  /// `===` on strings: code units, not canonical equivalence (Swift's `==` would
  /// call `"é"` and `"e\u{301}"` equal).
  static func same(_ lhs: String, _ rhs: String) -> Bool {
    lhs.utf16.elementsEqual(rhs.utf16)
  }

  /// `startsWith`, code unit for code unit.
  static func hasPrefix(_ value: String, _ prefix: String) -> Bool {
    value.utf16.starts(with: prefix.utf16)
  }

  /// `endsWith`, code unit for code unit.
  static func hasSuffix(_ value: String, _ suffix: String) -> Bool {
    value.utf16.reversed().starts(with: suffix.utf16.reversed())
  }

  /// `value.split(separator)` for a literal, non-empty separator.
  static func split(_ value: String, _ separator: String) -> [String] {
    let units = Array(value.utf16)
    let needle = Array(separator.utf16)
    precondition(!needle.isEmpty, "JS.split needs a separator")
    var out: [String] = []
    var start = 0
    var index = 0
    while index + needle.count <= units.count {
      if units[index..<(index + needle.count)].elementsEqual(needle) {
        out.append(String(decoding: units[start..<index], as: UTF16.self))
        index += needle.count
        start = index
      } else {
        index += 1
      }
    }
    out.append(String(decoding: units[start...], as: UTF16.self))
    return out
  }

  /// `toLowerCase()`. Foundation's root-locale lowering is the same full Unicode
  /// mapping JavaScript applies (final sigma included).
  static func lower(_ value: String) -> String {
    value.lowercased()
  }

  /// `toUpperCase()`.
  static func upper(_ value: String) -> String {
    value.uppercased()
  }

  /// `word.charAt(0).toUpperCase() + word.slice(1)` (and `word[0]!.toUpperCase() + …`).
  /// The first CODE UNIT is upper-cased; one half of a surrogate pair upper-cases to
  /// itself in JavaScript, so a word that opens with an astral character is unchanged.
  static func capitaliseFirstUnit(_ word: String) -> String {
    guard let first = word.utf16.first else { return word }
    if UTF16.isLeadSurrogate(first) || UTF16.isTrailSurrogate(first) { return word }
    return upper(String(decoding: [first], as: UTF16.self)) + substring(word, 1)
  }

  /// `String(number)` / a number in a template literal.
  static func string(_ number: Double) -> String {
    ECMAScriptNumber.string(number)
  }

  /// `Math.round`: halves go towards +∞, and a value a hair under a half stays
  /// down (`floor(x + 0.5)` would round `0.49999999999999994` up).
  static func round(_ value: Double) -> Double {
    guard value.isFinite else { return value }
    let floor = value.rounded(.down)
    return value - floor >= 0.5 ? floor + 1 : floor
  }

  /// The offset of the first line break `/\r?\n/` matches: the `\r` of a `\r\n`,
  /// else the `\n`; `-1` when there is none. A lone `\r` is not a break.
  static func searchLineBreak(_ value: String) -> Int {
    var previousWasCR = false
    for (offset, unit) in value.utf16.enumerated() {
      if unit == 0x0A { return previousWasCR ? offset - 1 : offset }
      previousWasCR = unit == 0x0D
    }
    return -1
  }

  /// `JSON.parse`, for the strings the engine reads a record out of. `nil` where
  /// JavaScript would throw.
  static func parseJSON(_ text: String) -> JSONValue? {
    try? JSONValue(parsing: text)
  }
}
