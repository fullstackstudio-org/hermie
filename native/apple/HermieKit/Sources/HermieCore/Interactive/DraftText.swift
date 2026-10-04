import Foundation

/// The text of a draft the person has to be able to see exactly as it is, by the rules the gateway
/// holds an approved text to (`verbatim_problem` and `layout_problem` in the fork's
/// `tui_gateway/request_text.py`, contract §6): characters that do not show as themselves, runs of
/// combining marks, and spacing that could push part of the text out of view. The gateway first
/// removes the whitespace at the end of every line and of the text, then refuses what is left; this
/// is the same check on the client's side (§6.5: exactly the same set, never more lenient), so the
/// sheet can say which rule is broken and where, and show the characters as visible codes. Nothing
/// is rewritten: the person corrects the text.
public enum DraftText {
  /// At most this many combining marks (`Mn`, `Me`) on one character.
  public static let maxCombiningMarks = 4
  /// Spaces in a row after a line's first non-space character.
  public static let maxSpaceRun = 16
  /// Spaces at the start of a line.
  public static let maxIndent = 32
  /// Empty lines in a row.
  public static let maxBlankLines = 3
  /// Characters (code points) on one line.
  public static let maxLineChars = 2_000

  /// A character that does not show as itself, and how often the text holds it.
  public struct Hidden: Sendable, Equatable, Identifiable {
    public var scalar: Unicode.Scalar
    public var count: Int
    public var id: UInt32 { scalar.value }

    /// `U+202E`.
    public var code: String {
      String(format: "U+%04X", scalar.value)
    }
  }

  /// A rule an approved text breaks. A line is counted from 1.
  public enum Problem: Sendable, Equatable {
    /// Nothing is left of the text once the gateway has stripped it.
    case empty
    /// Characters that cannot be shown as they are (controls, tabs, format and bidi characters,
    /// line separators, spaces other than the plain one, zero-width and other default-ignorable
    /// characters, invisible letters, unassigned code points).
    case characters([Hidden])
    /// More than `maxCombiningMarks` combining marks on one character.
    case combiningMarks
    /// More than `maxBlankLines` empty lines in a row, from `line`.
    case blankLines(line: Int)
    /// More than `maxLineChars` characters on `line`.
    case lineTooLong(line: Int)
    /// More than `maxIndent` spaces at the start of `line`.
    case indent(line: Int)
    /// More than `maxSpaceRun` spaces in a row on `line`.
    case spaceRun(line: Int)
  }

  // MARK: Characters

  /// Letters and symbols that render as nothing: the Hangul fillers, the blank Braille pattern, the
  /// musical null notehead and the Khitan small script filler (contract/requests §6.2, item 4).
  private static let invisibleLetters: Set<UInt32> = [0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x1D159, 0x16FE4]

  /// `Default_Ignorable_Code_Point` as the gateway copies it from `DerivedCoreProperties.txt`.
  private static let defaultIgnorable: [ClosedRange<UInt32>] = [
    0x00AD...0x00AD, 0x034F...0x034F, 0x061C...0x061C, 0x115F...0x1160, 0x17B4...0x17B5, 0x180B...0x180F,
    0x200B...0x200F, 0x202A...0x202E, 0x2060...0x206F, 0x3164...0x3164, 0xFE00...0xFE0F, 0xFEFF...0xFEFF,
    0xFFA0...0xFFA0, 0xFFF0...0xFFF8, 0x1BCA0...0x1BCA3, 0x1D173...0x1D17A, 0xE0000...0xE0FFF
  ]

  static func isDefaultIgnorable(_ scalar: Unicode.Scalar) -> Bool {
    defaultIgnorable.contains { $0.contains(scalar.value) }
  }

