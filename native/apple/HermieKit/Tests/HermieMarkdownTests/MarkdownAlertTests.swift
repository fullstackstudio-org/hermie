import Foundation
import Testing

@testable import HermieMarkdown

/// The GitHub-style alert (`contract/markup/README.md` section 4): every example of the contract is an alert
/// of its kind with the body it names, or an ordinary quote.
@Suite("Alerts: which quotes are callouts") struct MarkdownAlertTests {
  private struct Example {
    let name: String
    let markdown: String
    let alert: String?
    let body: String?
  }

  private static let examples: [Example] = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    guard let data = try? Data(contentsOf: url.appendingPathComponent("contract/markup/examples.json")),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let list = root["alerts"] as? [[String: Any]]
    else {
      preconditionFailure("contract/markup/examples.json is not readable")
    }
    return list.map {
      Example(
        name: $0["name"] as? String ?? "", markdown: $0["markdown"] as? String ?? "", alert: $0["alert"] as? String,
        body: $0["body"] as? String)
    }
  }()

  /// The blocks of the first quote of a Markdown source, or nil when it has none.
  private func quote(of markdown: String) -> [MarkdownBlock]? {
    for block in MarkdownDocument(markdown).blocks {
      if case .quote(let blocks) = block.kind { return blocks }
    }
    return nil
  }

  /// The body as the contract writes it: paragraphs as their text, a list as dashes, blank lines between.
  private func written(_ blocks: [MarkdownBlock]) -> String {
    blocks.map { block -> String in
      switch block.kind {
      case .paragraph(let inline): inline.plainText
      case .list(let list):
        list.items.map { item in
          "- " + item.blocks.compactMap { if case .paragraph(let inline) = $0.kind { inline.plainText } else { nil } }.joined()
        }.joined(separator: "\n")
      default: "?"
      }
    }.joined(separator: "\n\n")
  }

  @Test func everyExampleOfTheContractIsWhatItSays() {
    #expect(Self.examples.count >= 4)

    for example in Self.examples {
      guard let blocks = quote(of: example.markdown) else {
        // Not a quote at all: nothing to be an alert.
        #expect(example.alert == nil, "\(example.name)")
        continue
      }

      let alert = MarkdownAlert.read(blocks)
      #expect(alert?.kind.rawValue == example.alert, "\(example.name)")

      if let alert, let body = example.body {
        #expect(written(alert.body) == body, "\(example.name)")
      }
    }
  }

  @Test func theMarkerKeepsTheTraitsOfWhatFollowsItOnTheNextLine() throws {
    let blocks = try #require(quote(of: "> [!WARNING]\n> This is **bold** and `code`."))
    let alert = try #require(MarkdownAlert.read(blocks))

    #expect(alert.kind == .warning)
    guard case .paragraph(let inline)? = alert.body.first?.kind else {
      Issue.record("no paragraph")
      return
    }
    #expect(inline.plainText == "This is bold and code.")
    #expect(inline.runs.contains { $0.traits.contains(.bold) && $0.text == "bold" })
    #expect(inline.runs.contains { $0.traits.contains(.code) && $0.text == "code" })
  }

  @Test func aMarkerAloneIsACalloutWithATitleOnly() throws {
    let blocks = try #require(quote(of: "> [!TIP]"))
    let alert = try #require(MarkdownAlert.read(blocks))
    #expect(alert.kind == .tip)
    #expect(alert.body.isEmpty)
  }

  @Test func anOrdinaryQuoteIsNotAnAlert() throws {
    for markdown in ["> Just a quote.", "> - a list\n> - first", "> ## A heading", "> [link](https://example.org)"] {
      let blocks = try #require(quote(of: markdown))
      #expect(MarkdownAlert.read(blocks) == nil, "\(markdown)")
    }
    #expect(MarkdownAlert.read([]) == nil)
  }

  @Test func theFiveKindsAreTheFiveMarkers() {
    #expect(MarkdownAlertKind.allCases.map(\.rawValue) == ["note", "tip", "important", "warning", "caution"])
    #expect(MarkdownAlertKind.allCases.map(\.marker) == ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])
  }
}
