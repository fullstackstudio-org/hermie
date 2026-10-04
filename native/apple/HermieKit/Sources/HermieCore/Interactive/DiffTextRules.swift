import Foundation

/// The rules a line of a diff, a hunk header and the file's paths are held to before this app shows them
/// (`contract/requests/README.md` §7.1): the characters of §6.2 with the tab allowed, no whitespace at the
/// end, and the layout limits of a diff, counted in COLUMNS (a space is one column, a tab runs to the next
/// multiple of 8, everything else is one).
///
/// The gateway refuses to build a request holding a line that breaks them, so a frame that does is not
/// one the gateway sent. This app does not show it: a review exists to show exactly what would be written,
/// and a hidden character or a screenful of padding would be the way to hide something from it.
public enum DiffTextRules {
  /// A tab runs to the next multiple of this many columns.
  public static let tabStop = 8
  /// Columns of spaces and tabs that start a line.
  public static let maxIndent = 96
  /// Columns of any other run of spaces and tabs.
  public static let maxSpaceRun = 32
  /// Columns of all the spaces and tabs of a line together, the indent included.
  public static let maxWhitespace = 160
  /// Combining marks (`Mn`, `Me`) in a row.
  public static let maxCombiningMarks = DraftText.maxCombiningMarks
  /// Code points of a line, its marker included.
  public static let maxLineChars = 500
  /// Code points of a hunk header.
  public static let maxHeaderChars = 200
  /// Code points of a path.
  public static let maxPathChars = 300

  private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
    let category = scalar.properties.generalCategory
    return category == .nonspacingMark || category == .enclosingMark
  }

  /// The column after `scalar` when it starts at `column`.
  static func advance(_ column: Int, over scalar: Unicode.Scalar) -> Int {
    scalar == "\t" ? (column / tabStop + 1) * tabStop : column + 1
  }

  /// The width of `text` in columns, tabs at their stops. For a text that has passed `isShowable`.
  public static func columns(of text: String) -> Int {
    text.unicodeScalars.reduce(0) { advance($0, over: $1) }
  }

  /// Whether `text` (one line: a hunk line without its marker, or a header) may be shown as it is.
  ///
  /// - characters: no line break of any kind, no control, format, surrogate, private-use or unassigned
  ///   character, no whitespace other than the space and the tab, no invisible letter, no
  ///   default-ignorable code point;
  /// - no more than `maxCombiningMarks` combining marks in a row, and none at the start or right after
  ///   a space or a tab;
  /// - no whitespace at the end;
  /// - the indent up to `maxIndent` columns, any other run up to `maxSpaceRun`, all of it together up
  ///   to `maxWhitespace`.
  public static func isShowable(_ text: String) -> Bool {
    var column = 0
    var marks = 0
    var afterBlank = true
    var runStart: Int?
    var total = 0

    func closeRun(at end: Int) -> Bool {
      guard let start = runStart else { return true }

      let width = end - start
      runStart = nil
      total += width

      return width <= (start == 0 ? maxIndent : maxSpaceRun) && total <= maxWhitespace
    }

    for scalar in text.unicodeScalars {
      if scalar == " " || scalar == "\t" {
        if runStart == nil {
          runStart = column
        }

        column = advance(column, over: scalar)
        marks = 0
        afterBlank = true
        continue
      }

      guard closeRun(at: column) else { return false }

      if scalar == "\n" || DraftText.isNotVerbatim(scalar) {
        return false
      }

      if isMark(scalar) {
        marks += 1

        if afterBlank || marks > maxCombiningMarks {
          return false
        }
      } else {
        marks = 0
      }

      afterBlank = false
      column += 1
    }

    // Whitespace at the end is refused, not trimmed: a change that only adds or removes it would be
    // invisible.
    return runStart == nil
  }

  /// Whether `text` is one line of display text (a path): no line break of any kind. Other characters
  /// are shown as visible codes (`DraftText.reveal`), not refused.
  public static func isOneLine(_ text: String) -> Bool {
    !text.unicodeScalars.contains { scalar in
      switch scalar.value {
      case 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029: true
      default: false
      }
    }
  }

  // MARK: Rendering

  /// A tab is shown as this marker, followed by the spaces that bring the text to the tab's stop.
  public static let tabMarker: Character = "\u{2192}"

  /// `text` as it is drawn in a monospaced row: every tab is the marker and the spaces up to its
  /// stop of 8 columns, so a tab is never hidden, collapsed or turned into another number of spaces
  /// (§7.1), and the text after it starts where it would in an editor with that stop.
  public static func rendered(_ text: String) -> String {
    pieces(text).map { piece in
      switch piece {
      case .text(let text): text
      case .tab(let width): String(tabMarker) + String(repeating: " ", count: max(0, width - 1))
      }
    }.joined()
  }

  /// A run of the line: text as it is, or a tab and the columns it spans.
  public enum Piece: Sendable, Equatable {
    case text(String)
    case tab(width: Int)
  }

  /// `text` split at its tabs.
  public static func pieces(_ text: String) -> [Piece] {
    var pieces: [Piece] = []
    var current = String.UnicodeScalarView()
    var column = 0

    for scalar in text.unicodeScalars {
      if scalar == "\t" {
        if !current.isEmpty {
          pieces.append(.text(String(current)))
          current = String.UnicodeScalarView()
        }

        let next = advance(column, over: scalar)
        pieces.append(.tab(width: next - column))
        column = next
      } else {
        current.append(scalar)
        column += 1
      }
    }

    if !current.isEmpty {
      pieces.append(.text(String(current)))
    }

    return pieces
  }
}
