import Foundation

/// A JavaScript regular expression, run on ICU through `NSRegularExpression`.
///
/// ICU is the closest engine Foundation has: it is a backtracking engine with the
/// same leftmost, ordered-alternative semantics, and it reports UTF-16 offsets, as
/// JavaScript does. It still differs from ECMAScript in a handful of places, so no
/// JavaScript pattern is used verbatim. Every pattern in this target is rewritten
/// by hand with the pieces of `JSPattern`, and the TypeScript original is quoted
/// beside it. The differences that matter:
///
/// - `\s` / `\S`: ICU's set is `[\t\n\f\r\p{Z}]`; JavaScript's also has U+000B and
///   U+FEFF. Use `JSPattern.s` / `JSPattern.S`.
/// - `\d` and `\w` are Unicode-wide in ICU and ASCII in JavaScript. Write `[0-9]` and
///   `[A-Za-z0-9_]`.
/// - `\b` is a Unicode word boundary in ICU. Use `JSPattern.b`.
/// - `$` without the `m` flag: JavaScript matches only at the very end; ICU also
///   matches before a final line terminator. Use `JSPattern.end`.
/// - `.` excludes U+000B, U+000C and U+0085 in ICU and not in JavaScript. Avoid `.`.
/// - Inside a set ICU gives `[`, `&`, `-` and `(` meanings JavaScript does not;
///   escape them.
struct JSRegExp: @unchecked Sendable {
  // `NSRegularExpression` is an immutable class that Foundation documents as safe to
  // use from several threads at once; nothing here mutates it after `init`.
  private let regex: NSRegularExpression

  /// `pattern` is ICU syntax, already rewritten from the JavaScript original.
  init(_ pattern: String, ignoreCase: Bool = false) {
    do {
      regex = try NSRegularExpression(pattern: pattern, options: ignoreCase ? [.caseInsensitive] : [])
    } catch {
      preconditionFailure("Invalid regular expression \(pattern): \(error)")
    }
  }

  /// `re.exec(value)` (without the `g` flag): the first match, or `nil`.
  func exec(_ value: String) -> JSMatch? {
    let text = value as NSString
    guard let result = regex.firstMatch(in: value, options: [], range: NSRange(location: 0, length: text.length))
    else { return nil }
    var groups: [String?] = []
    groups.reserveCapacity(result.numberOfRanges)
    for index in 0..<result.numberOfRanges {
      let range = result.range(at: index)
      groups.append(range.location == NSNotFound ? nil : text.substring(with: range))
    }
    return JSMatch(index: result.range.location, length: result.range.length, groups: groups)
  }

  /// `re.test(value)`.
  func test(_ value: String) -> Bool {
    regex.firstMatch(in: value, options: [], range: NSRange(location: 0, length: (value as NSString).length)) != nil
  }

  /// `value.search(re)`: the UTF-16 offset of the first match, or `-1`.
  func search(_ value: String) -> Int {
    exec(value)?.index ?? -1
  }

  /// `value.split(re)` for a pattern without capture groups that never matches empty.
  func split(_ value: String) -> [String] {
    let text = value as NSString
    var out: [String] = []
    var start = 0
    for result in regex.matches(in: value, options: [], range: NSRange(location: 0, length: text.length)) {
      out.append(text.substring(with: NSRange(location: start, length: result.range.location - start)))
      start = result.range.location + result.range.length
    }
    out.append(text.substring(from: start))
    return out
  }

  /// `value.replace(re, literal)`: the first match only (no `g` flag).
  func replaceFirst(in value: String, with literal: String) -> String {
    guard let match = exec(value) else { return value }
    return JS.substring(value, 0, match.index) + literal + JS.substring(value, match.index + match.length)
  }

  /// `value.replace(re, literal)` with the `g` flag.
  func replaceAll(in value: String, with literal: String) -> String {
    let text = value as NSString
    return regex.stringByReplacingMatches(
      in: value,
      options: [],
      range: NSRange(location: 0, length: text.length),
      withTemplate: NSRegularExpression.escapedTemplate(for: literal)
    )
  }

  /// `[...value.matchAll(re)].map(match => match[0])` for a global pattern that never
  /// matches empty.
  ///
  /// One pass over the whole string: each search resumes where the last match
  /// ended, as a global expression's `lastIndex` does, and sees the text before it
  /// as `matchAll` does. Searching a copy of the rest after every match would cost
  /// the length of the text per match.
  func allMatches(in value: String) -> [String] {
    let text = value as NSString
    return regex.matches(in: value, options: [], range: NSRange(location: 0, length: text.length))
      .prefix { $0.range.length > 0 }
      .map { text.substring(with: $0.range) }
  }
}

/// One `exec` result: offsets in UTF-16 code units, `groups[0]` the whole match, a
/// group that did not take part `nil` (`undefined`).
struct JSMatch: Sendable {
  let index: Int
  let length: Int
  let groups: [String?]

  subscript(group: Int) -> String? {
    groups.indices.contains(group) ? groups[group] : nil
  }
}

/// The ICU spellings of the JavaScript constructs that ICU reads differently.
enum JSPattern {
  /// The body of a set matching what JavaScript's `\s` matches.
  static let spaceSet = #"\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
  /// JavaScript's `\s`.
  static let s = "[\(spaceSet)]"
  /// JavaScript's `\S`.
  static let S = "[^\(spaceSet)]"
  /// JavaScript's `\b`: a change between an ASCII word character and anything else.
  /// (Under the `i` flag ICU closes the set over case, which adds U+017F and U+212A —
  /// exactly what JavaScript's `/iu` word characters add.)
  static let b = #"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"#
  /// JavaScript's `$` without the `m` flag: the very end of the input.
  static let end = #"\z"#
}
