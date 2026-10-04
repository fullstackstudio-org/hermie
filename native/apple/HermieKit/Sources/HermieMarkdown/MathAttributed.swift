import SwiftUI

extension MathLinear {
  /// The spans as an `AttributedString` for `Text`.
  ///
  /// Only intents and offsets are set: a variable is emphasised, bold is strong, and a script that
  /// Unicode has no glyph for is raised or lowered by `scriptOffset` per level and set smaller. The font
  /// is the environment's, so a formula in a heading is as big as the heading.
  public static func attributed(_ spans: [MathSpan], scriptOffset: CGFloat = 5) -> AttributedString {
    var out = AttributedString()
    for span in spans {
      var piece = AttributedString(span.text)
      switch span.style {
      case .italic: piece.inlinePresentationIntent = .emphasized
      case .bold: piece.inlinePresentationIntent = .stronglyEmphasized
      case .mono: piece.inlinePresentationIntent = .code
      case .roman: break
      }
      if span.level != 0 {
        piece.baselineOffset = CGFloat(span.level) * scriptOffset
      }
      if span.depth == 1 {
        piece.font = .footnote
      } else if span.depth >= 2 {
        piece.font = .caption2
      }
      out += piece
    }
    return out
  }
}
