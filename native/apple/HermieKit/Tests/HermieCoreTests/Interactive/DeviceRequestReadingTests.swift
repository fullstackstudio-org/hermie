import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The signature, the code scan and the voice note as the center reads them and answers them: every frame of the
/// contract is shown, every frame the gateway never builds is not, and every answer is the contract's, with a hash
/// that is the contract's own.
@Suite("Signature, code scan and voice note: reading and answering")
struct DeviceRequestReadingTests {
  // MARK: Frames

  @Test("every valid signature frame is shown, with the statement exactly as it came")
  func signatureFramesAreShown() throws {
    for id in ["req_sig_lease", "req_sig_required"] {
      let prompt = try DeviceExamples.prompt("input.signature", id: id)
      guard case .signature(let request) = prompt.body else {
        Issue.record("\(id): not a signature")
        return
      }

      let raw = try DeviceExamples.params("input.signature", id: id)["statement"]?.stringValue
      #expect(request.statement == raw, "\(id): not cleaned, trimmed or cut")
      #expect(prompt.method == "input.signature")
      #expect(request.upload.maxFiles == 2)
    }

    let lease = try DeviceExamples.prompt("input.signature", id: "req_sig_lease")
    guard case .signature(let request) = lease.body else { return }
    #expect(request.signerName == "Ada Lovelace")
    #expect(lease.offersSkip)
    #expect(try !DeviceExamples.prompt("input.signature", id: "req_sig_required").offersSkip)
  }

  @Test("the frames the gateway never builds for a signature are not shown, and none of them is")
  func signatureInvalidFramesAreRefused() throws {
    for entry in try DeviceExamples.methodSection("input.signature", "invalid_frames") {
      let name = entry["name"]?.stringValue ?? "?"
      var params = try #require(entry["params"]?.objectValue, "\(name)")
      params["expires_at"] = .number(Double(Int(Date().timeIntervalSince1970) + 300))
      let reading = DeviceExamples.reading("input.signature", params)

      switch name {
      case "signer_name_two_lines", "signer_name_too_long":
        // A name is display-only: read as one bounded line rather than refused.
        guard case .content(let content) = reading, case .signature(let request) = content.body else {
          Issue.record("\(name): expected the request to be shown")
          continue
        }
        #expect(!(request.signerName ?? "").contains("\n"), "\(name)")
        // At most the bound, and an ellipsis when it was cut.
        #expect((request.signerName ?? "").unicodeScalars.count <= SignatureRequest.signerNameLimit + 1, "\(name)")
      default:
        #expect(reading == .cannotShow(reason: CannotShowReason.notSupportedOnDevice), "\(name)")
      }
    }
  }

  @Test("a statement this app cannot show exactly as it is is not shown: its hash would be of something else")
  func hiddenCharactersInAStatement() throws {
    var params = try DeviceExamples.params("input.signature", id: "req_sig_lease")

    for statement in [
      "I agree\u{202E}", "pay\u{200B}ment", "tab\there", "no\u{00A0}break", "line\u{2028}sep", "bell\u{07}", "\u{FEFF}start",
      "emoji \u{FE0F}", "carriage\rreturn",
    ] {
      params["statement"] = .string(statement)
      #expect(DeviceExamples.reading("input.signature", params) == .cannotShow(reason: "not_supported_on_device"), "\(statement.debugDescription)")
    }

    // What is plain stays, including line breaks and the whitespace a person typed.
    for statement in ["I agree.", "Line one\nLine two", "  indented and trailing  ", "Gelezen en akkoord — café ✓", "日本語の同意"] {
      params["statement"] = .string(statement)
      guard case .content(let content) = DeviceExamples.reading("input.signature", params), case .signature(let request) = content.body
      else {
        Issue.record("\(statement.debugDescription) was not shown")
        continue
      }

      #expect(request.statement == statement, "verbatim")
    }

    params["statement"] = .string(String(repeating: "x", count: 500))
    #expect(DeviceExamples.reading("input.signature", params) != .cannotShow(reason: "not_supported_on_device"))
    params["statement"] = .string(String(repeating: "x", count: 501))
    #expect(DeviceExamples.reading("input.signature", params) == .cannotShow(reason: "not_supported_on_device"))
  }

