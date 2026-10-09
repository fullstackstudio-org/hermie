import SwiftUI

/// A Markdown table: a header row on a tinted band, the body rows under it,
/// columns shared by both and aligned the way the delimiter row says.
///
/// Every cell is stretched to its column (a header cell to its row too), so
/// the band runs unbroken across the header and an alignment holds across the
/// whole column, not just inside the cell's own text. Cells are `Text` built
/// from the parsed inline content, the same safe path as a paragraph.
struct MarkdownTableView: View {
  let table: MarkdownTable
  @ScaledMetric(relativeTo: .body) private var cellPadding: CGFloat = 8
  /// The widest a cell's text gets before it wraps, once the table no longer
  /// fits at its natural width.
  @ScaledMetric(relativeTo: .body) private var wrapWidth: CGFloat = 220

  var body: some View {
    // The table at its natural width when that fits; else with its long cells
    // wrapped, when that fits; else wrapped and scrolling sideways. A scroll
    // view that has nothing to scroll would still take a drag that started on
    // it, so it is the last resort.
    ViewThatFits(in: .horizontal) {
      grid(wrapAt: .infinity)
      grid(wrapAt: wrapWidth)
      ScrollView(.horizontal) {
        grid(wrapAt: wrapWidth)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(MarkdownStrings.table(columns: table.header.count, rows: table.rows.count))
  }

  private func grid(wrapAt maxTextWidth: CGFloat) -> some View {
    Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
      GridRow {
        ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
          self.cell(cell, row: -1, column: column, maxTextWidth: maxTextWidth)
            .font(.body.bold())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlignment(column))
            .background(.quaternary.opacity(0.5))
            .accessibilityAddTraits(.isHeader)
            .modifier(MarkdownTableCellFrameReporter(row: -1, column: column, part: .cell))
        }
      }
      ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
        Divider()
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
            self.cell(cell, row: index, column: column, maxTextWidth: maxTextWidth)
              .frame(maxWidth: .infinity, alignment: frameAlignment(column))
              .modifier(MarkdownTableCellFrameReporter(row: index, column: column, part: .cell))
          }
        }
      }
    }
    .fixedSize()
    .coordinateSpace(.named(MarkdownTableCellFrame.space))
    .overlay {
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(.quaternary)
    }
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  private func cell(_ inline: MarkdownInline, row: Int, column: Int, maxTextWidth: CGFloat) -> some View {
    MarkdownTableCellText(maxWidth: maxTextWidth) {
      MarkdownInlineText(inline: inline, codeBackground: Color.secondary.opacity(0.14))
        .multilineTextAlignment(textAlignment(column))
    }
    .padding(cellPadding)
    .modifier(MarkdownTableCellFrameReporter(row: row, column: column, part: .content))
  }

  private func alignment(_ column: Int) -> MarkdownColumnAlignment? {
    column < table.alignments.count ? table.alignments[column] : nil
  }

  private func frameAlignment(_ column: Int) -> Alignment {
    switch alignment(column) {
    case .center: .center
    case .trailing: .trailing
    default: .leading
    }
  }

  private func textAlignment(_ column: Int) -> TextAlignment {
    switch alignment(column) {
    case .center: .center
    case .trailing: .trailing
    default: .leading
    }
  }
}

/// A cell's text at its natural width, up to `maxWidth`, wrapping beyond it.
///
/// A grid sizes its columns from its cells' ideal widths, and a `Text`'s ideal
/// width is all of it on one line. `.frame(maxWidth:)` would clamp the frame
/// but lay the text out at that ideal width all the same, so it would spill
/// out of its column. This offers the clamped width to the text itself, which
/// then wraps, and keeps it when the grid later offers the full column.
struct MarkdownTableCellText: Layout {
  var maxWidth: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let text = subviews.first else { return .zero }
    let natural = text.sizeThatFits(.unspecified)
    let width = min(natural.width, maxWidth, proposal.width ?? .infinity)
    guard width < natural.width else { return natural }
    return text.sizeThatFits(ProposedViewSize(width: width, height: nil))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

/// Where one table cell landed, in the table's coordinates: the whole cell,
/// stretched to its column, or its content (the text and its padding). Row -1
/// is the header. For tests: nothing is measured unless
/// `markdownTableCellFrames` is set.
struct MarkdownTableCellFrame: Hashable, Sendable {
  enum Part: Hashable, Sendable {
    case cell
    case content
  }

  static let space = "HermieMarkdownTable"
  var row: Int
  var column: Int
  var part: Part
  var frame: CGRect
}

extension EnvironmentValues {
  @Entry var markdownTableCellFrames: MarkdownTableCellFrameSink? = nil
}

/// Receives the cells' frames; compared by identity, so setting one does not
/// invalidate the table on every update the way a bare closure would.
final class MarkdownTableCellFrameSink: Equatable, Sendable {
  let report: @MainActor @Sendable (MarkdownTableCellFrame) -> Void

  init(_ report: @escaping @MainActor @Sendable (MarkdownTableCellFrame) -> Void) {
    self.report = report
  }

  static func == (lhs: MarkdownTableCellFrameSink, rhs: MarkdownTableCellFrameSink) -> Bool { lhs === rhs }
}

private struct MarkdownTableCellFrameReporter: ViewModifier {
  let row: Int
  let column: Int
  let part: MarkdownTableCellFrame.Part
  @Environment(\.markdownTableCellFrames) private var sink

  func body(content: Content) -> some View {
    if let sink {
      content.onGeometryChange(for: CGRect.self) { $0.frame(in: .named(MarkdownTableCellFrame.space)) } action: {
        sink.report(MarkdownTableCellFrame(row: row, column: column, part: part, frame: $0))
      }
    } else {
      content
    }
  }
}
