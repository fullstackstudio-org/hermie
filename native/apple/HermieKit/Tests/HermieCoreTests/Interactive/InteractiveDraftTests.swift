import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

private func draftParams(
  text: String = "Hi Bram,\n\nSee you Friday.", editable: Bool? = nil, subject: String? = nil
) -> ReviewDraftParams {
  var json: JSONObject = ["v": 1, "title": "t", "summary": "s", "kind": "mail", "text": .string(text)]

  if let editable {
    json["editable"] = .bool(editable)
  }

  if let subject {
    json["subject"] = .string(subject)
  }

  return ReviewDraftParams(json: json)
}

@Suite("Draft text")
struct DraftTextTests {
  @Test("characters that do not show as themselves are shown as codes, and plain text is left alone")
  func reveal() {
    #expect(DraftText.reveal("Hi Bram,\n\nSee you Friday.") == "Hi Bram,\n\nSee you Friday.")
    #expect(DraftText.reveal("pay\u{202E}gnp.exe") == "pay\u{27E8}U+202E\u{27E9}gnp.exe")
    #expect(DraftText.reveal("a\u{200B}b") == "a\u{27E8}U+200B\u{27E9}b", "zero width space")
    #expect(DraftText.reveal("a\u{2066}b\u{2069}") == "a\u{27E8}U+2066\u{27E9}b\u{27E8}U+2069\u{27E9}", "bidi isolates")
    #expect(DraftText.reveal("a\tb") == "a\u{27E8}U+0009\u{27E9}b")
    #expect(DraftText.reveal("a\u{00A0}b") == "a\u{27E8}U+00A0\u{27E9}b", "a space that is not the plain one")
    #expect(DraftText.reveal("I \u{2764}\u{FE0F}") == "I \u{2764}\u{27E8}U+FE0F\u{27E9}")
    #expect(DraftText.reveal("a\u{2028}b") == "a\u{27E8}U+2028\u{27E9}b")
    #expect(DraftText.reveal("a b\n") == "a b\n")
    #expect(DraftText.reveal("Zoë 日本語 👨‍👩‍👧") == "Zoë 日本語 👨\u{27E8}U+200D\u{27E9}👩\u{27E8}U+200D\u{27E9}👧", "joiners show too")
  }

  @Test("the hidden characters of a text are listed once each, with how often")
  func hidden() {
    let found = DraftText.hidden(in: "a\u{202E}b\u{202E}c\u{200B}")
    #expect(found.map(\.code) == ["U+202E", "U+200B"])
    #expect(found.map(\.count) == [2, 1])
    #expect(DraftText.hidden(in: "plain").isEmpty)
  }

  @Test("the gateway's trimming: whitespace at the end of every line and of the whole text")
  func trimming() {
    #expect(DraftText.gatewayTrimmed("a  \nb\t\n\n  ") == "a\nb")
    #expect(DraftText.gatewayTrimmed("  a") == "  a", "leading whitespace is kept")
    #expect(DraftText.gatewayTrimmed("a\u{00A0}\u{3000}\nb\u{0085}") == "a\nb", "NBSP, ideographic space and NEL too")
    #expect(DraftText.gatewayTrimmed("a\r\nb") == "a\nb", "a CR at a line end goes")
    #expect(DraftText.gatewayTrimmed("a\u{1C}") == "a", "Python's str.isspace counts the information separators")
  }

  private func codes(_ text: String) -> [String] {
    for problem in DraftText.problems(in: text) {
      if case .characters(let found) = problem {
        return found.map(\.code)
      }
    }

    return []
  }

  @Test("what the gateway refuses after trimming is what the sheet refuses: not a tab at the end, but one inside")
  func refusedCharacters() {
    #expect(DraftText.problems(in: "fine\n").isEmpty)
    #expect(DraftText.problems(in: "end\t").isEmpty, "trimmed away by the gateway")
    #expect(codes("a\tb") == ["U+0009"])
    #expect(codes("a\u{202E}b") == ["U+202E"])
    #expect(codes("a\u{200B}b") == ["U+200B"], "a format character")
    #expect(codes("a\rb") == ["U+000D"], "a CR inside a line")
    #expect(codes("a\u{00A0}b") == ["U+00A0"], "NBSP is refused: any space but the plain one")
    #expect(codes("a\u{202F}b\u{3000}c") == ["U+202F", "U+3000"])
    #expect(codes("a\u{2003}b") == ["U+2003"])
  }

