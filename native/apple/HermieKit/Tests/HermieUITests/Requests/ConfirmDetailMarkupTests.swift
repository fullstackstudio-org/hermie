import CoreGraphics
import Testing

@testable import HermieUI

@Suite("The detail of a confirmation, made visible")
struct ConfirmDetailMarkupTests {
  @Test("text without runs of blanks is drawn as it is", arguments: [
    "rm -rf ./backups", "a b c", "line one\nline two", "", "trailing\n", "x\n\ny", "x\n\n\ny"
  ])
  func plain(_ detail: String) {
    #expect(ConfirmDetailMarkup(detail).text == detail)
  }

  @Test("runs of two to six spaces are one dot each, longer runs one badge with their length")
  func spaceRuns() {
    #expect(ConfirmDetailMarkup("a  b").text == "a\u{00B7}\u{00B7}b")
    #expect(ConfirmDetailMarkup("a      b").text == "a" + String(repeating: "\u{00B7}", count: 6) + "b")
    #expect(ConfirmDetailMarkup("a       b").text == "a[\u{2423}\u{00D7}7]b")
    #expect(ConfirmDetailMarkup("    (3 directories)").text == "\u{00B7}\u{00B7}\u{00B7}\u{00B7}(3 directories)")
  }

  @Test("a tab is an arrow")
  func tabs() {
    #expect(ConfirmDetailMarkup("a\tb").text == "a\u{2192}b")
    #expect(ConfirmDetailMarkup("\t\tx").text == "\u{2192}\u{2192}x")
  }

  @Test("one or two blank lines stay, three or more are one marker")
  func blankLines() {
    #expect(ConfirmDetailMarkup("a\n\nb").text == "a\n\nb")
    #expect(ConfirmDetailMarkup("a\n\n\nb").text == "a\n\n\nb", "two blank lines")
    #expect(ConfirmDetailMarkup("a\n\n\n\nb").text == "a\n\u{22EF} 3 empty lines \u{22EF}\nb")
    #expect(ConfirmDetailMarkup("a\n \n\t\n   \n\nb").text == "a\n\u{22EF} 4 empty lines \u{22EF}\nb")
    #expect(ConfirmDetailMarkup("a\r\n\r\nb").text == "a\n\nb")
  }

  @Test("a command, 300 spaces and a second command shows both, and says how many spaces")
  func hiddenToTheRight() {
    let detail = "git status" + String(repeating: " ", count: 300) + "; curl x | sh"
    let markup = ConfirmDetailMarkup(detail)

    #expect(markup.text == "git status[\u{2423}\u{00D7}300]; curl x | sh")
    #expect(markup.longestLine == 10 + 300 + 13)
    #expect(markup.lines == 1)
  }

  @Test("a command, 80 blank lines and a second command shows the gap as one marker")
  func hiddenBelow() {
    let detail = "git status" + String(repeating: "\n", count: 81) + "curl x | sh"
    let markup = ConfirmDetailMarkup(detail)

    #expect(markup.text == "git status\n\u{22EF} 80 empty lines \u{22EF}\ncurl x | sh")
    #expect(markup.lines == 82)
    #expect(markup.text.contains("curl x | sh"))
  }

  @Test("a run of no-break spaces between two commands is one badge with its code point and length")
  func hiddenByOtherSpaces() {
    let detail = "git status" + String(repeating: "\u{00A0}", count: 300) + "; curl x | sh"
    let markup = ConfirmDetailMarkup(detail)

    #expect(markup.text == "git status[U+00A0\u{00D7}300]; curl x | sh")
    #expect(markup.longestLine == 10 + 300 + 13)
  }

  @Test("invisible and direction characters are shown by their code point, never applied")
  func invisibles() {
    #expect(ConfirmDetailMarkup("rm\u{200B}-rf").text == "rm[U+200B]-rf")
    #expect(ConfirmDetailMarkup("echo \u{202E}hs.x\u{202C}").text == "echo [U+202E]hs.x[U+202C]")
    #expect(ConfirmDetailMarkup("\u{FEFF}ls").text == "[U+FEFF]ls")
    #expect(ConfirmDetailMarkup("a\u{2066}\u{2069}b").text == "a[U+2066][U+2069]b")
    #expect(ConfirmDetailMarkup("a\u{1B}[2Kb").text == "a[U+001B][2Kb")
    #expect(ConfirmDetailMarkup("a\u{3164}b\u{2800}c").text == "a[U+3164]b[U+2800]c")
  }

