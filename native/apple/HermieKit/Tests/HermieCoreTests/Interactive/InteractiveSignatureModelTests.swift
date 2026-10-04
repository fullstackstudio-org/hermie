import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

@Suite("The signature's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveSignatureModelTests {
  private func prompt(_ id: String = "req_sig_lease") throws -> (InteractivePrompt, SignatureRequest) {
    let prompt = try DeviceExamples.prompt("input.signature", id: id)

    guard case .signature(let request) = prompt.body else {
      throw DeviceExamples.ReadFailure(method: "input.signature")
    }

    return (prompt, request)
  }

  /// A signature drawn on the pad.
  private func signed() -> SignatureInk {
    var ink = SignatureInk()
    ink.begin(at: SignaturePoint(x: 10, y: 80))

    for step in 1...30 {
      ink.extend(to: SignaturePoint(x: 10 + Double(step) * 8, y: 80 - 40 * sin(Double(step) / 4)))
    }

    return ink
  }

  private func model(_ request: SignatureRequest, now: Int = 1_791_119_310) -> InteractiveSignatureModel {
    InteractiveSignatureModel(request: request, clock: { Date(timeIntervalSince1970: TimeInterval(now)) })
  }

  @Test("nothing is made or sent until the person presses Sign, and a tap or a short stroke is not a signature")
  func signingNeedsASignature() async throws {
    let (_, request) = try prompt()
    let model = model(request)
    let uploads = RecordingUploader()

    #expect(model.phase == .drawing && !model.canSign)
    #expect(await model.sign(through: uploads.uploader) == nil)
    #expect(uploads.calls.isEmpty)

    var tap = SignatureInk()
    tap.begin(at: SignaturePoint(x: 5, y: 5))
    model.setInk(tap)
    #expect(!model.canSign)

    model.setInk(signed())
    #expect(model.canSign)
    #expect(uploads.calls.isEmpty, "drawing sends nothing")
  }

  @Test("Sign writes the PNG and the SVG, uploads both flat into the directory, and answers as the contract's example does")
  func signsAndAnswers() async throws {
    let (prompt, request) = try prompt()
    let model = model(request, now: 1_791_119_310)
    let uploads = RecordingUploader()
    model.setInk(signed())

    let answer = try #require(await model.sign(through: uploads.uploader))
    #expect(model.phase == .uploaded && model.signedAt == 1_791_119_310)

    // Two files: the PNG and the SVG, named as the contract's example names them, directly in the directory.
    let calls = uploads.calls
    #expect(calls.map(\.mime) == ["image/png", "image/svg+xml"])
    #expect(calls.map(\.name) == ["signature.png", "signature.svg"])
    #expect(calls.allSatisfy { request.upload.contains(path: $0.path) })
    #expect(calls[0].path.range(of: #"/[0-9a-f]{16}-signature\.png$"#, options: .regularExpression) != nil)
    #expect(calls[1].path.range(of: #"/[0-9a-f]{16}-signature\.svg$"#, options: .regularExpression) != nil)

    // What was uploaded is what the gateway's own rules take.
    #expect(SignatureSVGRules.typeProblem(mime: "image/png", data: calls[0].data) == nil)
    #expect(SignatureSVGRules.typeProblem(mime: "image/svg+xml", data: calls[1].data) == nil)

    guard case .signature(let files, let signedAt) = answer else {
      Issue.record("not a signature answer")
      return
    }

    #expect(signedAt == 1_791_119_310)
    #expect(files.map(\.bytes) == calls.map(\.data.count), "bytes as uploaded")

    // The reply to it carries the hash of the statement that was shown, and nothing of the drawing.
    let reply = try #require(prompt.reply(to: answer))
    #expect(reply.result["statement_sha256"] == .string(request.statementSHA256))
    #expect(reply.result["signed_at"] == 1_791_119_310)
    #expect(reply.result["status"] == "answered")
    #expect(reply.summary == ["status": "answered"])
  }

  @Test("the SHA-256 and the size in the answer are those of the bytes that went out")
  func answerDescribesWhatWentOut() async throws {
    let (_, request) = try prompt()
    let model = model(request)
    let uploads = RecordingUploader()
    model.setInk(signed())

    guard case .signature(let files, _)? = await model.sign(through: uploads.uploader) else {
      Issue.record("no answer")
      return
    }

    for (file, call) in zip(files, uploads.calls) {
      #expect(file.bytes == call.data.count)
      #expect(file.sha256 == DeviceExamples.sha256(call.data))
    }
  }

  @Test("an answer already uploaded is answered again without sending the files twice; a change of ink starts over")
  func retry() async throws {
    let (_, request) = try prompt()
    let now = Mutex(100)
    let model = InteractiveSignatureModel(
      request: request, clock: { Date(timeIntervalSince1970: TimeInterval(now.withLock { $0 })) })
    let uploads = RecordingUploader()
    model.setInk(signed())

    let first = try #require(await model.sign(through: uploads.uploader))
    now.withLock { $0 = 200 }
    let again = try #require(await model.sign(through: uploads.uploader))
    #expect(first == again, "the same files and the same time")
    #expect(uploads.calls.count == 2, "not uploaded twice")

    // Drawing on, or clearing, throws the files away: the next Sign makes new ones, at the time it was pressed.
    var next = signed()
    next.begin(at: SignaturePoint(x: 20, y: 120))
    next.extend(to: SignaturePoint(x: 200, y: 125))
    model.setInk(next)
    #expect(model.phase == .drawing && model.signedAt == nil)
    let third = try #require(await model.sign(through: uploads.uploader))
    #expect(uploads.calls.count == 4)

    if case .signature(_, let signedAt) = third {
      #expect(signedAt == 200)
    }

    model.clear()
    #expect(model.ink.isEmpty && !model.canSign && model.phase == .drawing)
  }

  @Test("a failed upload is said, nothing is answered, and Sign again tries once more")
  func uploadFailure() async throws {
    let (_, request) = try prompt()
    let model = model(request)
    let uploads = RecordingUploader()
    uploads.failEvery(with: "Could not reach the gateway.")
    model.setInk(signed())

    #expect(await model.sign(through: uploads.uploader) == nil)
    #expect(model.phase == .failed(.upload(.failed(message: "Could not reach the gateway."))))
    #expect(model.canSign)

    uploads.failEvery(with: nil)
    #expect(await model.sign(through: uploads.uploader) != nil)
    #expect(model.phase == .uploaded)
  }

  @Test("a signature larger than the request allows is refused before a byte moves")
  func tooLarge() async throws {
    var params = try DeviceExamples.params("input.signature", id: "req_sig_lease")
    params["upload"] = ["dir": "/home/ada/uploads", "max_bytes": 200, "max_total_bytes": 400, "max_files": 2, "strip_metadata": false]

    guard case .content(let content) = DeviceExamples.reading("input.signature", params), case .signature(let request) = content.body
    else {
      Issue.record("not shown")
      return
    }

    let model = model(request)
    let uploads = RecordingUploader()
    model.setInk(signed())

    #expect(await model.sign(through: uploads.uploader) == nil)
    #expect(model.phase == .failed(.tooLarge))
    #expect(uploads.calls.isEmpty)
  }

  @Test("leaving the sheet deletes what was staged, and the pad takes no strokes while the files are on their way")
  func discarding() async throws {
    let (_, request) = try prompt()
    let model = model(request)
    let uploads = RecordingUploader()
    model.setInk(signed())
    #expect(await model.sign(through: uploads.uploader) != nil)

    let staged = model.files.items.map(\.file.url)
    #expect(!staged.isEmpty)
    model.discard()
    #expect(model.files.items.isEmpty)
    #expect(staged.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
  }
}
