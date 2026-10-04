import Testing

@testable import HermieMarkdown

/// `MarkdownSpeech` is a port of the Expo app's `features/voice/speech-text.ts`; the expected strings
/// are what the TypeScript answers for the same input, so every client reads a reply the same way.
@Suite("Markdown to speech")
struct MarkdownSpeechTests {
  /// The sentence for a summarised block, in English, as `Strings.Chat.Voice.codeBlock` says it.
  private func block(_ lines: Int) -> String {
    lines == 1 ? "Code block, 1 line" : "Code block, \(lines) lines"
  }

  private func speak(_ markdown: String) -> String {
    MarkdownSpeech.text(markdown, codeBlock: block)
  }

  @Test("the syntax goes and the words stay")
  func words() {
    #expect(
      speak("## Retry semantics\n\nThe **gateway** re-runs the `turn` itself.")
        == "Retry semantics.\nThe gateway re-runs the turn itself.")
  }

  @Test("a link is read by its label and never by its target")
  func link() {
    let spoken = speak("See [the release notes](https://example.com/notes?v=2) for details.")

    #expect(spoken == "See the release notes for details.")
    #expect(!spoken.contains("example.com"))
  }

  @Test("a long listing is described, not recited")
  func longListing() {
    let body = (0..<12).map { "const value\($0) = \($0)" }.joined(separator: "\n")

    #expect(speak("Here:\n\n```ts\n\(body)\n```") == "Here:\nCode block, 12 lines.")
  }

  @Test("a short listing is read out, because a one-liner is often the answer")
  func shortListing() {
    #expect(speak("```sh\nnpm run typecheck\n```") == "npm run typecheck.")
  }

  @Test("a listing short in lines but long in characters is summarised, in the singular")
  func longLine() {
    let long = String(repeating: "x", count: MarkdownSpeech.shortCodeCharacters + 10)

    #expect(speak("```\n\(long)\n```") == "Code block, 1 line.")
  }

  @Test("a fence the reply has not closed yet is summarised from what has arrived")
  func unclosedFence() {
    #expect(
      speak("Working on it:\n```py\nimport os\nimport sys\nprint(os.getcwd())") == "Working on it:\nCode block, 3 lines.")
  }

  @Test("the short-listing threshold agrees with its constant")
  func threshold() {
    let body = Array(repeating: "ok", count: MarkdownSpeech.shortCodeLines).joined(separator: "\n")

    #expect(!speak("```\n\(body)\n```").contains("Code block"))
    #expect(speak("```\n\(body)\nok\n```").contains("Code block"))
  }

  @Test("a table is read a row at a time, without its delimiter row")
  func table() {
    let source = ["| Model | Window |", "| --- | ---: |", "| Opus | 200k |", "| Haiku | 100k |"].joined(separator: "\n")

    #expect(speak(source) == "Model, Window.\nOpus, 200k.\nHaiku, 100k.")
  }

  @Test("mathematics is read as its source, subscripts and all")
  func math() {
    #expect(speak("The sum is $a_1 + b_2$ exactly.") == "The sum is a_1 + b_2 exactly.")
    #expect(speak("$$\n\\frac{a}{b}\n$$") == "\\frac{a}{b}.")
    #expect(speak("$$x^2 + y^2 = z^2$$") == "x^2 + y^2 = z^2.")
  }

  @Test("a line that already ends in punctuation is left alone")
  func punctuation() {
    #expect(speak("Done!") == "Done!")
    #expect(speak("Is it?") == "Is it?")
  }

  @Test("nothing at all is nothing to say")
  func empty() {
    #expect(speak("") == "")
    #expect(speak("\n\n---\n\n") == "")
  }

  @Test("a list is read as sentences, not as bullets")
  func list() {
    #expect(speak("- first\n- second\n") == "first.\nsecond.")
  }

  // MARK: The language of a reply

  @Test("a language it is confident about is named")
  func guessed() {
    #expect(MarkdownSpeech.guessLanguage("Het is niet duidelijk dat de gateway een antwoord voor ons heeft.") == "nl")
    #expect(MarkdownSpeech.guessLanguage("The gateway said that this would have been the answer you want.") == "en")
  }

  @Test("too short, or a tie, is no guess")
  func declined() {
    #expect(MarkdownSpeech.guessLanguage("ok") == nil)
    #expect(MarkdownSpeech.guessLanguage("") == nil)
    #expect(MarkdownSpeech.guessLanguage("que con") == nil)
  }
}
