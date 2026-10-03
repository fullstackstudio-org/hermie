#if os(macOS)
  import AppKit
  import HermieMarkdown
  import SwiftUI
  import Testing

  @testable import HermieUI

  /// A bubble hugs its words: its width is the words' ideal width plus the padding, clamped to the
  /// cap, on either side. (On 0.2.2 every bubble was the full width, a one-letter message too.)
  @MainActor
  @Suite struct BubbleWidthTests {
    /// The bubble's words as the message views draw them: Markdown that does not fill its width.
    struct Words: View {
      let text: String
      let side: BubbleSide

      var body: some View {
        MessageBubble(side: side, tail: true, fill: side == .outgoing ? BubblePalette.outgoing : BubblePalette.incoming) {
          MarkdownView(MarkdownDocument(text))
            .environment(\.markdownFillsWidth, false)
        }
      }
    }

    /// The bubble's width in a column `column` points wide, as `BubbleColumn` places it.
    private func bubbleWidth(_ text: String, side: BubbleSide, column: CGFloat, width: BubbleWidth = .text) -> CGFloat {
      let host = NSHostingController(rootView: Words(text: text, side: side))
      return host.sizeThatFits(in: CGSize(width: width.cap(column), height: .greatestFiniteMagnitude)).width
    }

    /// The words' own width on one line.
    private func idealWidth(_ text: String) -> CGFloat {
      let host = NSHostingController(rootView: MarkdownView(MarkdownDocument(text)).environment(\.markdownFillsWidth, false))
      return host.sizeThatFits(in: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).width
    }

    /// The bubble's horizontal padding, both sides (`MessageBubble`).
    private let padding: CGFloat = 26

    @Test(arguments: [BubbleSide.outgoing, .incoming])
    func aOneLetterMessageIsASmallBubble(side: BubbleSide) {
      let width = bubbleWidth("a", side: side, column: 800)
      #expect(abs(width - (idealWidth("a") + padding)) <= 1, "\(width)")
      #expect(width < 60)
    }

    @Test(arguments: [BubbleSide.outgoing, .incoming])
    func aShortSentenceIsAsWideAsItsWords(side: BubbleSide) {
      let text = "Introduce yourself in one line."
      let width = bubbleWidth(text, side: side, column: 800)
      #expect(abs(width - (idealWidth(text) + padding)) <= 1, "\(width)")
      #expect(width < BubbleWidth.text.cap(800))
    }

    @Test(arguments: [BubbleSide.outgoing, .incoming])
    func aLongParagraphWrapsAtTheCapNotEarlier(side: BubbleSide) {
      let text = String(repeating: "A paragraph long enough to wrap several times over. ", count: 8)
      // A phone column (400: cap 300) and a wide Mac window (1600: cap 560).
      for column in [CGFloat(400), 1600] {
        let width = bubbleWidth(text, side: side, column: column)
        let cap = BubbleWidth.text.cap(column)
        #expect(width <= cap + 0.5, "column \(column): \(width) over the cap \(cap)")
        #expect(width >= cap - 24, "column \(column): \(width) wrapped well short of the cap \(cap)")
      }
    }

    @Test func aLongUnbreakableTokenStaysWithinTheCap() {
      let url = "https://example.com/" + String(repeating: "segment-without-any-space-", count: 12)
      let width = bubbleWidth(url, side: .outgoing, column: 400)
      #expect(width <= BubbleWidth.text.cap(400) + 0.5, "\(width)")
    }

    @Test func aTableOrCodeGetsTheWideCap() {
      let code = "```swift\n" + String(repeating: "let value = compute(input, with: options) ", count: 6) + "\n```"
      let width = bubbleWidth(code, side: .incoming, column: 1000, width: .wide)
      #expect(width <= BubbleWidth.wide.cap(1000) + 0.5)
      #expect(width > BubbleWidth.text.cap(1000), "\(width): the wide cap is used, not the text one")
    }
  }
#endif
