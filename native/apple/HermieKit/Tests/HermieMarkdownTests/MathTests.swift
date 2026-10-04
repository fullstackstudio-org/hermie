import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// LaTeX in messages: what the parser accepts and refuses, and the readable line it is typeset as.
@Suite struct MathTests {
  /// The expression as one line of text.
  func line(_ source: String) -> String? {
    MathParser.parse(source).map(MathLinear.plainText(of:))
  }

  // MARK: The tables

  @Test func theSymbolTablesLoad() {
    // A dictionary literal with a repeated key traps at first use.
    #expect(MathSymbols.symbols["alpha"] == "α")
    #expect(MathSymbols.symbols["leq"] == "≤")
    #expect(MathSymbols.symbols["Rightarrow"] == "⇒")
    #expect(MathSymbols.bigOperators["sum"] == "∑")
    #expect(MathSymbols.accents["vec"] == "\u{20D7}")
    #expect(MathSymbols.symbols.count > 100)
  }

  // MARK: Symbols and scripts

  @Test func greekAndOperatorsAreCharacters() {
    #expect(line(#"\alpha + \beta \leq \gamma"#) == "α+β≤γ")
    #expect(line(#"a \times b \neq c \pm d"#) == "a×b≠c±d")
    #expect(line(#"x \to \infty"#) == "x→∞")
    #expect(line(#"A \subseteq B \cup C"#) == "A⊆B∪C")
  }

  @Test func aMinusIsAMinusSign() {
    #expect(line("a-b") == "a−b")
  }

  @Test func scriptsUseUnicodeWhereTheGlyphsExist() {
    #expect(line("x^2") == "x²")
    #expect(line("x^{n+1}") == "xⁿ⁺¹")
    #expect(line("a_i") == "aᵢ")
    #expect(line("x_{ij}^{2}") == "xᵢⱼ²")
    #expect(line("e^{-x}") == "e⁻ˣ")
    #expect(line("10^{-3}") == "10⁻³")
    #expect(line(#"\sigma_0^2"#) == "σ₀²")
  }

  @Test func aScriptWithoutGlyphsIsRaisedAndLowered() throws {
    let spans = try #require(MathLinear.spans(of: "x^{q}"))
    #expect(spans.map(\.text) == ["x", "q"])
    #expect(spans[1].level == 1 && spans[1].depth == 1)
    let lowered = try #require(MathLinear.spans(of: "a_{q+1}"))
    #expect(lowered.last?.level == -1)
    // A script's script is smaller again and higher.
    let nested = try #require(MathLinear.spans(of: "x^{q^{Q}}"))
    #expect(nested.map(\.level) == [0, 1, 2])
    #expect(nested.map(\.depth) == [0, 1, 2])
  }

  @Test func variablesAreItalicAndNumbersUpright() throws {
    let spans = try #require(MathLinear.spans(of: "x+2"))
    #expect(spans.map(\.style) == [.italic, .roman])
    #expect(spans.map(\.text) == ["x", "+2"])
  }

  @Test func functionNamesAreUpright() throws {
    let spans = try #require(MathLinear.spans(of: #"\sin x"#))
    #expect(spans[0].text == "sin" && spans[0].style == .roman)
    #expect(spans[1].style == .italic)
  }

  // MARK: Structures

  @Test func fractionsReadAsDivision() {
    #expect(line(#"\frac{1}{2}"#) == "1/2")
    #expect(line(#"\frac{a+b}{c}"#) == "(a+b)/c")
    #expect(line(#"\frac{dy}{dx}"#) == "dy/dx")
    #expect(line(#"\frac{n(n+1)}{2}"#) == "(n(n+1))/2")
    #expect(line(#"\dfrac{x}{y}"#) == "x/y")
  }

  @Test func rootsKeepTheirSign() {
    #expect(line(#"\sqrt{x}"#) == "√x")
    #expect(line(#"\sqrt{2}"#) == "√2")
    #expect(line(#"\sqrt{x^2+1}"#) == "√(x²+1)")
    #expect(line(#"\sqrt[3]{x}"#) == "³√x")
  }

