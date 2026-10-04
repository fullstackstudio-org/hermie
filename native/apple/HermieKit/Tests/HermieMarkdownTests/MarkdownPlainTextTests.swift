import Testing

@testable import HermieMarkdown

/// `MarkdownPlainText` is a port of `packages/markdown/src/plain-text.ts` (`plainTextBlock`) and of the
/// Expo app's `messageLinks`; the expected strings below are what the TypeScript answers for the same
/// input, so the three clients copy the same words.
@Suite("Markdown to plain text and links")
struct MarkdownPlainTextTests {
  @Test("emphasis, code spans and strike-through lose their marks")
  func inline() {
    #expect(MarkdownPlainText.block("**Bold** and _it_ with `code` and ~~gone~~") == "Bold and it with code and gone")
    #expect(MarkdownPlainText.block("plain words only") == "plain words only")
  }

  @Test("block syntax goes, a fence keeps what is inside it, a table keeps its cells")
  func blocks() {
    let source = "# Heading\n\n- item one\n- [x] done\n1. first\n\n> quote\n\n```ts\nconst *a* = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    #expect(MarkdownPlainText.block(source) == "Heading\n\nitem one\ndone\nfirst\n\nquote\n\nconst *a* = 1\n\n a   b\n 1   2")
  }

  @Test("a link is its text, an image its alt text, snake_case stays")
  func links() {
    let source = "See [the docs](https://example.com/a) and <https://example.org> and ![pic](x.png) and snake_case_name."
    #expect(MarkdownPlainText.block(source) == "See the docs and https://example.org and pic and snake_case_name.")
  }

  @Test("blank runs shrink to one empty line, trailing blanks go, escapes are undone")
  func whitespace() {
    #expect(MarkdownPlainText.block("Line one  \n\n\n\nLine two\\*escaped\\*") == "Line one\n\nLine two*escaped*")
    #expect(MarkdownPlainText.block("") == "")
  }

  @Test("the two copies differ only where there is markup")
  func differs() {
    #expect(MarkdownPlainText.differs("**bold**"))
    #expect(!MarkdownPlainText.differs("just words, nothing else"))
  }

  @Test("links: markdown, autolinks and bare URLs, in order, without duplicates")
  func linkList() {
    let text = "Read [the docs](https://a.example/docs \"title\"), then <https://b.example> or https://c.example/x and [again](https://a.example/docs)."
    #expect(MarkdownPlainText.links(in: text) == ["https://a.example/docs", "https://b.example", "https://c.example/x"])
    #expect(MarkdownPlainText.links(in: "no links here").isEmpty)
    #expect(MarkdownPlainText.links(in: "").isEmpty)
  }

  @Test("a message lists at most eight links")
  func linkCap() {
    let text = (1...12).map { "https://example.com/\($0)" }.joined(separator: " ")
    let links = MarkdownPlainText.links(in: text)
    #expect(links.count == MarkdownPlainText.maxLinks)
    #expect(links.first == "https://example.com/1")
  }
}
