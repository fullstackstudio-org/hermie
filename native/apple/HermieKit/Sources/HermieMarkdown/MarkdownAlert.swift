import Foundation

// A GitHub-style alert in a message
// =================================
//
// A quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` is drawn as a
// callout (`contract/markup/README.md` section 4). It is not a block of its own: the parser still produces a
// quote, so the shared block model and `contract/markdown` do not change, and every other renderer shows a
// quote that begins with the marker. This is the one place that decides whether a quote is an alert and what
// is left of it once the marker line is gone; `native/web/src/markdown/Alert.tsx` (`readAlert`) is its twin.
//
// The marker is upper case and exact and alone on its line (white space after it is allowed). A lower-case
// or mixed-case marker, text after it on its line, a marker that is not the quote's first line, an unknown
// marker and a marker outside a quote are ordinary text. A quote nested inside a callout is an ordinary quote
// (the view sets that, not this).

/// Which of the five callouts.
public enum MarkdownAlertKind: String, Sendable, Hashable, CaseIterable {
  case note
  case tip
  case important
  case warning
  case caution

  /// The marker as it is written, without the brackets: `NOTE`.
  var marker: String { rawValue.uppercased() }
}

/// A quote that is an alert: its kind, and the blocks that are left once the marker line is gone.
public struct MarkdownAlert: Sendable, Hashable {
  public var kind: MarkdownAlertKind
  public var body: [MarkdownBlock]

  public init(kind: MarkdownAlertKind, body: [MarkdownBlock]) {
    self.kind = kind
    self.body = body
  }

  /// The alert a quote's blocks say, or `nil` for an ordinary quote.
  public static func read(_ blocks: [MarkdownBlock]) -> MarkdownAlert? {
    guard let first = blocks.first, case .paragraph(let inline) = first.kind else {
      return nil
    }

    let text = Array(inline.plainText.unicodeScalars)

    for kind in MarkdownAlertKind.allCases {
      guard let consumed = markerLength(kind, in: text) else { continue }

      var body = Array(blocks.dropFirst())
      let rest = drop(consumed, from: inline)

      if rest.runs.contains(where: { !$0.text.allSatisfy(\.isWhitespace) }) {
        body.insert(MarkdownBlock(id: first.id, kind: .paragraph(rest)), at: 0)
      }

      return MarkdownAlert(kind: kind, body: body)
    }

    return nil
  }

  /// How many scalars the marker line takes (the marker, any spaces and tabs, and the line break), or `nil`
  /// when the text does not begin with exactly this marker alone on its line.
  private static func markerLength(_ kind: MarkdownAlertKind, in text: [Unicode.Scalar]) -> Int? {
    let marker = Array("[!\(kind.marker)]".unicodeScalars)
    guard text.count >= marker.count, Array(text[0..<marker.count]) == marker else { return nil }

    var index = marker.count
    while index < text.count, text[index] == " " || text[index] == "\t" { index += 1 }

    if index == text.count { return index }

    // `\r\n` cannot reach here (the parser turns a break into `\n`), but a stray `\r` before it is white space.
    if text[index] == "\r", index + 1 < text.count, text[index + 1] == "\n" { return index + 2 }
    if text[index] == "\n" { return index + 1 }
    return nil
  }

  /// The inline content without its first `count` scalars (the marker line), keeping every run's traits.
  private static func drop(_ count: Int, from inline: MarkdownInline) -> MarkdownInline {
    var remaining = count
    var runs: [MarkdownRun] = []

    for run in inline.runs {
      if remaining == 0 {
        runs.append(run)
        continue
      }

      let scalars = Array(run.text.unicodeScalars)

      if scalars.count <= remaining {
        remaining -= scalars.count
        continue
      }

      var kept = run
      var view = String.UnicodeScalarView()
      view.append(contentsOf: scalars[remaining...])
      kept.text = String(view)
      remaining = 0
      runs.append(kept)
    }

    return MarkdownInline(runs)
  }
}
