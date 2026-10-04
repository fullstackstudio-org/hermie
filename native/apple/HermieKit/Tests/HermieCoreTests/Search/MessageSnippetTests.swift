import Testing

@testable import HermieCore

@Suite struct MessageSnippetTests {
  @Test func aSnippetIsTidiedThenSplitAtWhatWasMatched() {
    let runs = MessageSnippet.runs("  ...the >>>invoic<<<es\n\nfrom   March\"}")

    #expect(
      runs == [
        .init(text: "...the ", match: false), .init(text: "invoic", match: true),
        .init(text: "es from March", match: false),
      ])
  }

  @Test func controlAndFormatCharactersCannotReorderOrHideWhatIsDrawn() {
    // A right-to-left override, a zero-width joiner, a NUL and a line separator, all in the gateway's text.
    let runs = MessageSnippet.runs("pay >>>\u{202E}evil\u{200D}<<< now\u{0000}\u{2028}done")

    #expect(runs.map(\.text) == ["pay ", " evil ", " now  done"])
    #expect(runs.map(\.match) == [false, true, false])
    #expect(runs.allSatisfy { run in !run.text.unicodeScalars.contains { $0.value == 0x202E || $0.value == 0x200D } })
  }

  @Test func aRunIsBoundedInUTF16Units() {
    let long = String(repeating: "a", count: 1_000)
    let runs = MessageSnippet.runs("\(long) >>>\(long)<<<")

    #expect(runs.map(\.text.utf16.count) == [MessageSnippet.runLimit, MessageSnippet.runLimit])
  }

  @Test func theBoundNeverCutsACharacterInHalf() {
    // 399 units, then an emoji of two units: it does not fit, so it is left out whole.
    let text = String(repeating: "a", count: 399) + "😀" + "tail"

    #expect(MessageSnippet.runs(text).first?.text == String(repeating: "a", count: 399))
  }

  @Test func markdownAndLinksAreOnlyCharacters() {
    let runs = MessageSnippet.runs("see [click](https://evil.example) and >>>**bold**<<<")

    #expect(runs.map(\.text) == ["see [click](https://evil.example) and ", "**bold**"])
  }

  @Test func aSnippetThatCleansToNothingHasNoRuns() {
    #expect(MessageSnippet.runs("").isEmpty)
    #expect(MessageSnippet.runs("\"}").isEmpty)
    #expect(MessageSnippet.runs("   ").isEmpty)
  }
}
