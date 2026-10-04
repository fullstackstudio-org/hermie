import SwiftUI

// Display mathematics, laid out with SwiftUI: stacked fractions, roots with a bar, big operators with
// their limits, fences that grow, grids. Text is `Text`, so it follows Dynamic Type and the system
// font; only the arrangement is ours.
//
// Pieces that are a line of characters (symbols, scripts, a fence round a line) are not boxes: runs of
// them are one `Text` made by `MathLinear`, so `x² + y²` is a single piece of text. Only fractions,
// roots, operators with limits and grids open out into stacks.

// MARK: - The axis

extension VerticalAlignment {
  /// The maths axis: the line through the middle of a `+` and of a fraction's bar, which boxes in a
  /// row line up on (not on their centres: a fraction whose numerator is taller than its denominator
  /// still has its bar level with the `=` beside it).
  static let mathAxis = VerticalAlignment(MathAxis.self)
}

private enum MathAxis: AlignmentID {
  static func defaultValue(in context: ViewDimensions) -> CGFloat {
    context[VerticalAlignment.center]
  }
}

/// Subviews stacked top to bottom, centred, with the maths axis through one of them. With a `barIndex`,
/// that subview is a rule as wide as the widest of the others.
struct MathStack: Layout {
  var axisIndex: Int
  var barIndex: Int?
  var spacing: CGFloat
  var barThickness: CGFloat = 1

  private func sizes(_ subviews: Subviews) -> [CGSize] {
    subviews.enumerated().map { index, subview in
      index == barIndex ? CGSize(width: 0, height: barThickness) : subview.sizeThatFits(.unspecified)
    }
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let sizes = sizes(subviews)
    let width = sizes.map(\.width).max() ?? 0
    let height = sizes.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, sizes.count - 1))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = sizes(subviews)
    let width = sizes.map(\.width).max() ?? 0
    var y = bounds.minY
    for (index, subview) in subviews.enumerated() {
      let size = index == barIndex ? CGSize(width: width, height: barThickness) : sizes[index]
      subview.place(
        at: CGPoint(x: bounds.minX + (width - size.width) / 2, y: y), anchor: .topLeading,
        proposal: ProposedViewSize(size))
      y += size.height + spacing
    }
  }

  func explicitAlignment(
    of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) -> CGFloat? {
    guard guide == .mathAxis, subviews.indices.contains(axisIndex) else { return nil }
    let sizes = sizes(subviews)
    var y = bounds.minY
    for index in 0..<axisIndex { y += sizes[index].height + spacing }
    return y + sizes[axisIndex].height / 2
  }
}

/// A base with a superscript and a subscript at its trailing corners: the base keeps its size and its
/// place on the axis, the scripts sit against its top and bottom edges.
struct MathScripts: Layout {
  var hasSup: Bool
  var hasSub: Bool
  var gap: CGFloat = 1

  private func parts(_ subviews: Subviews) -> (base: CGSize, sup: CGSize, sub: CGSize) {
    let base = subviews[0].sizeThatFits(.unspecified)
    var index = 1
    var sup = CGSize.zero
    var sub = CGSize.zero
    if hasSup { sup = subviews[index].sizeThatFits(.unspecified); index += 1 }
    if hasSub { sub = subviews[index].sizeThatFits(.unspecified) }
    return (base, sup, sub)
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let p = parts(subviews)
    // Scripts may be taller than the base: the block grows over the base and under it.
    let above = max(0, p.sup.height - p.base.height / 2)
    let below = max(0, p.sub.height - p.base.height / 2)
    return CGSize(
      width: p.base.width + gap + max(p.sup.width, p.sub.width),
      height: p.base.height + (hasSup ? above : 0) + (hasSub ? below : 0))
  }

