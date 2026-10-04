import Foundation
import Testing

@testable import HermieCore

/// What a scanned code says, cleaned the way the gateway cleans it (the vectors of the fake gateway's
/// `cleanScanValue`, itself the fork's).
@Suite("A scanned value")
struct ScanValueTests {
  @Test(
    "is cleaned without being trimmed or collapsed",
    arguments: [
      ("WIFI:T:WPA;S:my  net;P:pass word;;", "WIFI:T:WPA;S:my  net;P:pass word;;"),
      ("https://exa\u{200B}mple.com/\u{202E}txt.exe", "https://example.com/txt.exe"),
      ("a\u{001B}[31mred\u{0007}", "a[31mred"),
      ("a\tb\u{00A0}c\u{3000}d", "a b c d"),
      ("a\r\nb\rc\u{2028}d\u{2029}e\u{000B}f", "a\nb\nc\nd\nef"),
      ("a\u{2066}b\u{2069}", "ab"),
      ("a\u{FEFF}b", "ab"),
      ("a\u{E0041}b", "ab"),
      ("a\u{3164}b", "ab"),
      ("a\u{E000}b", "ab"),
      ("e" + String(repeating: "\u{0301}", count: 6), "e" + String(repeating: "\u{0301}", count: 4)),
      ("  padded  ", "  padded  "),
      ("", ""),
    ])
  func cleaned(raw: String, want: String) {
    #expect(ScanValue.clean(raw) == want)
    // Cleaning twice changes nothing more: what was shown is what is sent, and what the gateway then keeps.
    #expect(ScanValue.clean(ScanValue.clean(raw)) == want)
  }

  @Test("nothing visible left is nothing to send, however much is left of it")
  func nothingVisible() {
    #expect(ScanValue.clean("\u{200B}\u{202E}\u{0000}").isEmpty)
    #expect(ScanValue.problem(in: ScanValue.clean("\u{200B}\u{202E} \u{200B}")) == .empty)
    #expect(ScanValue.problem(in: ScanValue.clean(" \n\t ")) == .empty)
    #expect(ScanValue.problem(in: "") == .empty)
    #expect(ScanValue.problem(in: "a") == nil)
    #expect(ScanValue.problem(in: String(repeating: "x", count: ScanValue.maxLength)) == nil)
    #expect(ScanValue.problem(in: String(repeating: "x", count: ScanValue.maxLength + 1)) == .tooLong(count: ScanValue.maxLength + 1))
    // Code points, not what a person counts as a character.
    #expect(ScanValue.problem(in: String(repeating: "\u{1F600}", count: ScanValue.maxLength)) == nil)
    #expect(ScanValue.problem(in: String(repeating: "\u{1F600}", count: ScanValue.maxLength + 1)) != nil)
  }

  @Test("any text cleans to something with no character a person cannot see, and cleaning it again changes nothing")
  func cleaningProperty() {
    var generator = SeededGenerator(seed: 0xC0DE)
    let pool: [Unicode.Scalar] = [
      "a", "Z", "0", " ", "\n", "\t", "\r", "\u{0000}", "\u{001B}", "\u{007F}", "\u{0085}", "\u{00A0}", "\u{00AD}", "\u{034F}",
      "\u{0301}", "\u{200B}", "\u{200E}", "\u{202A}", "\u{202E}", "\u{2028}", "\u{2029}", "\u{2060}", "\u{2066}", "\u{3000}",
      "\u{3164}", "\u{FE0F}", "\u{FEFF}", "\u{E000}", "\u{E0041}", "\u{1D159}", "é", "日", "\u{1F600}", "\u{0378}",
    ]

    for _ in 0..<500 {
      let length = Int.random(in: 0..<40, using: &generator)
      var raw = String.UnicodeScalarView()

      for _ in 0..<length {
        raw.append(pool.randomElement(using: &generator) ?? "a")
      }

      let cleaned = ScanValue.clean(String(raw))

      #expect(ScanValue.clean(cleaned) == cleaned)

      var marks = 0

      for scalar in cleaned.unicodeScalars {
        let category = scalar.properties.generalCategory
        #expect(![.format, .privateUse, .surrogate, .unassigned, .lineSeparator, .paragraphSeparator].contains(category), "\(scalar.value)")
        #expect(!(category == .control && scalar != "\n"), "\(scalar.value)")
        #expect(!DraftText.isDefaultIgnorable(scalar) && !DraftText.invisibleLetters.contains(scalar.value), "\(scalar.value)")
        #expect(category != .spaceSeparator || scalar == " ", "other spaces become a plain one")
        marks = (category == .nonspacingMark || category == .enclosingMark) ? marks + 1 : 0
        #expect(marks <= 4, "no more than four marks on one character")
      }
    }
  }
}
