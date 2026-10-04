import Foundation
import HermieCore
import HermieProtocol
import HermieTranscript
import SwiftUI
import Testing
#if os(macOS)
  import AppKit
#endif

@testable import HermieUI

/// The parts of the form, file and draft sheets that are plain functions or small views: which
/// sources a request offers, the words for a field's problem, what the transcript's card says, and
/// that every control draws. (The sheets themselves are not driven by UI tests.)
@MainActor
@Suite("Interactive sheets")
struct InteractiveSheetTests {
  // MARK: File sources

  private func fileParams(accept: String? = nil, capture: String? = nil) -> InputFileParams {
    var json: JSONObject = ["v": 1, "upload": ["dir": "/a"]]

    if let accept {
      json["accept"] = .string(accept)
    }

    if let capture {
      json["capture"] = .string(capture)
    }

    return InputFileParams(json: json)
  }

  @Test("a request for pictures offers the library, the camera and Files, the camera first when it asks for a photo")
  func sourcesForPictures() {
    typealias Source = FileSheetView.Source

    #expect(
      FileSheetView.sources(for: fileParams(accept: "image"), camera: true, scanner: true)
        == [.photos, .camera, .scan, .files])
    #expect(
      FileSheetView.sources(for: fileParams(accept: "image", capture: "photo"), camera: true, scanner: true)
        == [.camera, .photos, .scan, .files])
    #expect(FileSheetView.sources(for: fileParams(accept: "image", capture: "photo"), camera: false, scanner: false) == [.photos, .files])
    // A Mac: no camera, no scanner.
    #expect(FileSheetView.sources(for: fileParams(accept: "any"), camera: false, scanner: false) == [.photos, .files])
  }

  @Test("a request for a document offers the scanner first, and no library, no camera")
  func sourcesForDocuments() {
    #expect(FileSheetView.sources(for: fileParams(accept: "document"), camera: true, scanner: true) == [.scan, .files])
    #expect(FileSheetView.sources(for: fileParams(accept: "document"), camera: true, scanner: false) == [.files])
    #expect(FileSheetView.sources(for: fileParams(accept: "document", capture: "scan"), camera: false, scanner: true) == [.scan, .files])
  }

  @Test("a request for audio, or a preference this device cannot meet, still offers Files")
  func sourcesForAudio() {
    #expect(FileSheetView.sources(for: fileParams(accept: "audio", capture: "audio"), camera: true, scanner: true) == [.files])
    #expect(FileSheetView.sources(for: fileParams(accept: "image", capture: "scan"), camera: true, scanner: false) == [.photos, .camera, .files])
    #expect(FileSheetView.sources(for: fileParams(), camera: false, scanner: false).last == .files)
  }

  @Test("every source has a title and an icon")
  func sourceWords() {
    for source in [FileSheetView.Source.photos, .camera, .scan, .files] {
      #expect(!source.title.isEmpty && !source.title.hasPrefix("native."))
      #expect(!source.icon.isEmpty)
    }

    #expect(FileSheetView.icon(forFileNamed: "a.jpg") == "photo")
    #expect(FileSheetView.icon(forFileNamed: "a.pdf") == "doc.richtext")
    #expect(FileSheetView.icon(forFileNamed: "a.m4a") == "waveform")
    #expect(FileSheetView.icon(forFileNamed: "a.mov") == "film")
    #expect(FileSheetView.icon(forFileNamed: "noextension") == "doc")
  }

  // MARK: Words for fields

  private func field(_ json: JSONValue) throws -> FormField {
    try #require(FormField(jsonValue: json))
  }

  private let clock = FormClock(zone: TimeZone(identifier: "Europe/Amsterdam") ?? .gmt)

  @Test("a problem is said in a sentence with the field's own bounds in it, never the gateway's reason")
  func problemWords() throws {
    let number = try field(["id": "g", "kind": "number", "label": "g", "min": 1, "max": 12, "step": 2])
    let amount = try field(["id": "b", "kind": "amount", "label": "b", "currency": "EUR", "min": "0", "max": "5000"])
    let date = try field(["id": "d", "kind": "date", "label": "d", "min": "2026-10-05", "max": "2026-12-31"])
    let time = try field(["id": "t", "kind": "time", "label": "t", "min": "08:00", "max": "18:00"])
    let text = try field(["id": "x", "kind": "text", "label": "x", "max_length": 20])
    let choice = try field([
      "id": "c", "kind": "choice", "label": "c", "multiple": true, "min_selected": 2, "max_selected": 3,
      "options": [["value": "a", "label": "A"]]
    ])

    #expect(FormFieldText.problem(.missing, field: text, clock: clock) == "This is required.")
    #expect(FormFieldText.problem(.tooLong, field: text, clock: clock) == "Too long: at most 20 characters.")
    #expect(FormFieldText.problem(.format, field: text, clock: clock) == "That is not in the right format.")
    #expect(FormFieldText.problem(.belowMin, field: number, clock: clock) == "Must be at least 1.")
    #expect(FormFieldText.problem(.aboveMax, field: number, clock: clock) == "Must be at most 12.")
    #expect(FormFieldText.problem(.step, field: number, clock: clock) == "Must go up in steps of 2 from 1.")
    #expect(FormFieldText.problem(.notInteger, field: number, clock: clock) == "Enter a whole number.")
    #expect(FormFieldText.problem(.belowMin, field: amount, clock: clock) == "Must be at least 0 EUR.")
    #expect(FormFieldText.problem(.aboveMax, field: amount, clock: clock) == "Must be at most 5000 EUR.")
    #expect(FormFieldText.problem(.belowMin, field: time, clock: clock) == "Must be on or after 08:00.")
    #expect(FormFieldText.problem(.aboveMax, field: time, clock: clock) == "Must be on or before 18:00.")
    #expect(FormFieldText.problem(.tooFew, field: choice, clock: clock) == "Choose at least 2.")
    #expect(FormFieldText.problem(.tooMany, field: choice, clock: clock) == "Choose at most 3.")
    #expect(FormFieldText.problem(.order, field: date, clock: clock) == "The end is before the start.")

    let before = FormFieldText.problem(.belowMin, field: date, clock: clock)
    #expect(before.hasPrefix("Must be on or after ") && before.contains("2026"), "\(before)")
    let after = FormFieldText.problem(.aboveMax, field: date, clock: clock)
    #expect(after.hasPrefix("Must be on or before ") && after.contains("2026"), "\(after)")

    // A reason this build has no words for, or one that cannot be said without a bound it lacks.
    for odd in [FormProblem.other("brand_new"), .zone, .offset, .duplicate, .notAnOption] {
      #expect(FormFieldText.problem(odd, field: text, clock: clock) == "The gateway did not accept this value.")
    }

    #expect(FormFieldText.problem(.belowMin, field: text, clock: clock) == "The gateway did not accept this value.")
    #expect(!FormFieldText.problem(.other("field:x:y"), field: text, clock: clock).contains("field:"))
  }

  @Test("numeric bounds are said under the field")
  func boundsWords() throws {
    #expect(FormFieldText.bounds(try field(["id": "g", "kind": "number", "label": "g", "min": 1, "max": 12])) == "Between 1 and 12")
    #expect(FormFieldText.bounds(try field(["id": "g", "kind": "number", "label": "g", "min": 1])) == "At least 1")
    #expect(FormFieldText.bounds(try field(["id": "b", "kind": "amount", "label": "b", "currency": "EUR", "max": "5000"])) == "At most 5000")
    #expect(FormFieldText.bounds(try field(["id": "g", "kind": "number", "label": "g"])) == nil)
    #expect(FormFieldText.bounds(try field(["id": "t", "kind": "text", "label": "t"])) == nil)
  }

  @Test("the gateway's reasons for refusing an answer are said in the app's words")
  func refusalWords() {
    #expect(NativeStrings.Interactive.refusal("not_optional") == "This request cannot be skipped.")
    #expect(NativeStrings.Interactive.refusal("files:too_many") == "Too many files.")
    #expect(NativeStrings.Interactive.refusal("files:too_large") == "The files are too large together.")
    #expect(NativeStrings.Interactive.refusal("file:0:too_large") == "A file is larger than the gateway allows.")
    #expect(NativeStrings.Interactive.refusal("file:2:outside_dir") == "A file is not where the gateway expects it.")
    #expect(NativeStrings.Interactive.refusal("file:2:something_new") == "The gateway did not accept one of the files.")
    #expect(NativeStrings.Interactive.refusal("bad_shape") == "The gateway could not read this answer.")
    #expect(NativeStrings.Interactive.refusal("too_many_attempts") == "Too many answers were refused, so the request was withdrawn.")
    #expect(NativeStrings.Interactive.refusal("text:not_verbatim") == "The gateway refuses the text: it holds characters or spacing that cannot be shown as they are.")
    #expect(NativeStrings.Interactive.refusal("text:edited") == "This draft cannot be changed.")
    #expect(NativeStrings.Interactive.refusal("some_new_reason") == "The gateway did not accept this answer.")
    #expect(NativeStrings.Interactive.refusal("a:reason\nthat is long and from elsewhere") == "The gateway did not accept this answer.")
  }

  @Test("every notice has words in the sheet and an icon; the chat's line names the bot only for what could not be shown")
  func noticeWords() {
    let notices: [InteractiveNotice] = [
      .expired, .withdrawn, .mayNotHaveArrived, .answeredElsewhere, .notAllowed, .lapsed,
      .cannotShow(method: "input.form", reason: "no_camera")
    ]

    for notice in notices {
      #expect(!InteractiveNoticeView.sheetText(notice).isEmpty)
      #expect(!InteractiveNoticeView.icon(notice).isEmpty)
      #expect(!InteractiveNoticeView.sheetText(notice).hasPrefix("native."))
    }

    #expect(InteractiveNoticeView.text(.answeredElsewhere, bot: "ada") == "This was answered on another device. Nothing was sent from here.")
    #expect(InteractiveNoticeView.text(.cannotShow(method: "input.form", reason: "x"), bot: "ada") == "Hermie could not show a request from ada and told it so.")
  }

  @Test("each rule a draft breaks is said in a sentence with its line and its limit")
  func draftProblemWords() {
    #expect(DraftSheetView.words(for: .combiningMarks) == "More than 4 combining marks on one character.")
    #expect(DraftSheetView.words(for: .blankLines(line: 7)) == "From line 7 there are more than 3 blank lines in a row.")
    let long = DraftSheetView.words(for: .lineTooLong(line: 2))
    #expect(long.hasPrefix("Line 2 is longer than 2") && long.hasSuffix("000 characters."), "\(long)")
    #expect(DraftSheetView.words(for: .indent(line: 5)) == "Line 5 is indented by more than 32 spaces.")
    #expect(DraftSheetView.words(for: .spaceRun(line: 1)) == "Line 1 has more than 16 spaces in a row.")
    #expect(DraftSheetView.words(for: .empty).hasPrefix("Nothing is left"))
    #expect(DraftSheetView.words(for: .characters([])).hasPrefix("Characters that do not show"))
  }

  #if os(macOS)
    @Test("the draft editor never wraps and corrects nothing")
    func editorDoesNotWrap() {
      let scroll = NSScrollView()
      let view = NSTextView(frame: .zero)
      NoWrapTextEditor.configure(view, in: scroll)

      #expect(view.textContainer?.widthTracksTextView == false)
      #expect(view.isHorizontallyResizable)
      #expect((view.textContainer?.containerSize.width ?? 0) >= NoWrapTextEditor.containerWidth)
      #expect(view.textContainer?.lineBreakMode == .byClipping)
      #expect(scroll.hasHorizontalScroller)
      #expect(!view.isRichText)
      #expect(!view.isAutomaticQuoteSubstitutionEnabled)
      #expect(!view.isAutomaticDashSubstitutionEnabled)
      #expect(!view.isAutomaticTextReplacementEnabled)
      #expect(!view.isAutomaticSpellingCorrectionEnabled)
      #expect(!view.isAutomaticLinkDetectionEnabled)
      #expect(!view.isAutomaticDataDetectionEnabled)
      #expect(!view.isContinuousSpellCheckingEnabled)
      #expect(!view.smartInsertDeleteEnabled)
    }
  #endif

  @Test("the draft's text draws, and a long line is not wrapped into many")
  func noWrapTextRenders() throws {
    let long = "a long line " + String(repeating: "x", count: 600)
    let renderer = ImageRenderer(content: NoWrapText(text: "short\n" + long + "\n  indented").frame(width: 390))
    renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
    let image = try #require(renderer.cgImage)
    #expect(image.height > 0)
    #expect(image.height < 200, "\(image.height)")
  }

  // MARK: The transcript's card

  private func item(
    _ method: String = "input.form", state: RequestState, summary: RequestAnswerSummary? = nil, cancel: String? = nil,
    title: String = "Hotel booking"
  ) -> RequestItem {
    RequestItem(
      base: ItemBase(id: "i1", seq: 0, ts: 1_790_000_000, origin: .live, version: 1), requestID: "srq-1", method: method, title: title,
      summary: "s", optional: true, state: state, answerSummary: summary, cancelReason: cancel)
  }

  @Test("the card says what kind, and how it stands, by the summary's keys alone")
  func cardWords() {
    typealias Card = InteractiveRequestCardView

    #expect(Card.kind(of: item("input.form", state: .open)) == "Form")
    #expect(Card.kind(of: item("input.file", state: .open)) == "File")
    #expect(Card.kind(of: item("review.draft", state: .open)) == "Draft review")
    #expect(Card.kind(of: item("device.location", state: .open)) == nil)

    #expect(Card.state(of: item(state: .open)) == "Waiting for your answer")
    #expect(Card.state(of: item(state: .answered, summary: RequestAnswerSummary(status: "answered"))) == "Answered")
    #expect(Card.state(of: item(state: .answered, summary: RequestAnswerSummary(status: "skipped"))) == "Skipped")
    #expect(Card.state(of: item("input.file", state: .answered, summary: RequestAnswerSummary(status: "answered", count: 2))) == "Files sent: 2")
    #expect(Card.state(of: item("review.draft", state: .answered, summary: RequestAnswerSummary(decision: "approved", edited: false))) == "Approved")
    #expect(Card.state(of: item("review.draft", state: .answered, summary: RequestAnswerSummary(decision: "approved", edited: true))) == "Approved with changes")
    #expect(Card.state(of: item("review.draft", state: .answered, summary: RequestAnswerSummary(decision: "rejected"))) == "Rejected")
    #expect(Card.state(of: item(state: .answered)) == "Answered")
    #expect(Card.state(of: item(state: .cancelled, cancel: "timeout")) == "Timed out")
    #expect(Card.state(of: item(state: .cancelled, cancel: "resolved")) == "Answered on another device")
    #expect(Card.state(of: item(state: .cancelled, cancel: "interrupted")) == "Ended without an answer")
    #expect(Card.state(of: item(state: .cancelled)) == "Ended without an answer")

    #expect(Card.icon(of: item("input.file", state: .open)) == "paperclip")
    #expect(Card.icon(of: item("review.draft", state: .open)) == "text.badge.checkmark")
    #expect(Card.icon(of: item(state: .open)) == "list.bullet.rectangle")
    #expect(Card.icon(of: item(state: .cancelled)) == "xmark.circle")
  }

  @Test("the card draws in every state at the default text size and at AX5, with an agent title that tries to be markup")
  func cardRenders() throws {
    let states: [RequestItem] = [
      item(state: .open), item(state: .answered, summary: RequestAnswerSummary(status: "answered")),
      item(state: .cancelled, cancel: "timeout"),
      item(state: .open, title: "**bold** [link](https://example.com) \u{202E}reversed"),
      item("device.location", state: .open)
    ]

    for size in [DynamicTypeSize.large, .accessibility5] {
      for state in states {
        let renderer = ImageRenderer(
          content: InteractiveRequestCardView(item: state, presentation: .full)
            .frame(width: 390)
            .dynamicTypeSize(size))
        renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
        let image = try #require(renderer.cgImage, "\(state.title) did not render")
        #expect(image.height > 0)
      }
    }
  }

  @Test("a request item is no longer a row that draws nothing")
  func cardTakesRoom() {
    let visible = VisibleItem(item: .request(item(state: .open)), presentation: .full)
    #expect(!TranscriptRowBuilder.drawsNothing(TranscriptRow(visible)))
  }

  // MARK: The fields draw

  @Test("every kind of field draws, in a form with its defaults, at the default text size and at AX5")
  func fieldsRender() throws {
    let fields: JSONValue = [
      ["id": "name", "kind": "text", "label": "Name on the booking", "required": true, "max_length": 20, "hint": "As on the passport."],
      ["id": "bio", "kind": "text", "label": "Notes", "multiline": true, "input": "email"],
      ["id": "guests", "kind": "number", "label": "Guests", "integer": true, "min": 1, "max": 12, "default": 2],
      ["id": "budget", "kind": "amount", "label": "Budget", "currency": "EUR", "min": "0", "max": "5000"],
      ["id": "yen", "kind": "amount", "label": "Price", "currency": "JPY"],
      ["id": "arrival", "kind": "date", "label": "Arrival", "tz": "Europe/Amsterdam", "default": "2026-10-05", "min": "2026-10-01"],
      ["id": "empty_date", "kind": "date", "label": "Departure"],
      ["id": "check_in", "kind": "time", "label": "Check-in", "default": "14:30"],
      ["id": "call_at", "kind": "datetime", "label": "Call", "tz": "Europe/Amsterdam", "default": "2026-10-07T14:30:00+02:00"],
      ["id": "stay", "kind": "daterange", "label": "Stay", "default": ["start": "2026-10-03", "end": "2026-10-05"]],
      ["id": "room", "kind": "choice", "label": "Room", "options": [["value": "s", "label": "Single"], ["value": "d", "label": "Double"]]],
      ["id": "extras", "kind": "choice", "label": "Extras", "multiple": true, "max_selected": 1,
        "options": [["value": "b", "label": "Breakfast"], ["value": "p", "label": "Parking"]], "default": ["b"]],
      ["id": "news", "kind": "toggle", "label": "Send me offers", "default": true]
    ]
    let form = InteractiveFormModel(
      params: InputFormParams(json: ["v": 1, "title": "t", "summary": "s", "fields": fields]),
      device: TimeZone(identifier: "Europe/Amsterdam") ?? .gmt)
    // Show every problem too.
    _ = form.submit()

    for size in [DynamicTypeSize.large, .accessibility5] {
      for id in form.fields.compactMap(\.id) {
        let renderer = ImageRenderer(
          content: FormFieldRow(form: form, id: id)
            .frame(width: 390)
            .padding()
            .dynamicTypeSize(size))
        renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
        let image = try #require(renderer.cgImage, "\(id) did not render")
        #expect(image.height > 0, "\(id)")
      }
    }
  }

  // MARK: Strings

  private func table(_ language: String) throws -> [String: String] {
    let path = try #require(
      HermieStringsLookup.bundle.path(
        forResource: "Native", ofType: "strings", inDirectory: nil, forLocalization: language))
    let plist = try #require(NSDictionary(contentsOfFile: path) as? [String: String])
    return plist.filter { $0.key.hasPrefix("native.interactive.") }
  }

  /// The conversions of a format string, by kind: what has to be the same in every language
  /// (`%1$@` and `%@` are both an object; where it stands is the translation's business).
  private func conversions(_ format: String) -> [String] {
    guard let expression = try? NSRegularExpression(pattern: #"%(?:\d+\$)?(lld|@|d|f)"#) else {
      return []
    }

    let text = format as NSString
    return expression.matches(in: format, range: NSRange(location: 0, length: text.length))
      .map { text.substring(with: $0.range(at: 1)) }
      .sorted()
  }

  @Test("every interactive string is in all three languages, with the same conversions, and none is empty")
  func stringsInAllLanguages() throws {
    let en = try table("en")
    let nl = try table("nl")
    let de = try table("de")

    #expect(en.count >= 100, "\(en.count)")
    #expect(Set(en.keys) == Set(nl.keys), "nl is missing \(Set(en.keys).subtracting(nl.keys)) / has more \(Set(nl.keys).subtracting(en.keys))")
    #expect(Set(en.keys) == Set(de.keys), "de is missing \(Set(en.keys).subtracting(de.keys)) / has more \(Set(de.keys).subtracting(en.keys))")

    for (key, value) in en {
      #expect(!value.isEmpty, "\(key)")
      #expect(!(nl[key] ?? "").isEmpty && !(de[key] ?? "").isEmpty, "\(key)")
      #expect(conversions(value) == conversions(nl[key] ?? ""), "nl \(key)")
      #expect(conversions(value) == conversions(de[key] ?? ""), "de \(key)")
    }
  }

  @Test("every accessor finds its string")
  func accessors() {
    typealias I = NativeStrings.Interactive
    let all: [String] = [
      I.titleForm("A"), I.titleFile("A"), I.titleDraft("A"), I.says("A"), I.onBehalfOf("A"), I.later, I.skip, I.send,
      I.tryAgain, I.close, I.decline, I.declineHint, I.earlierAnswerLost, I.answeredElsewhere, I.notAllowed, I.cannotShow("A"),
      I.refusalNotOptional, I.refusalTooManyFiles, I.refusalFilesTooLarge, I.refusalFileRefused,
      I.refusalNotVerbatim, I.refusalEdited, I.refusalOther, I.refusalOutsideDir, I.refusalFileTooLarge,
      I.refusalBadShape, I.refusalTooManyAttempts,
      I.Form.required, I.Form.chooseDate, I.Form.chooseTime, I.Form.chooseDateTime, I.Form.chooseRange, I.Form.clear,
      I.Form.from, I.Form.to, I.Form.choose, I.Form.none, I.Form.inZone("A"), I.Form.characters(1, of: 2),
      I.Form.between("1", "2"), I.Form.atLeast("1"), I.Form.atMost("2"), I.Form.wholeAmounts("JPY"),
      I.Form.decimals("EUR", 2), I.Form.needAttention, I.Form.problemMissing, I.Form.problemFormat,
      I.Form.problemTooLong(1), I.Form.problemBelowMin("1"), I.Form.problemAboveMax("1"), I.Form.problemBefore("1"),
      I.Form.problemAfter("1"), I.Form.problemNotInteger, I.Form.problemStep("1", "2"), I.Form.problemOrder,
      I.Form.problemTooFew(1), I.Form.problemTooMany(1), I.Form.problemOther,
      I.File.scan, I.File.oneFile, I.File.upToFiles(2), I.File.perFile("1 MB"), I.File.inTotal("2 MB"),
      I.File.stripNote, I.File.noFiles, I.File.uploadAndSend, I.File.cancelUpload, I.File.uploadFailed, I.File.giveUp,
      I.File.giveUpNote, I.File.uploaded, I.File.changeFiles, I.File.rejectTooMany(2), I.File.rejectTooLarge("a", "1 MB"),
      I.File.rejectTotal("1 MB"), I.File.rejectUnreadable("a"),
      I.Draft.kindMail, I.Draft.kindPost, I.Draft.kindMessage, I.Draft.kindDocument, I.Draft.kindOther,
      I.Draft.subject, I.Draft.recipients, I.Draft.textLabel, I.Draft.approve, I.Draft.approveWithChanges,
      I.Draft.reject, I.Draft.rejectConfirm, I.Draft.back, I.Draft.comment("A"), I.Draft.edited, I.Draft.revert,
      I.Draft.notEditable, I.Draft.hiddenWarning, I.Draft.hiddenLegend, I.Draft.tooLong(1), I.Draft.problemEmpty,
      I.Draft.problemCharacters, I.Draft.problemMarks(4), I.Draft.problemBlankLines(2, 3), I.Draft.problemLineTooLong(2, 2000),
      I.Draft.problemIndent(2, 32), I.Draft.problemSpaceRun(2, 16), I.Draft.correctNote, I.Draft.noWrapHint,
      I.Draft.commentTooLong(1),
      I.Card.form, I.Card.file, I.Card.draft, I.Card.open, I.Card.answered, I.Card.skipped, I.Card.files(1),
      I.Card.approved, I.Card.approvedEdited, I.Card.rejected, I.Card.timedOut, I.Card.ended,
      I.Card.answeredElsewhere, I.Card.openAction
    ]

    for text in all {
      #expect(!text.isEmpty && !text.hasPrefix("native.interactive."), "\(text)")
    }

    // One accessor for each key of the table: a key nobody asks for is a leftover.
    #expect(all.count == ((try? table("en"))?.count ?? -1))
  }
}
