import Foundation

/// What a scanned code says, as the person sees it before they send it and as the gateway hands it to the
/// agent (`contract/requests/README.md` §12).
///
/// A decoded code is UNTRUSTED text: a QR code can hold a link, a command, a hidden character that
/// reorders what is shown. The client never opens it, shows it as plain text, and shows it CLEANED the
/// way the gateway cleans it, so what the person read is what the agent receives. Nothing is trimmed or
/// collapsed: `WIFI:T:WPA;S:my  net;;` stays as it is.
public enum ScanValue {
  /// The most a result's `value` may hold, in code points.
  public static let maxLength = 4_096
  /// More combining marks than this on one character are dropped (`MAX_COMBINING_MARKS` of §6.2).
  static let maxCombiningMarks = 4

  /// Why a cleaned value cannot be sent.
  public enum Problem: Sendable, Equatable {
    /// Nothing visible is left of it once cleaned (`scan:empty`).
    case empty
    /// More than `maxLength` code points: refused by the gateway (`bad_shape`), never cut.
    case tooLong(count: Int)
  }

  /// A code's text as the gateway cleans it: control characters other than a line break (a tab becomes a
  /// space), format characters (bidi overrides and isolates, zero width), surrogates, private-use,
  /// unassigned, default-ignorable and invisible code points go, combining marks past four on one
  /// character go, line and paragraph separators become line breaks, and every other space becomes a plain
  /// one.
  public static func clean(_ raw: String) -> String {
    var out = String.UnicodeScalarView()
    var marks = 0
    var previousWasCarriageReturn = false

    for scalar in raw.unicodeScalars {
      // A CR LF pair, and a lone CR, are one line break.
      if scalar == "\n", previousWasCarriageReturn {
        previousWasCarriageReturn = false
        continue
      }

      previousWasCarriageReturn = scalar == "\r"
      let character: Unicode.Scalar = scalar == "\r" ? "\n" : scalar
      let category = character.properties.generalCategory
      let combining = category == .nonspacingMark || category == .enclosingMark

      if DraftText.invisibleLetters.contains(character.value) || DraftText.isDefaultIgnorable(character) {
        marks = combining ? marks : 0
        continue
      }

      if combining {
        marks += 1

        if marks <= maxCombiningMarks {
          out.append(character)
        }

        continue
      }

      marks = 0

      switch category {
      case .lineSeparator, .paragraphSeparator:
        out.append("\n")
      case .spaceSeparator:
        out.append(" ")
      case .control:
        // The tab becomes a space and a line feed stays; every other control character goes.
        if character == "\t" {
          out.append(" ")
        } else if character == "\n" {
          out.append("\n")
        }
      case .format, .surrogate, .privateUse, .unassigned:
        continue
      default:
        out.append(character)
      }
    }

    return String(out)
  }

  /// Whether there is anything visible in a cleaned value: a space or a line break alone is not.
  public static func hasVisibleContent(_ cleaned: String) -> Bool {
    cleaned.unicodeScalars.contains { $0 != " " && $0 != "\n" }
  }

  /// What stops `cleaned` (a value already through `clean(_:)`) from being sent, or nil.
  public static func problem(in cleaned: String) -> Problem? {
    let count = cleaned.unicodeScalars.count

    if count > maxLength {
      return .tooLong(count: count)
    }

    return hasVisibleContent(cleaned) ? nil : .empty
  }
}
