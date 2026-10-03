import CoreGraphics
import Foundation

/**
 The detail of a confirmation as the person reads it: the gateway's text, character for character,
 with the whitespace made visible, because text that looks harmless can hide what runs. A command
 followed by 300 spaces and a second command, or 80 blank lines before one, shows nothing wrong until
 it is read to its end. The same rules are in the web client (`markVerbatimDetail`).

 - A run of 2 to 6 spaces is that many `·`; a run of 7 or more is one `[␣×N]`; a single space stays.
 - A tab is `→`.
 - A run of 3 or more blank lines (empty, or only spaces and tabs) is one line `⋯ N empty lines ⋯`;
   one or two blank lines stay as they are.
 - A line ending `\r\n` is read as `\n`.

 `lines` and `longestLine` are of the original text (`longestLine` in Unicode scalars). What is
 copied is the original, never this text.
 */
struct ConfirmDetailMarkup: Equatable {
  /// What is drawn, and what VoiceOver reads.
  let text: String
  /// The number of lines of the original, split at `\n`.
  let lines: Int
  /// The most Unicode scalars on one line of the original.
  let longestLine: Int

  /// A run of this many spaces or more is one badge, not one dot each.
  static let badgeFrom = 7
  /// A run of this many blank lines or more is one marker.
  static let collapseFrom = 3

  /// `emptyLines`: the words for a collapsed run of blank lines, given how many (the app's own,
  /// localised: `NativeStrings.Confirm.emptyLines`).
  init(_ detail: String, emptyLines: (Int) -> String = { "\u{22EF} \($0) empty lines \u{22EF}" }) {
    let normalised = detail.replacingOccurrences(of: "\r\n", with: "\n")
    let original = normalised.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    lines = original.count
    longestLine = original.map { $0.unicodeScalars.count }.max() ?? 0

    var out: [String] = []
    var index = 0

    while index < original.count {
      guard Self.isBlank(original[index]) else {
        out.append(Self.mark(original[index]))
        index += 1
        continue
      }

      var end = index

      while end < original.count, Self.isBlank(original[end]) {
        end += 1
      }

      let run = end - index

      if run >= Self.collapseFrom {
        out.append(emptyLines(run))
      } else {
        out.append(contentsOf: original[index..<end].map(Self.mark))
      }

      index = end
    }

    text = out.joined(separator: "\n")
  }

  /// Empty, or only spaces and tabs.
  private static func isBlank(_ line: String) -> Bool {
    line.unicodeScalars.allSatisfy { $0 == " " || $0 == "\t" }
  }

  /// One line with its space runs and tabs made visible.
  private static func mark(_ line: String) -> String {
    var out = ""
    var run = 0

    func flush() {
      if run >= badgeFrom {
        out += "[\u{2423}\u{00D7}\(run)]"
      } else if run >= 2 {
        out += String(repeating: "\u{00B7}", count: run)
      } else if run == 1 {
        out += " "
      }

      run = 0
    }

    for scalar in line.unicodeScalars {
      switch scalar {
      case " ":
        run += 1
      case "\t":
        flush()
        out += "\u{2192}"
      default:
        flush()
        out.unicodeScalars.append(scalar)
      }
    }

    flush()
    return out
  }
}

/**
 How far the person has read a detail that does not fit: Confirm stays off until every direction in
 which it overflows has been scrolled to its end at least once. Once reached it stays reached.
 */
struct ConfirmDetailReview: Equatable {
  /// The first measurement has come in.
  private(set) var measured = false
  private(set) var overflowsHorizontally = false
  private(set) var overflowsVertically = false
  private(set) var reachedHorizontally = false
  private(set) var reachedVertically = false

  /// A pixel of slack for rounding.
  static let slack: CGFloat = 1

  /// The detail overflows its viewport in some direction.
  var overflows: Bool { overflowsHorizontally || overflowsVertically }

  /// Every overflowing direction has been scrolled to its end.
  var complete: Bool {
    measured && (!overflowsHorizontally || reachedHorizontally) && (!overflowsVertically || reachedVertically)
  }

  /// The sizes of the content and of the viewport it scrolls in.
  mutating func measure(content: CGSize, viewport: CGSize) {
    // Both sizes come in on their own; until both are known there is nothing to compare.
    guard content.width > 0, content.height > 0, viewport.width > 0, viewport.height > 0 else { return }
    measured = true
    overflowsHorizontally = content.width > viewport.width + Self.slack
    overflowsVertically = content.height > viewport.height + Self.slack
  }

  /// The part of the content that is in view.
  mutating func see(visible: CGRect, content: CGSize) {
    // Only an axis that overflows has an end to reach, and only once it is measured.
    guard measured else { return }
    if overflowsHorizontally, visible.maxX >= content.width - Self.slack { reachedHorizontally = true }
    if overflowsVertically, visible.maxY >= content.height - Self.slack { reachedVertically = true }
  }
}