  @Test("default-ignorables that are not format characters are refused too: U+FE0F of an emoji, U+034F, the Hangul fillers")
  func ignorables() {
    #expect(codes("I \u{2764}\u{FE0F}") == ["U+FE0F"], "❤️ is refused: the gateway has no way to show a variation selector")
    #expect(codes("a\u{FE00}b") == ["U+FE00"])
    #expect(codes("a\u{034F}b") == ["U+034F"], "the combining grapheme joiner")
    #expect(codes("a\u{115F}\u{1160}b") == ["U+115F", "U+1160"], "Hangul fillers")
    #expect(codes("a\u{3164}b\u{FFA0}") == ["U+3164", "U+FFA0"])
    #expect(codes("a\u{2800}b") == ["U+2800"], "the blank Braille pattern")
    #expect(codes("a\u{E0041}b") == ["U+E0041"], "a tag character")
    #expect(codes("a\u{0378}b") == ["U+0378"], "unassigned")
    #expect(codes("Zoë 日本語 café") == [], "ordinary text, accents and all")
    #expect(codes("a\u{0301}b") == [], "one combining mark is fine")
  }

  @Test("more than four combining marks on one character are refused, and the run starts again after a character")
  func combiningMarks() {
    let acute = "\u{0301}"
    #expect(DraftText.problems(in: "a" + String(repeating: acute, count: 4)).isEmpty)
    #expect(DraftText.problems(in: "a" + String(repeating: acute, count: 5)) == [.combiningMarks])
    // Four, a letter, four: two runs of four.
    #expect(DraftText.problems(in: "a" + String(repeating: acute, count: 4) + "b" + String(repeating: acute, count: 4)).isEmpty)
    // The run does not carry across a line.
    #expect(DraftText.problems(in: "a" + String(repeating: acute, count: 3) + "\n" + String(repeating: acute, count: 3)).isEmpty)
    #expect(DraftText.problems(in: "a" + String(repeating: acute, count: 3) + "\u{20DD}" + acute) == [.combiningMarks], "an enclosing mark counts")
  }

  @Test("the layout rules: blank lines, a long line, indentation, a run of spaces")
  func layout() {
    let spaces = { (n: Int) in String(repeating: " ", count: n) }

    #expect(DraftText.problems(in: "a\n\n\n\nb").isEmpty, "three blank lines")
    #expect(DraftText.problems(in: "a\n\n\n\n\nb") == [.blankLines(line: 2)])
    #expect(DraftText.problems(in: "a\n \n  \n\n \nb") == [.blankLines(line: 2)], "lines of spaces are blank")
    #expect(DraftText.problems(in: "a\n\n\n\n\n").isEmpty, "blank lines at the end are trimmed away first")

    #expect(DraftText.problems(in: spaces(32) + "x").isEmpty)
    #expect(DraftText.problems(in: "a\n" + spaces(33) + "x") == [.indent(line: 2)])

    #expect(DraftText.problems(in: "a" + spaces(16) + "b").isEmpty)
    #expect(DraftText.problems(in: "ok\na" + spaces(17) + "b") == [.spaceRun(line: 2)])
    #expect(DraftText.problems(in: spaces(20) + "a b").isEmpty, "the indent is not a run")

    #expect(DraftText.problems(in: String(repeating: "x", count: 2_000)).isEmpty)
    #expect(DraftText.problems(in: "a\n" + String(repeating: "x", count: 2_001)) == [.lineTooLong(line: 2)])
    // Counted in code points, not in what a person sees as one character.
    #expect(DraftText.problems(in: String(repeating: "😀", count: 2_001)) == [.lineTooLong(line: 1)])

    // Several rules: each once, characters first.
    let many = DraftText.problems(in: "a\u{200B}\n\n\n\n\nb" + spaces(40))
    #expect(many.count == 2)
  }

