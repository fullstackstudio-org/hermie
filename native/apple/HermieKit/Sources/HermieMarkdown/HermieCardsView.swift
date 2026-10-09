import SwiftUI

// The `hermie-cards` renderer: SwiftUI over a `HermieCardsSpec` that already passed validation
// (`HermieCards.swift`). Nothing here decides whether a block is a set of cards, and nothing a reply wrote is
// handed to anything but `Text`: a title, a subtitle, a tag and a connector label are text, an icon is a
// symbol picked from the closed table (`HermieCardIcons`), and a colour is the tint or a system colour. No
// image is loaded and no link is made, whatever the block says.

/// Every word a cards block shows or speaks. English here; the app supplies its own language through
/// `EnvironmentValues.markdownCardsLabels`, because this target owns no string catalog.
public struct MarkdownCardsLabels: Sendable {
  /// What a screen reader calls the block when it has no title.
  public var name: String
  /// The sentence a screen reader gets for one card.
  public var words: HermieCardsSpeech.Words
  public var copySource: String
  public var moreOptions: String
  /// Show source / Show rendered / Copied.
  public var code: MarkdownCodeStrings

  public init(
    name: String, words: HermieCardsSpeech.Words, copySource: String, moreOptions: String, code: MarkdownCodeStrings
  ) {
    self.name = name
    self.words = words
    self.copySource = copySource
    self.moreOptions = moreOptions
    self.code = code
  }

  public static let english = MarkdownCardsLabels(
    name: "Cards",
    words: HermieCardsSpeech.Words(
      card: { position, total, title in "Card \(position) of \(total), \(title)" },
      highlighted: "highlighted",
      tags: { "tags \($0)" },
      then: { "then: \($0)" }),
    copySource: MarkdownStrings.copySource,
    moreOptions: "More options",
    code: MarkdownCodeStrings(
      copy: MarkdownStrings.copy, copied: MarkdownStrings.copied, showSource: MarkdownStrings.showSource,
      showRendered: "Show cards")
  )
}

extension EnvironmentValues {
  /// The words of a cards block. The default is English; the app's views set their own.
  @Entry public var markdownCardsLabels = MarkdownCardsLabels.english
}

/// A cards block: the picture, with its title, and in its corner the "..." button (`MarkdownDrawnBlock`).
struct MarkdownCardsBlock: View {
  let spec: HermieCardsSpec
  let source: String

  @Environment(\.markdownCardsLabels) private var labels

  var body: some View {
    MarkdownDrawnBlock(
      source: source, name: spec.title ?? labels.name,
      strings: MarkdownDrawnStrings(
        moreOptions: labels.moreOptions, showSource: labels.code.showSource, showRendered: labels.code.showRendered,
        copySource: labels.copySource, copied: labels.code.copied)
    ) {
      HermieCardsView(spec: spec)
    }
  }
}

/// The picture: a stack of cards joined by connectors, or a grid of them.
struct HermieCardsView: View {
  let spec: HermieCardsSpec

  @Environment(\.markdownCardsLabels) private var labels
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var gridMinimum: CGFloat = 150
  @ScaledMetric(relativeTo: .body) private var gap: CGFloat = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let title = spec.title {
        Text(title)
          .font(.subheadline.weight(.semibold))
          // Room for the "..." button in the corner.
          .padding(.trailing, 36)
          .accessibilityHidden(true)
      }

      switch spec.layout {
      case .stack:
        stack
      case .grid:
        CardsGridLayout(minimumWidth: gridMinimum, spacing: gap, singleColumn: typeSize.isAccessibilitySize) {
          ForEach(Array(spec.cards.enumerated()), id: \.offset) { index, card in
            cardView(card, index: index, fillsRow: true)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var stack: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(spec.cards.enumerated()), id: \.offset) { index, card in
        cardView(card, index: index)

        if index < spec.cards.count - 1 {
          CardsConnector(kind: spec.connector ?? .arrow, label: card.next)
        }
      }
    }
  }

  private func cardView(_ card: HermieCard, index: Int, fillsRow: Bool = false) -> some View {
    CardView(card: card, fillsRow: fillsRow)
      // One element per card, read as one sentence; the connector's label is part of it.
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(HermieCardsSpeech.sentence(spec, index: index, words: labels.words))
  }
}

/// One card: an icon tile, the title, the subtitle and the tags.
struct CardView: View {
  let card: HermieCard
  /// In a grid the card takes the height of its row, so the cards of a row are one height.
  var fillsRow = false