  private func offsets(_ p: (base: CGSize, sup: CGSize, sub: CGSize)) -> (above: CGFloat, below: CGFloat) {
    (hasSup ? max(0, p.sup.height - p.base.height / 2) : 0, hasSub ? max(0, p.sub.height - p.base.height / 2) : 0)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let p = parts(subviews)
    let o = offsets(p)
    subviews[0].place(
      at: CGPoint(x: bounds.minX, y: bounds.minY + o.above), anchor: .topLeading, proposal: ProposedViewSize(p.base))
    var index = 1
    let x = bounds.minX + p.base.width + gap
    if hasSup {
      subviews[index].place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(p.sup))
      index += 1
    }
    if hasSub {
      subviews[index].place(
        at: CGPoint(x: x, y: bounds.minY + o.above + p.base.height - (p.sub.height - o.below)), anchor: .topLeading,
        proposal: ProposedViewSize(p.sub))
    }
  }

  func explicitAlignment(
    of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) -> CGFloat? {
    guard guide == .mathAxis else { return nil }
    let p = parts(subviews)
    return bounds.minY + offsets(p).above + subviews[0].dimensions(in: .unspecified)[.mathAxis]
  }
}

// MARK: - Fences and radicals

/// A delimiter drawn as a path the height of what it fences.
struct MathFence: Shape {
  var glyph: String

  /// How wide the fence is drawn.
  static func width(of glyph: String) -> CGFloat {
    switch glyph {
    case "{", "}": 8
    case "‖": 7
    default: 6
    }
  }

  func path(in rect: CGRect) -> Path {
    var path = Path()
    let w = rect.width
    let h = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x, y: rect.minY + y) }

    switch glyph {
    case "(":
      path.move(to: point(w, 0))
      path.addQuadCurve(to: point(w, h), control: point(-w * 0.4, h / 2))
    case ")":
      path.move(to: point(0, 0))
      path.addQuadCurve(to: point(0, h), control: point(w * 1.4, h / 2))
    case "[":
      path.addLines([point(w, 0), point(0, 0), point(0, h), point(w, h)])
    case "⌈":
      path.addLines([point(w, 0), point(0, 0), point(0, h)])
    case "⌊":
      path.addLines([point(0, 0), point(0, h), point(w, h)])
    case "]":
      path.addLines([point(0, 0), point(w, 0), point(w, h), point(0, h)])
    case "⌉":
      path.addLines([point(0, 0), point(w, 0), point(w, h)])
    case "⌋":
      path.addLines([point(w, 0), point(w, h), point(0, h)])
    case "{":
      path.move(to: point(w, 0))
      path.addQuadCurve(to: point(w * 0.5, h * 0.16), control: point(w * 0.5, 0))
      path.addLine(to: point(w * 0.5, h * 0.42))
      path.addQuadCurve(to: point(0, h * 0.5), control: point(w * 0.5, h * 0.5))
      path.addQuadCurve(to: point(w * 0.5, h * 0.58), control: point(w * 0.5, h * 0.5))
      path.addLine(to: point(w * 0.5, h * 0.84))
      path.addQuadCurve(to: point(w, h), control: point(w * 0.5, h))
    case "}":
      path.move(to: point(0, 0))
      path.addQuadCurve(to: point(w * 0.5, h * 0.16), control: point(w * 0.5, 0))
      path.addLine(to: point(w * 0.5, h * 0.42))
      path.addQuadCurve(to: point(w, h * 0.5), control: point(w * 0.5, h * 0.5))
      path.addQuadCurve(to: point(w * 0.5, h * 0.58), control: point(w * 0.5, h * 0.5))
      path.addLine(to: point(w * 0.5, h * 0.84))
      path.addQuadCurve(to: point(0, h), control: point(w * 0.5, h))
    case "|":
      path.move(to: point(w / 2, 0))
      path.addLine(to: point(w / 2, h))
    case "‖":
      path.move(to: point(w * 0.25, 0))
      path.addLine(to: point(w * 0.25, h))
      path.move(to: point(w * 0.75, 0))
      path.addLine(to: point(w * 0.75, h))
    case "⟨":
      path.move(to: point(w, 0))
      path.addLine(to: point(0, h / 2))
      path.addLine(to: point(w, h))
    case "⟩":
      path.move(to: point(0, 0))
      path.addLine(to: point(w, h / 2))
      path.addLine(to: point(0, h))
    default:
      break
    }
    return path
  }
}

