import Foundation
import Testing

@testable import HermieProtocol

/// `contract/requests/` (a byte-identical copy of the gateway's): every valid frame reads into its
/// typed request and re-encodes unchanged, every valid answer is what the typed constructors build,
/// and a field kind this build does not know cannot crash it.
@Suite("Interactive requests contract") struct InteractiveContractTests {
  // MARK: Corpus access

  static func examples() throws -> JSONValue {
    try loadContract("requests/examples.json")
  }

  static func section(_ method: String, _ key: String) throws -> [JSONValue] {
    try #require(try examples()["methods"]?[method]?[key]?.arrayValue, "methods.\(method).\(key)")
  }

  /// The frame of `method` with this request id.
  static func frame(_ method: String, id: String) throws -> ServerRequest {
    let frames = try section(method, "frames")
    let match = try #require(frames.first { $0["id"]?.stringValue == id }, "no \(method) frame \(id)")
    return try #require(ServerRequest(jsonValue: match))
  }

  static let methods = ServerRequestBody.Method.interactive

  // MARK: Frames

  @Test("every valid frame is a server request that reads into its typed params and re-encodes unchanged")
  func framesDecode() throws {
    var count = 0
    for method in Self.methods {
      for raw in try Self.section(method, "frames") {
        count += 1
        let place = "\(method) \(raw["id"]?.stringValue ?? "?")"
        guard case .serverRequest(let request) = try #require(InboundFrame(jsonValue: raw), "\(place)") else {
          Issue.record("\(place): not classified as a server request")
          continue
        }
        #expect(request.method == method, "\(place)")
        #expect(try canonical(request) == canonical(raw), "\(place) re-encodes differently")

        let body = request.body
        #expect(body.method == method)
        #expect(body.isInteractive && !body.isSecureInput, "\(place)")
        #expect(!ServerRequestBody.Method.secureInput.contains(method))

        switch body {
        case .inputForm(let params):
          #expect(params.fields?.count == raw["params"]?["fields"]?.arrayValue?.count, "\(place)")
          #expect(params.firstUnknownField == nil, "\(place)")
          #expect(try canonical(Self.copy(params)) == canonical(params), "\(place) loses keys when typed")
          #expect(params.offersSkip == (raw["params"]?["optional"]?.boolValue ?? true))
        case .inputFile(let params):
          #expect(try canonical(Self.copy(params)) == canonical(params), "\(place) loses keys when typed")
          #expect(params.upload != nil, "\(place)")
          #expect(params.offersSkip == (raw["params"]?["optional"]?.boolValue ?? true))
        case .reviewDraft(let params):
          #expect(try canonical(Self.copy(params)) == canonical(params), "\(place) loses keys when typed")
          #expect(params.offersSkip == (raw["params"]?["optional"]?.boolValue ?? false))
        case .reviewDiff(let params):
          #expect(try canonical(Self.copy(params)) == canonical(params), "\(place) loses keys when typed")
          #expect(!params.offersSkip, "\(place): there is no skip")
          #expect(params.hunks?.count == raw["params"]?["hunks"]?.arrayValue?.count, "\(place)")
        default:
          Issue.record("\(place): typed as \(body.method)")
        }
        // The envelope, whichever method.
        let envelope = raw["params"]
        switch body {
        case .inputForm(let p): Self.expectEnvelope(p, envelope, place)
        case .inputFile(let p): Self.expectEnvelope(p, envelope, place)
        case .reviewDraft(let p): Self.expectEnvelope(p, envelope, place)
        case .reviewDiff(let p): Self.expectEnvelope(p, envelope, place)
        default: break
        }
      }
    }
    #expect(count == 13)
  }

  static func expectEnvelope<P: InteractiveRequestParams>(_ params: P, _ raw: JSONValue?, _ place: String) {
    #expect(params.sessionID == raw?["session_id"]?.stringValue, "\(place)")
    #expect(params.v == 1, "\(place)")
    #expect(params.title == raw?["title"]?.stringValue && params.title != nil, "\(place)")
    #expect(params.summary == raw?["summary"]?.stringValue && params.summary != nil, "\(place)")
    #expect(params.expiresAt == raw?["expires_at"]?.intValue && params.expiresAt != nil, "\(place)")
    #expect(params.actingUser?.id == raw?["acting_user"]?["id"]?.stringValue, "\(place)")
    #expect(params.actingUser?.name == raw?["acting_user"]?["name"]?.stringValue, "\(place)")
  }

  @Test("the booking form carries all nine field kinds, typed")
  func bookingFormKinds() throws {
    guard case .inputForm(let params) = try Self.frame("input.form", id: "req_form_booking").body else {
      Issue.record("not an input.form")
      return
    }
    let fields = try #require(params.fields)
    #expect(fields.map(\.kind) == [.text, .number, .daterange, .amount, .date, .time, .datetime, .choice, .choice, .toggle, .text])
    #expect(Set(fields.map(\.kind)) == Set(FormFieldKind.knownCases))
    #expect(fields.map(\.id) == [
      "name", "guests", "stay", "budget", "arrival", "check_in", "call_at", "room", "extras", "newsletter", "notes"
    ])

    guard case .text(let name) = fields[0], case .number(let guests) = fields[1],
      case .daterange(let stay) = fields[2], case .amount(let budget) = fields[3],
      case .datetime(let callAt) = fields[6], case .choice(let room) = fields[7],
      case .choice(let extras) = fields[8], case .toggle(let newsletter) = fields[9],
      case .text(let notes) = fields[10]
    else {
      Issue.record("a field is not the case its kind names")
      return
    }
    #expect(name.isRequired && name.maxLength == 20 && name.effectiveMaxLength == 20 && !name.isMultiline)
    #expect(guests.min == 1 && guests.max == 12 && guests.isInteger && guests.default == 2)
    #expect(stay.min == "2026-10-05" && stay.max == "2026-12-31" && stay.default == nil)
    #expect(budget.currency == "EUR" && budget.min == "0" && budget.max == "5000")
    #expect(callAt.tz == "Europe/Amsterdam" && callAt.min == "2026-10-05T00:00:00+02:00")
    #expect(room.options == [FormChoiceOption(value: "single", label: "Single"), FormChoiceOption(value: "double", label: "Double")])
    #expect(!room.isMultiple && extras.isMultiple && extras.maxSelected == 2 && extras.minSelected == nil)
    #expect(newsletter.default == false && !newsletter.isRequired)
    #expect(notes.isMultiline && notes.effectiveMaxLength == TextFormField.defaultMaxLength)
    #expect(notes.hint == "Allergies, accessibility, arrival time.")
    #expect(params.actingUser?.name == "Ada")
  }

  @Test("the file frames read accept, capture, multiple and the upload target")
  func fileFrames() throws {
    guard case .inputFile(let receipt) = try Self.frame("input.file", id: "req_file_receipt").body,
      case .inputFile(let contracts) = try Self.frame("input.file", id: "req_file_contracts").body
    else {
      Issue.record("not input.file")
      return
    }
    #expect(receipt.accept == .image && receipt.capture == .photo && !receipt.isMultiple && receipt.offersSkip)
    #expect(receipt.upload?.stripMetadata == true && receipt.upload?.maxFiles == 1)
    #expect(receipt.upload?.maxBytes == 10_485_760 && receipt.upload?.maxTotalBytes == 10_485_760)
    #expect(receipt.upload?.dir == "/home/ada/work/uploads/hermie/2026-10-04")
    #expect(contracts.accept == .document && contracts.capture == nil && contracts.isMultiple && !contracts.offersSkip)
    #expect(contracts.upload?.maxTotalBytes == 52_428_800 && contracts.upload?.maxFiles == 3)
  }

  @Test("the draft frames read the draft apart from its display-only keys")
  func draftFrames() throws {
    guard case .reviewDraft(let mail) = try Self.frame("review.draft", id: "req_draft_mail").body else {
      Issue.record("not review.draft")
      return
    }
    #expect(mail.kind == .mail && mail.isEditable && !mail.offersSkip)
    #expect(mail.subject == "Re: Flat on the Oudegracht")
    #expect(mail.recipients == ["Bram de Vries <bram@example.com>"])
    #expect(mail.text?.hasPrefix("Hi Bram,\n\n") == true)
  }

  @Test("a frame the gateway never sends still reads and re-encodes without crashing")
  func invalidFramesDoNotCrash() throws {
    var count = 0
    for method in Self.methods {
      for entry in try Self.section(method, "invalid_frames") {
        count += 1
        let params = try #require(entry["params"]?.objectValue)
        let request = ServerRequest(id: "x", method: method, params: params)
        #expect(request.body.method == method)
        #expect(try canonical(ServerRequest(id: "x", request.body)) == canonical(request))
        if case .inputForm(let form) = request.body {
          _ = form.fields
          _ = form.firstUnknownField
        }
      }
    }
    #expect(count == 52)
  }

  // MARK: Answers

  /// The value the typed constructor for `field`'s kind builds from the corpus's raw JSON.
  static func value(for field: FormField, raw: JSONValue) -> FormValue? {
    switch field {
    case .text: raw.stringValue.map(FormValue.text)
    case .number: raw.doubleValue.map(FormValue.number)
    case .amount: raw.stringValue.map(FormValue.amount)
    case .date: raw.stringValue.map(FormValue.date)
    case .time: raw.stringValue.map(FormValue.time)
    case .datetime:
      raw.stringValue.flatMap(FormDateTime.split).map { FormValue.datetime(instant: $0.instant, zone: $0.zone) }
    case .daterange:
      raw["start"]?.stringValue.flatMap { start in
        raw["end"]?.stringValue.map { FormValue.daterange(start: start, end: $0) }
      }
    case .choice(let choice):
      choice.isMultiple
        ? raw.arrayValue.map { FormValue.choices($0.compactMap(\.stringValue)) }
        : raw.stringValue.map(FormValue.choice)
    case .toggle: raw.boolValue.map(FormValue.toggle)
    case .unknown: nil
    }
  }

  @Test("every valid input.form answer is what the typed constructors encode")
  func formAnswers() throws {
    let answers = try Self.section("input.form", "answers")
    #expect(answers.count == 4)
    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let request = try Self.frame("input.form", id: try #require(answer["request"]?.stringValue))
      guard case .inputForm(let params) = request.body else { continue }

      let built: InputFormResult
      if result["status"]?.stringValue == "skipped" {
        #expect(params.offersSkip, "\(name): skipped needs an optional request")
        built = .skipped
      } else {
        var values: [String: FormValue] = [:]
        for field in params.fields ?? [] {
          guard let id = field.id, let raw = result["values"]?[id] else { continue }
          let value = try #require(Self.value(for: field, raw: raw), "\(name): \(id)")
          values[id] = value
        }
        #expect(values.count == result["values"]?.objectValue?.count, "\(name): a value without a field")
        built = .answered(values: values)
      }
      #expect(try canonical(built) == canonical(result), "\(name)")

      // And the answer reads back.
      let reread = try #require(InputFormResult(jsonValue: result), "\(name)")
      #expect(reread.status == built.status && reread.values == built.values, "\(name)")
    }
  }

  @Test("an amount is a string, never a number")
  func amountIsAString() throws {
    let built = InputFormResult.answered(values: ["budget": .amount("180.00")])
    #expect(built.values?["budget"] == .string("180.00"))
    #expect(try canonical(built) == #"{"status":"answered","values":{"budget":"180.00"}}"#)
    #expect(FormValue(jsonValue: .null) == nil)
    #expect(FormValue(jsonValue: ["start": "2026-10-03"]) == nil)
    #expect(FormValue(jsonValue: ["a", 1]) == nil)
  }

  @Test("every valid input.file answer is what the typed constructors encode, and its paths lie directly in upload.dir")
  func fileAnswers() throws {
    let answers = try Self.section("input.file", "answers")
    #expect(answers.count == 4)
    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let request = try Self.frame("input.file", id: try #require(answer["request"]?.stringValue))
      guard case .inputFile(let params) = request.body else { continue }
      let upload = try #require(params.upload)

      let built: InputFileResult
      if result["status"]?.stringValue == "skipped" {
        built = .skipped
      } else {
        var files: [UploadedFile] = []
        for raw in result["files"]?.arrayValue ?? [] {
          let file = UploadedFile(
            path: try #require(raw["path"]?.stringValue),
            name: try #require(raw["name"]?.stringValue),
            mime: try #require(raw["mime"]?.stringValue),
            bytes: try #require(raw["bytes"]?.intValue),
            sha256: try #require(raw["sha256"]?.stringValue))
          #expect(upload.contains(path: file.path ?? ""), "\(name): \(file.path ?? "")")
          #expect((file.bytes ?? .max) <= (upload.maxBytes ?? 0), "\(name)")
          files.append(file)
        }
        #expect(files.count <= (upload.maxFiles ?? 0) && (files.count == 1 || params.isMultiple), "\(name)")
        #expect(files.map { $0.bytes ?? 0 }.reduce(0, +) <= (upload.maxTotalBytes ?? 0), "\(name)")
        built = .answered(files: files, text: result["text"]?.stringValue)
      }
      #expect(try canonical(built) == canonical(result), "\(name)")
      #expect(InputFileResult(jsonValue: result)?.files == built.files, "\(name)")
    }
  }

  @Test("the answers the gateway refuses for their paths fail the client's own check too")
  func fileAnswerPaths() throws {
    var checked = 0
    for invalid in try Self.section("input.file", "invalid_answers") {
      let reason = invalid["reason"]?.stringValue ?? ""
      guard reason.hasPrefix("file:"), reason.hasSuffix(":outside_dir"),
        let index = Int(reason.dropFirst("file:".count).prefix { $0 != ":" })
      else { continue }
      let request = try Self.frame("input.file", id: try #require(invalid["request"]?.stringValue))
      guard case .inputFile(let params) = request.body else { continue }
      let files = InputFileResult(jsonValue: try #require(invalid["result"]))?.files ?? []
      let path = try #require(files[index].path)
      #expect(try #require(params.upload).contains(path: path) == false, "\(invalid["name"]?.stringValue ?? "")")
      checked += 1
    }
    #expect(checked == 3)

    let target = UploadTarget(json: ["dir": "/uploads/a"])
    #expect(target.contains(path: "/uploads/a/x.jpg"))
    #expect(target.contains(path: "/uploads/./a/b/../x.jpg"))
    #expect(target.contains(path: "/uploads//a/./x.jpg"))
    #expect(!target.contains(path: "/uploads/a"))
    #expect(!target.contains(path: "/uploads/a/"))
    #expect(!target.contains(path: "/uploads/a/b/x.jpg"))
    #expect(!target.contains(path: "/uploads/a/.."))
    #expect(!target.contains(path: "/uploads"))
    #expect(!target.contains(path: "/uploads/a/../b/x.jpg"))
    #expect(!target.contains(path: "/uploads/ab/x.jpg"))
    #expect(!target.contains(path: "uploads/a/x.jpg"))
    #expect(!target.contains(path: "/../uploads/a/x.jpg"))
    #expect(!UploadTarget().contains(path: "/uploads/a/x.jpg"))
  }

  @Test("every valid review.draft answer is what the typed constructors encode")
  func draftAnswers() throws {
    let answers = try Self.section("review.draft", "answers")
    #expect(answers.count == 6)
    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let built: ReviewDraftResult =
        switch result["decision"]?.stringValue {
        case "approved": .approved(text: result["text"]?.stringValue ?? "")
        default: .rejected(comment: result["comment"]?.stringValue)
        }
      #expect(try canonical(built) == canonical(result), "\(name)")
      let reread = try #require(ReviewDraftResult(jsonValue: result), "\(name)")
      #expect(reread.decision == built.decision && reread.text == built.text && reread.comment == built.comment, "\(name)")
    }
    #expect(ReviewDraftResult.rejected().json == ["decision": "rejected"])
  }

  @Test("the diff frames read kind, path, old path and every hunk with its anchor")
  func diffFrames() throws {
    guard case .reviewDiff(let settings) = try Self.frame("review.diff", id: "req_diff_settings").body,
      case .reviewDiff(let rename) = try Self.frame("review.diff", id: "req_diff_rename").body,
      case .reviewDiff(let appended) = try Self.frame("review.diff", id: "req_diff_append").body,
      case .reviewDiff(let created) = try Self.frame("review.diff", id: "req_diff_new_file").body
    else {
      Issue.record("not review.diff")
      return
    }

    #expect(settings.kind == .modify && settings.path == "app/settings.py" && settings.oldPath == nil)
    #expect(settings.hunks?.map(\.id) == ["h1", "h2"])
    #expect(settings.hunks?.first?.header == "@@ -3,4 +3,4 @@ class Settings:")
    #expect(settings.hunks?.first?.lines?.count == 5 && settings.hunks?.first?.anchor == nil)
    #expect(rename.kind == .rename && rename.path == "app/accounts.py" && rename.oldPath == "app/users.py")
    #expect(rename.hunks?.first?.anchor == .start)
    #expect(appended.hunks?.first?.anchor == .end)
    #expect(created.kind == .new && created.hunks?.first?.anchor == .both)
    #expect(created.hunks?.first?.lines?.last == "\\ No newline at end of file")
    #expect(DiffKind.knownCases.map(\.rawValue) == ["modify", "new", "delete", "rename"])
    #expect(DiffKind.named("copy") == .unknown("copy") && DiffAnchor.named("middle") == .unknown("middle"))
  }

  @Test("every valid review.diff answer is what the typed constructor encodes, and decides every hunk")
  func diffAnswers() throws {
    let answers = try Self.section("review.diff", "answers")
    #expect(answers.count == 9)

    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let request = try Self.frame("review.diff", id: try #require(answer["request"]?.stringValue))
      guard case .reviewDiff(let params) = request.body else { continue }

      let decided = try #require(ReviewDiffResult(jsonValue: result)?.hunks, "\(name)")
      #expect(Set(decided.keys) == Set(params.hunks?.compactMap(\.id) ?? []), "\(name): every hunk, no other")

      let built = ReviewDiffResult.decided(decided)
      #expect(try canonical(built) == canonical(result), "\(name)")
      #expect(built.decision?.rawValue == result["decision"]?.stringValue, "\(name)")
    }

    // `approved` when some hunk is, `rejected` when none is: the pairings the gateway refuses are not built.
    #expect(ReviewDiffResult.decided(["h1": .rejected, "h2": .rejected]).decision == .rejected)
    #expect(ReviewDiffResult.decided(["h1": .approved, "h2": .rejected]).decision == .approved)
    #expect(ReviewDiffResult.decided(["h1": .approved]).json["comment"] == nil, "no comment")
    #expect(HunkDecision.named("skipped") == .unknown("skipped"))
  }

  // MARK: Field definitions

  @Test("every field definition reads as its kind, and every valid value is a form value that encodes unchanged")
  func fieldDefinitions() throws {
    let entries = try #require(try Self.examples()["form_fields"]?.arrayValue)
    var kinds = Set<FormFieldKind>()
    for entry in entries {
      let name = entry["name"]?.stringValue ?? "?"
      let raw = try #require(entry["field"], "\(name)")
      let field = try #require(FormField(jsonValue: raw), "\(name)")
      #expect(!field.isUnknown && field.kind.rawValue == raw["kind"]?.stringValue, "\(name)")
      #expect(field.id == raw["id"]?.stringValue && field.label == raw["label"]?.stringValue, "\(name)")
      #expect(try canonical(Self.copy(field)) == canonical(raw), "\(name) loses keys when typed")
      kinds.insert(field.kind)

      for valid in entry["valid"]?.arrayValue ?? [] {
        let value = try #require(Self.value(for: field, raw: valid), "\(name): \(valid)")
        #expect(try canonical(value) == canonical(valid), "\(name)")
        if case .datetime = field, let text = valid.stringValue {
          let parts = try #require(FormDateTime.split(text), "\(text)")
          #expect(!parts.instant.contains("[") && !parts.zone.isEmpty)
        }
      }
    }
    #expect(kinds == Set(FormFieldKind.knownCases))
  }

  @Test("an amount's invalid JSON number never builds an amount value")
  func amountNumberIsRefusedByType() throws {
    let entries = try #require(try Self.examples()["form_fields"]?.arrayValue)
    let amount = try #require(entries.first { $0["name"] == "amount" }?["field"])
    let field = try #require(FormField(jsonValue: amount))
    #expect(Self.value(for: field, raw: 180) == nil)
  }

  @Test("a datetime value is an instant, then its zone in brackets")
  func datetimeValue() {
    #expect(FormDateTime.value(instant: "2026-10-03T14:30+02:00", zone: "Europe/Amsterdam") == "2026-10-03T14:30+02:00[Europe/Amsterdam]")
    let parts = FormDateTime.split("2026-10-03T14:30:00+02:00[Europe/Amsterdam]")
    #expect(parts?.instant == "2026-10-03T14:30:00+02:00" && parts?.zone == "Europe/Amsterdam")
    #expect(FormDateTime.split("2026-10-03T14:30:00+02:00") == nil)
    #expect(FormDateTime.split("[Europe/Amsterdam]") == nil)
    #expect(FormDateTime.split("2026-10-03T14:30+02:00[]") == nil)
  }

  // MARK: Unknown things never crash

  @Test("a field of a kind this build does not know reads as unknown and keeps its id and label")
  func unknownFieldKind() throws {
    let raw: JSONValue = ["id": "sig", "kind": "signature", "label": "Sign here", "ink": "blue"]
    let field = try #require(FormField(jsonValue: raw))
    guard case .unknown(let kind, let json) = field else {
      Issue.record("not unknown: \(field)")
      return
    }
    #expect(kind == "signature" && field.kind == .unknown("signature") && field.isUnknown)
    #expect(field.id == "sig" && field.label == "Sign here")
    #expect(json["ink"] == "blue")
    #expect(try canonical(field) == canonical(raw))

    // Through a form, beside known fields; the form is still readable and names the field it cannot show.
    let form = ServerRequest(
      id: "r", method: "input.form",
      params: [
        "v": 1, "title": "T", "summary": "S", "expires_at": 1,
        "fields": [["id": "a", "kind": "toggle", "label": "A"], raw, ["id": "b", "kind": "text", "label": "B"]]
      ])
    guard case .inputForm(let params) = form.body else {
      Issue.record("not an input.form")
      return
    }
    #expect(params.fields?.map(\.kind) == [.toggle, .unknown("signature"), .text])
    #expect(params.firstUnknownField?.id == "sig")
    #expect(try canonical(ServerRequest(id: "r", form.body)) == canonical(form))
    let refusal = try #require(form.cannotShow(reason: CannotShowReason.notSupportedOnDevice))
    #expect(refusal.error?.isCannotShow == true && refusal.error?.reason == "not_supported_on_device")
  }

  @Test("a field without a kind, or with one that is not a string, is unknown too; a non-object element is dropped")
  func malformedFields() throws {
    #expect(FormField(jsonValue: ["id": "a", "label": "A"])?.kind == .unknown(""))
    #expect(FormField(jsonValue: ["id": "a", "kind": 5])?.kind == .unknown(""))
    #expect(FormField(jsonValue: ["id": "a", "kind": "Text"])?.kind == .unknown("Text"))
    #expect(FormField(jsonValue: "text") == nil)

    let params = InputFormParams(json: ["fields": [["id": "a", "kind": "toggle", "label": "A"], "junk", 4, .null]])
    #expect(params.fields?.map(\.id) == ["a"])
    #expect(InputFormParams(json: ["fields": "x"]).fields == nil)
  }

  @Test("an unknown FormField kind decodes through Codable too")
  func codable() throws {
    let data = Data(#"{"id":"sig","kind":"signature","label":"Sign here"}"#.utf8)
    let field = try JSONDecoder().decode(FormField.self, from: data)
    #expect(field.isUnknown && field.id == "sig")
    #expect(try JSONDecoder().decode(FormField.self, from: JSONEncoder().encode(field)) == field)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(FormField.self, from: Data("[1]".utf8)) }
  }

  @Test("methods nobody handles are still unknown, and the four interactive ones are declared")
  func methodsAndUnknowns() {
    for method in ["input.other", "review.other", "input", "tour", ""] {
      let request = ServerRequest(id: "a", method: method, params: ["session_id": "s"])
      #expect(request.body == .unknown(method: method, params: ["session_id": "s"]), "\(method)")
      #expect(!request.body.isInteractive)
    }
    #expect(ServerRequestBody.Method.interactive == ["input.form", "input.file", "review.draft", "review.diff"])
    #expect(Set(ServerRequestBody.Method.interactive).isSubset(of: Set(ServerRequestBody.Method.all)))
    #expect(ServerRequestBody.Method.all == ServerRequestBody.Method.all.sorted())
    #expect(ServerRequestBody.Method.all.count == Set(ServerRequestBody.Method.all).count)
  }

  @Test("unknown keys survive, a key of the wrong type reads as nil and falls back to the method's default")
  func lenientReading() throws {
    let form = InputFormParams(json: [
      "v": 1, "title": "T", "summary": "S", "expires_at": "soon", "optional": "yes", "future_key": ["a": 1],
      "fields": []
    ])
    #expect(form.expiresAt == nil && form.optionalFlag == nil)
    #expect(form.offersSkip)
    #expect(form.json["future_key"] == ["a": 1])
    #expect(try canonical(ServerRequest(id: "r", .inputForm(form))) == canonical(ServerRequest(id: "r", method: "input.form", params: form.json)))

    #expect(!ReviewDraftParams(json: [:]).offersSkip)
    #expect(ReviewDraftParams(json: ["optional": true]).offersSkip)
    #expect(InputFileParams(json: ["optional": false]).offersSkip == false)
    #expect(InputFileParams(json: ["upload": "x"]).upload == nil)
    #expect(UploadedFile(json: ["bytes": "10"]).bytes == nil)
    #expect(UploadedFile(json: ["bytes": 1.5]).bytes == nil)
    #expect(ReviewDraftParams(json: ["recipients": ["a", 1]]).recipients == ["a"])
    #expect(DraftKind.named("memo") == .unknown("memo") && FileAccept.named("video") == .unknown("video"))
  }

  @Test("a request has expired by the client's own clock at expires_at")
  func expiry() {
    let params = ReviewDraftParams(json: ["expires_at": 1_791_119_400])
    #expect(params.expiryDate == Date(timeIntervalSince1970: 1_791_119_400))
    #expect(!params.hasExpired(at: Date(timeIntervalSince1970: 1_791_119_399)))
    #expect(params.hasExpired(at: Date(timeIntervalSince1970: 1_791_119_400)))
    #expect(!ReviewDraftParams(json: [:]).hasExpired(at: .distantFuture))
  }

  // MARK: 4041 and capabilities

  @Test("the cannot_show frames are what the helper builds")
  func cannotShow() throws {
    var checked = 0
    for entry in try #require(try Self.examples()["errors"]?.arrayValue) {
      guard entry["direction"] == "client_to_gateway", let frame = entry["frame"] else { continue }
      let id = try #require(frame["id"]?.stringValue)
      let reason = try #require(frame["error"]?["data"]?["reason"]?.stringValue)
      let request = ServerRequest(id: id, method: "input.file", params: [:])
      let answer = try #require(request.cannotShow(reason: reason))
      #expect(try canonical(answer) == canonical(frame), "\(entry["name"]?.stringValue ?? "")")
      #expect(answer.error?.code == 4041 && answer.error?.message == "cannot_show")
      #expect(answer.error?.isCannotShow == true && answer.error?.reason == reason)
      checked += 1
    }
    #expect(checked == 4)
    #expect(JSONRPCError.cannotShowCode == 4041)
    #expect(ServerRequest(json: ["method": "input.form"]).cannotShow(reason: "x") == nil)
    #expect(JSONRPCError(code: -32601, message: "no").isCannotShow == false)
    #expect(JSONRPCError(code: 4041, message: "cannot_show").reason == nil)
  }

  @Test("the second client.capabilities call is the example's, and the result's requests read back")
  func capabilities() throws {
    let example = try #require(try Self.examples()["capabilities"]?[0]?["request"])
    var params = ClientCapabilitiesParams(serverRequests: true)
    params.confirm = [.plain]
    // The contract's example lists the four methods; this build shows all of them (the diff sheet is
    // `DiffSheet`), so it advertises exactly that list.
    let advertised = try #require(example["params"]?["requests"]?.arrayValue)
    let listed = advertised.compactMap { $0.stringValue }
    #expect(listed == ServerRequestBody.Method.interactive)
    params.requests = listed
    let request = JSONRPCRequest(id: .number(3), RPC.ClientCapabilities.self, params: params)
    #expect(try canonical(request) == canonical(example))
    #expect(ClientCapabilitiesParams(serverRequests: true).requests == nil)
    #expect(ClientCapabilitiesParams(serverRequests: true).json["requests"] == nil)

    let result = try #require(
      ClientCapabilitiesResult(jsonValue: ["server_requests": ["approval", "input.form"], "requests": ["input.form", "future.thing"]]))
    #expect(result.requests == ["input.form", "future.thing"])
    #expect(ClientCapabilitiesResult(json: ["requests": []]).requests == [])
    #expect(ClientCapabilitiesResult(json: [:]).requests == nil)
  }

  // MARK: Typed copies (a key without a typed property shows up as a difference)

  static func copy(_ params: InputFormParams) -> InputFormParams {
    with(InputFormParams()) {
      envelope(params, into: &$0)
      $0.fields = params.fields.map { $0.map(copy) }
    }
  }

  static func copy(_ params: InputFileParams) -> InputFileParams {
    with(InputFileParams()) {
      envelope(params, into: &$0)
      $0.accept = params.accept
      $0.capture = params.capture
      $0.multiple = params.multiple
      $0.upload = params.upload.map { upload in
        with(UploadTarget()) {
          $0.dir = upload.dir
          $0.maxBytes = upload.maxBytes
          $0.maxTotalBytes = upload.maxTotalBytes
          $0.maxFiles = upload.maxFiles
          $0.stripMetadata = upload.stripMetadata
        }
      }
    }
  }

  static func copy(_ params: ReviewDraftParams) -> ReviewDraftParams {
    with(ReviewDraftParams()) {
      envelope(params, into: &$0)
      $0.kind = params.kind
      $0.text = params.text
      $0.subject = params.subject
      $0.recipients = params.recipients
      $0.editable = params.editable
    }
  }

  static func copy(_ params: ReviewDiffParams) -> ReviewDiffParams {
    with(ReviewDiffParams()) {
      envelope(params, into: &$0)
      $0.kind = params.kind
      $0.path = params.path
      $0.oldPath = params.oldPath
      $0.hunks = params.hunks.map { hunks in
        hunks.map { hunk in
          with(DiffHunk()) {
            $0.id = hunk.id
            $0.header = hunk.header
            $0.lines = hunk.lines
            $0.anchor = hunk.anchor
          }
        }
      }
    }
  }

  static func envelope<P: InteractiveRequestParams>(_ source: P, into copy: inout P) {
    copy.sessionID = source.sessionID
    copy.v = source.v
    copy.title = source.title
    copy.summary = source.summary
    copy.detail = source.detail
    copy.expiresAt = source.expiresAt
    copy.optionalFlag = source.optionalFlag
    copy.actingUser = source.actingUser.map { user in
      with(InteractiveActingUser()) {
        $0.id = user.id
        $0.name = user.name
      }
    }
  }

  static func copy(_ field: FormField) -> FormField {
    switch field {
    case .text(let f):
      .text(with(TextFormField()) {
        common(f, &$0)
        $0.multiline = f.multiline
        $0.maxLength = f.maxLength
        $0.input = f.input
        $0.default = f.default
      })
    case .number(let f):
      .number(with(NumberFormField()) {
        common(f, &$0)
        $0.min = f.min
        $0.max = f.max
        $0.step = f.step
        $0.integer = f.integer
        $0.default = f.default
      })
    case .amount(let f):
      .amount(with(AmountFormField()) {
        common(f, &$0)
        $0.currency = f.currency
        $0.min = f.min
        $0.max = f.max
        $0.default = f.default
      })
    case .date(let f):
      .date(with(DateFormField()) {
        common(f, &$0)
        $0.min = f.min
        $0.max = f.max
        $0.tz = f.tz
        $0.default = f.default
      })
    case .time(let f):
      .time(with(TimeFormField()) {
        common(f, &$0)
        $0.min = f.min
        $0.max = f.max
        $0.tz = f.tz
        $0.default = f.default
      })
    case .datetime(let f):
      .datetime(with(DateTimeFormField()) {
        common(f, &$0)
        $0.min = f.min
        $0.max = f.max
        $0.tz = f.tz
        $0.default = f.default
      })
    case .daterange(let f):
      .daterange(with(DateRangeFormField()) {
        common(f, &$0)
        $0.min = f.min
        $0.max = f.max
        $0.tz = f.tz
        $0.default = f.default.map { FormDateRange(start: $0.start ?? "", end: $0.end ?? "") }
      })
    case .choice(let f):
      .choice(with(ChoiceFormField()) {
        common(f, &$0)
        $0.options = f.options.map { $0.map { FormChoiceOption(value: $0.value ?? "", label: $0.label ?? "") } }
        $0.multiple = f.multiple
        $0.minSelected = f.minSelected
        $0.maxSelected = f.maxSelected
        $0.default = f.default
      })
    case .toggle(let f):
      .toggle(with(ToggleFormField()) {
        common(f, &$0)
        $0.default = f.default
      })
    case .unknown: field
    }
  }

  static func common<F: FormFieldView>(_ source: F, _ copy: inout F) {
    copy.id = source.id
    copy.kind = source.kind
    copy.label = source.label
    copy.hint = source.hint
    copy.required = source.required
  }
}
