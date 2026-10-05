import Foundation
import Testing

@testable import HermieCore
@testable import HermieUI

@MainActor
private final class FakeRecogniser: DictationEngine {
  var isAvailable = true
  var processingAnswer = RecognitionProcessing.onDevice
  var languages = ["nl-NL", "en-US", "nl-BE", "en-US"]

  func requestPermission() async -> RecognitionPermission { .granted }
  func processing(language: String?) -> RecognitionProcessing { processingAnswer }
  func supportedLanguages() -> [String] { languages }
  func start(language: String?, events: DictationEvents) {}
  func stop() {}
  func abort() {}
}

@MainActor
private final class FakeSynthesiser: SpeechSynthesizing {
  var isAvailable = true
  var installed = [SpeechVoice(id: "xander", name: "Xander", language: "nl-NL")]
  private(set) var stops = 0

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {}
  func stop() { stops += 1 }
  func voices() -> [SpeechVoice] { installed }
}

/// A gateway that is never asked anything: the setup page only needs an access to be handed.
private struct IdleSpeech: GatewaySpeechTransport {
  struct Idle: Error {}

  func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig { throw Idle() }
  func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice] { throw Idle() }
  func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip { throw Idle() }
  func previewSample(voiceID: String, profile: String?) async throws -> GatewayAudioClip { throw Idle() }
  func stream(text: String, profile: String?, voice: String?) -> AsyncThrowingStream<GatewayStreamEvent, any Error> {
    AsyncThrowingStream { $0.finish(throwing: Idle()) }
  }
}

/// The pieces of Settings › Voice that decide what it says.
/// The accesses a gateway-aware speaker was made around.
@MainActor
private final class Asked {
  var accesses: [GatewaySpeechAccess] = []
}

@MainActor
@Suite("Settings: Voice") struct VoiceSettingsPageTests {
  private func probe(_ recogniser: FakeRecogniser = FakeRecogniser(), _ synth: FakeSynthesiser = FakeSynthesiser())
    -> VoiceProbe
  {
    VoiceProbe(engines: VoiceEngines(dictation: { recogniser }, speech: { synth }))
  }

  @Test("the setup page's speaker is the device's until the gateway is there, then one around the gateway")
  func setupSpeakerFollowsTheSession() {
    let plain = FakeSynthesiser()
    let spoken = FakeSynthesiser()
    let asked = Asked()
    let engines = VoiceEngines(
      dictation: { FakeRecogniser() }, speech: { plain },
      gateway: GatewayVoiceEngines(
        speech: { access in
          asked.accesses.append(access)
          return spoken
        }, call: { _ in AppleVoiceModeEngine.call() }))
    let speakers = VoiceSetupSpeakers(engines: engines)

    #expect(speakers.speaker(for: nil) === plain, "no session yet: the device's")
    #expect(speakers.speaker(for: nil) === plain)
    #expect(asked.accesses.isEmpty)
    #expect(plain.stops == 0)

    let access = GatewaySpeechAccess(transport: IdleSpeech(), profile: nil)

    #expect(speakers.speaker(for: access) === spoken, "the session arrived: the page now has the gateway's voice")
    #expect(speakers.speaker(for: access) === spoken)
    #expect(asked.accesses.count == 1, "made once for it, not on every redraw")
    #expect(asked.accesses.first === access)
    #expect(plain.stops == 1, "what the first one was saying is cut")

    let next = GatewaySpeechAccess(transport: IdleSpeech(), profile: nil)

    #expect(speakers.speaker(for: next) === spoken)
    #expect(asked.accesses.count == 2, "a new connection is a new access, and a new speaker around it")
    #expect(asked.accesses.last === next)
  }

  @Test("the languages are named in the reader's language, sorted by name, each once")
  func languages() {
    let choices = VoiceLanguageChoice.choices(["nl-NL", "en-US", "nl-BE", "en-US"], locale: Locale(identifier: "en"))

    #expect(choices.map(\.tag) == ["nl-BE", "nl-NL", "en-US"], "Dutch (Belgium), Dutch (Netherlands), English")
    #expect(choices.last?.name == "English (United States)")
  }

  @Test("a tag the system cannot name is shown as itself")
  func unnamed() {
    #expect(VoiceLanguageChoice.name(of: "zz-ZZ", locale: Locale(identifier: "en")).contains("zz") == true)
  }

  @Test("the rate stops are named from the slowest to the fastest")
  func rates() {
    #expect(VoiceSettings.rateSteps.map(VoiceSettings.rateLabel) == [
      Strings.Chat.Voice.RateOptions.slowest, Strings.Chat.Voice.RateOptions.slow, Strings.Chat.Voice.RateOptions.normal,
      Strings.Chat.Voice.RateOptions.fast, Strings.Chat.Voice.RateOptions.fastest
    ])
  }

  @Test("each half is there only where the device has it")
  func capabilities() {
    let recogniser = FakeRecogniser()
    let synth = FakeSynthesiser()
    recogniser.isAvailable = false

    let page = probe(recogniser, synth)
    #expect(!page.canDictate)
    #expect(page.canSpeak)

    synth.isAvailable = false
    #expect(!probe(recogniser, synth).canSpeak)
  }

  @Test("the footer says the language is recognised on the device, or that it cannot be, and that nothing is sent by itself")
  func footer() {
    let recogniser = FakeRecogniser()
    let page = probe(recogniser)

    recogniser.processingAnswer = .onDevice
    let local = VoiceSettingsPage.dictationFooter(probe: page, language: "nl-NL")
    #expect(local.contains(NativeStrings.Voice.dictationNote))
    #expect(local == NativeStrings.Voice.Processing.onDevice(VoiceLanguageChoice.name(of: "nl-NL")) + " " + NativeStrings.Voice.dictationNote)

    recogniser.processingAnswer = .unavailable
    #expect(VoiceSettingsPage.dictationFooter(probe: page, language: "nl-NL").contains(NativeStrings.Voice.Processing.unavailable(VoiceLanguageChoice.name(of: "nl-NL"))))
  }

  @Test("the voice row names the chosen voice, or says Automatic")
  func voiceName() {
    let voices = [SpeechVoice(id: "xander", name: "Xander", language: "nl-NL")]

    #expect(VoiceSettingsPage.voiceName("xander", in: voices) == "Xander")
    #expect(VoiceSettingsPage.voiceName(nil, in: voices) == NativeStrings.Voice.automatic)
    #expect(VoiceSettingsPage.voiceName("gone", in: voices) == NativeStrings.Voice.automatic, "a voice that was removed is not claimed")
  }
}