  @Test("a version this build does not know is declined for what it is, before anything else is checked")
  func unknownVersions() throws {
    var params = try DeviceExamples.params("input.signature", id: "req_sig_lease")
    params["v"] = 2
    #expect(DeviceExamples.reading("input.signature", params) == .cannotShow(reason: "unsupported_version"))

    var scan = try DeviceExamples.params("device.scan", id: "req_scan_any")
    scan["v"] = 2
    #expect(DeviceExamples.reading("device.scan", scan) == .cannotShow(reason: "unsupported_version"))
  }

  @Test("every valid scan frame is shown, with the symbologies it asks for")
  func scanFramesAreShown() throws {
    let any = try DeviceExamples.prompt("device.scan", id: "req_scan_any")
    let ean = try DeviceExamples.prompt("device.scan", id: "req_scan_ean")
    let required = try DeviceExamples.prompt("device.scan", id: "req_scan_required")

    guard case .scan(let anyRequest) = any.body, case .scan(let eanRequest) = ean.body, case .scan(let requiredRequest) = required.body
    else {
      Issue.record("not a scan")
      return
    }

    #expect(anyRequest.formats.isEmpty && anyRequest.accepts(.qr) && anyRequest.accepts(.aztec))
    #expect(eanRequest.formats == [.ean13, .ean8] && eanRequest.accepts(.ean8) && !eanRequest.accepts(.qr))
    #expect(requiredRequest.formats == [.qr, .aztec])
    #expect(any.offersSkip && ean.offersSkip && !required.offersSkip)
    #expect(!anyRequest.accepts(.unknown("upca")))
  }

