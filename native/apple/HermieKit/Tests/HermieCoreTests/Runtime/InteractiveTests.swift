import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
/// A value nobody else in the test writes, so finding it anywhere is a leak.
private let typed = "booking-7f3a-never-anywhere"

/// The params of the three interactive requests, as the gateway builds them
/// (`contract/requests/examples.json`), next to the transport's `session_id`.
enum InteractiveFrames {
  /// The harness clock's wall time is 1_790_000_000 at its start: this is 300 s on.
  static let expires = 1_790_000_300

  static func envelope(
    title: String = "Hotel booking",
    summary: String = "Fill this in and I will book the best match.",
    expires: Int? = InteractiveFrames.expires,
    optional: Bool? = nil
  ) -> JSONObject {
    var params: JSONObject = ["v": 1, "title": .string(title), "summary": .string(summary)]

    if let expires {
      params["expires_at"] = .number(Double(expires))
    }

    if let optional {
      params["optional"] = .bool(optional)
    }

    params["acting_user"] = ["id": "oidc:5b1e0c9a", "name": "Ada"]
    return params
  }

  static func form(
    expires: Int? = InteractiveFrames.expires,
    optional: Bool? = nil,
    fields: JSONValue? = nil
  ) -> JSONObject {
    var params = envelope(expires: expires, optional: optional)
    params["fields"] =
      fields ?? [
        ["id": "name", "kind": "text", "label": "Name on the booking", "required": true],
        ["id": "guests", "kind": "number", "label": "Guests", "integer": true, "default": 2]
      ]
    return params
  }

  static func file(expires: Int? = InteractiveFrames.expires, multiple: Bool = false, maxFiles: Int = 1) -> JSONObject {
    var params = envelope(title: "Receipt", summary: "Take a photo of the receipt.", expires: expires)
    params["accept"] = "image"
    params["capture"] = "photo"
    params["multiple"] = .bool(multiple)
    params["upload"] = [
      "dir": "/home/ada/work/uploads/hermie/2026-10-04",
      "max_bytes": 10_485_760,
      "max_total_bytes": 10_485_760,
      "max_files": .number(Double(maxFiles)),
      "strip_metadata": true
    ]
    return params
  }

  static let draftText = "Hi Bram,\n\nThe flat is free from 1 November.\nKind regards,\nAda"

  static func draft(expires: Int? = InteractiveFrames.expires, editable: Bool = true) -> JSONObject {
    var params = envelope(
      title: "Reply to Bram", summary: "Approve, edit or reject it.", expires: expires, optional: false)
    params["kind"] = "mail"
    params["text"] = .string(draftText)
    params["subject"] = "Re: Flat on the Oudegracht"
    params["recipients"] = ["Bram de Vries <bram@example.com>"]
    params["editable"] = .bool(editable)
    return params
  }

  static func upload(_ name: String = "receipt.jpg") -> UploadedFile {
    UploadedFile(
      path: "/home/ada/work/uploads/hermie/2026-10-04/3f9c2a7b1d4e8f60-\(name)",
      name: name,
      mime: "image/jpeg",
      bytes: 482_113,
      sha256: String(repeating: "ab", count: 32)
    )
  }
}

/// A session over the scripted link with the researcher's chat open on `Fixture.runtime`, and its
/// interactive request center.
@MainActor
struct InteractiveHarness {
  let harness: SessionHarness
  var link: ScriptedLink { harness.link }
  var clock: ManualClock { harness.clock }
  var session: GatewaySession { harness.session }
  var center: InteractiveRequestCenter { harness.session.interactive }

  init(cache: (any ChatCaching)? = nil, keyValues: KeyValueStore? = nil, requests: [String]? = nil) {
    harness = SessionHarness(cache: cache, keyValues: keyValues, requests: requests)
  }

  func open() async throws {
    try await harness.start()
    try await harness.open()
    try await harness.frame()
  }

  /// Raise a request and wait until the center has it open.
  @discardableResult
  func raiseOpen(
    _ id: String,
    _ method: String = "input.form",
    params: JSONObject = InteractiveFrames.form(),
    session: String = Fixture.runtime,
    replayed: Bool = false
  ) async throws -> InteractivePrompt {
    var params = params
    params["session_id"] = .string(session)
    link.raise(id: id, method: method, params: params, replayed: replayed)
    let center = self.center
    try await eventually("\(id) to open") { await center.isOpen(id) }
    return try #require(center.prompts.first { $0.id == id })
  }

