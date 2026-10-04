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

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {}
  func stop() {}
  func voices() -> [SpeechVoice] { installed }
}

/// The pieces of Settings › Voice that decide what it says.
@MainActor
@Suite("Settings: Voice") struct VoiceSettingsPageTests {
  private func probe(_ recogniser: FakeRecogniser = FakeRecogniser(), _ synth: FakeSynthesiser = FakeSynthesiser())
    -> VoiceProbe
  {
    VoiceProbe(engines: VoiceEngines(dictation: { recogniser }, speech: { synth }))
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
