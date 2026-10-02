import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// A reply drawn as native blocks.
///
/// Fonts are text styles, so everything follows Dynamic Type; spacing and
/// indents are `@ScaledMetric`; nothing has a fixed height. Links take the
/// environment's tint and open through its `OpenURLAction`. Text is
/// selectable. Each block view is `Equatable` on its block, so a settled block
/// is not re-rendered while the tail of a reply streams.
public struct MarkdownView: View {
  private let blocks: [MarkdownBlock]
  @ScaledMetric(relativeTo: .body) private var spacing: CGFloat = 10

  public init(_ document: MarkdownDocument) {
    self.blocks = document.blocks
  }

  public init(blocks: [MarkdownBlock]) {
    self.blocks = blocks
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(blocks) { block in
        MarkdownBlockView(block: block).equatable()
      }
    }
    .textSelection(.enabled)
  }
}

/// One block, of any kind.
public struct MarkdownBlockView: View, Equatable {
  public let block: MarkdownBlock

  public init(block: MarkdownBlock) {
    self.block = block
  }

  public nonisolated static func == (lhs: MarkdownBlockView, rhs: MarkdownBlockView) -> Bool {
    lhs.block == rhs.block
  }

  public var body: some View {
    switch block.kind {
    case .paragraph(let inline):
      MarkdownParagraphView(inline: inline)
    case .heading(let level, let inline):
      MarkdownHeadingView(level: level, inline: inline)
    case .list(let list):
      MarkdownListView(list: list)
    case .quote(let blocks):
      MarkdownQuoteView(blocks: blocks)
    case .table(let table):
      MarkdownTableView(table: table)
    case .code(let code):
      MarkdownCodeView(
        label: code.language ?? "", accessibilityLabel: MarkdownStrings.code(language: code.language),
        copyLabel: MarkdownStrings.copyCode, source: code.text)
    case .math(let source):
      MarkdownCodeView(
        label: MarkdownStrings.mathematics, accessibilityLabel: MarkdownStrings.mathematics,
        copyLabel: MarkdownStrings.copySource, source: source.trimmingCharacters(in: .whitespacesAndNewlines))
    case .mermaid(let source):
      MarkdownCodeView(
        label: MarkdownStrings.diagram, accessibilityLabel: MarkdownStrings.mermaidSource,
        copyLabel: MarkdownStrings.copySource, source: source)
    case .rule:
      Divider()
        .padding(.vertical, 4)
    case .html(let text):
      Text(text)
        .font(.callout.monospaced())
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// Nested blocks, type-erased so a list or quote can hold more of itself.
struct MarkdownBlockStack: View {
  let blocks: [MarkdownBlock]
  @ScaledMetric(relativeTo: .body) private var spacing: CGFloat = 6

  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(blocks) { block in
        AnyView(MarkdownBlockView(block: block).equatable())
      }
    }
  }
}

// MARK: - Text blocks

struct MarkdownParagraphView: View {
  let inline: MarkdownInline

  var body: some View {
    Text(inline.attributedString(codeBackground: Color.secondary.opacity(0.14)))
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
  }
}

struct MarkdownHeadingView: View {
  let level: Int
  let inline: MarkdownInline

  private var font: Font {
    switch level {
    case 1: .title2.bold()
    case 2: .title3.bold()
    case 3: .headline
    default: .subheadline.bold()
    }
  }

  private var headingLevel: AccessibilityHeadingLevel {
    switch level {
    case 1: .h1
    case 2: .h2
    case 3: .h3
    case 4: .h4
    case 5: .h5
    default: .h6
    }
  }

  var body: some View {
    Text(inline.attributedString())
      .font(font)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, level <= 2 ? 4 : 0)
      .accessibilityAddTraits(.isHeader)
      .accessibilityHeading(headingLevel)
  }
}

// MARK: - Lists

struct MarkdownListView: View {
  let list: MarkdownList
  @ScaledMetric(relativeTo: .body) private var markerWidth: CGFloat = 18
  @ScaledMetric(relativeTo: .body) private var gap: CGFloat = 6
  @ScaledMetric(relativeTo: .body) private var itemSpacing: CGFloat = 4