  @Test("§6.1: a text empty once stripped is refused; whitespace at line ends goes first, leading whitespace stays")
  func stripping() {
    #expect(DraftText.problems(in: "") == [.empty])
    #expect(DraftText.problems(in: " \n\t\n  ") == [.empty])
    #expect(DraftText.problems(in: "\u{00A0}\u{3000}") == [.empty])
    #expect(DraftText.problems(in: "a\t\nb \r\nc\u{00A0}\u{2028}").isEmpty, "tab, CR, NBSP and U+2028 at a line end are stripped, not refused")
    #expect(DraftText.problems(in: "  indented\n").isEmpty, "leading whitespace is kept")
    #expect(DraftText.problems(in: "\tindented") == [.characters([DraftText.Hidden(scalar: "\t", count: 1)])], "a leading tab is refused")
    #expect(DraftText.problems(in: "a\n\n\n\n\n").isEmpty, "a final LF and trailing blank lines are dropped")
  }

  @Test("§6.2: LF and U+0020 are the only whitespace; every control, space, format, private, unassigned and invisible character is refused")
  func characterRules() {
    func refused(_ scalar: UInt32) -> Bool {
      guard let value = Unicode.Scalar(scalar) else { return false }
      return codes("a" + String(Character(value)) + "b") == [String(format: "U+%04X", scalar)]
    }

    for scalar: UInt32 in [
      0x01, 0x09, 0x0B, 0x0C, 0x0D, 0x1B, 0x1C, 0x7F, 0x80, 0x85, 0x9F,  // Cc other than LF
      0xA0, 0x1680, 0x2000, 0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029,  // other whitespace
      0x00AD, 0x200B, 0x200D, 0x202E, 0x2066, 0xFEFF, 0xE0001,  // Cf
      0xE000, 0xF8FF,  // Co
      0x0378, 0xFFFF,  // Cn
      0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x1D159,  // invisible letters
      0x034F, 0xFE00, 0xFE0F, 0xE0100, 0xE01EF, 0x180B, 0x17B4, 0x17B5, 0x061C  // default-ignorable
    ] {
      #expect(refused(scalar), "U+\(String(scalar, radix: 16, uppercase: true))")
    }

    #expect(codes("plain text, 100% of it\nsecond line") == [])
    #expect(codes("naïve café 日本語 Ωmega 😀") == [])
    #expect(codes("a\u{200C}b") == ["U+200C"], "ZWNJ is Cf")
  }

  @Test("§6.2: more than four Mn/Me in a row, counted from zero at any other character")
  func marks() {
    let mark = "\u{0301}"
    func run(_ n: Int) -> String { String(repeating: mark, count: n) }

    #expect(DraftText.problems(in: "a" + run(4)).isEmpty)
    #expect(DraftText.problems(in: "a" + run(5)) == [.combiningMarks])
    #expect(DraftText.problems(in: run(5)) == [.combiningMarks], "even at the very start")
    #expect(DraftText.problems(in: run(4) + "a" + run(4)).isEmpty, "a base letter resets")
    #expect(DraftText.problems(in: run(3) + " " + run(3)).isEmpty, "a space resets")
    #expect(DraftText.problems(in: run(3) + "\n" + run(3)).isEmpty, "an LF resets")
    #expect(DraftText.problems(in: run(3) + "\u{0903}" + run(3)).isEmpty, "a spacing mark (Mc) resets")
    #expect(DraftText.problems(in: "a" + run(2) + "\u{20DD}" + run(2)) == [.combiningMarks], "an enclosing mark counts")
    // A mark that is default-ignorable is refused as that, before it is counted.
    #expect(DraftText.problems(in: "a" + run(4) + "\u{FE0F}") == [.characters([DraftText.Hidden(scalar: "\u{FE0F}", count: 1)])])
  }