  @Test("a scan that lists a kind twice, none, a name that is not the contract's, or eight is not shown")
  func scanInvalidFramesAreRefused() throws {
    let invalid = try DeviceExamples.methodSection("device.scan", "invalid_frames")
    #expect(invalid.count == 4)

    for entry in invalid {
      var params = try #require(entry["params"]?.objectValue)
      params["expires_at"] = .number(Double(Int(Date().timeIntervalSince1970) + 300))
      #expect(
        DeviceExamples.reading("device.scan", params) == .cannotShow(reason: CannotShowReason.notSupportedOnDevice),
        "\(entry["name"]?.stringValue ?? "?")")
    }
  }

  @Test("a recording is asked for only with accept and capture audio together; the pairings the gateway never builds are not shown")
  func voiceFrames() throws {
    let voice = try DeviceExamples.prompt("input.file", id: "req_file_voice")
    guard case .file(let params) = voice.body else {
      Issue.record("not a file request")
      return
    }

    #expect(params.asksForRecording && voice.offersSkip)
    #expect(try !DeviceExamples.prompt("input.file", id: "req_file_voice_required").offersSkip)

    // `accept: audio` with no capture is the file sheet's: a recording the person picks.
    guard case .file(let pick) = try DeviceExamples.prompt("input.file", id: "req_file_voice_pick").body else { return }
    #expect(!pick.asksForRecording && pick.accept == .audio)

    var refused = 0

    for entry in try DeviceExamples.methodSection("input.file", "invalid_frames") where entry["layer"]?.stringValue == "cross_field" {
      var params = try #require(entry["params"]?.objectValue)
      params["expires_at"] = .number(Double(Int(Date().timeIntervalSince1970) + 300))
      let name = entry["name"]?.stringValue ?? "?"

      if name.contains("capture") {
        #expect(DeviceExamples.reading("input.file", params) == .cannotShow(reason: "not_supported_on_device"), "\(name)")
        refused += 1
      }
    }

    #expect(refused == 4)
  }

  // MARK: Answers

  @Test("the contract's valid signature answers are what the reply builds, hash included, whatever the file order")
  func signatureAnswers() throws {
    for answer in try DeviceExamples.methodSection("input.signature", "answers") {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let prompt = try DeviceExamples.prompt("input.signature", id: try #require(answer["request"]?.stringValue))

      if result["status"]?.stringValue == "skipped" {
        let reply = try #require(prompt.reply(to: .skip), "\(name)")
        #expect(reply.result == ["status": "skipped"])
        continue
      }

      let typed = try #require(InputSignatureResult(jsonValue: result), "\(name)")
      let files = try #require(typed.files, "\(name)")
      let signedAt = try #require(typed.signedAt, "\(name)")
      let reply = try #require(prompt.reply(to: .signature(files: files, signedAt: signedAt)), "\(name)")

      // The hash the client computes from the statement it showed is the contract's own value.
      #expect(reply.result == result.objectValue, "\(name)")
      #expect(reply.summary == ["status": "answered"], "only that it was signed")
    }
  }

  @Test("an answer the gateway would refuse for its files, its time or its optionality is never sent")
  func signatureAnswersTheClientRefuses() throws {
    let lease = try DeviceExamples.prompt("input.signature", id: "req_sig_lease")
    let required = try DeviceExamples.prompt("input.signature", id: "req_sig_required")

    let png = DeviceExamples.file("signature.png", mime: "image/png", bytes: 18_211)
    let svg = DeviceExamples.file("signature.svg", mime: "image/svg+xml", bytes: 6_412, token: "9a2b4c6d8e0f1325")
    let now = 1_791_119_310

    #expect(lease.reply(to: .signature(files: [png, svg], signedAt: now)) != nil)
    #expect(lease.reply(to: .signature(files: [svg, png], signedAt: now)) != nil)
    #expect(lease.reply(to: .signature(files: [png], signedAt: now)) == nil, "one file")
    #expect(lease.reply(to: .signature(files: [png, svg, svg], signedAt: now)) == nil, "three files")
    #expect(lease.reply(to: .signature(files: [png, png], signedAt: now)) == nil, "two PNGs")

    var jpeg = png
    jpeg.mime = "image/jpeg"
    #expect(lease.reply(to: .signature(files: [jpeg, svg], signedAt: now)) == nil, "files:not_png_and_svg")

    var pngAsSVG = png
    pngAsSVG.path = png.path?.replacingOccurrences(of: ".png", with: ".svg")
    #expect(lease.reply(to: .signature(files: [pngAsSVG, svg], signedAt: now)) == nil, "file:0:extension")

    var outside = svg
    outside.path = "/home/ada/elsewhere/9a2b4c6d8e0f1325-signature.svg"
    #expect(lease.reply(to: .signature(files: [png, outside], signedAt: now)) == nil, "file:1:outside_dir")

    var large = png
    large.bytes = 1_048_577
    #expect(lease.reply(to: .signature(files: [large, svg], signedAt: now)) == nil, "file:0:too_large")

    var together = png
    together.bytes = 1_048_576
    var other = svg
    other.bytes = 1_048_576
    #expect(lease.reply(to: .signature(files: [together, other], signedAt: now)) != nil, "exactly the total")
    other.bytes = 1_048_577
    #expect(lease.reply(to: .signature(files: [together, other], signedAt: now)) == nil, "over the total")

    #expect(lease.reply(to: .signature(files: [png, svg], signedAt: -1)) == nil)
    #expect(lease.reply(to: .signature(files: [png, svg], signedAt: 9_007_199_254_740_993)) == nil, "beyond 2^53")
    #expect(lease.reply(to: .signature(files: [png, svg], signedAt: 9_007_199_254_740_992)) != nil)

    #expect(required.reply(to: .skip) == nil, "not_optional")
    #expect(lease.reply(to: .scan(value: "x", symbology: .qr)) == nil, "another method's answer")
  }

  @Test("the statement hash is the SHA-256 of its exact UTF-8 bytes: no normalisation, trimming or line-ending change")
  func statementHash() {
    #expect(SignatureRequest.sha256(of: "abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    #expect(SignatureRequest.sha256(of: "") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    #expect(
      SignatureRequest.sha256(of: "Gelezen en akkoord — café ✓")
        == "cc2308b155d079b38695d056306142c69b7dd642b6ce1fd4c0e1f7e319d5ffe9")

    let variants = ["a", "a\n", "a ", "a\r\n", "A", "\u{00E9}", "e\u{0301}"]
    #expect(Set(variants.map(SignatureRequest.sha256(of:))).count == variants.count, "all different")
    #expect(SignatureRequest.sha256(of: "\u{00E9}") != SignatureRequest.sha256(of: "e\u{0301}"), "not normalised")
    #expect(SignatureRequest.sha256(of: "x").range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, "lowercase hex")
  }

  @Test("the contract's valid scan answers are what the reply builds, and the ones it refuses are never sent")
  func scanAnswers() throws {
    for answer in try DeviceExamples.methodSection("device.scan", "answers") {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let prompt = try DeviceExamples.prompt("device.scan", id: try #require(answer["request"]?.stringValue))

      if result["status"]?.stringValue == "skipped" {
        #expect(prompt.reply(to: .skip)?.result == ["status": "skipped"], "\(name)")
        continue
      }

      let typed = try #require(DeviceScanResult(jsonValue: result), "\(name)")
      let value = try #require(typed.value, "\(name)")
      let symbology = try #require(typed.symbology, "\(name)")
      let reply = try #require(prompt.reply(to: .scan(value: value, symbology: symbology)), "\(name)")
      #expect(reply.result == result.objectValue, "\(name)")
      // The card keeps the kind of code and nothing the code said.
      #expect(reply.summary == ["status": "answered", "symbology": .string(typed.symbology?.rawValue ?? "")], "\(name)")
    }

    let any = try DeviceExamples.prompt("device.scan", id: "req_scan_any")
    let ean = try DeviceExamples.prompt("device.scan", id: "req_scan_ean")
    let required = try DeviceExamples.prompt("device.scan", id: "req_scan_required")

    #expect(ean.reply(to: .scan(value: "https://example.com/box", symbology: .qr)) == nil, "symbology:not_requested")
    #expect(any.reply(to: .scan(value: "\u{200B}\u{202E} \u{200B}", symbology: .qr)) == nil, "scan:empty")
    #expect(any.reply(to: .scan(value: "", symbology: .qr)) == nil)
    #expect(any.reply(to: .scan(value: "012345678905", symbology: .unknown("upca"))) == nil, "a symbology the contract lacks")
    #expect(required.reply(to: .skip) == nil, "not_optional")
    #expect(any.reply(to: .scan(value: String(repeating: "x", count: 4_096), symbology: .qr)) != nil)
    #expect(any.reply(to: .scan(value: String(repeating: "x", count: 4_097), symbology: .qr)) == nil, "never cut, never sent")

    // What goes out is what the person was shown: cleaned like the gateway cleans it.
    let cleaned = any.reply(to: .scan(value: "https://exa\u{200B}mple.com/\u{202E}txt.exe", symbology: .qr))
    #expect(cleaned?.result["value"] == "https://example.com/txt.exe")
  }

  @Test("a voice note is a recording: audio files without parameters, a transcript only with one, and only up to 4,000 characters")
  func voiceAnswers() throws {
    let voice = try DeviceExamples.prompt("input.file", id: "req_file_voice")
    let any = try DeviceExamples.prompt("input.file", id: "req_file_any")
    let receipt = try DeviceExamples.prompt("input.file", id: "req_file_receipt")

    let note = DeviceExamples.file("reply.m4a", mime: "audio/mp4")
    let picked = DeviceExamples.file("meeting.caf", mime: "audio/x-caf")
    let image = DeviceExamples.file("reply.jpg", mime: "image/jpeg")
    let withParameters = DeviceExamples.file("reply.m4a", mime: "audio/webm;codecs=opus")

    let reply = try #require(voice.reply(to: .files([note], text: "Tuesday at ten works for me.")))
    #expect(reply.result["text"] == "Tuesday at ten works for me.")
    // The card learns that it was a voice note, and neither the recording nor its transcript.
    #expect(reply.summary == ["status": "answered", "count": 1, "audio": true])

    #expect(voice.reply(to: .files([note], text: nil))?.result["text"] == nil, "no transcript is no key")
    #expect(voice.reply(to: .files([note], text: ""))?.result["text"] == nil)
    #expect(voice.reply(to: .files([picked], text: "Let's start with the budget.")) != nil, "a picked recording is one too")
    #expect(voice.reply(to: .files([image], text: nil)) == nil, "file:0:not_audio")
    #expect(voice.reply(to: .files([withParameters], text: nil)) == nil, "the type is sent without parameters")
    #expect(voice.reply(to: .files([note], text: String(repeating: "x", count: 4_000))) != nil)
    #expect(voice.reply(to: .files([note], text: String(repeating: "x", count: 4_001))) == nil)

    // A transcript belongs to a recording: not to a photo, not to a document, not to an `any` answer without audio.
    #expect(receipt.reply(to: .files([image], text: "Parking, 12 euro.")) == nil, "text:not_audio")
    #expect(any.reply(to: .files([DeviceExamples.file("claim.pdf", mime: "application/pdf")], text: "This is a claim.")) == nil)
    #expect(any.reply(to: .files([note], text: "hello")) != nil, "an any request with an audio file may carry it")
    #expect(receipt.reply(to: .files([image], text: nil))?.summary["audio"] == nil)
  }
}
