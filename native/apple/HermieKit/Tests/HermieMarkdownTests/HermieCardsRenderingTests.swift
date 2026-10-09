import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Drawn cards and callouts: they build, lay out in a narrow column at the largest text size, render, and an
/// invalid block (or the owner's own bubble) is the listing it was.
@MainActor
@Suite("hermie-cards: drawn") struct HermieCardsRenderingTests {
  private func render(_ view: some View, width: CGFloat) -> (size: CGSize, image: CGImage?) {
    let sized = view.frame(width: width)
    let fit = CGSize(width: width, height: .greatestFiniteMagnitude)
    #if os(macOS)
      let size = NSHostingController(rootView: sized).sizeThatFits(in: fit)
    #else
      let size = UIHostingController(rootView: sized).sizeThatFits(in: fit)
    #endif
    let renderer = ImageRenderer(content: sized)
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)

    return (size, renderer.cgImage)
  }

  private func spec(cards count: Int, layout: HermieCardsLayout = .stack, title: String? = "Plan") -> HermieCardsSpec {
    let cards = (0..<count).map { index in
      HermieCard(
        title: "Card \(index + 1)", subtitle: "A subtitle that is long enough to wrap in a narrow column",
        icon: index % 2 == 0 ? "server" : "generic", tags: index % 3 == 0 ? ["k3s", "Postgres", "Next.js"] : [],
        highlight: index == 1, next: layout == .stack && index < count - 1 && index % 2 == 0 ? "deploys to" : nil)
    }
    return HermieCardsSpec(title: title, layout: layout, connector: layout == .stack ? .arrow : nil, cards: cards)
  }

  private func block(_ spec: HermieCardsSpec) -> some View {
    MarkdownCardsBlock(spec: spec, source: "{}")
  }

  @Test(arguments: [2, 5, 12])
  func aStackLaysOutInANarrowColumn(count: Int) {
    let result = render(block(spec(cards: count)), width: 320)

    #expect(result.size.width <= 320.5, "\(count) cards are \(result.size.width) wide")
    #expect(result.size.height > CGFloat(count) * 50, "\(count) cards are \(result.size.height) tall")
    #expect(result.image != nil)
  }

  @Test func theStackGrowsWithTheNumberOfCards() {
    let few = render(block(spec(cards: 2)), width: 320).size.height
    let many = render(block(spec(cards: 6)), width: 320).size.height
    #expect(many > few * 2)
  }

  @Test(arguments: [2, 5, 12])
  func aGridWrapsIntoColumnsAndStaysInTheWidth(count: Int) {
    let wide = render(block(spec(cards: count, layout: .grid)), width: 420)
    let stacked = render(block(spec(cards: count)), width: 420)

    #expect(wide.size.width <= 420.5)
    #expect(wide.image != nil)
    #expect(wide.size.height < stacked.size.height, "two columns are shorter than a stack of \(count)")
  }

  @Test func aGridFallsToOneColumnInANarrowColumnAndAtAccessibilitySizes() {
    let narrow = render(block(spec(cards: 4, layout: .grid)), width: 200)
    let ax = render(block(spec(cards: 4, layout: .grid)).environment(\.dynamicTypeSize, .accessibility5), width: 420)

    #expect(narrow.size.width <= 200.5)
    #expect(ax.size.width <= 420.5)
    #expect(narrow.size.height > 4 * 50, "one card under the other")
    #expect(ax.size.height > 4 * 70)
  }

  @Test func everyKindOfConnectorLaysOutAtTheLargestSize() {
    for connector in HermieCardsConnector.allCases {
      var spec = spec(cards: 3)
      spec.connector = connector
      let result = render(block(spec).environment(\.dynamicTypeSize, .accessibility5), width: 320)

      #expect(result.size.width <= 320.5, "\(connector)")
      #expect(result.image != nil)
    }
  }

  @Test func theBlockViewDrawsValidCardsAndTheListingOtherwise() {
    func height(_ text: String, drawing: Bool = true) -> CGFloat {
      render(MarkdownView(MarkdownDocument(text)).environment(\.markdownDrawsBlocks, drawing), width: 320).size.height
    }

    let valid = "```hermie-cards\n{\"cards\":[{\"title\":\"One\",\"icon\":\"server\"},{\"title\":\"Two\"}]}\n```"
    let invalid = "```hermie-cards\n{\"cards\":[{\"title\":\"One\"}]}\n```"

    #expect(height(valid) > 120, "two cards and a connector")
    #expect(height(invalid) < 120, "a one-line listing")
    #expect(height(valid, drawing: false) < 120, "the owner's own bubble keeps what was typed")
  }

  @Test func aCalloutIsDrawnForEveryKindAndAQuoteIsNotWhenDrawingIsOff() {
    func height(_ text: String, drawing: Bool = true) -> CGFloat {
      render(MarkdownView(MarkdownDocument(text)).environment(\.markdownDrawsBlocks, drawing), width: 320).size.height
    }

    for kind in MarkdownAlertKind.allCases {
      let text = "> [!\(kind.marker)]\n> A sentence that says what the \(kind.rawValue) is about."
      let result = render(MarkdownView(MarkdownDocument(text)), width: 320)

      #expect(result.size.width <= 320.5, "\(kind)")
      #expect(result.image != nil)
      // The title line is added; the marker line is not drawn as text.
      #expect(height(text) > height(text, drawing: false) - 30, "\(kind)")
    }
  }

  @Test func aQuoteInsideACalloutIsAnOrdinaryQuote() {
    let nested = "> [!NOTE]\n> Outer.\n>\n> > [!TIP]\n> > Inner."
    let result = render(MarkdownView(MarkdownDocument(nested)), width: 320)

    #expect(result.size.width <= 320.5)
    #expect(result.size.height > 60)
  }
}
