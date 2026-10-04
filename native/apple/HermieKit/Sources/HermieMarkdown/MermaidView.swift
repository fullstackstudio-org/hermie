import SwiftUI

/// A `mermaid` fence: drawn when it is a flowchart or a pie, a labelled listing of its source when it is
/// anything else (a sequence diagram, a class diagram, a `subgraph`, half a diagram while it streams).
/// Either way Copy copies the source, and a drawn diagram has a toggle for it.
struct MarkdownMermaidBlock: View {
  let source: String

  var body: some View {
    if let diagram = MermaidParser.parse(source) {
      MarkdownCodeView(
        label: MarkdownStrings.diagram, accessibilityLabel: MarkdownStrings.diagram,
        copyLabel: MarkdownStrings.copySource, source: source, rendered: AnyView(MermaidDiagramView(diagram: diagram)),
        spoken: diagram.summary)
    } else {
      // Not drawn: a listing, named for what it is, so it is clear it is a diagram's source and not code.
      MarkdownCodeView(
        label: MarkdownStrings.mermaidDiagram, accessibilityLabel: MarkdownStrings.mermaidSource,
        copyLabel: MarkdownStrings.copySource, source: source)
    }
  }
}

struct MermaidDiagramView: View {
  let diagram: MermaidDiagram

  var body: some View {
    switch diagram {
    case .flowchart(let chart): MermaidFlowchartView(chart: chart)
    case .pie(let pie): MermaidPieView(pie: pie)
    }
  }
}

// MARK: - Flowchart

struct MermaidFlowchartView: View {
  let chart: MermaidFlowchart
  @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17

  var body: some View {
    let layout = MermaidLayout.layout(chart, bodyFontSize: bodySize)

    ZStack(alignment: .topLeading) {
      Canvas { context, _ in
        for edge in layout.edges { Self.draw(edge, in: &context, fontSize: layout.fontSize) }
        for node in layout.nodes { Self.draw(node, in: &context) }
      }
      .frame(width: layout.size.width, height: layout.size.height)

      ForEach(Array(layout.nodes.enumerated()), id: \.offset) { _, node in
        Text(node.lines.joined(separator: "\n"))
          .font(.system(size: layout.fontSize))
          .multilineTextAlignment(.center)
          .fixedSize()
          .frame(width: node.rect.width, height: node.rect.height)
          .position(x: node.rect.midX, y: node.rect.midY)
      }

      ForEach(Array(layout.edges.enumerated()), id: \.offset) { _, edge in
        if let label = edge.edge.label {
          Text(label)
            .font(.system(size: layout.fontSize - 1))
            .fixedSize()
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 3))
            .position(x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2)
        }
      }
    }
    .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
  }

  static func draw(_ edge: MermaidPlacedEdge, in context: inout GraphicsContext, fontSize: CGFloat) {
    var line = Path()
    line.move(to: edge.start)
    line.addLine(to: edge.end)
    let width: CGFloat = edge.edge.stroke == .thick ? 2.6 : 1.3
    let dash: [CGFloat] = edge.edge.stroke == .dotted ? [3, 3] : []
    context.stroke(
      line, with: .style(.foreground.opacity(0.7)),
      style: StrokeStyle(lineWidth: width, lineCap: .round, dash: dash))

    guard edge.edge.arrow else { return }
    let angle = atan2(edge.end.y - edge.start.y, edge.end.x - edge.start.x)
    let size: CGFloat = 7
    var head = Path()
    head.move(to: edge.end)
    head.addLine(to: CGPoint(x: edge.end.x - size * cos(angle - .pi / 7), y: edge.end.y - size * sin(angle - .pi / 7)))
    head.addLine(to: CGPoint(x: edge.end.x - size * cos(angle + .pi / 7), y: edge.end.y - size * sin(angle + .pi / 7)))
    head.closeSubpath()
    context.fill(head, with: .style(.foreground.opacity(0.7)))
  }

  static func draw(_ node: MermaidPlacedNode, in context: inout GraphicsContext) {
    let rect = node.rect
    var path = Path()
    switch node.node.shape {
    case .rect:
      path = Path(roundedRect: rect, cornerRadius: 3)
    case .round:
      path = Path(roundedRect: rect, cornerRadius: 10)
    case .stadium:
      path = Path(roundedRect: rect, cornerRadius: rect.height / 2)
    case .circle:
      path = Path(ellipseIn: rect)
    case .rhombus:
      path.addLines([
        CGPoint(x: rect.midX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.midY),
        CGPoint(x: rect.midX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.midY)
      ])
      path.closeSubpath()
    case .hexagon:
      let inset = min(14, rect.width / 4)
      path.addLines([
        CGPoint(x: rect.minX + inset, y: rect.minY), CGPoint(x: rect.maxX - inset, y: rect.minY),
        CGPoint(x: rect.maxX, y: rect.midY), CGPoint(x: rect.maxX - inset, y: rect.maxY),
        CGPoint(x: rect.minX + inset, y: rect.maxY), CGPoint(x: rect.minX, y: rect.midY)
      ])
      path.closeSubpath()
    case .subroutine:
      path = Path(roundedRect: rect, cornerRadius: 3)
    }
    context.fill(path, with: .style(.foreground.opacity(0.08)))
    context.stroke(path, with: .style(.foreground.opacity(0.55)), lineWidth: 1.2)
    if node.node.shape == .subroutine {
      var bars = Path()
      for x in [rect.minX + 7, rect.maxX - 7] {
        bars.move(to: CGPoint(x: x, y: rect.minY))
        bars.addLine(to: CGPoint(x: x, y: rect.maxY))
      }
      context.stroke(bars, with: .style(.foreground.opacity(0.55)), lineWidth: 1.2)
    }
  }
}