/// The sign of a root: a tick, a stroke down and a long one up, the height of the radicand.
struct MathRadical: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let w = rect.width
    let h = rect.height
    path.move(to: CGPoint(x: rect.minX, y: rect.minY + h * 0.62))
    path.addLine(to: CGPoint(x: rect.minX + w * 0.28, y: rect.minY + h * 0.56))
    path.addLine(to: CGPoint(x: rect.minX + w * 0.5, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    return path
  }
}

// MARK: - The view

/// A parsed expression, laid out.
struct MathNodeView: View {
  let node: MathNode
  @ScaledMetric(relativeTo: .body) private var scriptOffset: CGFloat = 5
  @ScaledMetric(relativeTo: .body) private var rule: CGFloat = 1

  var body: some View {
    MathBoxes(scriptOffset: scriptOffset, rule: rule).box(node, nesting: 0)
  }
}

/// Builds the views of a tree; a value so the recursion is a plain function.
private struct MathBoxes {
  let scriptOffset: CGFloat
  let rule: CGFloat

  /// Whether `node` is a line of characters, which `MathLinear` can set as text.
  func isLine(_ node: MathNode) -> Bool {
    switch node {
    case .run, .space: true
    case .row(let items): items.allSatisfy(isLine)
    case .scripts(let base, let sup, let sub): isLine(base) && sup.map(isLine) != false && sub.map(isLine) != false
    case .fenced(_, _, let body): isLine(body)
    case .accent(let base, _): isLine(base)
    case .op(_, let upper, let lower): upper == nil && lower == nil
    case .frac, .sqrt, .grid: false
    }
  }

  func text(_ nodes: [MathNode]) -> some View {
    let spans = MathLinear.spans(of: .row(nodes))
    return Text(MathLinear.attributed(spans, scriptOffset: scriptOffset))
  }

  func box(_ node: MathNode, nesting: Int) -> AnyView {
    if isLine(node) {
      return AnyView(text([node]))
    }
    switch node {
    case .row(let items):
      return AnyView(row(items, nesting: nesting))
    case .frac(let numerator, let denominator):
      return AnyView(
        MathStack(axisIndex: 1, barIndex: 1, spacing: 2, barThickness: rule) {
          box(numerator, nesting: nesting + 1).padding(.horizontal, 2)
          Rectangle()
          box(denominator, nesting: nesting + 1).padding(.horizontal, 2)
        }
        .font(nesting == 0 ? nil : .callout)
        .padding(.horizontal, 2))
    case .sqrt(let radicand, let index):
      return AnyView(
        HStack(alignment: .mathAxis, spacing: 0) {
          if let index {
            box(index, nesting: nesting + 2).font(.caption2).offset(y: -6).padding(.trailing, -2)
          }
          // The sign is drawn over the room left for it, so it is as tall as the radicand and asks
          // for no height of its own.
          box(radicand, nesting: nesting)
            .padding(.top, 3)
            .padding(.leading, 12)
            .padding(.trailing, 2)
            .overlay(alignment: .top) { Rectangle().frame(height: rule).padding(.leading, 10) }
            .overlay(alignment: .leading) {
              MathRadical().stroke(style: StrokeStyle(lineWidth: rule, lineCap: .round, lineJoin: .round))
                .frame(width: 10)
            }
        }
        .padding(.leading, 1))
    case .op(let symbol, let upper, let lower):
      return AnyView(limits(symbol: symbol, upper: upper, lower: lower, nesting: nesting))
    case .scripts(let base, let sup, let sub):
      return AnyView(scripted(base: base, sup: sup, sub: sub, nesting: nesting))
    case .fenced(let open, let close, let body):
      return AnyView(fenced(open: open, close: close, nesting: nesting) { box(body, nesting: nesting) })
    case .accent(let base, _):
      return box(base, nesting: nesting)
    case .grid(let rows, let open, let close, let style):
      return AnyView(grid(rows: rows, open: open, close: close, style: style, nesting: nesting))
    case .run, .space:
      return AnyView(text([node]))
    }
  }