  /// Python's `str.isspace()`: the Unicode white space and the four information separators.
  static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
    scalar.properties.isWhitespace || (0x1C...0x1F).contains(scalar.value)
  }

  private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
    scalar.properties.generalCategory == .nonspacingMark || scalar.properties.generalCategory == .enclosingMark
  }

  /// A character the gateway refuses in an approved text on its own: unassigned or default-ignorable,
  /// or (but for a line feed and the plain space) a control, format, surrogate, private-use, line or
  /// paragraph separator, any other space, or an invisible letter. Combining marks are judged in
  /// runs, not here (`Problem.combiningMarks`), unless they are default-ignorable (U+FE0F, U+034F).
  public static func isNotVerbatim(_ scalar: Unicode.Scalar) -> Bool {
    let category = scalar.properties.generalCategory

    if category == .unassigned || isDefaultIgnorable(scalar) {
      return true
    }

    if scalar == "\n" || scalar == " " {
      return false
    }

    switch category {
    case .control, .format, .surrogate, .privateUse, .lineSeparator, .paragraphSeparator, .spaceSeparator:
      return true
    default:
      return invisibleLetters.contains(scalar.value) || isSpace(scalar)
    }
  }

  /// A character shown as a visible code in a draft: every one the gateway refuses, a line feed
  /// excepted.
  public static func isRevealed(_ scalar: Unicode.Scalar) -> Bool {
    scalar != "\n" && isNotVerbatim(scalar)
  }

  /// The text with every revealed character replaced by its code in angle brackets,
  /// `a⟨U+202E⟩b`. Line feeds and plain spaces stay.
  public static func reveal(_ text: String) -> String {
    guard text.unicodeScalars.contains(where: isRevealed) else {
      return text
    }

    var out = String.UnicodeScalarView()

    for scalar in text.unicodeScalars {
      if isRevealed(scalar) {
        out.append(contentsOf: String(format: "\u{27E8}U+%04X\u{27E9}", scalar.value).unicodeScalars)
      } else {
        out.append(scalar)
      }
    }

    return String(out)
  }

  /// The revealed characters of a text, once each with its count, in the order they first appear.
  public static func hidden(in text: String) -> [Hidden] {
    var found: [Hidden] = []

    for scalar in text.unicodeScalars where isRevealed(scalar) {
      if let index = found.firstIndex(where: { $0.scalar == scalar }) {
        found[index].count += 1
      } else {
        found.append(Hidden(scalar: scalar, count: 1))
      }
    }

    return found
  }

  // MARK: Trimming

  /// What the gateway makes of an approved text before it judges it: it is split on LF only, the
  /// whitespace at the end of every line is removed, and then at the end of the whole text (so
  /// trailing blank lines go). Counted in code points, as the gateway counts: a CR LF is two
  /// characters here, though Swift reads them as one.
  public static func gatewayTrimmed(_ text: String) -> String {
    string(from: trimmed(lines(of: text)))
  }

  private static func lines(of text: String) -> [[Unicode.Scalar]] {
    var lines: [[Unicode.Scalar]] = [[]]

    for scalar in text.unicodeScalars {
      if scalar == "\n" {
        lines.append([])
      } else {
        lines[lines.count - 1].append(scalar)
      }
    }

    return lines
  }

  private static func string(from lines: [[Unicode.Scalar]]) -> String {
    var view = String.UnicodeScalarView()

    for (index, line) in lines.enumerated() {
      if index > 0 {
        view.append("\n")
      }

      view.append(contentsOf: line)
    }

    return String(view)
  }

  private static func rstrip(_ scalars: [Unicode.Scalar]) -> [Unicode.Scalar] {
    var scalars = scalars

    while let last = scalars.last, isSpace(last) {
      scalars.removeLast()
    }

    return scalars
  }

  /// Every line without its trailing whitespace, and the text without trailing whitespace, which
  /// takes the blank lines at its end.
  private static func trimmed(_ lines: [[Unicode.Scalar]]) -> [[Unicode.Scalar]] {
    var lines = lines.map(rstrip)

    // Whitespace at the end of the whole text is whole blank lines (each already empty).
    while lines.count > 1, lines.last?.isEmpty == true {
      lines.removeLast()
    }

    return lines
  }

  // MARK: The rules

  /// Every rule the text breaks once the gateway has trimmed it, each once (a line is the first
  /// where it happens); empty when the gateway takes it.
  public static func problems(in text: String) -> [Problem] {
    let lines = trimmed(lines(of: text))
    var problems: [Problem] = []

    if lines.allSatisfy({ $0.isEmpty }) {
      return [.empty]
    }

    // Characters, and the runs of combining marks.
    var hidden: [Hidden] = []
    var marks = 0
    var tooManyMarks = false

    for line in lines {
      for scalar in line {
        if isNotVerbatim(scalar) {
          if let at = hidden.firstIndex(where: { $0.scalar == scalar }) {
            hidden[at].count += 1
          } else {
            hidden.append(Hidden(scalar: scalar, count: 1))
          }

          continue
        }

        if isMark(scalar) {
          marks += 1
          tooManyMarks = tooManyMarks || marks > maxCombiningMarks
          continue
        }

        marks = 0
      }

      // A line feed is not a mark: the run ends with the line.
      marks = 0
    }

    if !hidden.isEmpty {
      problems.append(.characters(hidden))
    }

    if tooManyMarks {
      problems.append(.combiningMarks)
    }

    // Layout, on the lines as the gateway sees them.
    var blank = 0
    var reported: Set<Int> = []

    func report(_ kind: Int, _ problem: Problem) {
      if reported.insert(kind).inserted {
        problems.append(problem)
      }
    }

    for (index, line) in lines.enumerated() {
      let number = index + 1

      if line.allSatisfy({ $0 == " " }) {
        blank += 1

        if blank > maxBlankLines {
          report(0, .blankLines(line: number - blank + 1))
        }

        continue
      }

      blank = 0

      if line.count > maxLineChars {
        report(1, .lineTooLong(line: number))
      }

      let indent = line.prefix { $0 == " " }.count

      if indent > maxIndent {
        report(2, .indent(line: number))
      }

      var run = 0

      for scalar in line.dropFirst(indent) {
        if scalar == " " {
          run += 1

          if run > maxSpaceRun {
            report(3, .spaceRun(line: number))
          }
        } else {
          run = 0
        }
      }
    }

    return problems
  }

  /// The text the gateway would refuse, as characters only (kept for the code list under a draft).
  public static func refused(in text: String) -> [Hidden] {
    for problem in problems(in: text) {
      if case .characters(let found) = problem {
        return found
      }
    }

    return []
  }
}
