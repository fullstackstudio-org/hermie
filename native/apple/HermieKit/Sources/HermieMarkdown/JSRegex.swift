import Foundation

// The preprocessing rules are a port of TypeScript written against JavaScript
// regular expressions. These helpers give `NSRegularExpression` the JavaScript
// behaviour those rules rely on: offsets in UTF-16 code units, `replace` with a
// callback over every match, and `split` that keeps captured groups.
//
// One difference is handled in the patterns rather than here: without the `m`
// flag JavaScript's `$` matches only at the very end, while ICU's also matches
// before a final line break, so the ported patterns write `\z` where the
// TypeScript wrote `$`.

struct JSRegex: @unchecked Sendable {
  // NSRegularExpression is immutable and documented as thread-safe.
  let regex: NSRegularExpression

  init(_ pattern: String, caseInsensitive: Bool = false) {
    do {
      regex = try NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    } catch {
      preconditionFailure("invalid pattern \(pattern): \(error)")
    }
  }

  /// One match: the whole match and each group (`nil` when it did not take part).
  struct Match {
    let groups: [String?]
    let range: NSRange

    subscript(index: Int) -> String? { groups[index] }
  }

  private func makeMatch(_ result: NSTextCheckingResult, in string: NSString) -> Match {
    let groups = (0..<result.numberOfRanges).map { index -> String? in
      let range = result.range(at: index)
      return range.location == NSNotFound ? nil : string.substring(with: range)
    }
    return Match(groups: groups, range: result.range)
  }

  /// `regex.test(string)`.
  func test(_ string: String) -> Bool {
    let ns = string as NSString
    return regex.firstMatch(in: string, range: NSRange(location: 0, length: ns.length)) != nil
  }

  /// `regex.exec(string)` from the start.
  func firstMatch(_ string: String) -> Match? {
    let ns = string as NSString
    guard let result = regex.firstMatch(in: string, range: NSRange(location: 0, length: ns.length)) else {
      return nil
    }
    return makeMatch(result, in: ns)
  }

  /// Every match, in order.
  func matches(_ string: String) -> [Match] {
    let ns = string as NSString
    return regex.matches(in: string, range: NSRange(location: 0, length: ns.length)).map { makeMatch($0, in: ns) }
  }

  /// `string.replace(/…/g, (match, ...groups, offset, whole) => …)`.
  func replace(_ string: String, _ transform: (Match, NSString) -> String) -> String {
    let ns = string as NSString
    let results = regex.matches(in: string, range: NSRange(location: 0, length: ns.length))
    guard !results.isEmpty else { return string }
    var out = ""
    var cursor = 0
    for result in results {
      out += ns.substring(with: NSRange(location: cursor, length: result.range.location - cursor))
      out += transform(makeMatch(result, in: ns), ns)
      cursor = result.range.location + result.range.length
    }
    out += ns.substring(from: cursor)
    return out
  }

  /// `string.replace(/…/g, template)` for a constant replacement.
  func replace(_ string: String, with replacement: String) -> String {
    replace(string) { _, _ in replacement }
  }

  /// `string.split(/(…)/)`: the pieces between matches, with every captured
  /// group spliced in between them (a group that did not take part is `""`).
  /// None of the ported patterns can match the empty string.
  func split(_ string: String) -> [String] {
    let ns = string as NSString
    var out: [String] = []
    var cursor = 0
    for result in regex.matches(in: string, range: NSRange(location: 0, length: ns.length)) {
      out.append(ns.substring(with: NSRange(location: cursor, length: result.range.location - cursor)))
      for index in 1..<max(1, result.numberOfRanges) {
        let range = result.range(at: index)
        out.append(range.location == NSNotFound ? "" : ns.substring(with: range))
      }
      cursor = result.range.location + result.range.length
    }
    out.append(ns.substring(from: cursor))
    return out
  }
}

extension String {
  /// JavaScript's `String.prototype.trim()`.
  var jsTrimmed: String {
    trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
  }

  /// Whether `trim()` would leave anything.
  var hasNonSpace: Bool {
    !jsTrimmed.isEmpty
  }

  /// The length JavaScript reports: UTF-16 code units.
  var jsLength: Int {
    utf16.count
  }
}

/// JavaScript's `/\s/.test(c)` for one UTF-16 code unit.
func jsIsSpace(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
    return true
  case 0x2000...0x200A:
    return true
  default:
    return false
  }
}