  /// A row: runs of lines are one `Text`, the rest are boxes, all on the maths axis.
  func row(_ items: [MathNode], nesting: Int) -> some View {
    var pieces: [AnyView] = []
    var line: [MathNode] = []
    func flush() {
      if !line.isEmpty { pieces.append(AnyView(text(line))) }
      line = []
    }
    for item in items {
      if isLine(item) {
        line.append(item)
      } else {
        flush()
        pieces.append(box(item, nesting: nesting))
      }
    }
    flush()
    return HStack(alignment: .mathAxis, spacing: 2) {
      ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in piece }
    }
  }

  /// A big operator with limits: above and below for sums, products and limits, beside for integrals.
  func limits(symbol: String, upper: MathNode?, lower: MathNode?, nesting: Int) -> some View {
    let isIntegral = "∫∬∭∮".contains(symbol)
    return Group {
      if isIntegral {
        scripted(base: .run(symbol, .roman), sup: upper, sub: lower, nesting: nesting, large: true)
      } else {
        let symbolView = Text(verbatim: symbol).font(symbol.count == 1 ? .title2 : .body)
        let hasUpper = upper != nil
        MathStack(axisIndex: hasUpper ? 1 : 0, barIndex: nil, spacing: 1) {
          if let upper { box(upper, nesting: nesting + 1).font(.footnote) }
          symbolView
          if let lower { box(lower, nesting: nesting + 1).font(.footnote) }
        }
        .padding(.horizontal, 1)
      }
    }
  }

  /// A base that is not a line, or an integral sign, with scripts at its corners.
  func scripted(base: MathNode, sup: MathNode?, sub: MathNode?, nesting: Int, large: Bool = false) -> some View {
    MathScripts(hasSup: sup != nil, hasSub: sub != nil) {
      if case .run(let symbol, _) = base, large {
        Text(verbatim: symbol).font(.title2)
      } else {
        box(base, nesting: nesting)
      }
      if let sup { box(sup, nesting: nesting + 1).font(.footnote) }
      if let sub { box(sub, nesting: nesting + 1).font(.footnote) }
    }
  }

  /// A body between delimiters drawn over the room left beside it, the height of the body.
  func fenced(open: String, close: String, nesting: Int, @ViewBuilder body: () -> some View) -> some View {
    body()
      .padding(.leading, open.isEmpty ? 0 : MathFence.width(of: open) + 3)
      .padding(.trailing, close.isEmpty ? 0 : MathFence.width(of: close) + 3)
      .padding(.vertical, 1)
      .overlay(alignment: .leading) { fence(open) }
      .overlay(alignment: .trailing) { fence(close) }
  }

  @ViewBuilder func fence(_ glyph: String) -> some View {
    if !glyph.isEmpty {
      MathFence(glyph: glyph)
        .stroke(style: StrokeStyle(lineWidth: rule, lineCap: .round, lineJoin: .round))
        .frame(width: MathFence.width(of: glyph))
    }
  }

  func grid(rows: [[MathNode]], open: String, close: String, style: MathGridStyle, nesting: Int) -> some View {
    fenced(open: open, close: close, nesting: nesting) {
      Grid(alignment: style == .matrix ? .center : .leading, horizontalSpacing: 14, verticalSpacing: 4) {
        ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
          GridRow {
            ForEach(Array(cells.enumerated()), id: \.offset) { column, cell in
              box(cell, nesting: nesting + 1)
                .gridColumnAlignment(style == .aligned && column == 0 ? .trailing : (style == .matrix ? .center : .leading))
            }
          }
        }
      }
      .padding(.horizontal, 2)
    }
  }
}

/// A display formula for a block: the expression, then nothing else.
struct MathBlockView: View {
  let node: MathNode

  var body: some View {
    MathNodeView(node: node)
  }
}

/// A `$$ … $$` block: the formula laid out when the parser knows every command in it, its LaTeX source
/// as a listing when it does not. Copy always copies the source.
struct MarkdownMathBlock: View {
  let source: String

  var body: some View {
    if let node = MathParser.parse(source) {
      MarkdownCodeView(
        label: MarkdownStrings.mathematics, accessibilityLabel: MarkdownStrings.mathematics,
        copyLabel: MarkdownStrings.copySource, source: source, rendered: AnyView(MathBlockView(node: node)),
        spoken: MathLinear.plainText(of: node))
    } else {
      MarkdownCodeView(
        label: MarkdownStrings.mathematics, accessibilityLabel: MarkdownStrings.mathematics,
        copyLabel: MarkdownStrings.copySource, source: source)
    }
  }
}