  var body: some View {
    VStack(alignment: .leading, spacing: itemSpacing) {
      ForEach(Array(list.items.enumerated()), id: \.offset) { offset, item in
        HStack(alignment: .firstTextBaseline, spacing: gap) {
          marker(for: item, at: offset)
            .frame(minWidth: markerWidth, alignment: list.ordered ? .trailing : .center)
          MarkdownBlockStack(blocks: item.blocks)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // One element per simple item; an item that holds more (a nested
        // list, a second paragraph) keeps its children navigable.
        .accessibilityElement(children: item.blocks.count <= 1 ? .combine : .contain)
      }
    }
  }

  @ViewBuilder
  private func marker(for item: MarkdownListItem, at offset: Int) -> some View {
    if let checked = item.checked {
      Image(systemName: checked ? "checkmark.square.fill" : "square")
        .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        .accessibilityLabel(checked ? MarkdownStrings.taskDone : MarkdownStrings.taskOpen)
    } else if list.ordered {
      // The text's own style, not a level below it: inside a reply drawn `.secondary` (an interim
      // one), `.secondary` here was two levels down and failed the contrast audit.
      Text(verbatim: "\(list.start + offset).")
        .monospacedDigit()
        .foregroundStyle(.primary)
    } else {
      Text(verbatim: "•")
        .foregroundStyle(.secondary)
        .accessibilityLabel(MarkdownStrings.bullet)
    }
  }
}

// MARK: - Quotes

struct MarkdownQuoteView: View {
  let blocks: [MarkdownBlock]
  @ScaledMetric(relativeTo: .body) private var inset: CGFloat = 12

  var body: some View {
    MarkdownBlockStack(blocks: blocks)
      .foregroundStyle(.secondary)
      .padding(.leading, inset)
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(alignment: .leading) {
        Capsule()
          .fill(.tint.opacity(0.6))
          .frame(width: 3)
      }
  }
}

// MARK: - Tables

struct MarkdownTableView: View {
  let table: MarkdownTable
  @ScaledMetric(relativeTo: .body) private var cellPadding: CGFloat = 8

  var body: some View {
    // The table at its natural width when that fits, scrolling sideways
    // when it does not: a scroll view that has nothing to scroll would still
    // take a drag that started on it.
    ViewThatFits(in: .horizontal) {
      grid
      ScrollView(.horizontal) {
        grid
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(MarkdownStrings.table(columns: table.header.count, rows: table.rows.count))
  }

  private var grid: some View {
    Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
      GridRow {
        ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
          self.cell(cell, column: column)
            .font(.body.bold())
            .gridColumnAlignment(alignment(column))
            .accessibilityAddTraits(.isHeader)
        }
      }
      .background(.quaternary.opacity(0.5))
      ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
        Divider()
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
            self.cell(cell, column: column)
          }
        }
      }
    }
    .fixedSize()
    .overlay {
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(.quaternary)
    }
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  private func cell(_ inline: MarkdownInline, column: Int) -> some View {
    Text(inline.attributedString(codeBackground: Color.secondary.opacity(0.14)))
      .multilineTextAlignment(textAlignment(column))
      .padding(cellPadding)
  }

  private func alignment(_ column: Int) -> HorizontalAlignment {
    switch column < table.alignments.count ? table.alignments[column] : nil {
    case .center: .center
    case .trailing: .trailing
    default: .leading
    }
  }

  private func textAlignment(_ column: Int) -> TextAlignment {
    switch column < table.alignments.count ? table.alignments[column] : nil {
    case .center: .center
    case .trailing: .trailing
    default: .leading
    }
  }
}

// MARK: - Code, mathematics and diagrams

/// A monospaced listing that scrolls sideways, with a label and a copy button.
/// Mathematics and Mermaid use it to show their source until they are drawn.
struct MarkdownCodeView: View {
  let label: String
  let accessibilityLabel: String
  let copyLabel: String
  let source: String

  @State private var copied = false
  @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 10

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        Spacer(minLength: 8)
        Button {
          MarkdownPasteboard.copy(source)
          copied = true
        } label: {
          Label(copied ? MarkdownStrings.copied : MarkdownStrings.copy, systemImage: copied ? "checkmark" : "doc.on.doc")
            .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(copied ? MarkdownStrings.copied : copyLabel)
        .task(id: copied) {
          guard copied else { return }
          try? await Task.sleep(for: .seconds(1.5))
          copied = false
        }
      }
      .padding(.horizontal, padding)
      .padding(.top, padding * 0.6)

      ScrollView(.horizontal) {
        Text(source)
          .font(.body.monospaced())
          .fixedSize(horizontal: true, vertical: false)
          .padding(padding)
          .accessibilityLabel(accessibilityLabel)
          .accessibilityValue(source)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
  }
}

enum MarkdownPasteboard {
  @MainActor
  static func copy(_ text: String) {
    #if os(iOS)
      UIPasteboard.general.string = text
    #elseif os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}
