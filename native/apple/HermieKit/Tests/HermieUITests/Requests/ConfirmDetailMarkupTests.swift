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
    fits.measure(content: CGSize(width: 200, height: 60), viewport: CGSize(width: 300, height: 220))
    #expect(!fits.overflows)
    #expect(fits.complete)

    var long = ConfirmDetailReview()
    long.measure(content: CGSize(width: 2_000, height: 60), viewport: CGSize(width: 300, height: 220))
    #expect(long.overflowsHorizontally && !long.overflowsVertically)
    #expect(!long.complete)
    long.see(visible: CGRect(x: 1_700, y: 0, width: 300, height: 60), content: CGSize(width: 2_000, height: 60))
    #expect(long.complete)
  }

  @Test("an unmeasured detail cannot be read to its end")
  func unmeasured() {
    var review = ConfirmDetailReview()
    review.measure(content: .zero, viewport: CGSize(width: 300, height: 220))
    review.see(visible: CGRect(x: 0, y: 0, width: 300, height: 220), content: .zero)
    #expect(!review.complete)
  }
}
