#if os(macOS)
import AVFoundation
import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A device renderer that only records: what a sentence falls back to, with no sound.
@MainActor
private final class RecordingFallback: VoiceSpeechRenderer {
  private(set) var renders = 0

  func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    renders += 1
  }

  func cancel() {}
  func voices() -> [SpeechVoice] { [] }
}

@MainActor
private final class Counted {
  var value = 0
}

/// What a renderer delivered, from whichever thread.
private final class Heard: @unchecked Sendable {
  private let state = Mutex<(frames: Int, rates: Set<Double>, buffers: Int, ended: Bool)>((0, [], 0, false))

  var frames: Int { state.withLock { $0.frames } }
  var rates: Set<Double> { state.withLock { $0.rates } }
  var buffers: Int { state.withLock { $0.buffers } }
  var ended: Bool { state.withLock { $0.ended } }

  var deliver: @Sendable (AVAudioPCMBuffer?) -> Void {
    { [self] buffer in
      state.withLock {
        if let buffer {
          $0.frames += Int(buffer.frameLength)
          $0.rates.insert(buffer.format.sampleRate)
          $0.buffers += 1
        } else {
          $0.ended = true
        }
      }
    }
  }
}

extension Integration {
  /// The gateway's text-to-speech as the app uses it, over real sockets and real HTTP against the fake
  /// gateway: what it offers, the voices it lists, the streamed PCM and the file route decoded, a voice
  /// per request, cutting in, and the credential of a gated gateway on the audio socket.
  @Suite("Gateway speech") @MainActor
  struct GatewaySpeechIntegrationTests {
    private let sentence = ReadRequest(id: "a#0", text: "Hello there, this is a sentence.", language: "en", source: .gateway)

    private func state(_ gateway: FakeGateway) async throws -> JSONValue {
      try await gateway.control("GET", "/__fake/state")
    }

    private func requests(_ gateway: FakeGateway) async throws -> [JSONObject] {
      (try await state(gateway)["audioRequests"]?.arrayValue ?? []).compactMap(\.objectValue)
    }

    private func access(_ session: GatewaySession, profile: String? = "researcher") throws -> GatewaySpeechAccess {
      try #require(session.speechAccess(profile: profile))
    }

    private func renderer(_ access: GatewaySpeechAccess, fallback: RecordingFallback = RecordingFallback())
      -> (GatewaySpeechRenderer, RecordingFallback)
    {
      (GatewaySpeechRenderer(transport: access.transport, profile: access.profile, fallback: fallback), fallback)
    }

    private func wait(_ what: String, _ condition: @escaping @Sendable () -> Bool) async throws {
      try await capabilityWait(what) { condition() }
    }

    // MARK: What the gateway offers

    @Test("a gateway with a relayed provider says it can speak, and offers no voice to choose")
    func relayedProvider() async throws {
      try await withCapabilitySession { session, _ in
        let access = try access(session)

        #expect(access.config == nil, "nothing is known until it is asked")

        await access.loadConfig()

        #expect(access.isAvailable)
        #expect(access.providerName == "Edge")
        #expect(!access.canChooseVoice)
        #expect(access.selectableVoices.isEmpty)
      }
    }

    @Test("ElevenLabs is named, its voices listed (cloned ones too), and one is chosen only where the gateway takes a voice")
    func elevenLabsVoices() async throws {
      try await withCapabilitySession(
        FakeGateway.Options(extraArguments: ["--tts-provider", "elevenlabs", "--tts-voice-selection"])
      ) { session, _ in
        let access = try access(session)
        await access.loadConfig()
        await access.loadVoices()

        #expect(access.providerName == "ElevenLabs")
        #expect(access.config?.defaultVoice == "voice-rachel")
        #expect(access.canChooseVoice)
        #expect(access.selectableVoices.map(\.label) == ["Adam (premade)", "My own voice (cloned)", "Rachel (premade)"])
        #expect(access.name(ofVoice: "voice-clone-1") == "My own voice (cloned)")
      }
    }

