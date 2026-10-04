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
 - Every other character that draws nothing, or moves text without being seen, is shown by its code
   point: `[U+200B]`, and a run of the same one `[U+00A0×300]`. These are the control characters
   other than tab and `\n` (a lone `\r`, escape, form feed), the format characters (zero-width ones,
   the byte order mark, the direction overrides and isolates), every space separator but the plain
   space (no-break, ideographic and the other widths), the line and paragraph separators, and the
   blank letters (the Hangul fillers, the blank Braille pattern). The same goes for every
   default-ignorable code point (the variation selectors, the combining grapheme joiner, the
   Mongolian and Khmer invisibles, the tag characters), every unassigned code point (noncharacters
   included) and U+1D159, the musical null notehead. So a line break that is not `\n` stays on its
   line, and text cannot be reordered or hidden by what it does not draw.

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

  /// One line with its space runs, tabs and hidden characters made visible.
  private static func mark(_ line: String) -> String {
    var out = ""
    var run = 0
    var hidden: (scalar: Unicode.Scalar, count: Int)?

    func flushSpaces() {
      if run >= badgeFrom {
        out += "[\u{2423}\u{00D7}\(run)]"
      } else if run >= 2 {
        out += String(repeating: "\u{00B7}", count: run)
      } else if run == 1 {
        out += " "
      }

      run = 0
    }

    func flushHidden() {
      guard let (scalar, count) = hidden else { return }
      out += count == 1 ? "[\(codePoint(scalar))]" : "[\(codePoint(scalar))\u{00D7}\(count)]"
      hidden = nil
    }

    for scalar in line.unicodeScalars {
      if scalar == " " {
        flushHidden()
        run += 1
      } else if scalar == "\t" {
        flushSpaces()
        flushHidden()
        out += "\u{2192}"
      } else if isHidden(scalar) {
        flushSpaces()

        if let current = hidden, current.scalar == scalar {
          hidden = (scalar, current.count + 1)
        } else {
          flushHidden()
          hidden = (scalar, 1)
        }
      } else {
        flushSpaces()
        flushHidden()
        out.unicodeScalars.append(scalar)
      }
    }

    flushSpaces()
    flushHidden()
    return out
  }

  /// Drawn as nothing though no class says so: the blank letters, the blank Braille pattern and the
  /// musical null notehead (U+1D159).
  private static let blankLetters: Set<UInt32> = [0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x1D159]

  /// Draws nothing, or moves text unseen (see the type's comment). Never tab, `\n` or the plain space.
  /// The web client's `HIDDEN_RUN` is the same rule, over the same sample strings.
  static func isHidden(_ scalar: Unicode.Scalar) -> Bool {
    if scalar == "\t" || scalar == "\n" || scalar == " " {
      return false
    }

    if scalar.properties.isDefaultIgnorableCodePoint || blankLetters.contains(scalar.value) {
      return true
    }

    switch scalar.properties.generalCategory {
    case .control, .format, .unassigned, .spaceSeparator, .lineSeparator, .paragraphSeparator:
      return true
    default:
      return false
    }
  }

  /// `U+00A0`: at least four hex digits, upper case.
  private static func codePoint(_ scalar: Unicode.Scalar) -> String {
    let hex = String(scalar.value, radix: 16, uppercase: true)
    return "U+" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
  }
}

/**
 How far the person has read a detail: Confirm stays off until the detail's frame has been wholly in
 view of the sheet's scrolling text, and, while it was, every direction in which the detail overflows
 has been scrolled to its end at least once. A detail that is partly below the sheet's fold (a phone
 on its side, large text) has lines nobody has seen, however far its own box was scrolled. Once reached
 it stays reached.
 */
struct ConfirmDetailReview: Equatable {
  /// The first measurement has come in.
  private(set) var measured = false
  private(set) var overflowsHorizontally = false
  private(set) var overflowsVertically = false
  private(set) var reachedHorizontally = false
  private(set) var reachedVertically = false
  /// The detail's frame is wholly in view of the sheet's scrolling text right now.
  private(set) var inView = false
  /// It has been, at some moment after it was measured.
  private(set) var framed = false
  /// The detail's box is scrolled to its right or bottom end right now.
  private var atEndHorizontally = false
  private var atEndVertically = false

