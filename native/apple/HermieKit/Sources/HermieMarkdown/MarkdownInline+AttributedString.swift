import Foundation
import SwiftUI

extension MarkdownInline {
  /// The schemes a tap may leave the app through. Anything else — a path on
  /// the gateway's disk from a `MEDIA:` tag, a relative link — is drawn as a
  /// link but stays inert, as in the Expo app.
  static let openableSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  /// The runs as an `AttributedString` for `Text`.
  ///
  /// Only intents are set, never fonts or colours: `Text` resolves bold,
  /// italic and code against the font in the environment, which is what keeps
  /// Dynamic Type and a heading's size, and draws links in the environment's
  /// tint and opens them through its `OpenURLAction`.
  ///
  /// A formula (`.math`) is typeset as a line (`MathLinear`): symbols, `x²`, `a/b`; `scriptOffset` is
  /// how far a script with no Unicode glyph is raised. One this parser does not know stays its LaTeX
  /// source, in code.
  public func attributedString(codeBackground: Color? = nil, scriptOffset: CGFloat = 5) -> AttributedString {
    var out = AttributedString()
    for run in runs {
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
      if let link = run.link {
        if let url = URL(string: link), let scheme = url.scheme?.lowercased(), Self.openableSchemes.contains(scheme) {
          piece.link = url
        } else {
          piece.underlineStyle = .single
        }
      }
      out += piece
    }
    return out
  }
}