// MARK: - Pie

struct MermaidPieView: View {
  let pie: MermaidPie
  @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 132

  static let palette: [Color] = [.blue, .orange, .green, .purple, .red, .teal, .yellow, .pink, .indigo, .brown]

  var body: some View {
    let arcs = pie.arcs

    VStack(alignment: .leading, spacing: 8) {
      if let title = pie.title {
        Text(title).font(.subheadline.weight(.semibold))
      }
      HStack(alignment: .center, spacing: 16) {
        Canvas { context, size in
          let centre = CGPoint(x: size.width / 2, y: size.height / 2)
          let outer = min(size.width, size.height) / 2
          let inner = outer * 0.58
          for arc in arcs {
            context.fill(
              Self.sector(centre: centre, outer: outer, inner: inner, arc: arc), with: .color(Self.palette[arc.index % Self.palette.count]),
              style: FillStyle(eoFill: true))
          }
        }
        .frame(width: diameter, height: diameter)

        VStack(alignment: .leading, spacing: 5) {
          ForEach(Array(pie.slices.enumerated()), id: \.offset) { index, slice in
            HStack(alignment: .firstTextBaseline, spacing: 7) {
              RoundedRectangle(cornerRadius: 2)
                .fill(Self.palette[index % Self.palette.count])
                .frame(width: 10, height: 10)
              Text(slice.label)
                .font(.callout)
                .frame(maxWidth: 150, alignment: .leading)
              Spacer(minLength: 8)
              Text(verbatim: "\(MermaidParser.format(slice.value))  \(arcs[index].percent)%")
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
            }
          }
        }
        .fixedSize()
      }
    }
  }

  /// One slice of the ring; a slice that is the whole turn is the ring itself.
  static func sector(centre: CGPoint, outer: CGFloat, inner: CGFloat, arc: MermaidPieArc) -> Path {
    var path = Path()
    if arc.isFull {
      path.addEllipse(in: CGRect(x: centre.x - outer, y: centre.y - outer, width: outer * 2, height: outer * 2))
      path.addEllipse(in: CGRect(x: centre.x - inner, y: centre.y - inner, width: inner * 2, height: inner * 2))
      return path
    }
    // Zero degrees is twelve o'clock and the angle grows clockwise, as a pie is read.
    let from = Angle(degrees: arc.startDegrees - 90)
    let to = Angle(degrees: arc.endDegrees - 90)
    path.addArc(center: centre, radius: outer, startAngle: from, endAngle: to, clockwise: false)
    path.addArc(center: centre, radius: inner, startAngle: to, endAngle: from, clockwise: true)
    path.closeSubpath()
    return path
  }
}