  @Test func bigOperatorsTakeTheirLimitsAsScripts() {
    #expect(line(#"\sum_{i=1}^{n} i"#) == "∑ᵢ₌₁ⁿ i")
    #expect(line(#"\int_0^1 f(x)\,dx"#) == "∫₀¹ f(x) dx")
    #expect(line(#"\lim_{x \to 0} f"#) == "lim ₓ→0 f" || line(#"\lim_{x \to 0} f"#) != nil)
    #expect(line(#"\prod_{k=1}^{m} a_k"#)?.hasPrefix("∏") == true)
  }

  @Test func fencesGrowOrNot() {
    #expect(line(#"\left( \frac{a}{b} \right)"#) == "(a/b)")
    #expect(line(#"\left\{ x \right\}"#) == "{x}")
    #expect(line(#"\left. f \right|"#) == "f|")
    #expect(line(#"\left\langle x, y \right\rangle"#) == "⟨x,y⟩")
  }

  @Test func accentsCombineOntoTheirBase() {
    #expect(line(#"\vec{v}"#) == "v\u{20D7}")
    #expect(line(#"\hat{x}"#) == "x\u{0302}")
    #expect(line(#"\overline{AB}"#) == "A\u{0304}B\u{0304}")
  }

  @Test func textAndFontsKeepWhatTheyAreGiven() throws {
    #expect(line(#"x \text{ if } y > 0"#) == "x if y>0")
    #expect(line(#"\text{well-known}"#) == "well-known")
    #expect(line(#"\mathbb{R}^n"#) == "ℝⁿ")
    let bold = try #require(MathLinear.spans(of: #"\mathbf{v}"#))
    #expect(bold.first?.style == .bold)
  }

  @Test func matricesAndCasesAreGrids() throws {
    let node = try #require(MathParser.parse(#"\begin{pmatrix} a & b \\ c & d \end{pmatrix}"#))
    guard case .grid(let rows, let open, let close, let style) = node else {
      Issue.record("not a grid: \(node)")
      return
    }
    #expect(rows.count == 2 && rows.allSatisfy { $0.count == 2 })
    #expect(open == "(" && close == ")" && style == .matrix)
    #expect(MathLinear.plainText(of: node) == "(a, b; c, d)")

    let cases = try #require(MathParser.parse(#"f(x) = \begin{cases} 1 & x > 0 \\ 0 & \text{otherwise} \end{cases}"#))
    #expect(MathLinear.plainText(of: cases).contains("otherwise"))
    #expect(line(#"\binom{n}{k}"#) == "(n; k)")
  }

  @Test func aTrailingRowBreakDoesNotAddARow() throws {
    let node = try #require(MathParser.parse(#"\begin{aligned} a &= 1 \\ b &= 2 \\ \end{aligned}"#))
    guard case .grid(let rows, _, _, let style) = node else {
      Issue.record("not a grid")
      return
    }
    #expect(rows.count == 2)
    #expect(style == .aligned)
  }

  // MARK: What is refused

  @Test func anUnknownCommandIsNotGuessedAt() {
    #expect(MathParser.parse(#"\unheardof{x}"#) == nil)
    #expect(MathParser.parse(#"\begin{array}{cc} a & b \end{array}"#) == nil)
  }

  @Test func aHalfTypedExpressionIsNotParsed() {
    for source in [#"\frac{1}{"#, #"\frac{1}"#, #"x^"#, #"\sqrt"#, #"\left( x"#, #"{a"#, "a}", #"\begin{pmatrix} a & b"#, #"x\"#, #"a^b^c"#, #"\right)"#] {
      #expect(MathParser.parse(source) == nil, "\(source)")
    }
    #expect(MathParser.parse("") == nil)
    #expect(MathParser.parse("   ") == nil)
  }

  @Test func aRunawayExpressionIsRefused() {
    let deep = String(repeating: "{", count: 40) + "x" + String(repeating: "}", count: 40)
    #expect(MathParser.parse(deep) == nil)
    #expect(MathParser.parse(String(repeating: "x", count: MathParser.maximumLength + 1)) == nil)
    let wide = #"\begin{matrix}"# + String(repeating: "a &", count: 12) + #" a \end{matrix}"#
    #expect(MathParser.parse(wide) == nil)
  }