  func answers(_ id: String) -> [JSONObject] {
    link.answers.filter { $0.id == id }.map(\.result)
  }

  /// The `data.reason` of the `4041` that went out for a request, when one did.
  func cannotShowReason(_ id: String) -> String? {
    guard link.declines.contains(where: { $0.id == id && $0.code == JSONRPCError.cannotShowCode }) else {
      return nil
    }

    return link.declineData(id)?["reason"]?.stringValue
  }

  /// The chat's card for a request (the newest, for one asked again), once the center's calls to
  /// the transcript ran.
  func card(_ id: String) async -> RequestItem? {
    await center.settleTranscript()
    return await session.store.state(of: bot)?.orderedItems.compactMap(\.asRequest).last { $0.requestID == id }
  }
}

@Suite("Interactive requests: routing, answering, ending", .timeLimit(.minutes(1))) @MainActor
struct InteractiveTests {
  // MARK: Routing

  @Test("a request goes to the chat whose runtime session it names, and the transcript shows only a card")
  func routesBySession() async throws {
    let h = InteractiveHarness()
    try await h.open()

    let prompt = try await h.raiseOpen("srq-1", params: InteractiveFrames.form(optional: true))
    #expect(prompt.chatKey == bot)
    #expect(prompt.method == "input.form")
    #expect(prompt.title == "Hotel booking")
    #expect(prompt.summary == "Fill this in and I will book the best match.")
    #expect(prompt.actingUser == "Ada")
    #expect(prompt.offersSkip, "input.* offers Skip unless the agent says otherwise")
    #expect(prompt.deadline == h.clock.now + .seconds(300), "from expires_at")
    #expect(h.center.needsInput(bot))
    #expect(!h.center.needsInput("someone-else"))
    #expect(h.link.declines.isEmpty, "the store left it alone")
    #expect(h.link.answers.isEmpty)

    let card = try #require(await h.card("srq-1"))
    #expect(card.method == "input.form")
    #expect(card.title == "Hotel booking")
    #expect(card.state == .open)
    #expect(card.optional)
    #expect(card.answerSummary == nil)
  }

  @Test("each method reads its params; a draft offers no Skip unless it says so")
  func readsEveryMethod() async throws {
    let h = InteractiveHarness()
    try await h.open()

    let form = try await h.raiseOpen("f")
    guard case .form(let formParams) = form.body else {
      Issue.record("not a form")
      return
    }
    #expect(formParams.fields?.count == 2)

    let file = try await h.raiseOpen("u", "input.file", params: InteractiveFrames.file())
    guard case .file(let fileParams) = file.body else {
      Issue.record("not a file")
      return
    }
    #expect(fileParams.accept == .image)
    #expect(fileParams.upload?.dir == "/home/ada/work/uploads/hermie/2026-10-04")

    let draft = try await h.raiseOpen("d", "review.draft", params: InteractiveFrames.draft())
    guard case .draft(let draftParams) = draft.body else {
      Issue.record("not a draft")
      return
    }
    #expect(draftParams.text == InteractiveFrames.draftText, "verbatim")
    #expect(draftParams.recipients == ["Bram de Vries <bram@example.com>"])
    #expect(!draft.offersSkip)
    #expect(h.center.prompts(for: bot).map(\.id) == ["f", "u", "d"])
  }

  @Test("the envelope's texts are cleaned and bounded for display; the title is one line")
  func cleansTexts() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.form()
    params["title"] = "Pay\u{202E}gnp.exe\u{0007}\nnow"
    params["summary"] = .string(String(repeating: "a", count: 700))
    params["detail"] = "line one\n\n\n\nline\ttwo"
    params["acting_user"] = ["id": "x", "name": "Ada\u{202E}Evil"]

