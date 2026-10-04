#if os(macOS)
import AVFoundation
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

// MARK: - The signature, the code scan and the voice note

private struct Authorised: CaptureAuthorizing {
  var camera: CaptureAccess = .granted
  var microphone: CaptureAccess = .granted

  func cameraAccess() -> CaptureAccess { camera }
  func requestCamera() async -> Bool { camera == .granted }
  func microphoneAccess() -> CaptureAccess { microphone }
  func requestMicrophone() async -> Bool { microphone == .granted }
}

/// A recorder that "records" a second of real AAC into the file it is given, when stopped.
@MainActor
private final class RealisticRecorder: VoiceRecording {
  var onEvent: (@MainActor (VoiceRecorderEvent) -> Void)?
  private var url: URL?

  func start(into url: URL, maxSeconds: Double, maxBytes: Int) throws(VoiceRecorderError) {
    self.url = url
  }

  func stop() {
    if let url {
      try? Self.writeAAC(to: url)
    }

    onEvent?(.finished(seconds: 1))
  }

  func cancel() {
    onEvent = nil
  }

  static func writeAAC(to url: URL) throws {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
    ]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 1, interleaved: false))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100))
    buffer.frameLength = 44_100

    for index in 0..<44_100 {
      buffer.floatChannelData?[0][index] = Float(sin(Double(index) * 0.05)) * 0.3
    }

    try file.write(from: buffer)
  }
}

@MainActor
private final class SilentPlayer: VoicePlaying {
  var onEvent: (@MainActor (VoicePlayerEvent) -> Void)?
  func play(_ url: URL) throws {}
  func pause() {}
  func stop() {}
}

@MainActor
private final class FixedTranscriber: VoiceTranscribing {
  func isAvailable(language: String?) -> Bool { true }
  func requestAuthorization() async -> Bool { true }
  func transcribe(_ file: URL, language: String?) async -> String? { "Tuesday at ten works for\u{200B} me." }
}

extension Integration {
  /// The signature, the code scan and the voice note against the real fake gateway, over real sockets. The fake
  /// holds an answer to the contract and applies the gateway's own rules to what it receives (the SVG allowlist
  /// after the request settled, the statement hash, the cleaning of a scanned value, the audio rules).
  @Suite("Signature, code scan and voice note") @MainActor
  struct DeviceRequestsIntegrationTests {
    private static let everything = InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(location: true, contact: true, calendar: true, signature: true, scan: true))

    /// A signature on the pad.
    private static func ink() -> SignatureInk {
      var ink = SignatureInk()
      ink.begin(at: SignaturePoint(x: 12, y: 90))

      for step in 1...60 {
        let t = Double(step) / 60
        ink.extend(to: SignaturePoint(x: 12 + 300 * t, y: 90 - 60 * sin(t * .pi * 4) * (1 - t * 0.5)))
      }

      ink.begin(at: SignaturePoint(x: 40, y: 130))
      ink.extend(to: SignaturePoint(x: 280, y: 126))
      return ink
    }

    private static func stored(_ gateway: FakeGateway) async throws -> [JSONValue] {
      try await gateway.control("GET", "/__fake/files")["files"]?.arrayValue ?? []
    }