  @Test("§6.3: the limits, to the character, on the stripped text, in code points")
  func limits() {
    let spaces = { (n: Int) in String(repeating: " ", count: n) }

    // MAX_INDENT is the leading run only; later runs are MAX_SPACE_RUN, however deep the line sits.
    #expect(DraftText.problems(in: spaces(32) + "x").isEmpty)
    #expect(DraftText.problems(in: spaces(33) + "x") == [.indent(line: 1)])
    #expect(DraftText.problems(in: "x" + spaces(17) + "y") == [.spaceRun(line: 1)])
    #expect(DraftText.problems(in: "x" + spaces(16) + "y").isEmpty)
    #expect(DraftText.problems(in: spaces(32) + "x" + spaces(16) + "y").isEmpty, "the indent is not also a run")
    #expect(DraftText.problems(in: spaces(32) + "x" + spaces(17) + "y") == [.spaceRun(line: 1)])
    #expect(DraftText.problems(in: spaces(40) + "x" + spaces(17) + "y").count == 2)

    // MAX_BLANK_LINES: three between lines, a fourth refused, and leading blank lines count.
    #expect(DraftText.problems(in: "a\n\n\n\nb").isEmpty)
    #expect(DraftText.problems(in: "a\n\n\n\n\nb") == [.blankLines(line: 2)])
    #expect(DraftText.problems(in: "\n\n\n\nx") == [.blankLines(line: 1)])
    #expect(DraftText.problems(in: "\n\n\nx").isEmpty)
    #expect(DraftText.problems(in: "a\n \n  \n\n   \nb") == [.blankLines(line: 2)], "a line of spaces is an empty line once stripped")

    // MAX_LINE_CHARS: the whole line, indent included, without the LF, in code points.
    #expect(DraftText.problems(in: String(repeating: "x", count: 2_000)).isEmpty)
    #expect(DraftText.problems(in: "ok\n" + String(repeating: "x", count: 2_001)) == [.lineTooLong(line: 2)])
    #expect(DraftText.problems(in: spaces(10) + String(repeating: "x", count: 1_991)) == [.lineTooLong(line: 1)])
    #expect(DraftText.problems(in: String(repeating: "😀", count: 2_000)).isEmpty)
    #expect(DraftText.problems(in: String(repeating: "😀", count: 2_001)) == [.lineTooLong(line: 1)], "an emoji is one code point")
    // A combining mark counts as a character; a family emoji is five code points.
    #expect(DraftText.problems(in: "a" + String(repeating: "\u{0301}", count: 4) + String(repeating: "x", count: 1_996)) == [.lineTooLong(line: 1)])

    // No exemption: a draft is plain text, not JSON.
    #expect(DraftText.problems(in: "\"code\\n" + spaces(20) + "x\"") == [.spaceRun(line: 1)])
  }

  @Test("§6.4: the order is strip, characters, layout; characters are listed before the layout rules")
  func order() {
    let both = DraftText.problems(in: "a\u{200B}\n\n\n\n\nb" + String(repeating: " ", count: 40) + "c")
    #expect(both.count == 3, "characters, blank lines, a run of spaces")

    if case .characters? = both.first {
    } else {
      Issue.record("characters first: \(both)")
    }
  }

  @Test("the draft the agent sent is taken as it came")
  func originalIsFine() {
    #expect(DraftText.problems(in: "Hi Bram,\n\nSee you Friday.\n\nGroet, Ada").isEmpty)
  }
}

@MainActor
@Suite("Draft model")
struct InteractiveDraftModelTests {
  @Test("an unchanged draft is approved as it came; an edit is an edit; trailing whitespace is not")
  func edited() {
    let draft = InteractiveDraftModel(params: draftParams())

    #expect(!draft.isEdited)
    #expect(draft.canApprove)
    draft.text += "   \n\n"
    #expect(!draft.isEdited, "the gateway trims it")
    draft.text = "Hi Bram,\n\nSee you Saturday."
    #expect(draft.isEdited)
    #expect(draft.approval == .approve(text: "Hi Bram,\n\nSee you Saturday."))
    draft.revert()
    #expect(!draft.isEdited)
  }

