import Foundation

/// One stretch of an expression set on one line: the text, how it is set, and how far it is raised
/// (positive) or lowered (negative) in script levels.
public struct MathSpan: Sendable, Hashable {
  public var text: String
  public var style: MathStyle
  /// Script levels above (+) or below (−) the baseline. Zero for text set in line.
  public var level: Int
  /// How deep inside scripts the run is; a script's script is smaller again.
  public var depth: Int

  public init(_ text: String, _ style: MathStyle = .roman, level: Int = 0, depth: Int = 0) {
    self.text = text
    self.style = style
    self.level = level
    self.depth = depth
  }
}

/// An expression as one line of text: the readable typeset form of mathematics, and the form inline
/// formulas are drawn in.
///
/// Fractions are `a/b`, roots `√(…)`, limits are scripts, a grid is its rows between its fence. Scripts
/// that Unicode has glyphs for (`x²`, `aᵢ`, `eˣ`, `10⁻³`) are those glyphs, which sit right at any text
/// size; the rest are raised or lowered runs.
public enum MathLinear {
  /// The expression in `source` as spans, or `nil` when it is outside what the parser knows.
  public static func spans(of source: String) -> [MathSpan]? {
    MathParser.parse(source).map(spans(of:))
  }

  public static func spans(of node: MathNode) -> [MathSpan] {
    var out: [MathSpan] = []
    emit(node, level: 0, depth: 0, into: &out)
    return merged(out)
  }

  /// The text with no regard for how it is set: what VoiceOver reads and a copy would hold.
  public static func plainText(of node: MathNode) -> String {
    spans(of: node).map(\.text).joined()
  }

  /// Neighbouring spans set the same way are one.
  static func merged(_ spans: [MathSpan]) -> [MathSpan] {
    var out: [MathSpan] = []
    for span in spans where !span.text.isEmpty {
      if let last = out.last, last.style == span.style, last.level == span.level, last.depth == span.depth {
        out[out.count - 1].text += span.text
      } else {
        out.append(span)
      }
    }
    return out
  }

  // MARK: Walking the tree

  static func emit(_ node: MathNode, level: Int, depth: Int, into out: inout [MathSpan]) {
    switch node {
    case .run(let text, let style):
      out.append(MathSpan(text, style, level: level, depth: depth))

    case .row(let items):
      for item in items { emit(item, level: level, depth: depth, into: &out) }

    case .space:
      out.append(MathSpan(" ", .roman, level: level, depth: depth))

    case .scripts(let base, let sup, let sub):
      emit(base, level: level, depth: depth, into: &out)
      emitScripts(sup: sup, sub: sub, level: level, depth: depth, into: &out)

    case .op(let symbol, let upper, let lower):
      out.append(MathSpan(symbol, .roman, level: level, depth: depth))
      emitScripts(sup: upper, sub: lower, level: level, depth: depth, into: &out)
      if upper != nil || lower != nil { out.append(MathSpan(" ", .roman, level: level, depth: depth)) }

    case .frac(let numerator, let denominator):
      emitOperand(numerator, level: level, depth: depth, into: &out)
      out.append(MathSpan("/", .roman, level: level, depth: depth))
      emitOperand(denominator, level: level, depth: depth, into: &out)

    case .sqrt(let radicand, let index):
      if let index {
        emitScripts(sup: index, sub: nil, level: level, depth: depth, into: &out)
      }
      out.append(MathSpan("√", .roman, level: level, depth: depth))
      emitOperand(radicand, level: level, depth: depth, into: &out, always: true)

    case .fenced(let open, let close, let body):
      out.append(MathSpan(open, .roman, level: level, depth: depth))
      emit(body, level: level, depth: depth, into: &out)
      out.append(MathSpan(close, .roman, level: level, depth: depth))

    case .accent(let base, let combining):
      var inner: [MathSpan] = []
      emit(base, level: level, depth: depth, into: &inner)
      // A bar or a slash covers the whole base; the others sit on its last character.
      let covers = combining == "\u{0304}" || combining == "\u{0338}"
      for (index, span) in inner.enumerated() {
        var accented = span
        if covers {
          accented.text = span.text.map { $0.isWhitespace ? String($0) : "\($0)\(combining)" }.joined()
        } else if index == inner.count - 1, let last = span.text.last {
          accented.text = String(span.text.dropLast()) + "\(last)\(combining)"
        }
        out.append(accented)
      }

    case .grid(let rows, let open, let close, let style):
      out.append(MathSpan(open, .roman, level: level, depth: depth))
      let separator = style == .matrix ? ", " : "  "
      for (rowIndex, row) in rows.enumerated() {
        if rowIndex > 0 { out.append(MathSpan("; ", .roman, level: level, depth: depth)) }
        for (columnIndex, cell) in row.enumerated() {
          if columnIndex > 0 { out.append(MathSpan(separator, .roman, level: level, depth: depth)) }
          emit(cell, level: level, depth: depth, into: &out)
        }
      }
      out.append(MathSpan(close, .roman, level: level, depth: depth))
    }
  }

