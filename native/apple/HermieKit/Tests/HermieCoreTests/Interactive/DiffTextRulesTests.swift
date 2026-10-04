import Foundation
import Testing

@testable import HermieCore

/// The rules a diff line is held to before it is shown (`contract/requests/README.md` §7.1), and how a
/// tab is drawn.
@Suite("Diff text rules")
struct DiffTextRulesTests {
  private func spaces(_ count: Int) -> String { String(repeating: " ", count: count) }
  private func tabs(_ count: Int) -> String { String(repeating: "\t", count: count) }

  @Test("a tab runs to the next multiple of 8; everything else is one column")
  func columns() {
    #expect(DiffTextRules.columns(of: "") == 0)
    #expect(DiffTextRules.columns(of: "abc") == 3)
    #expect(DiffTextRules.columns(of: "\t") == 8)
    #expect(DiffTextRules.columns(of: "ab\tc") == 9, "the tab runs from column 2 to 8")
    #expect(DiffTextRules.columns(of: "1234567\tc") == 9, "one column to the stop")
    #expect(DiffTextRules.columns(of: "12345678\tc") == 17, "a full tab from a stop")
    #expect(DiffTextRules.columns(of: tabs(12)) == 96)
    #expect(DiffTextRules.columns(of: " \t") == 8)
    #expect(DiffTextRules.columns(of: "日本語") == 3, "every other character is one column")
  }

  @Test("the examples of the contract: six tab levels, a Python body, three tab-aligned comments pass")
  func passes() {
    #expect(DiffTextRules.isShowable(""), "a blank context line holds no text")
    #expect(DiffTextRules.isShowable(tabs(6) + "x := 1"))
    #expect(DiffTextRules.isShowable(tabs(12) + "x"), "twelve tab levels are the most of the indent")
    #expect(DiffTextRules.isShowable(spaces(32) + "result = compute(value)"), "eight 4-space levels")
    #expect(DiffTextRules.isShowable(spaces(96) + "x"), "the indent is 96 columns")
    #expect(DiffTextRules.isShowable("a\t// one\t// two\t// three"))
    #expect(DiffTextRules.isShowable("name = \"booking\""))
    #expect(DiffTextRules.isShowable("naïve café 日本語 Ωmega 😀 e\u{0301}"))
  }

  @Test("padding that would push text out of view is refused")
  func padding() {
    #expect(!DiffTextRules.isShowable(spaces(97) + "x"), "indent over 96 columns")
    #expect(!DiffTextRules.isShowable(tabs(13) + "x"), "13 tab levels are 104 columns")
    #expect(!DiffTextRules.isShowable(tabs(300) + "x"))
    #expect(!DiffTextRules.isShowable("a" + tabs(400) + "b"), "400 tabs inside a line")
    #expect(!DiffTextRules.isShowable(String(repeating: " \t", count: 40) + "x"), "a space and a tab, repeated")
    #expect(DiffTextRules.isShowable("a" + spaces(32) + "b"), "a run of 32 columns")
    #expect(!DiffTextRules.isShowable("a" + spaces(33) + "b"), "40 spaces inside a line")
    #expect(!DiffTextRules.isShowable("a" + spaces(40) + "b"))
    #expect(!DiffTextRules.isShowable("a" + tabs(5) + "b"), "a run of tabs is its width: 5 tabs from column 1 reach 40")

    // Several runs of 32 columns separated by a character: all the whitespace together is capped at 160.
    let run = spaces(32)
    #expect(DiffTextRules.isShowable("a" + run + "b" + run + "c" + run + "d" + run + "e" + run + "f"), "160 columns")
    #expect(!DiffTextRules.isShowable("a" + run + "b" + run + "c" + run + "d" + run + "e" + run + "f" + run + "g"), "192 columns")
    #expect(DiffTextRules.isShowable(spaces(96) + "a" + run + "b" + run + "c"), "96 and two runs are 160")
    #expect(!DiffTextRules.isShowable(spaces(96) + "a" + run + "b" + run + "c" + run + "d"), "the indent counts too: 192")
    #expect(DiffTextRules.isShowable(spaces(64) + "a" + run + "b" + run + "c" + run + "d"), "64 and three runs are 160")
  }

  @Test("a run is measured from where it starts, so a tab near a stop is short")
  func runFromItsStart() {
    // 31 characters, then a tab (to column 32, one column), then 31 more spaces: 32 columns together.
    #expect(DiffTextRules.isShowable(String(repeating: "x", count: 7) + "\t" + "x"))
    #expect(DiffTextRules.isShowable("x" + spaces(31) + "y"))
    #expect(DiffTextRules.isShowable(String(repeating: "x", count: 31) + "\t" + spaces(31) + "y"), "1 + 31")
    #expect(!DiffTextRules.isShowable(String(repeating: "x", count: 31) + "\t" + spaces(32) + "y"), "1 + 32")
  }

