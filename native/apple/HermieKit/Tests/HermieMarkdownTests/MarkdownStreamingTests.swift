import Foundation
import Synchronization
import Testing

@testable import HermieMarkdown

/// The Foundation parser, counting what it is asked to parse.
final class CountingParser: MarkdownParsing {
  private let inner = FoundationMarkdownParser()
  private let parsed = Mutex<[String]>([])

  var sources: [String] { parsed.withLock { $0 } }

  func parse(_ source: String) -> [MarkdownBlock] {
    parsed.withLock { $0.append(source) }
    return inner.parse(source)
  }
}

@Suite struct MarkdownStreamingTests {
  /// A long reply with every block kind, repeated until it passes `bytes`.
  static func longReply(bytes: Int) -> String {
    var sections: [String] = []
    var index = 0
    while sections.joined(separator: "\n\n").utf8.count < bytes {
      sections.append(
        """
        ## Section \(index)

        Paragraph \(index) with **bold**, *italic*, `code`, ~~gone~~ and a [link](https://example.com/\(index)).
        It wraps onto a second line with $x_\(index)^2$ in it.

        - item one of \(index)
          - nested item
        - [x] a done task
        - [ ] an open task

        1. first
        2. second

        > A quote in section \(index).

        | Key | Value |
        |:--|--:|
        | a\(index) | \(index * 7) |
        | b\(index) | \(index * 11) |

        ```swift
        let value\(index) = \(index)

        print(value\(index))
        ```

        $$
        \\sum_{i=0}^{\(index)} i
        $$

        ---
        """)
      index += 1
    }
    return sections.joined(separator: "\n\n")
  }

  @Test func appendingFiftyKilobytesInTwoHundredChunksParsesOnlyTheTail() throws {
    let full = Self.longReply(bytes: 50 * 1024)
    #expect(full.utf8.count >= 50 * 1024)

    let characters = Array(full)
    let chunkCount = 200
    let parser = CountingParser()
    var document = MarkdownDocument(parser: parser)
    var previous: [MarkdownBlock] = []
    var identityBreaks: [String] = []
    var settledReparses: [String] = []
    let clock = ContinuousClock()
    let started = clock.now

    for step in 1...chunkCount {
      let end = characters.count * step / chunkCount
      let start = characters.count * (step - 1) / chunkCount
      let before = document.sliceIDs
      document.append(String(characters[start..<end]))

      // Only the tail is parsed: a slice that existed before this chunk and
      // was not one of the last two is never handed to the parser again.
      let settledBefore = Set(before.dropLast(2))
      let reparsed = document.lastParsedSliceIDs.filter(settledBefore.contains)
      if !reparsed.isEmpty {
        settledReparses.append("step \(step): slices \(reparsed)")
      }

      // Everything before the tail keeps its identity and its content.
      let settled = max(0, previous.count - 6)
      if Array(document.blocks.prefix(settled)) != Array(previous.prefix(settled)) {
        identityBreaks.append("step \(step)")
      }
      previous = document.blocks
    }
    let elapsed = clock.now - started

    #expect(document.text == full)
    #expect(identityBreaks.isEmpty, Comment(rawValue: identityBreaks.joined(separator: ", ")))

    // The incremental result is exactly what a fresh parse gives.
    let fresh = MarkdownDocument(full)
    #expect(NeutralShape.blocks(document.blocks) == NeutralShape.blocks(fresh.blocks))

    #expect(settledReparses.isEmpty, Comment(rawValue: settledReparses.joined(separator: "; ")))

    // Every slice is parsed once when it appears; the only extra parses are
    // the open tail's, at most one per chunk.
    let finalSlices = fresh.parseCount
    #expect(document.parseCount == parser.sources.count)
    #expect(document.parseCount - finalSlices <= chunkCount)
    print(
      "streaming: \(full.utf8.count) bytes, \(chunkCount) chunks, \(document.blocks.count) blocks, "
        + "\(finalSlices) slices, \(document.parseCount) parses (fresh parse: \(fresh.parseCount)), \(elapsed)")
  }

  @Test func aTailParagraphKeepsItsIdentityWhileItGrows() {
    var document = MarkdownDocument("First paragraph.\n\nSecond")
    let before = document.blocks.map(\.id)
    document.append(" paragraph, still arriving")
    #expect(document.blocks.map(\.id) == before)
    #expect(document.blocks.last?.kind == .paragraph(MarkdownInline([MarkdownRun("Second paragraph, still arriving")])))
  }

  @Test func anUnterminatedFenceIsCodeFromItsFirstLine() {
    var document = MarkdownDocument("Here you go:\n\n```swift\nlet a")
    guard case .code(let code) = document.blocks.last?.kind else {
      Issue.record("expected a code block, got \(String(describing: document.blocks.last))")
      return
    }
    #expect(code.language == "swift")
    #expect(code.text == "let a")
    document.append(" = 1\n```\n\nAfter.")
    #expect(document.blocks.count == 3)
  }

  @Test func displayMathThatClosesLaterSwallowsWhatFollows() {
    var document = MarkdownDocument("Before.\n\n$$\nx\n\nstill maths")
    #expect(document.blocks.allSatisfy { if case .math = $0.kind { false } else { true } })
    document.append("\n$$\n\nAfter.")
    let kinds = document.blocks.map { block -> String in
      switch block.kind {
      case .math: "math"
      case .paragraph: "paragraph"
      default: "other"
      }
    }
    #expect(kinds == ["paragraph", "math", "paragraph"])
    #expect(NeutralShape.blocks(document.blocks) == NeutralShape.blocks(MarkdownDocument(document.text).blocks))
  }

  @Test func reasoningThatClosesReplacesTheTextBeforeIt() {
    var document = MarkdownDocument("<think>planning")
    #expect(document.blocks.isEmpty)
    document.append("</think>The answer.")
    #expect(document.blocks.map(\.kind) == [.paragraph(MarkdownInline([MarkdownRun("The answer.")]))])
  }
}