  /// An operand of `/` or `√`: bare when it reads as one thing, in parentheses otherwise.
  static func emitOperand(_ node: MathNode, level: Int, depth: Int, into out: inout [MathSpan], always: Bool = false) {
    var inner: [MathSpan] = []
    emit(node, level: level, depth: depth, into: &inner)
    let text = inner.map(\.text).joined()
    let atomic = !text.isEmpty && text.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." }
    // A root of one symbol or number needs no parentheses either.
    let needsParentheses = !(atomic && (always ? text.count == 1 || text.allSatisfy(\.isNumber) : true))
    if needsParentheses { out.append(MathSpan("(", .roman, level: level, depth: depth)) }
    out.append(contentsOf: inner)
    if needsParentheses { out.append(MathSpan(")", .roman, level: level, depth: depth)) }
  }

  /// A subscript and a superscript after a base, in the order they are read: below, then above.
  static func emitScripts(sup: MathNode?, sub: MathNode?, level: Int, depth: Int, into out: inout [MathSpan]) {
    if let sub { emitScript(sub, up: false, level: level, depth: depth, into: &out) }
    if let sup { emitScript(sup, up: true, level: level, depth: depth, into: &out) }
  }

  static func emitScript(_ node: MathNode, up: Bool, level: Int, depth: Int, into out: inout [MathSpan]) {
    var inner: [MathSpan] = []
    emit(node, level: level, depth: depth, into: &inner)
    // Whole script in Unicode script characters: set in line.
    if inner.allSatisfy({ $0.level == level }), let mapped = scripted(inner.map(\.text).joined(), up: up) {
      let style = inner.first?.style == .bold ? MathStyle.bold : .roman
      out.append(MathSpan(mapped, style, level: level, depth: depth))
      return
    }
    // Otherwise raised or lowered a level, and smaller.
    inner = []
    emit(node, level: level + (up ? 1 : -1), depth: depth + 1, into: &inner)
    out.append(contentsOf: inner)
  }

  // MARK: Unicode scripts

  static let superscripts: [Character: Character] = [
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "−": "⁻", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ", "h": "ʰ", "i": "ⁱ", "j": "ʲ",
    "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ", "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ",
    "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ", "T": "ᵀ",
    "α": "ᵅ", "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "θ": "ᶿ", "φ": "ᵠ", "χ": "ᵡ",
    "′": "′", "∗": "∗", "°": "°"
  ]

  static let subscripts: [Character: Character] = [
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "−": "₋", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
    "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
    "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ"
  ]

  /// `text` in script characters, or `nil` when one of its characters has none.
  static func scripted(_ text: String, up: Bool) -> String? {
    guard !text.isEmpty else { return nil }
    let table = up ? superscripts : subscripts
    var out = ""
    for character in text {
      guard let mapped = table[character] else { return nil }
      out.append(mapped)
    }
    return out
  }
}
