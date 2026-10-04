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

  @Test("what the gateway refuses after trimming is what the sheet refuses: not a tab at the end, but one inside")
  func refused() {
    #expect(DraftText.refused(in: "fine\n").isEmpty)
    #expect(DraftText.refused(in: "end\t").isEmpty, "trimmed away by the gateway")
    #expect(DraftText.refused(in: "a\tb").map(\.code) == ["U+0009"])
    #expect(DraftText.refused(in: "a\u{202E}b").map(\.code) == ["U+202E"])
    #expect(DraftText.refused(in: "a\u{200B}b").map(\.code) == ["U+200B"], "a format character")
    #expect(DraftText.refused(in: "a\rb").map(\.code) == ["U+000D"], "a CR inside a line")
    #expect(DraftText.refused(in: "a\u{00A0}b").isEmpty, "an unusual space is shown, not refused")
    #expect(DraftText.removingRefused(from: "a\u{202E}b\tc\nd") == "abc\nd")
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
    #expect(!draft.refusedCharacters.isEmpty)
    #expect(!draft.canApprove)
    draft.removeRefusedCharacters()
    #expect(draft.text == "Pay now")
    #expect(draft.canApprove)

    draft.text = ""
    #expect(!draft.canApprove, "nothing to approve")
    draft.text = String(repeating: "a", count: InteractivePrompt.draftLimit + 1)
    #expect(draft.isTooLong)
    #expect(!draft.canApprove)
    draft.text = String(repeating: "a", count: InteractivePrompt.draftLimit)
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