    @Test("a signature drawn in the sheet's model is uploaded as a PNG and an SVG the gateway's rules take, and the agent is told what was signed")
    func signature() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.everything)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.signature")

        guard case .signature(let request)? = model.presented?.body else {
          Issue.record("not a signature request")
          return
        }

        #expect(request.statement == "I have read the rental agreement dated 3 October 2026 and agree to its terms.")

        let signature = InteractiveSignatureModel(request: request, clock: { Date(timeIntervalSince1970: 1_791_119_310) })
        signature.setInk(Self.ink())
        let answer = try #require(await signature.sign(through: model.uploader))
        #expect(await model.answer(answer))
        signature.discard()

        // What the gateway took, and what it is told the agent gets.
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered", "the PNG and the SVG passed the gateway's own checks: \(view)")
        #expect(view["refusals"] == [])
        let told = try #require(view["answer"])
        #expect(told["signed"] == true)
        #expect(told["statement_sha256"]?.stringValue == request.statementSHA256)
        #expect(told["signed_at"]?.intValue == 1_791_119_310)

        // Two files landed, flat, a PNG and an SVG, with the hash and size the answer quotes.
        let landed = try await Self.stored(gateway)
        #expect(landed.count == 2)
        #expect(landed.map { $0["mime"]?.stringValue } == ["image/png", "image/svg+xml"])

        guard case .signature(let references, _) = answer else { return }
        #expect(landed.map { $0["sha256"]?.stringValue } == references.map(\.sha256))
        #expect(landed.map { $0["bytes"]?.intValue } == references.map(\.bytes))
        #expect(landed.allSatisfy { request.upload.contains(path: $0["path"]?.stringValue ?? "") })

        // The SVG the gateway holds is one line of the allowlist and nothing else.
        let svgPath = try #require(landed[1]["path"]?.stringValue)
        let encoded = try #require(svgPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed))
        let (status, text) = try await FakeGateway.plainRequest("GET", gateway.baseURL + "/__fake/files/content?path=\(encoded)")
        #expect(status == 200)
        #expect(SignatureSVGRules.problem(in: text) == nil)
        #expect(text.hasPrefix("<svg xmlns=\"http://www.w3.org/2000/svg\"") && !text.contains("\n"))
        await chat.session.shutdown()
      }
    }

    @Test("a signature skipped, or declined, is not a signature: the gateway sees a skip, or 4041 declined")
    func signatureSkippedOrDeclined() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.everything)
        let model = chat.model

        let skipped = try await chat.raise(gateway, "input.signature")
        #expect(await model.skip())
        #expect(try await InteractiveChat.view(gateway, skipped)["outcome"] == "answered")
        #expect(try await Self.stored(gateway).isEmpty, "nothing was made, nothing uploaded")

        let declined = try await chat.raise(gateway, "input.signature", ["optional": false])
        #expect(await model.cannotShow(reason: CannotShowReason.declined))
        let view = try await InteractiveChat.view(gateway, declined)
        #expect(view["outcome"] == "unavailable" && view["reason"] == "declined")
        await chat.session.shutdown()
      }
    }

    @Test("a scanned code is sent cleaned, as the person saw it; the gateway takes it and tells the agent it is scanned text")
    func scan() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.everything)
        let model = chat.model
        let id = try await chat.raise(gateway, "device.scan", ["formats": ["qr", "aztec"]])

        guard case .scan(let request)? = model.presented?.body else {
          Issue.record("not a scan request")
          return
        }

        let scan = InteractiveScanModel(request: request, authorization: Authorised())
        await scan.start()
        scan.detected("4006381333931", as: .ean13)
        #expect(scan.phase == .scanning, "a kind the request did not ask for is looked past")
        scan.detected("https://exa\u{200B}mple.com/\u{202E}txt.exe", as: .qr)

        let found = try #require(scan.found)
        #expect(found.value == "https://example.com/txt.exe" && found.wasCleaned)
        #expect(try await InteractiveChat.view(gateway, id)["outcome"] == nil, "shown, not sent")

        #expect(await model.answer(try #require(scan.answer)))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered" && view["refusals"] == [])
        let told = try #require(view["answer"])
        #expect(told["value"]?.stringValue == "https://example.com/txt.exe")
        #expect(told["symbology"]?.stringValue == "qr")
        #expect(told["cleaned"] != true, "what was sent was already what the gateway would keep")
        await chat.session.shutdown()
      }
    }

    @Test("a camera the person refused answers 4041 permission_denied; no camera, no_camera; Skip a skip")
    func scanRefusals() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.everything)
        let model = chat.model

        let denied = try await chat.raise(gateway, "device.scan")
        guard case .scan(let request)? = model.presented?.body else { return }
        let scan = InteractiveScanModel(request: request, authorization: Authorised(camera: .denied))
        await scan.start()
        let reason = try #require(scan.unavailable?.reason)
        #expect(await model.cannotShow(reason: reason))
        var view = try await InteractiveChat.view(gateway, denied)
        #expect(view["outcome"] == "unavailable" && view["reason"] == "permission_denied")
        #expect(view["agentReason"] == "cannot_show:permission_denied")

        let none = try await chat.raise(gateway, "device.scan")
        #expect(await model.cannotShow(reason: CannotShowReason.noCamera))
        view = try await InteractiveChat.view(gateway, none)
        #expect(view["reason"] == "no_camera")

        _ = try await chat.raise(gateway, "device.scan")
        #expect(await model.skip())
        await chat.session.shutdown()
      }
    }

    @Test("a voice note is recorded, written again without metadata, uploaded as audio/mp4 with its transcript, and the gateway takes it")
    func voiceNote() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.everything)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.file", ["accept": "audio", "capture": "audio", "multiple": false])

        guard case .file(let params)? = model.presented?.body else {
          Issue.record("not a file request")
          return
        }

        #expect(params.asksForRecording)

        let recorder = RealisticRecorder()
        let voice = InteractiveVoiceModel(
          params: params,
          engines: VoiceNoteEngines(
            recorder: { recorder }, player: { SilentPlayer() }, transcriber: { FixedTranscriber() },
            authorization: { Authorised() }))

        await voice.record()
        voice.stopRecording()
        try await interactiveWait("the note") { voice.phase == .recorded }
        try await interactiveWait("the transcript") { voice.transcript != .working }

        let answer = try #require(await voice.send(through: model.uploader))
        #expect(await model.answer(answer))
        voice.discard()

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered", "\(view)")
        #expect(view["refusals"] == [])

        let landed = try await Self.stored(gateway)
        #expect(landed.count == 1 && landed[0]["mime"]?.stringValue == "audio/mp4")
        #expect(landed[0]["path"]?.stringValue?.hasSuffix(".m4a") == true)

        // The gateway cleans the transcript (the zero-width space the recogniser put in goes).
        #expect(view["answer"]?["text"]?.stringValue == "Tuesday at ten works for me.")

        // The file the gateway holds is a clean container: audio and nothing that says where it was made.
        let size = try #require(landed[0]["bytes"]?.intValue)
        #expect(size > 1_000)
        await chat.session.shutdown()
      }
    }
  }
}
#endif