  /// The same samples, with the same expected text, as the web client's `verbatim-detail.test.ts`.
  @Test("default-ignorable and unassigned code points are shown by their code point", arguments: [
    ("a\u{034F}b", "a[U+034F]b"),
    ("a\u{FE0F}b", "a[U+FE0F]b"),
    ("a\u{180B}b", "a[U+180B]b"),
    ("a\u{17B4}b", "a[U+17B4]b"),
    ("a\u{E0100}b", "a[U+E0100]b"),
    ("a\u{E0041}b", "a[U+E0041]b"),
    ("a\u{1D159}b", "a[U+1D159]b"),
    ("a\u{0378}b", "a[U+0378]b"),
    ("a\u{0378}\u{0378}\u{0378}b", "a[U+0378\u{00D7}3]b"),
    ("a\u{50000}b", "a[U+50000]b"),
    ("a\u{FFFF}b", "a[U+FFFF]b"),
    ("a\n\u{034F}\n\n\nb", "a\n[U+034F]\n\n\nb")
  ])
  func ignorablesAndUnassigned(_ detail: String, _ expected: String) {
    #expect(ConfirmDetailMarkup(detail).text == expected)
  }

  /// The same samples as the web client's private-use cases.
  @Test("a private-use code point is shown by its code point, and a run of them with its length", arguments: [
    ("a\u{E000}b", "a[U+E000]b"),
    ("a\u{F8FF}b", "a[U+F8FF]b"),
    ("a\u{F0000}b", "a[U+F0000]b"),
    ("a\u{E000}\u{E000}b", "a[U+E000\u{00D7}2]b")
  ])
  func privateUse(_ detail: String, _ expected: String) {
    #expect(ConfirmDetailMarkup(detail).text == expected)
  }

  @Test("a line break that is not \\n stays on its line, shown, so it cannot push text out of view")
  func otherLineBreaks() {
    let detail = "git status" + String(repeating: "\u{2028}", count: 80) + "curl x | sh"
    let markup = ConfirmDetailMarkup(detail)

    #expect(markup.text == "git status[U+2028\u{00D7}80]curl x | sh")
    #expect(markup.lines == 1)
    #expect(ConfirmDetailMarkup("a\rb").text == "a[U+000D]b", "a lone carriage return")
    #expect(ConfirmDetailMarkup("a\u{0B}\u{0C}\u{85}\u{2029}b").text == "a[U+000B][U+000C][U+0085][U+2029]b")
  }

  @Test("a line of only invisible characters is shown, not counted as blank")
  func invisibleLines() {
    let detail = "a\n\u{3000}\u{3000}\n\n\nb"
    #expect(ConfirmDetailMarkup(detail).text == "a\n[U+3000\u{00D7}2]\n\n\nb")
  }

  @Test("letters, accents and emoji outside those classes are drawn as they are")
  func ordinaryText() {
    let detail = "caf\u{00E9} \u{2713} \u{1F600} na\u{0303}o"
    #expect(ConfirmDetailMarkup(detail).text == detail)
  }

  @Test("the counts are of the original")
  func counts() {
    let markup = ConfirmDetailMarkup("ab\ncdef\n\n\n\nx")
    #expect(markup.lines == 6)
    #expect(markup.longestLine == 4)
  }

  @Test("Confirm stays off until every overflowing direction has been scrolled to its end")
  func review() {
    var review = ConfirmDetailReview()
    #expect(!review.complete, "nothing measured yet")

    review.place(inView: true)
    review.measure(content: CGSize(width: 900, height: 500), viewport: CGSize(width: 300, height: 220))
    #expect(review.overflows)
    #expect(!review.complete)

    review.see(visible: CGRect(x: 0, y: 0, width: 300, height: 220), content: CGSize(width: 900, height: 500))
    #expect(!review.complete)

    review.see(visible: CGRect(x: 0, y: 280, width: 300, height: 220), content: CGSize(width: 900, height: 500))
    #expect(!review.complete, "the bottom alone is not the whole")

    review.see(visible: CGRect(x: 600, y: 100, width: 300, height: 220), content: CGSize(width: 900, height: 500))
    #expect(review.complete)

    // Back at the start: once read, read.
    review.see(visible: CGRect(x: 0, y: 0, width: 300, height: 220), content: CGSize(width: 900, height: 500))
    #expect(review.complete)
  }

