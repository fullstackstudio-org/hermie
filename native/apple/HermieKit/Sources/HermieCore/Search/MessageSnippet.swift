import Foundation

/// A hit's snippet as something that can be drawn: the gateway's text, tidied, split at what the index
/// matched, and cleaned of anything that could reorder or hide characters on screen.
///
/// Everything here is the gateway's text, so it is only ever drawn as characters (`Text(verbatim:)`, an
/// attributed string built run by run): never Markdown, never links.
public enum MessageSnippet {
  /// The longest run drawn, in UTF-16 units; the gateway's whole snippet is about forty tokens.
  public static let runLimit = 400

  /// The runs of `snippet` to draw, plain and matched in order. Runs left empty by the cleaning are dropped.
  public static func runs(_ snippet: String) -> [SnippetSegment] {
    SessionSearch.snippetSegments(SessionSearch.tidySnippet(snippet)).compactMap { segment in
      let text = clean(segment.text)

      return text.isEmpty ? nil : SnippetSegment(text: text, match: segment.match)
    }
  }

  /// One run as characters that cannot reorder or hide anything: control, format (the bidirectional
  /// overrides among them) and separator characters become spaces. Not trimmed: the spaces at the
  /// edges of a run are the spaces between it and the match.
  static func clean(_ run: String) -> String {
    var cleaned = String.UnicodeScalarView()
    var units = 0

    for scalar in run.unicodeScalars {
      let width = scalar.utf16.count

      if units + width > runLimit {
        break
      }

      units += width

      switch scalar.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator:
        cleaned.append(" ")
      default:
        cleaned.append(scalar)
      }
    }

    return String(cleaned)
  }
}
