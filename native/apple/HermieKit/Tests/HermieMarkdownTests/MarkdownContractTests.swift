import Foundation
import Testing

@testable import HermieMarkdown

/// The Swift block structure against the TypeScript reference, case by case.
@Suite struct MarkdownContractTests {
  /// Cases the port deliberately does not follow, with the reason. Each is a
  /// quirk of the TypeScript lexer rather than behaviour worth keeping.
  static let exclusions: [String: String] = [
    // marked's block-math extension reports a start at every `\[` (and `$$`),
    // so the lexer clips the paragraph there; when no display block follows,
    // the two halves are joined again with a line break. The reader sees a
    // break that was never written. The port keeps the sentence whole.
    "inline/escapes":
      "TS paragraph clip at a mid-line `\\[` inserts a line break",
    // marked keeps the trailing space of a paragraph's last line; CommonMark
    // (and so Foundation) strips it. Invisible either way.
    "inline/unterminated paren math":
      "trailing space at the end of a paragraph: kept by marked, stripped by CommonMark"
  ]

  static let groups = ["blocks", "inline", "preprocess", "streaming"]

  @Test(arguments: groups)
  func preprocessingMatches(group: String) throws {
    let fixtures = try MarkdownFixture.load(group)
    #expect(!fixtures.isEmpty)
    var failures: [String] = []
    for fixture in fixtures {
      let output = MarkdownPreprocessor.preprocess(fixture.input)
      if output != fixture.preprocessed {
        failures.append("\(fixture.name): \(output.debugDescription) != \(fixture.preprocessed.debugDescription)")
      }
    }
    report(failures, "\(group) preprocess: \(failures.count) of \(fixtures.count) differ")
  }

  @Test(arguments: groups)
  func blocksMatch(group: String) throws {
    let fixtures = try MarkdownFixture.load(group)
    var failures: [String] = []
    var compared = 0
    for fixture in fixtures where Self.exclusions["\(group)/\(fixture.name)"] == nil {
      compared += 1
      let actual = NeutralShape.blocks(MarkdownDocument(fixture.input).blocks)
      if actual != fixture.blocks {
        failures.append("\(fixture.name)\n  input:    \(fixture.input.debugDescription)\n  swift:    \(actual)\n  expected: \(fixture.blocks)")
      }
    }
    print("markdown contract \(group): \(compared - failures.count)/\(compared) equal, \(fixtures.count - compared) excluded")
    report(failures, "\(group) blocks: \(failures.count) of \(compared) differ")
  }

  /// The same prefixes fed to one document in order, as a stream: the
  /// incremental path must land exactly where a fresh parse does.
  @Test func streamingIncrementallyMatches() throws {
    let fixtures = try MarkdownFixture.load("streaming")
    var document = MarkdownDocument()
    var failures: [String] = []
    for fixture in fixtures where Self.exclusions["streaming/\(fixture.name)"] == nil {
      if !fixture.input.hasPrefix(document.text) {
        document = MarkdownDocument()
      }
      document.update(text: fixture.input)
      let actual = NeutralShape.blocks(document.blocks)
      if actual != fixture.blocks {
        failures.append("\(fixture.name)\n  swift:    \(actual)\n  expected: \(fixture.blocks)")
      }
    }
    report(failures, "streaming incrementally: \(failures.count) differ")
  }
}

/// One expectation for a batch of comparisons, with every failure printed.
func report(_ failures: [String], _ summary: String) {
  for failure in failures {
    print("MISMATCH " + failure)
  }
  #expect(failures.isEmpty, Comment(rawValue: summary))
}