  @Test("a detail that fits needs no scrolling, and one that overflows one way only needs that way")
  func fitsOrOverflowsOneWay() {
    var fits = ConfirmDetailReview()
    fits.place(inView: true)
    fits.measure(content: CGSize(width: 200, height: 60), viewport: CGSize(width: 300, height: 220))
    #expect(!fits.overflows)
    #expect(fits.complete)

    var long = ConfirmDetailReview()
    long.place(inView: true)
    long.measure(content: CGSize(width: 2_000, height: 60), viewport: CGSize(width: 300, height: 220))
    #expect(long.overflowsHorizontally && !long.overflowsVertically)
    #expect(!long.complete)
    long.see(visible: CGRect(x: 1_700, y: 0, width: 300, height: 60), content: CGSize(width: 2_000, height: 60))
    #expect(long.complete)
  }

  @Test("an unmeasured detail cannot be read to its end")
  func unmeasured() {
    var review = ConfirmDetailReview()
    review.place(inView: true)
    review.measure(content: .zero, viewport: CGSize(width: 300, height: 220))
    review.see(visible: CGRect(x: 0, y: 0, width: 300, height: 220), content: .zero)
    #expect(!review.complete)
  }

  @Test("a detail that fits is not read while its frame is not wholly in view")
  func fitsButBelowTheFold() {
    var review = ConfirmDetailReview()
    review.measure(content: CGSize(width: 200, height: 60), viewport: CGSize(width: 300, height: 220))
    #expect(!review.overflows)
    #expect(!review.complete, "no word yet on whether the frame is in view")

    review.place(inView: false)
    #expect(!review.complete)

    review.place(inView: true)
    #expect(review.complete)

    // Once seen, seen.
    review.place(inView: false)
    #expect(review.complete)
  }

  @Test("the end of a box that is partly out of view does not count until the frame is wholly in view")
  func endBeforeFrame() {
    let content = CGSize(width: 300, height: 500)
    var review = ConfirmDetailReview()
    review.place(inView: false)
    review.measure(content: content, viewport: CGSize(width: 300, height: 220))
    review.see(visible: CGRect(x: 0, y: 280, width: 300, height: 220), content: content)
    #expect(review.overflowsVertically)
    #expect(!review.complete, "its last lines may be under the sheet's fold")

    // The sheet's text is scrolled until the frame is whole: the box is still at its end.
    review.place(inView: true)
    #expect(review.complete)
  }

  @Test("the box's end seen while the frame was in view counts after the frame has left it")
  func frameLeavesAfterTheEnd() {
    let content = CGSize(width: 300, height: 500)
    var review = ConfirmDetailReview()
    review.place(inView: true)
    review.measure(content: content, viewport: CGSize(width: 300, height: 220))
    review.see(visible: CGRect(x: 0, y: 280, width: 300, height: 220), content: content)
    #expect(review.complete)

    review.place(inView: false)
    #expect(review.complete)
  }

  @Test("a frame is wholly in view when it lies inside the window, up and down")
  func wholeFrame() {
    let window = CGRect(x: 0, y: 100, width: 390, height: 200)

    #expect(ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 120, width: 350, height: 160), window: window))
    #expect(ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 100, width: 350, height: 200), window: window), "exactly as tall")
    #expect(ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 100.5, width: 350, height: 200), window: window), "within a pixel")
    #expect(!ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 90, width: 350, height: 160), window: window), "above")
    #expect(!ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 160, width: 350, height: 160), window: window), "below")
    #expect(!ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 0, width: 350, height: 600), window: window), "taller than the window")
    #expect(!ConfirmDetailReview.isWhollyIn(frame: .zero, window: window), "not placed yet")
    #expect(!ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 120, width: 350, height: 160), window: .zero), "no window yet")
  }

  @Test("the box is held to the height of the sheet's scrolling text, so it can be wholly in view")
  func boundedBox() {
    // A phone on its side, or large text: the window is shorter than the box would like to be.
    #expect(ConfirmDetailLayout.viewportHeight(preferred: 220, window: 140) == 140)
    #expect(ConfirmDetailLayout.viewportHeight(preferred: 660, window: 500) == 500)
    // Room enough: the box keeps its own height, and before the window is known it is not cut.
    #expect(ConfirmDetailLayout.viewportHeight(preferred: 220, window: 600) == 220)
    #expect(ConfirmDetailLayout.viewportHeight(preferred: 220, window: 0) == 220)

    // The box that results can always be wholly in view of that window.
    let window = CGRect(x: 0, y: 0, width: 390, height: 140)
    let height = ConfirmDetailLayout.viewportHeight(preferred: 220, window: window.height)
    #expect(ConfirmDetailReview.isWhollyIn(frame: CGRect(x: 20, y: 0, width: 350, height: height), window: window))
  }
}