  /// A pixel of slack for rounding.
  static let slack: CGFloat = 1

  /// The detail overflows its viewport in some direction.
  var overflows: Bool { overflowsHorizontally || overflowsVertically }

  /// The frame has been wholly in view, and every overflowing direction has been scrolled to its end
  /// while it was.
  var complete: Bool {
    measured && framed && (!overflowsHorizontally || reachedHorizontally) && (!overflowsVertically || reachedVertically)
  }

  /// The sizes of the content and of the viewport it scrolls in.
  mutating func measure(content: CGSize, viewport: CGSize) {
    // Both sizes come in on their own; until both are known there is nothing to compare.
    guard content.width > 0, content.height > 0, viewport.width > 0, viewport.height > 0 else { return }
    measured = true
    overflowsHorizontally = content.width > viewport.width + Self.slack
    overflowsVertically = content.height > viewport.height + Self.slack
    settle()
  }

  /// The part of the content that is in view.
  mutating func see(visible: CGRect, content: CGSize) {
    atEndHorizontally = visible.maxX >= content.width - Self.slack
    atEndVertically = visible.maxY >= content.height - Self.slack
    settle()
  }

  /// Whether the detail's frame is wholly in view of the sheet's scrolling text (`isWhollyIn`).
  mutating func place(inView: Bool) {
    self.inView = inView
    settle()
  }

  /// `frame` lies wholly inside `window`, as far as the sheet scrolls: up and down. The scrolling text
  /// has no sideways scroll, and its width is the sheet's.
  static func isWhollyIn(frame: CGRect, window: CGRect) -> Bool {
    guard !frame.isEmpty, !window.isEmpty else { return false }
    return frame.minY >= window.minY - slack && frame.maxY <= window.maxY + slack
  }

  /// An end only counts while the whole frame is in view; once counted it stays.
  private mutating func settle() {
    // Only an axis that overflows has an end to reach, and only once it is measured.
    guard measured, inView else { return }
    framed = true
    if overflowsHorizontally, atEndHorizontally { reachedHorizontally = true }
    if overflowsVertically, atEndVertically { reachedVertically = true }
  }
}

/// Whether the structured fields of a confirmation have been in view of the sheet's scrolling text:
/// the facts the person is confirming. Confirm waits for it as it waits for the detail. The fields' frame
/// may be taller than the window (large text, a phone on its side), so it counts once its top edge and
/// its bottom edge have each been in view; once seen it stays seen.
struct ConfirmFieldsReview: Equatable {
  private(set) var topSeen = false
  private(set) var bottomSeen = false

  /// Both ends have been in view.
  var complete: Bool { topSeen && bottomSeen }

  /// The fields' `frame` and the `window` of the scrolling text, in one coordinate space.
  mutating func see(frame: CGRect, window: CGRect) {
    guard !frame.isEmpty, !window.isEmpty else { return }
    let slack = ConfirmDetailReview.slack
    let within = { (y: CGFloat) in y >= window.minY - slack && y <= window.maxY + slack }

    if within(frame.minY) { topSeen = true }
    if within(frame.maxY) { bottomSeen = true }
  }
}

/// How tall the detail's own box may be. The box scrolls inside the sheet's scrolling text, and Confirm
/// waits for its whole frame to be in view of that text, so a box taller than the text's window could
/// never be wholly in view (a phone on its side, large text): it is held to the window's height and
/// stays scrollable inside it.
enum ConfirmDetailLayout {
  /// `preferred`: the box's height at the current text size. `window`: the height the sheet's
  /// scrolling text has (`0` until it is known).
  static func viewportHeight(preferred: CGFloat, window: CGFloat) -> CGFloat {
    guard window > 0 else { return preferred }
    return min(preferred, window)
  }
}
