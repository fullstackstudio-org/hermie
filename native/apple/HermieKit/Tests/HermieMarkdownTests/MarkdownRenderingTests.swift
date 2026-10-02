import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Every block kind instantiates and lays out at the largest accessibility
/// size, in a narrow column, without growing wider than the column: wide
/// tables and long code lines scroll instead. No snapshots; the checks are on
/// measured sizes.
///
/// `swift test` runs this on macOS, where text styles do not scale with
/// `dynamicTypeSize` (the Mac has no Dynamic Type), so there it proves that
/// every kind builds, lays out and renders under the AX5 environment. On the
/// iOS Simulator (`xcodebuild test`) the same suite also proves the text
/// really grows.
@MainActor
@Suite struct MarkdownRenderingTests {
  nonisolated static let width: CGFloat = 320

  nonisolated static let samples: [(name: String, text: String)] = [
    ("paragraph", "A paragraph with **bold**, *italic*, ~~struck~~, `code`, $x^2$ and a [link](https://example.com)."),
    ("heading", "# A heading long enough to wrap onto a second line at the largest text sizes"),
    ("list", "- one\n  - nested item with more words than fit\n- [x] done\n- [ ] open\n\n3. three\n4. four"),
    ("quote", "> A quoted paragraph that is long enough to wrap.\n>\n> - with a list"),
    (
      "table",
      "| Registrar | Domain | Renews | Autorenew | Nameservers | Owner |\n|:--|:-:|--:|---|---|---|\n"
        + "| Registrar One | docs.example.org | 2026-10-04 | off | ns1.example.net | Operations |"
    ),
    ("code", "```sh\ncurl --silent https://example.org/api/v1/" + String(repeating: "segment/", count: 30) + "end\n```"),
    ("math", "$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$"),
    ("mermaid", "```mermaid\nflowchart TD\n  A[Start] --> B{Ready?}\n```"),
    ("rule", "above\n\n---\n\nbelow"),
    ("html", "<div>\nraw html\n</div>")
  ]

  func size(_ text: String, _ dynamicType: DynamicTypeSize) -> CGSize {
    let view = MarkdownView(MarkdownDocument(text))
      .environment(\.dynamicTypeSize, dynamicType)
      .frame(width: Self.width)
    #if os(macOS)
      let host = NSHostingController(rootView: view)
    #else
      let host = UIHostingController(rootView: view)
    #endif
    return host.sizeThatFits(in: CGSize(width: Self.width, height: .greatestFiniteMagnitude))
  }

  @Test(arguments: samples.map(\.name))
  func laysOutAtAccessibilityFive(name: String) throws {
    let text = try #require(Self.samples.first { $0.name == name }?.text)
    let document = MarkdownDocument(text)
    #expect(!document.blocks.isEmpty)

    let large = size(text, .large)
    let huge = size(text, .accessibility5)
    #expect(huge.width <= Self.width + 0.5, "\(name) is \(huge.width) wide")
    #expect(huge.height > 0)
    #expect(huge.height >= large.height, "\(name): \(huge.height) at AX5, \(large.height) at large")

    let renderer = ImageRenderer(
      content: MarkdownView(document)
        .environment(\.dynamicTypeSize, .accessibility5)
        .frame(width: Self.width)
    )
    renderer.proposedSize = ProposedViewSize(width: Self.width, height: nil)
    let image = try #require(renderer.cgImage)
    #expect(image.height > 0)
  }

  #if os(iOS)
    @Test(arguments: samples.map(\.name).filter { $0 != "rule" })
    func textGrowsWithDynamicType(name: String) throws {
      let text = try #require(Self.samples.first { $0.name == name }?.text)
      #expect(size(text, .accessibility5).height > size(text, .large).height)
    }
  #endif

  @Test func everyKindIsCovered() {
    var kinds = Set<String>()
    for sample in Self.samples {
      for block in MarkdownDocument(sample.text).blocks {
        kinds.insert(String(describing: block.kind).components(separatedBy: "(").first ?? "")
      }
    }
    #expect(
      kinds.isSuperset(of: ["paragraph", "heading", "list", "quote", "table", "code", "math", "mermaid", "rule", "html"]),
      "\(kinds.sorted())")
  }
}
