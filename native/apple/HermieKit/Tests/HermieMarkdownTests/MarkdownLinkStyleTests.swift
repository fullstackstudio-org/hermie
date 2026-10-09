import SwiftUI
import Testing

@testable import HermieMarkdown

/// How a link in a reply is drawn: a dotted underline, and for a link to a web page a small arrow after it that
/// is a run of its own (not part of the link, not spoken). The schemes a tap may open are unchanged.
@Suite("Links: the reading-app style") struct MarkdownLinkStyleTests {
  private func attributed(_ runs: [MarkdownRun]) -> AttributedString {
    MarkdownInline(runs).attributedString()
  }

  private func glyphRuns(_ text: AttributedString) -> [AttributedString.Runs.Element] {
    text.runs.filter { String(text[$0.range].characters) == MarkdownInline.linkGlyph }
  }

  @Test(arguments: ["https://example.org/a", "http://example.org", "HTTPS://EXAMPLE.ORG/"])
  func aWebLinkCarriesTheArrowExactlyOnceAndIsNotPartOfIt(_ link: String) throws {
    let text = attributed([MarkdownRun("see "), MarkdownRun("the docs", link: link), MarkdownRun(" now")])
    let glyphs = glyphRuns(text)

    #expect(glyphs.count == 1)
    let mark = try #require(glyphs.first)
    #expect(mark.link == nil, "the arrow is not part of the link")
    #expect(String(text.characters) == "see the docs\(MarkdownInline.linkGlyph) now")

    // The link's own run is the words alone.
    let linked = text.runs.filter { $0.link != nil }
    #expect(linked.map { String(text[$0.range].characters) } == ["the docs"])
  }

  @Test func aLinkSplitIntoSeveralRunsByItsStylingGetsOneArrowAfterTheLastOne() {
    let text = attributed([
      MarkdownRun("a ", link: "https://example.org"), MarkdownRun("bold", traits: .bold, link: "https://example.org"),
      MarkdownRun(" end", link: "https://example.org"), MarkdownRun(" after")
    ])

    #expect(glyphRuns(text).count == 1)
    #expect(String(text.characters) == "a bold end\(MarkdownInline.linkGlyph) after")
  }

  @Test func twoDifferentLinksSideBySideGetOneArrowEach() {
    let text = attributed([
      MarkdownRun("one", link: "https://example.org/1"), MarkdownRun("two", link: "https://example.org/2")
    ])
    #expect(glyphRuns(text).count == 2)
  }

  @Test(arguments: ["mailto:a@example.org", "tel:+31612345678", "/api/files/x", "relative/path", "file:///etc/hosts"])
  func aLinkThatDoesNotLeaveForTheWebHasNoArrow(_ link: String) {
    let text = attributed([MarkdownRun("here", link: link)])

    #expect(glyphRuns(text).isEmpty)
    #expect(String(text.characters) == "here")
  }

  @Test func aLinkTheAppOpensIsUnderlinedWithDotsAndOneItDoesNotOpenKeepsAPlainUnderline() {
    let web = attributed([MarkdownRun("w", link: "https://example.org")])
    let mail = attributed([MarkdownRun("m", link: "mailto:a@example.org")])
    let inert = attributed([MarkdownRun("i", link: "relative/path")])

    #expect(web.runs.first?.link == URL(string: "https://example.org"))
    #expect(web.runs.first?.underlineStyle == Text.LineStyle(pattern: .dot))
    #expect(mail.runs.first?.underlineStyle == Text.LineStyle(pattern: .dot))
    #expect(inert.runs.first?.link == nil)
    #expect(inert.runs.first?.underlineStyle == Text.LineStyle.single)
  }

  @Test func plainTextHasNoArrowAndNoUnderline() {
    let text = attributed([MarkdownRun("just words")])
    #expect(String(text.characters) == "just words")
    #expect(text.runs.allSatisfy { $0.underlineStyle == nil && $0.link == nil })
  }

  @Test func theSchemesATapMayOpenAreUnchanged() {
    #expect(MarkdownInline.openableSchemes == ["http", "https", "mailto", "tel"])
    #expect(MarkdownInline.isOpenable(URL(string: "https://example.org")!))
    #expect(!MarkdownInline.isOpenable(URL(string: "javascript:alert(1)")!))
    #expect(!MarkdownInline.isOpenable(URL(string: "file:///etc/hosts")!))
  }

  @Test func aScreenReaderIsNotToldTheArrow() throws {
    let text = attributed([MarkdownRun("see "), MarkdownRun("the docs", link: "https://example.org"), MarkdownRun(".")])

    #expect(MarkdownInline.spokenText(of: text) == "see the docs.")
    #expect(MarkdownInline.spokenText(of: attributed([MarkdownRun("no link")])) == nil, "SwiftUI's own label stays")
    #expect(MarkdownInline.spokenText(of: attributed([MarkdownRun("m", link: "mailto:a@b.c")])) == nil)
  }

  @Test func aReplyThatMentionsTheArrowItselfIsLeftAlone() {
    let text = attributed([MarkdownRun("north-east \u{2197} is an arrow")])
    #expect(MarkdownInline.spokenText(of: text) == nil)
  }

  @Test func theBlocksOfAParsedReplyDrawTheArrowAfterAMarkdownLink() throws {
    let document = MarkdownDocument("Read [the guide](https://example.org/guide) first, or write to [us](mailto:a@example.org).")
    guard case .paragraph(let inline)? = document.blocks.first?.kind else {
      Issue.record("not a paragraph")
      return
    }
    let text = inline.attributedString()

    #expect(glyphRuns(text).count == 1)
    #expect(String(text.characters).hasPrefix("Read the guide\(MarkdownInline.linkGlyph) first"))
  }
}