    let prompt = try await h.raiseOpen("srq-c", params: params)
    #expect(prompt.title == "Paygnp.exe now")
    #expect(prompt.summary.count == InteractivePrompt.summaryLimit + 1)
    #expect(prompt.detail == "line one\nline two")
    #expect(prompt.actingUser == "AdaEvil")
  }

  @Test("a request for a session no chat holds yet waits, and opens when a resume binds it")
  func parksUntilBound() async throws {
    let h = InteractiveHarness()
    try await h.harness.start()

    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "early", method: "input.form", params: params)
    try await eventually("the store to see it") { await h.session.store.ingestedFrames >= 1 }
    let center = h.center
    try await eventually("it to wait") { await center.parkedCount == 1 }
    #expect(center.prompts.isEmpty)

    try await h.harness.open()
    try await h.harness.frame()
    try await eventually("the parked request to open") { await center.isOpen("early") }
    #expect(center.prompts.first?.chatKey == bot)
    #expect(h.link.declines.isEmpty)
    #expect(await h.card("early")?.state == .open)
  }

  @Test("one still unclaimed when the park limit passes is declined 4041, and the lot is bounded")
  func parkingIsBounded() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.form()
    params["session_id"] = "rt-other"

    for index in 0..<16 {
      h.link.raise(id: "far-\(index)", method: "input.form", params: params)
    }
    h.link.raise(id: "one-too-many", method: "input.form", params: params)
    let link = h.link
    try await eventually("the extra one to be declined") { link.declines.contains { $0.id == "one-too-many" } }
    #expect(h.link.declines.count == 1)
    #expect(h.link.declines.first?.code == 4041)
    #expect(h.cannotShowReason("one-too-many") == InteractiveRequestCenter.Reason.noChat)

    await h.clock.advance(by: .seconds(15))
    try await eventually("the parked ones to be declined") { link.declines.count == 17 }
    #expect(h.link.answers.isEmpty, "never answered with a result")
    #expect(h.center.prompts.isEmpty)
    #expect(link.declines.allSatisfy { $0.code == 4041 })
  }

  @Test("a request with no session is declined 4041 at once")
  func declinesWithoutSession() async throws {
    let h = InteractiveHarness()
    try await h.open()

    let link = h.link
    link.raise(id: "nosession", method: "input.form", params: InteractiveFrames.form())
    try await eventually("the refusal") { link.declines.contains { $0.id == "nosession" } }
    #expect(h.cannotShowReason("nosession") == InteractiveRequestCenter.Reason.noChat)
    #expect(h.center.prompts.isEmpty)
  }

  @Test("a method the connection did not advertise is left alone: it was declined -32601 below this layer")
  func unadvertisedIsIgnored() async throws {
    let h = InteractiveHarness(requests: ["input.form"])
    try await h.open()

    var params = InteractiveFrames.file()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-f", method: "input.file", params: params)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))

    #expect(h.center.prompts.isEmpty)
    #expect(h.center.notices.isEmpty)
    #expect(h.link.declines.isEmpty, "this layer sends nothing for it")
    #expect(h.link.answers.isEmpty)
    #expect(await h.card("srq-f") == nil, "and the transcript has no card for it")

    try await h.raiseOpen("srq-g")
    #expect(h.center.isOpen("srq-g"))
  }

  // MARK: What this build cannot show

  @Test("a form with a field kind this build does not know is declined 4041 not_supported_on_device, with a notice")
  func unknownFieldKind() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.form(fields: [["id": "x", "kind": "hologram", "label": "X"]])
    params["session_id"] = .string(Fixture.runtime)

    h.link.raise(id: "srq-u", method: "input.form", params: params)
    let center = h.center
    try await eventually("the notice") { await center.notices[bot] != nil }
    #expect(center.notices[bot]?.notice == .cannotShow(method: "input.form", reason: CannotShowReason.notSupportedOnDevice))
    #expect(h.cannotShowReason("srq-u") == "not_supported_on_device")
    #expect(h.link.declines.first?.message == "cannot_show")
    #expect(h.link.answers.isEmpty, "never a made-up skip")
    #expect(center.prompts.isEmpty)
    #expect(await h.card("srq-u") == nil)
  }

  @Test("a version this build does not know is declined 4041 unsupported_version; so is an upload with nowhere to go")
  func otherVersionsAndBrokenParams() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var future = InteractiveFrames.draft()
    future["v"] = 2
    future["session_id"] = .string(Fixture.runtime)
    var nowhere = InteractiveFrames.file()
    nowhere["upload"] = nil
    nowhere["session_id"] = .string(Fixture.runtime)

    h.link.raise(id: "srq-v", method: "review.draft", params: future)
    h.link.raise(id: "srq-n", method: "input.file", params: nowhere)
    let link = h.link
    try await eventually("both refusals") { link.declines.count == 2 }
    #expect(h.cannotShowReason("srq-v") == CannotShowReason.unsupportedVersion)
    #expect(h.cannotShowReason("srq-n") == CannotShowReason.notSupportedOnDevice)
    #expect(h.center.prompts.isEmpty)
    #expect(h.link.answers.isEmpty)
  }

  // MARK: Answering

  @Test("a form is answered with its values, byte for byte, once; the card says how it ended and holds no value")
  func answersAForm() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-a")
    let model = InteractiveModel(session: h.session, bot: bot)
    #expect(model.nextToPresent == "srq-a")
    model.present("srq-a")
    let values: [String: FormValue] = ["name": .text(typed), "guests": .number(2)]
    #expect(model.canAnswer(.form(values)))

    // Two taps at once: one answer.
    async let first = model.answer(.form(values))
    async let second = model.answer(.form(values))
    let results = await [first, second]
    #expect(results.filter { $0 }.count == 1)
    #expect(h.answers("srq-a") == [["status": "answered", "values": ["name": .string(typed), "guests": 2]]])
    #expect(!h.center.isOpen("srq-a"))
    #expect(model.presentedID == nil, "the sheet closes once it went out")
    #expect(h.center.lastAnswered?.requestID == "srq-a")

    let card = try #require(await h.card("srq-a"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.status == "answered")
    let canonical = try #require(await h.session.store.state(of: bot)).canonicalJSON
    #expect(!canonical.contains(typed), "no value in the transcript")

    // Nothing more goes out for it, whatever is tapped.
    #expect(await h.center.answer("srq-a", .form(values)) == false)
    #expect(await h.center.skip("srq-a") == false)
    #expect(h.answers("srq-a").count == 1)
  }

  @Test("an answer for a field the form does not have never goes out")
  func refusesAnUnknownField() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-x")

    #expect(await h.center.answer("srq-x", .form(["nope": .text("x")])) == false)
    #expect(h.link.answers.isEmpty)
    #expect(h.center.isOpen("srq-x"))
    #expect(h.center.phases["srq-x"] == nil)
  }

  @Test("Skip answers {status: skipped} where it is offered, and nowhere else")
  func skip() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-s")
    try await h.raiseOpen("srq-r", "review.draft", params: InteractiveFrames.draft())
    try await h.raiseOpen("srq-n", params: InteractiveFrames.form(optional: false))

    #expect(await h.center.skip("srq-r") == false, "a draft is rejected, not skipped")
    #expect(await h.center.skip("srq-n") == false, "not optional")
    #expect(await h.center.skip("srq-s"))
    #expect(h.answers("srq-s") == [["status": "skipped"]])
    #expect(h.link.answers.count == 1)

    let card = try #require(await h.card("srq-s"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.status == "skipped")
  }

  @Test("files are answered by reference, within the count the request allows")
  func answersFiles() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-f", "input.file", params: InteractiveFrames.file())
    let one = InteractiveFrames.upload()
    let two = InteractiveFrames.upload("second.jpg")

    #expect(await h.center.answer("srq-f", .files([], text: nil)) == false, "nothing to send")
    #expect(await h.center.answer("srq-f", .files([one, two], text: nil)) == false, "one file only")
    #expect(await h.center.answer("srq-f", .form([:])) == false, "another method's answer")
    #expect(h.link.answers.isEmpty)

    #expect(await h.center.answer("srq-f", .files([one], text: "")))
    #expect(h.answers("srq-f") == [InputFileResult.answered(files: [one]).json])
    let card = try #require(await h.card("srq-f"))
    #expect(card.answerSummary?.count == 1)
  }

  @Test("a draft is approved with its text, edited or not, and rejected with a comment")
  func answersDrafts() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("d-same", "review.draft", params: InteractiveFrames.draft())
    try await h.raiseOpen("d-edit", "review.draft", params: InteractiveFrames.draft())
    try await h.raiseOpen("d-fixed", "review.draft", params: InteractiveFrames.draft(editable: false))
    try await h.raiseOpen("d-no", "review.draft", params: InteractiveFrames.draft())

    let spaced = InteractiveFrames.draftText.replacingOccurrences(of: "Hi Bram,", with: "Hi Bram,  ")
    #expect(await h.center.answer("d-same", .approve(text: spaced)))
    #expect(h.answers("d-same").first?["decision"] == "approved")
    #expect(await h.card("d-same")?.answerSummary?.edited == false, "trailing spaces are not an edit")

    let edited = "Hi Bram,\n\nFree from 1 December.\nAda"
    #expect(await h.center.answer("d-edit", .approve(text: edited)))
    #expect(h.answers("d-edit") == [["decision": "approved", "text": .string(edited)]])
    #expect(await h.card("d-edit")?.answerSummary?.decision == "approved")
    #expect(await h.card("d-edit")?.answerSummary?.edited == true)

    #expect(await h.center.answer("d-fixed", .approve(text: edited)) == false, "the text may not change")
    #expect(await h.center.answer("d-fixed", .approve(text: "")) == false)
    #expect(h.answers("d-fixed").isEmpty)
    #expect(await h.center.answer("d-fixed", .approve(text: InteractiveFrames.draftText)))

    #expect(await h.center.answer("d-no", .reject(comment: "  too formal \n")))
    #expect(h.answers("d-no") == [["decision": "rejected", "comment": "too formal"]])
    #expect(await h.card("d-no")?.answerSummary?.decision == "rejected")
  }

  @Test("the sheet that cannot go on answers the error 4041 with its reason, never a skip")
  func cannotShowFromTheSheet() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-p", "input.file", params: InteractiveFrames.file())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-p")

    #expect(await model.cannotShow(reason: CannotShowReason.permissionDenied))
    #expect(h.cannotShowReason("srq-p") == "permission_denied")
    #expect(h.link.declines.first?.message == "cannot_show")
    #expect(h.link.answers.isEmpty)
    #expect(!h.center.isOpen("srq-p"))
    #expect(model.presentedID == nil)

    let card = try #require(await h.card("srq-p"))
    #expect(card.state == .cancelled)
    #expect(card.cancelReason == "cannot_show")

    #expect(await model.cannotShow(reason: "again") == false, "once")
    #expect(h.link.declines.count == 1)
  }

  @Test("an answer that did not go out fails, and goes out over the re-delivered copy")
  func retriesOverTheRedeliveredCopy() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-r")
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-r")
    let values: [String: FormValue] = ["name": .text(typed)]

    h.link.setSocketOpen(false)
    #expect(await model.answer(.form(values)) == false)
    #expect(model.hasFailed)
    #expect(h.center.isOpen("srq-r"))

    // The reconnect re-delivers it; the retry sends the values still in the sheet.
    h.link.setSocketOpen(true)
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-r", method: "input.form", params: params, replayed: true)
    try await eventually("the copy to arrive") { await h.session.store.ingestedFrames >= h.link.emittedFrames }
    try await Task.sleep(for: .milliseconds(20))
    #expect(!model.hasFailed)
    #expect(await model.answer(.form(values)))
    #expect(h.answers("srq-r") == [["status": "answered", "values": ["name": .string(typed)]]])
  }

  // MARK: Expiry and withdrawal

  @Test("at the gateway's deadline the request closes as expired and nothing is sent, typed or not")
  func expires() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-e")
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-e")
    #expect(model.secondsLeft == 300)

    await h.clock.advance(by: .seconds(100))
    #expect(model.secondsLeft == 200, "the countdown runs whether or not the sheet is up")
    await h.clock.advance(by: .seconds(200))
    #expect(!h.center.isOpen("srq-e"))
    #expect(model.presentedOutcome == .expired, "the sheet says so")
    #expect(model.notice == nil, "not twice")

    // Values typed after the expiry are never sent.
    #expect(await model.answer(.form(["name": .text(typed)])) == false)
    #expect(await model.skip() == false)
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)
    model.dismiss()
    #expect(h.center.notices[bot] == nil)

    let card = try #require(await h.card("srq-e"))
    #expect(card.state == .cancelled)
    #expect(card.cancelReason == "timeout")
  }

  @Test("a request whose expires_at has passed is not shown and not answered")
  func alreadyExpired() async throws {
    let h = InteractiveHarness()
    try await h.open()
    var params = InteractiveFrames.form(expires: 1_789_999_990)
    params["session_id"] = .string(Fixture.runtime)

    h.link.raise(id: "srq-late", method: "input.form", params: params)
    let center = h.center
    try await eventually("the notice") { await center.notices[bot] != nil }
    #expect(center.notices[bot]?.notice == .expired)
    #expect(center.prompts.isEmpty)
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)
    #expect(await h.card("srq-late") == nil)
  }

  @Test("a re-delivered copy has its countdown too: expires_at is absolute; one with none shows none")
  func replayedKnowsItsDeadline() async throws {
    let h = InteractiveHarness()
    try await h.open()
    await h.clock.advance(by: .seconds(100))

    let named = try await h.raiseOpen("srq-old", replayed: true)
    #expect(named.deadline == h.clock.now + .seconds(200))
    #expect(h.center.secondsLeft("srq-old") == 200)

    let unnamed = try await h.raiseOpen("srq-none", params: InteractiveFrames.form(expires: nil), replayed: true)
    #expect(unnamed.deadline == nil)
    #expect(h.center.secondsLeft("srq-none") == nil)

    let live = try await h.raiseOpen("srq-live", params: InteractiveFrames.form(expires: nil))
    #expect(live.deadline == h.clock.now + .seconds(300), "a live one without a deadline is shown for the longest the gateway waits")
  }

  @Test("request.cancel closes only its request: timeout as expired, anything else as withdrawn; the card follows")
  func withdrawn() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("a")
    try await h.raiseOpen("b", "review.draft", params: InteractiveFrames.draft())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("a")

    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "a", "method": "input.form", "reason": "interrupted"])
    let center = h.center
    try await eventually("a to close") { await !center.isOpen("a") }
    #expect(center.isOpen("b"))
    #expect(model.presentedOutcome == .withdrawn)

    model.dismiss()
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "b", "method": "review.draft", "reason": "timeout"])
    try await eventually("b to close") { await !center.isOpen("b") }
    #expect(model.notice?.notice == .expired)
    #expect(h.link.answers.isEmpty)
    #expect(h.link.declines.isEmpty)

    try await h.harness.frame()
    #expect(await h.card("a")?.state == .cancelled)
    #expect(await h.card("a")?.cancelReason == "interrupted")
    #expect(await h.card("b")?.cancelReason == "timeout")

    // A cancel that overtook its request: the request is ignored when it comes, and has no card.
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "c", "method": "input.form", "reason": "timeout"])
    try await eventually("the cancel to be heard") { await h.session.store.ingestedFrames >= h.link.emittedFrames }
    try await Task.sleep(for: .milliseconds(20))
    var params = InteractiveFrames.form()
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "c", method: "input.form", params: params)
    try await Task.sleep(for: .milliseconds(50))
    #expect(!center.isOpen("c"))
    #expect(await h.card("c") == nil)
  }

  // MARK: The chat lets go

  @Test("when the chat no longer holds the session, the request is declined 4041 session_closed exactly once")
  func rebindDeclinesOnce() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-rb")

    // Another client took the session over: the chat lets go of the runtime id.
    h.link.emit("session.reclaimed", session: Fixture.runtime, payload: [:])
    try await h.harness.frame()
    let center = h.center
    try await eventually("the request to be let go") { await !center.isOpen("srq-rb") }
    let link = h.link
    try await eventually("the refusal") { link.declines.contains { $0.id == "srq-rb" } }
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(20))
    #expect(h.link.declines.filter { $0.id == "srq-rb" }.count == 1)
    #expect(h.cannotShowReason("srq-rb") == InteractiveRequestCenter.Reason.sessionClosed)
    #expect(h.link.answers.isEmpty)
    #expect(center.notices[bot]?.notice == .withdrawn, "the chat says so")
    #expect(await h.card("srq-rb")?.state == .cancelled)
  }

  @Test("when the bot's chat is forgotten, its request is declined")
  func forgetDeclines() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-f")

    await h.session.store.forget(bot)
    try await h.harness.frame()
    h.session.interactive.storeChanged()
    let link = h.link
    try await eventually("the refusal") { link.declines.contains { $0.id == "srq-f" } }
    #expect(h.cannotShowReason("srq-f") == InteractiveRequestCenter.Reason.sessionClosed)
  }

  @Test("shutdown declines every open request 4041 shutting_down once, and the waiting ones too")
  func shutdownDeclines() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("x1")
    try await h.raiseOpen("x2", "review.draft", params: InteractiveFrames.draft())
    var params = InteractiveFrames.form()
    params["session_id"] = "rt-elsewhere"
    h.link.raise(id: "x3", method: "input.form", params: params)
    let center = h.center
    try await eventually("x3 to wait") { await center.parkedCount == 1 }

    await h.session.shutdown()
    #expect(h.link.declines.map(\.id).sorted() == ["x1", "x2", "x3"])
    #expect(h.link.declines.allSatisfy { $0.code == 4041 })
    #expect(["x1", "x2", "x3"].allSatisfy { h.cannotShowReason($0) == CannotShowReason.shuttingDown })
    #expect(h.link.answers.isEmpty)
    #expect(center.prompts.isEmpty)
    #expect(center.liveTaskCount == 0)
    await center.shutdown()
    #expect(h.link.declines.count == 3, "once")
  }

  // MARK: Beside the other sheets

  @Test("the approvals sheet does not take an interactive request's card")
  func approvalsSheetLeavesItAlone() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let requests = RequestsModel(chat: h.session.chat(bot))
    try await h.raiseOpen("srq-i")
    _ = await h.card("srq-i")
    try await h.harness.frame()

    #expect(requests.openRequests.isEmpty)
    #expect(requests.nextToPresent == nil)
    #expect(h.session.chat(bot).openRequests.compactMap(\.asRequest).map(\.requestID) == ["srq-i"], "the chat still needs input")
  }

  // MARK: Nothing kept

  @Test("the values are in no description, dump or store")
  func leavesNoTrace() async throws {
    let database = try SQLiteStore(.inMemory)
    let cache = SQLiteChatCache(store: database, gatewayId: "g1")
    let keyValues = KeyValueStore(store: database)
    let h = InteractiveHarness(cache: cache, keyValues: keyValues)
    try await h.open()
    try await h.raiseOpen("srq-t")
    try await h.raiseOpen("srq-d", "review.draft", params: InteractiveFrames.draft())
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-t")

    #expect(await model.answer(.form(["name": .text(typed)])))
    model.present("srq-d")
    #expect(await model.answer(.approve(text: typed)))
    #expect(h.answers("srq-t").first?["values"]?["name"]?.stringValue == typed, "it did go out")

    var texts: [String] = []

    for subject in [model as Any, h.center, h.center.prompts, model.presentedPrompt as Any, h.link.lifecycle] {
      var text = ""
      dump(subject, to: &text)
      texts.append(text)
      texts.append(String(describing: subject))
    }

    for text in texts {
      #expect(!text.contains(typed))
    }

    _ = await h.card("srq-d")
    await h.session.store.persistAll()
    try await h.harness.frame()
    let state = try #require(await h.session.store.state(of: bot))
    #expect(!state.canonicalJSON.contains(typed))
    await h.session.shutdown()

    let leaked = try await database.read { db -> [String] in
      let tables = try db.query("SELECT name FROM sqlite_master WHERE type = 'table'").compactMap { $0["name"].text }
      var hits: [String] = []

      for table in tables {
        for row in try db.query("SELECT * FROM \"\(table)\"") {
          for value in row.values {
            switch value {
            case .text(let text) where text.contains(typed): hits.append(table)
            case .blob(let data) where String(decoding: data, as: UTF8.self).contains(typed): hits.append(table)
            default: break
            }
          }
        }
      }

      return hits
    }
    #expect(leaked.isEmpty, "found in \(leaked)")
  }
}