    @Test("a gateway as shipped lists ElevenLabs voices it cannot be asked to use, so none is offered")
    func shippedGatewayOffersNoChoice() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--tts-provider", "elevenlabs"])) {
        session, _ in
        let access = try access(session)
        await access.loadConfig()
        await access.loadVoices()

        #expect(access.isAvailable)
        #expect(!access.canChooseVoice)
        #expect(access.selectableVoices.isEmpty)
      }
    }

    @Test("a gateway with no audio routes cannot speak, and says so by not answering")
    func noAudioRoutes() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--no-audio"])) { session, _ in
        let access = try access(session)
        await access.loadConfig()

        #expect(!access.isAvailable)
        #expect(!access.mayBeAvailable)
      }
    }

    // MARK: Speaking

    @Test("a sentence is streamed as PCM, in order, and the gateway is told the text and the bot")
    func streamed() async throws {
      try await withCapabilitySession { session, gateway in
        let (renderer, fallback) = renderer(try access(session))
        let heard = Heard()

        renderer.render(sentence, rate: 1, voice: nil, deliver: heard.deliver)
        try await wait("the sentence") { heard.ended }

        #expect(heard.frames == 7_200, "three frames of 2,400 samples")
        #expect(heard.rates == [24_000])
        #expect(fallback.renders == 0)

        let asked = try await requests(gateway)
        #expect(asked.count == 1)
        #expect(asked[0]["kind"] == .string("stream"))
        #expect(asked[0]["text"] == .string(sentence.text))
        #expect(asked[0]["profile"] == .string("researcher"))
      }
    }

    @Test("a provider with no stream is spoken from the file route, decoded, and the stream is asked for once")
    func fileRoute() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--no-tts-stream"])) { session, gateway in
        let (renderer, fallback) = renderer(try access(session))
        let first = Heard()
        let second = Heard()

        renderer.render(sentence, rate: 1, voice: nil, deliver: first.deliver)
        try await wait("the first sentence") { first.ended }
        renderer.render(sentence, rate: 1, voice: nil, deliver: second.deliver)
        try await wait("the second sentence") { second.ended }

        #expect(first.frames == 1_600)
        #expect(first.rates == [16_000])
        #expect(second.frames == 1_600)
        #expect(fallback.renders == 0)
        let kinds = try await requests(gateway).compactMap { $0["kind"]?.stringValue }
        #expect(kinds == ["speak", "speak"], "the fake answers fallback without recording: the stream is not asked twice")
      }
    }

    @Test("a gateway that cannot synthesise leaves the sentence to the device")
    func failingProvider() async throws {
      try await withCapabilitySession(
        FakeGateway.Options(extraArguments: ["--no-tts-stream", "--tts-speak-status", "500"])
      ) { session, _ in
        let (renderer, fallback) = renderer(try access(session))
        let told = Counted()
        renderer.setFallbackHandler { told.value += 1 }

        renderer.render(sentence, rate: 1, voice: nil, deliver: Heard().deliver)
        try await capabilityWait("the fall-back") { fallback.renders == 1 }

        #expect(told.value == 1)
      }
    }

    @Test("a gateway that takes a voice is sent the chosen one")
    func voicePerRequest() async throws {
      try await withCapabilitySession(
        FakeGateway.Options(extraArguments: ["--tts-provider", "elevenlabs", "--tts-voice-selection"])
      ) { session, gateway in
        let (renderer, _) = renderer(try access(session))
        let heard = Heard()
        var request = sentence
        request.gatewayVoice = "voice-adam"

        renderer.render(request, rate: 1, voice: nil, deliver: heard.deliver)
        try await wait("the sentence") { heard.ended }

        #expect(try await requests(gateway).first?["voice"] == .string("voice-adam"))
      }
    }

    @Test("a gateway as shipped ignores the voice it is sent: the request carries it, the answer does not change")
    func voiceIgnoredByAShippedGateway() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--tts-provider", "elevenlabs"])) {
        session, gateway in
        let (renderer, _) = renderer(try access(session))
        let heard = Heard()
        var request = sentence
        request.gatewayVoice = "voice-adam"

        renderer.render(request, rate: 1, voice: nil, deliver: heard.deliver)
        try await wait("the sentence") { heard.ended }

        #expect(heard.frames == 7_200)
        #expect(try await requests(gateway).first?["voice"] == .null, "the gateway recorded no voice")
      }
    }

    // MARK: Hearing a voice first

    @Test("a gateway with recorded samples says so, and a sample is fetched over HTTP and decodes as audio")
    func sampleOfAVoice() async throws {
      let arguments = ["--tts-provider", "elevenlabs", "--tts-voice-selection", "--tts-voice-preview", "sample"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, gateway in
        let access = try access(session)
        await access.loadConfig()
        await access.loadVoices()

        #expect(access.config?.voicePreview == .sample)
        let rachel = try #require(access.selectableVoices.first { $0.id == "voice-rachel" })
        #expect(rachel.hasSample)
        #expect(access.canPreview(rachel))

        let clip = try await access.previewClip(for: rachel, sentence: "unused")

        #expect(clip.mimeType == "audio/mpeg")
        #expect(!(try GatewayAudioDecoding.decode(clip)).isEmpty, "the system's reader opens it as a reply's file is opened")

        let asked = try await requests(gateway)
        #expect(asked.map { $0["kind"]?.stringValue } == ["preview"])
        #expect(asked.first?["voice"] == .string("voice-rachel"))
        #expect(asked.first?["profile"] == .string("researcher"))
      }
    }

    @Test("a voice the gateway has no sample of is a 404, said as such")
    func noSample() async throws {
      let arguments = ["--tts-provider", "elevenlabs", "--tts-voice-selection", "--tts-voice-preview", "sample"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, _ in
        let access = try access(session)
        await access.loadConfig()

        await #expect(throws: GatewayPreviewError.noSample) {
          _ = try await access.transport.previewSample(voiceID: "voice-nobody", profile: nil)
        }
      }
    }

    @Test("a provider that speaks for nothing is previewed through speak, in the voice")
    func speakPreview() async throws {
      let arguments = ["--tts-voice-selection", "--tts-voice-preview", "speak"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, gateway in
        let access = try access(session)
        await access.loadConfig()
        let colette = GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")

        #expect(access.config?.voicePreview == .speak)
        #expect(access.canPreview(colette))

        let clip = try await access.previewClip(for: colette, sentence: "A short sentence.")

        #expect(!(try GatewayAudioDecoding.decode(clip)).isEmpty)
        let asked = try await requests(gateway)
        #expect(asked.first?["kind"] == .string("speak"))
        #expect(asked.first?["text"] == .string("A short sentence."))
        #expect(asked.first?["voice"] == .string("nl-NL-ColetteNeural"))
      }
    }

    @Test("a gateway that says nothing of previews offers none")
    func paidProvider() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--tts-provider", "openai"])) { session, _ in
        let access = try access(session)
        await access.loadConfig()

        #expect(access.config?.voicePreview == nil)
        #expect(!access.canPreview(GatewayVoice(id: "alloy", name: "Alloy", hasSample: true)))
      }
    }

    @Test("a voice list that could not be read is empty, and a retry reads it again")
    func voicesError() async throws {
      let arguments = ["--tts-voice-selection", "--tts-voices-error", "unavailable"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, _ in
        let access = try access(session)
        await access.loadConfig()
        await access.loadVoices()

        #expect(access.voicesError == .unavailable)
        #expect(access.selectableVoices.isEmpty)

        await access.retryVoices()

        #expect(access.voicesError == .unavailable, "this gateway always fails: the retry asked and was told so")
      }
    }

    // MARK: The stream's error frame

    @Test("a voice the stream refuses is spoken by the gateway without it, and not asked for again")
    func errorFrame() async throws {
      let arguments = ["--tts-voice-selection", "--tts-stream-error", "unknown_voice", "--tts-error-voice", "ghost"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, gateway in
        let (renderer, fallback) = renderer(try access(session))
        let first = Heard()
        var request = sentence
        request.gatewayVoice = "ghost"

        renderer.render(request, rate: 1, voice: nil, deliver: first.deliver)
        try await wait("the sentence") { first.ended }

        #expect(first.frames == 7_200, "the stream's audio, from the profile's own voice")
        #expect(fallback.renders == 0, "not the device")
        #expect(try await requests(gateway).map { $0["voice"] ?? .null } == [.string("ghost"), .null])

        let second = Heard()
        renderer.render(request, rate: 1, voice: nil, deliver: second.deliver)
        try await wait("the next sentence") { second.ended }

        #expect(second.frames == 7_200)
        #expect(fallback.renders == 0)
        #expect(try await requests(gateway).map { $0["voice"] ?? .null } == [.string("ghost"), .null, .null], "the refused voice is not sent again")
      }
    }

    @Test("a 400 unknown_voice on speak is spoken again without the voice, from the same gateway")
    func speakRefusedForTheVoice() async throws {
      let arguments = ["--no-tts-stream", "--tts-voice-selection", "--tts-speak-error", "unknown_voice", "--tts-error-voice", "ghost"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, gateway in
        let (renderer, fallback) = renderer(try access(session))
        let heard = Heard()
        var request = sentence
        request.gatewayVoice = "ghost"

        renderer.render(request, rate: 1, voice: nil, deliver: heard.deliver)
        try await wait("the sentence") { heard.ended }

        #expect(heard.frames == 1_600, "the file route's clip")
        #expect(fallback.renders == 0, "not the device")
        #expect(try await requests(gateway).map { $0["voice"] ?? .null } == [.string("ghost"), .null])
      }
    }

    @Test("a refused voice on speak falls back to the device's voice")
    func speakRefused() async throws {
      let arguments = ["--tts-voice-selection", "--tts-stream-error", "invalid_voice", "--tts-speak-error", "invalid_voice"]

      try await withCapabilitySession(FakeGateway.Options(extraArguments: arguments)) { session, _ in
        let (renderer, fallback) = renderer(try access(session))
        var request = sentence
        request.gatewayVoice = "bad id"

        renderer.render(request, rate: 1, voice: nil, deliver: Heard().deliver)
        try await capabilityWait("the fall-back") { fallback.renders == 1 }
      }
    }

    @Test("cutting in closes the audio socket before the gateway has finished")
    func cuttingIn() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--tts-delay", "1500"])) { session, gateway in
        let (renderer, fallback) = renderer(try access(session))

        renderer.render(sentence, rate: 1, voice: nil, deliver: Heard().deliver)
        try await capabilityWait("the gateway to have the sentence") { try await requests(gateway).count == 1 }
        renderer.cancel()
        try await capabilityWait("the gateway to see the socket close") {
          try await state(gateway)["audioStreamsCancelled"]?.intValue == 1
        }

        #expect(fallback.renders == 0, "a cut-in is not a failure of the gateway")
      }
    }
  }
}

extension Integration {
  /// The audio socket of a gated gateway: the ticket its credential mints goes on the query.
  @Suite("Gateway speech, gated")
  struct GatewaySpeechGatedIntegrationTests {
    @Test("a signed-in native session speaks over the audio socket with its ticket on the query")
    func gatedGateway() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native)) { gateway in
        let native = try await NativeSession(gateway: gateway)
        try await native.signIn()

        let speech = LiveGatewaySpeech(
          http: native.http, baseURL: native.baseURL, credentials: native.credentials, extraHeaders: [:],
          sockets: URLSessionTransport())
        var frames = 0
        var ended = false

        for try await event in speech.stream(text: "Hello.", profile: "researcher", voice: nil) {
          switch event {
          case .pcm(let data): frames += data.count / 2
          case .end: ended = true
          default: break
          }
        }

        #expect(ended)
        #expect(frames == 7_200)

        let minted = try await gateway.control("GET", "/__fake/state")["ticketsMinted"]?.intValue
        let consumed = try await gateway.control("GET", "/__fake/state")["ticketsConsumed"]?.intValue
        #expect(minted == 1)
        #expect(consumed == 1, "the ticket was accepted on the query, once")
      }
    }
  }
}
#endif