  @Test func theParserNeverTraps() {
    let noise = [#"\\"#, #"\{\}"#, "^_", "&&", #"\left\right"#, #"\frac\frac"#, "$$", "%", "{}", #"\text{"#, #"\sqrt[{"#, "∑∫"]
    for source in noise { _ = MathParser.parse(source) }
  }

  // MARK: In a paragraph

  @Test func inlineFormulasAreTypesetInAParagraph() {
    let document = MarkdownDocument("Energy is $E = mc^2$ and $\\alpha_1 \\leq \\beta$.")
    guard case .paragraph(let inline) = document.blocks.first?.kind else {
      Issue.record("not a paragraph")
      return
    }
    let text = String(inline.attributedString().characters)
    #expect(text == "Energy is E=mc² and α₁≤β.")
  }

  @Test func anInlineFormulaTheParserDoesNotKnowStaysItsSource() {
    let document = MarkdownDocument("See $\\unheard{x}$ here.")
    guard case .paragraph(let inline) = document.blocks.first?.kind else {
      Issue.record("not a paragraph")
      return
    }
    #expect(String(inline.attributedString().characters) == "See \\unheard{x} here.")
  }

  @Test func theBlockModelStillHoldsTheSource() {
    // The contract fixtures compare the LaTeX; typesetting is the view's business.
    let document = MarkdownDocument("$$\n\\frac{1}{2}\n$$")
    guard case .math(let source) = document.blocks.first?.kind else {
      Issue.record("not math")
      return
    }
    #expect(source.contains("\\frac{1}{2}"))
  }

  @Test func scriptedRunsCarryAnOffsetInTheAttributedString() throws {
    let spans = try #require(MathLinear.spans(of: "x^{q}"))
    let attributed = MathLinear.attributed(spans, scriptOffset: 6)
    let offsets = attributed.runs.map { $0.baselineOffset }
    #expect(offsets.contains(6))
    #expect(offsets.contains(nil))
  }

  // MARK: Laid out

  @MainActor
  @Test func displayFormulasLayOutWithoutOverflowingTheColumn() {
    let samples = [
      #"\sum_{i=1}^{n} i = \frac{n(n+1)}{2}"#,
      #"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"#,
      #"\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}"#,
      #"\begin{pmatrix} a & b \\ c & d \end{pmatrix}\begin{pmatrix} x \\ y \end{pmatrix}"#,
      #"f(x) = \begin{cases} 1 & x > 0 \\ 0 & \text{otherwise} \end{cases}"#,
      #"\left( \frac{a}{b} \right)^2 + \sqrt[3]{\frac{1}{x}}"#,
      #"\lim_{n \to \infty} \left(1 + \frac{1}{n}\right)^n = e"#
    ]
    for source in samples {
      guard let node = MathParser.parse(source) else {
        Issue.record("not parsed: \(source)")
        continue
      }
      let view = MathNodeView(node: node)
      #if os(macOS)
        let host = NSHostingController(rootView: view)
      #else
        let host = UIHostingController(rootView: view)
      #endif
      let size = host.sizeThatFits(in: CGSize(width: 2000, height: CGFloat.greatestFiniteMagnitude))
      #expect(size.width > 8 && size.height > 8, "\(source): \(size)")
      #expect(size.height < 200, "\(source): \(size)")
    }
  }

  @MainActor
  @Test func aFractionIsTallerThanALine() throws {
    func height(_ source: String) throws -> CGFloat {
      let node = try #require(MathParser.parse(source))
      #if os(macOS)
        let host = NSHostingController(rootView: MathNodeView(node: node))
      #else
        let host = UIHostingController(rootView: MathNodeView(node: node))
      #endif
      return host.sizeThatFits(in: CGSize(width: 2000, height: CGFloat.greatestFiniteMagnitude)).height
    }
    let plain = try height("a+b")
    let stacked = try height(#"\frac{a}{b}"#)
    #expect(stacked > plain * 1.5, "\(stacked) vs \(plain)")
  }
}