  @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 36
  @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 12

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      if let icon = card.icon {
        Image(systemName: HermieCardIcons.symbol(for: icon))
          .font(.body.weight(.medium))
          .foregroundStyle(card.highlight ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
          .frame(width: tile, height: tile)
          .background(
            card.highlight ? AnyShapeStyle(.tint.opacity(0.16)) : AnyShapeStyle(.secondary.opacity(0.14)),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }

      VStack(alignment: .leading, spacing: 3) {
        Text(card.title)
          .font(.body.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)

        if let subtitle = card.subtitle {
          Text(subtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if !card.tags.isEmpty {
          WrapLayout(spacing: 6) {
            ForEach(card.tags, id: \.self) { tag in
              Text(tag)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .overlay(Capsule().strokeBorder(.secondary.opacity(0.35), lineWidth: 1))
            }
          }
          .padding(.top, 3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(padding)
    .frame(maxWidth: .infinity, maxHeight: fillsRow ? .infinity : nil, alignment: .topLeading)
    .background(
      card.highlight ? AnyShapeStyle(.tint.opacity(0.09)) : AnyShapeStyle(.quaternary.opacity(0.4)),
      in: RoundedRectangle(cornerRadius: 14, style: .continuous)
    )
    .overlay {
      if card.highlight {
        RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.tint, lineWidth: 1.5)
      }
    }
  }
}

/// What joins a card to the next in a stack: a line, an arrow or only space, under the icon's centre, and the
/// label beside it. Decoration: the label is spoken as part of the card it leaves.
struct CardsConnector: View {
  let kind: HermieCardsConnector
  let label: String?

  @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 36
  @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 12
  @ScaledMetric(relativeTo: .body) private var height: CGFloat = 28

  var body: some View {
    HStack(spacing: 8) {
      if kind != .none {
        VStack(spacing: 0) {
          Rectangle().fill(.secondary.opacity(0.55)).frame(width: 1.5)
          if kind == .arrow {
            Image(systemName: "arrowtriangle.down.fill")
              .font(.system(size: 7))
              .foregroundStyle(.secondary.opacity(0.75))
          }
        }
        .frame(width: 12, height: height)
      }

      if let label {
        Text(label)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, minHeight: kind == .none ? 8 : height, alignment: .leading)
    // Under the icon tile's centre.
    .padding(.leading, padding + tile / 2 - 6)
    .accessibilityHidden(true)
  }
}

// MARK: - Layouts

/// Cards side by side, in equal columns that wrap, each row as tall as its tallest card. One column when the
/// text is very large or the width is narrow. (`LazyVGrid` would leave the shorter cards of a row short.)
struct CardsGridLayout: Layout {
  var minimumWidth: CGFloat
  var spacing: CGFloat
  var singleColumn: Bool

  struct Cache {
    var columns = 1
    var columnWidth: CGFloat = 0
    var rowHeights: [CGFloat] = []
  }

  func makeCache(subviews: Subviews) -> Cache { Cache() }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
    let width = proposal.width ?? minimumWidth
    measure(width: width, subviews: subviews, cache: &cache)
    let height = cache.rowHeights.reduce(0, +) + spacing * CGFloat(max(0, cache.rowHeights.count - 1))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
    measure(width: bounds.width, subviews: subviews, cache: &cache)
    var y = bounds.minY

    for (row, height) in cache.rowHeights.enumerated() {
      for column in 0..<cache.columns {
        let index = row * cache.columns + column
        guard index < subviews.count else { break }
        let x = bounds.minX + CGFloat(column) * (cache.columnWidth + spacing)
        subviews[index].place(
          at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: cache.columnWidth, height: height))
      }
      y += height + spacing
    }
  }

  private func measure(width: CGFloat, subviews: Subviews, cache: inout Cache) {
    guard width.isFinite, width > 0 else {
      cache.columns = 1
      cache.columnWidth = minimumWidth
      cache.rowHeights = subviews.map { $0.sizeThatFits(ProposedViewSize(width: minimumWidth, height: nil)).height }
      return
    }

    let fit = max(1, Int(((width + spacing) / (minimumWidth + spacing)).rounded(.down)))
    let columns = singleColumn ? 1 : min(fit, max(1, subviews.count))
    let columnWidth = (width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
    var heights: [CGFloat] = []
    var index = 0

    while index < subviews.count {
      let row = subviews[index..<min(index + columns, subviews.count)]
      heights.append(row.map { $0.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height }.max() ?? 0)
      index += columns
    }

    cache.columns = columns
    cache.columnWidth = columnWidth
    cache.rowHeights = heights
  }
}

/// Chips that wrap onto a new line when the width runs out.
struct WrapLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let rows = arrange(width: width, subviews: subviews)
    let height = rows.last.map { $0.y + $0.height } ?? 0
    let used = rows.map(\.width).max() ?? 0
    return CGSize(width: proposal.width == nil ? used : min(used, width), height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for row in arrange(width: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.members {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), anchor: .topLeading, proposal: .unspecified)
        x += size.width + spacing
      }
    }
  }

  private struct Row {
    var members: [Int] = []
    var y: CGFloat = 0
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = []
    var current = Row()

    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let needed = current.members.isEmpty ? size.width : current.width + spacing + size.width

      if !current.members.isEmpty, needed > width {
        rows.append(current)
        current = Row(y: current.y + current.height + spacing)
      }

      current.width = current.members.isEmpty ? size.width : current.width + spacing + size.width
      current.height = max(current.height, size.height)
      current.members.append(index)
    }

    if !current.members.isEmpty { rows.append(current) }
    return rows
  }
}