  @Test("whitespace at the end is refused, not trimmed")
  func trailingWhitespace() {
    #expect(!DiffTextRules.isShowable("a "))
    #expect(!DiffTextRules.isShowable("a\t"))
    #expect(!DiffTextRules.isShowable(" "))
    #expect(!DiffTextRules.isShowable("\t"))
    #expect(!DiffTextRules.isShowable("a \t "))
    #expect(DiffTextRules.isShowable(" a"), "leading whitespace is the indent")
  }

  @Test("the characters of §6.2, with the tab allowed")
  func characters() {
    for scalar: UInt32 in [
      0x00, 0x01, 0x07, 0x0A, 0x0B, 0x0C, 0x0D, 0x1B, 0x7F, 0x80, 0x85, 0x9F,  // controls and line breaks
      0xA0, 0x1680, 0x2000, 0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029,  // other whitespace
      0x00AD, 0x200B, 0x200C, 0x200D, 0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF, 0xE0001,  // format
      0xE000, 0xF8FF, 0x0378, 0xFFFF,  // private use, unassigned
      0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x1D159, 0x16FE4,  // invisible letters
      0x034F, 0xFE00, 0xFE0F, 0xE0100, 0x180B, 0x17B4, 0x061C  // default-ignorable
    ] {
      guard let value = Unicode.Scalar(scalar) else { continue }
      #expect(!DiffTextRules.isShowable("a" + String(Character(value)) + "b"), "U+\(String(scalar, radix: 16, uppercase: true))")
    }

    #expect(DiffTextRules.isShowable("a\tb"), "the tab is allowed inside a line")
    #expect(DiffTextRules.isShowable("\ta"), "and leading")
  }

  @Test("combining marks: at most four in a row, none at the start or after a space or a tab")
  func marks() {
    let mark = "\u{0301}"
    #expect(DiffTextRules.isShowable("a" + String(repeating: mark, count: 4)))
    #expect(!DiffTextRules.isShowable("a" + String(repeating: mark, count: 5)))
    #expect(!DiffTextRules.isShowable(mark + "a"), "at the start")
    #expect(!DiffTextRules.isShowable("a " + mark), "after a space")
    #expect(!DiffTextRules.isShowable("a\t" + mark), "after a tab")
    #expect(DiffTextRules.isShowable("a" + mark + " b" + mark), "a base character in between")
    #expect(!DiffTextRules.isShowable("a" + String(repeating: mark, count: 3) + "\u{20DD}" + mark), "an enclosing mark counts")
  }

  @Test("a path is one line; odd characters in it are shown, not refused")
  func oneLine() {
    #expect(DiffTextRules.isOneLine("app/settings.py"))
    #expect(DiffTextRules.isOneLine("a\u{202E}b"))
    #expect(DiffTextRules.isOneLine("a\tb"))

    for scalar: UInt32 in [0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029] {
      #expect(!DiffTextRules.isOneLine("a" + String(Character(Unicode.Scalar(scalar)!)) + "b"), "U+\(String(scalar, radix: 16))")
    }
  }

  // MARK: Drawing a tab

  @Test("a line is split at its tabs, each with the columns it spans")
  func pieces() {
    #expect(DiffTextRules.pieces("") == [])
    #expect(DiffTextRules.pieces("abc") == [.text("abc")])
    #expect(DiffTextRules.pieces("\tx") == [.tab(width: 8), .text("x")])
    #expect(DiffTextRules.pieces("ab\tc") == [.text("ab"), .tab(width: 6), .text("c")])
    #expect(DiffTextRules.pieces("\t\t") == [.tab(width: 8), .tab(width: 8)])
    #expect(DiffTextRules.pieces("1234567\t") == [.text("1234567"), .tab(width: 1)])
  }

  @Test("a tab is shown as a marker and the spaces to its stop: never hidden, collapsed or another number of spaces")
  func rendered() {
    #expect(DiffTextRules.rendered("abc") == "abc")
    #expect(DiffTextRules.rendered("\tx") == "\u{2192}       x", "the marker and seven spaces")
    #expect(DiffTextRules.rendered("ab\tc") == "ab\u{2192}     c", "text after it starts at column 8")
    #expect(DiffTextRules.rendered("1234567\tc") == "1234567\u{2192}c", "one column to the stop")
    #expect(DiffTextRules.rendered("\t\tx").count == 17)

    // The drawn line is as wide as the line is in columns, so a column in the view is a column of the text.
    for text in ["", "abc", "\tx", "ab\tc", "a\tb\tc", tabs(5) + "x", "12345678\t9"] {
      #expect(DiffTextRules.rendered(text).count == DiffTextRules.columns(of: text), "\(text.debugDescription)")
    }

    // Two lines that differ only in a tab and the spaces after it do not look alike.
    #expect(DiffTextRules.rendered("\tx") != DiffTextRules.rendered(spaces(8) + "x"))
  }
}