  @Test("a draft that cannot be changed cannot be approved once it is; text the gateway refuses cannot be approved")
  func approving() {
    let fixed = InteractiveDraftModel(params: draftParams(editable: false))
    #expect(!fixed.isEditable)
    #expect(fixed.canApprove)
    fixed.text = "something else"
    #expect(!fixed.canApprove)
    fixed.revert()
    #expect(fixed.canApprove)

    let draft = InteractiveDraftModel(params: draftParams())
    draft.text = "Pay now\u{202E}"
    #expect(!draft.problems.isEmpty)
    #expect(!draft.canApprove)
    // Nothing is rewritten for the person: they correct it.
    draft.text = "Pay now"
    #expect(draft.canApprove)

    // A rule that is not about characters is just as much a reason not to approve.
    draft.text = "ok" + String(repeating: " ", count: 40) + "x"
    #expect(draft.problems == [.spaceRun(line: 1)])
    #expect(!draft.canApprove)
    draft.text = "ok x"
    #expect(draft.canApprove)
    draft.text = " \n "
    #expect(draft.problems == [.empty])
    #expect(!draft.canApprove)

    draft.text = "I \u{2764}\u{FE0F}"
    #expect(!draft.canApprove, "❤️")

    draft.text = ""
    #expect(!draft.canApprove, "nothing to approve")
    // Lines of 100 code points (99 and an LF): 200 of them are the contract's 20,000.
    let line = String(repeating: "a", count: 99) + "\n"
    draft.text = String(repeating: line, count: 200) + "a"
    #expect(draft.isTooLong)
    #expect(!draft.canApprove)
    draft.text = String(repeating: line, count: 200)
    #expect(!draft.isTooLong)
    #expect(draft.canApprove)
  }

  @Test("a rejection carries the comment when there is one")
  func rejecting() {
    let draft = InteractiveDraftModel(params: draftParams())

    #expect(draft.rejection == .reject(comment: nil))
    draft.comment = "too short"
    #expect(draft.rejection == .reject(comment: "too short"))
    draft.comment = String(repeating: "x", count: InteractivePrompt.commentLimit + 1)
    #expect(draft.commentIsTooLong)
    draft.wipe()
    #expect(draft.comment.isEmpty)
    #expect(draft.text == draft.original)
  }
}

@Suite("Interactive sheet: Later", .timeLimit(.minutes(1))) @MainActor
struct InteractiveLaterTests {
  @Test("Later puts the sheet away without answering, the request stays open and does not come back by itself; opening it again does")
  func later() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-1")
    try await h.raiseOpen("srq-2")
    let model = InteractiveModel(session: h.session, bot: Fixture.profile)

    #expect(model.nextToPresent == "srq-1")
    model.present("srq-1")
    #expect(model.nextToPresent == nil, "one sheet at a time")
    model.later()
    #expect(model.presentedID == nil)
    #expect(h.link.answers.isEmpty, "Later never answers")
    #expect(h.link.declines.isEmpty)
    #expect(h.center.isOpen("srq-1"))
    #expect(model.putAway == ["srq-1"])
    #expect(model.nextToPresent == "srq-2", "the next one comes up, not the one put away")

    model.present("srq-2")
    model.later()
    #expect(model.nextToPresent == nil)

    // From its card.
    model.present("srq-1")
    #expect(model.presentedID == "srq-1")
    #expect(!model.putAway.contains("srq-1"))
    #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])))
    #expect(model.presentedID == nil)
  }

  @Test("a request put away that then ends is forgotten by Later, and the chat's notice says how it ended")
  func laterAfterEnd() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-1")
    try await h.raiseOpen("srq-2")
    let model = InteractiveModel(session: h.session, bot: Fixture.profile)

    model.present("srq-1")
    model.later()
    #expect(model.putAway == ["srq-1"])

    h.link.emit(
      "request.cancel", session: Fixture.runtime,
      payload: ["id": "srq-1", "method": "input.form", "reason": "timeout"])
    let center = h.center
    try await eventually("srq-1 to close") { await !center.isOpen("srq-1") }
    #expect(model.notice?.notice == .expired)

    // The next Later forgets what is no longer open.
    model.present("srq-2")
    model.later()
    #expect(model.putAway == ["srq-2"])
    #expect(h.link.answers.isEmpty)
  }
}
