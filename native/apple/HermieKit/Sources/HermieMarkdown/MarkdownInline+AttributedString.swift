import Foundation
import SwiftUI

extension MarkdownInline {
  /// The schemes a tap may leave the app through. Anything else — a path on
  /// the gateway's disk from a `MEDIA:` tag, a relative link — is drawn as a
  /// link but stays inert, as in the Expo app.
  public static let openableSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  /// Whether a tap may leave the app through `url`: its scheme is one of `openableSchemes`.
  public static func isOpenable(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return openableSchemes.contains(scheme)
  }

  /// The mark after a link that leaves for the web: a narrow no-break space (so it never wraps onto a line
  /// of its own) and a north-east arrow in text presentation. It follows the link and is not part of it.
  static let linkGlyph = "\u{202F}\u{2197}\u{FE0E}"

  /// Whether a link opens a page on the web (`http`, `https`): the links that carry `linkGlyph`. `mailto` and
  /// `tel` hand the address to another app and carry none.
  static func leavesForTheWeb(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return scheme == "http" || scheme == "https"
  }

  /// What a screen reader says for `text` once the link marks are taken out: the link's own words are enough,
  /// and "north east arrow" after each is noise. `nil` when there are none, so a paragraph without a link keeps
  /// the label SwiftUI makes of it.
  public static func spokenText(of text: AttributedString) -> String? {
    let plain = String(text.characters)
    guard plain.contains(linkGlyph) else { return nil }
    return plain.replacingOccurrences(of: linkGlyph, with: "")
  }

  /// The runs as an `AttributedString` for `Text`.
  ///
  /// Only intents are set, never fonts or colours: `Text` resolves bold,
  /// italic and code against the font in the environment, which is what keeps
  /// Dynamic Type and a heading's size, and draws links in the environment's
  /// tint and opens them through its `OpenURLAction`.
  ///
  /// A link the app opens is underlined with dots, in the tint, and a link to a web page is followed by a small
  /// arrow (`linkGlyph`) in a run of its own, once per link, so it is not selected or opened with the link.
  ///
  /// A formula (`.math`) is typeset as a line (`MathLinear`): symbols, `x²`, `a/b`; `scriptOffset` is
  /// how far a script with no Unicode glyph is raised. One this parser does not know stays its LaTeX
  /// source, in code.
  public func attributedString(codeBackground: Color? = nil, scriptOffset: CGFloat = 5) -> AttributedString {
    var out = AttributedString()
    for (index, run) in runs.enumerated() {
      if run.traits.contains(.math), let spans = MathLinear.spans(of: run.text) {
        var typeset = MathLinear.attributed(spans, scriptOffset: scriptOffset)
        if run.traits.contains(.bold) { typeset.inlinePresentationIntent = .stronglyEmphasized }
        if run.traits.contains(.strikethrough) { typeset.strikethroughStyle = .single }
        out += typeset
        continue
      }
      var piece = AttributedString(run.text)
      var intent: InlinePresentationIntent = []
      if run.traits.contains(.bold) { intent.insert(.stronglyEmphasized) }
      if run.traits.contains(.italic) { intent.insert(.emphasized) }
      if run.traits.contains(.code) || run.traits.contains(.math) { intent.insert(.code) }
      if !intent.isEmpty { piece.inlinePresentationIntent = intent }
      if run.traits.contains(.strikethrough) { piece.strikethroughStyle = .single }
      if let codeBackground, run.traits.contains(.code) || run.traits.contains(.math) {
        piece.backgroundColor = codeBackground
      }
      var glyph = false
      if let link = run.link {
        if let url = URL(string: link), Self.isOpenable(url) {
          piece.link = url
          piece.underlineStyle = Text.LineStyle(pattern: .dot)
          // Once per link: after its last run, whatever styling split it into several.
          glyph = Self.leavesForTheWeb(url) && (index + 1 == runs.count || runs[index + 1].link != link)
        } else {
          piece.underlineStyle = .single
        }
      }
      out += piece
      if glyph {
        var mark = AttributedString(Self.linkGlyph)
        mark.foregroundColor = Color.accentColor.opacity(0.75)
        out += mark
      }
    }
    return out
  }
}
