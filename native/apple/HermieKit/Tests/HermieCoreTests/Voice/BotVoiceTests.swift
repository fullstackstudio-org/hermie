import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// Who speaks for a bot: the Voice screen's choice, or a voice the bot was given of its own; and what the
/// reader hands the synthesiser as a result.
@Suite(.timeLimit(.minutes(1))) @MainActor struct BotVoiceTests {
  private func open() throws -> KeyValueStore {
    KeyValueStore(store: try SQLiteStore(.inMemory))
  }

  // MARK: Resolution

  @Test func aBotWithNoVoiceOfItsOwnFollowsTheVoiceScreen() {
    let settings = VoiceSettings()
    settings.setVoiceIdentifier("apple.samantha")

    #expect(settings.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .apple, appleVoice: "apple.samantha"))

    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")

    #expect(
      settings.speech(bot: "hermes", gatewayID: "g1")
        == SpeechChoice(source: .gateway, appleVoice: "apple.samantha", gatewayVoice: "voice-rachel"),
      "the device's voice stays named: it is what speaks when the gateway cannot")
  }

  @Test func theGatewayVoiceIsOnlyHandedOverWhileTheGatewayIsTheSource() {
    let settings = VoiceSettings()
    settings.setGatewayVoice("voice-rachel")

    #expect(settings.speech(bot: "hermes", gatewayID: "g1").gatewayVoice == nil)
  }

  @Test func aBotCanSpeakInADeviceVoiceWhileTheScreenSaysGateway() {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")

    #expect(settings.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .apple, appleVoice: "apple.xander"))
    #expect(settings.speech(bot: "writer", gatewayID: "g1").source == .gateway, "another bot is untouched")
  }

  @Test func aBotCanSpeakInAGatewayVoiceWhileTheScreenSaysApple() {
    let settings = VoiceSettings()
    settings.setVoiceIdentifier("apple.samantha")
    settings.setBotVoice(BotVoice(source: .gateway, voice: "voice-adam"), bot: "hermes", gatewayID: "g1")

    #expect(
      settings.speech(bot: "hermes", gatewayID: "g1")
        == SpeechChoice(source: .gateway, appleVoice: "apple.samantha", gatewayVoice: "voice-adam"))
  }

  @Test func aBotsGatewayWithNoVoiceIsTheGatewaysOwn() {
    let settings = VoiceSettings()
    settings.setBotVoice(BotVoice(source: .gateway), bot: "hermes", gatewayID: "g1")

    #expect(settings.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .gateway))
  }

  @Test func aBotsVoiceBelongsToItsGatewayToo() {
    let settings = VoiceSettings()
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")

    #expect(settings.botVoice(bot: "hermes", gatewayID: "g1") != nil)
    #expect(settings.botVoice(bot: "hermes", gatewayID: "g2") == nil, "the same handle on another gateway is another bot")
  }

  @Test func backToDefaultForgetsTheBotsOwnVoice() {
    let settings = VoiceSettings()
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")
    settings.setBotVoice(nil, bot: "hermes", gatewayID: "g1")

    #expect(settings.botVoices.isEmpty)
    #expect(settings.speech(bot: "hermes", gatewayID: "g1").source == .apple)
  }

  // MARK: Kept

  @Test func theSourceAndEveryBotsVoiceSurviveARelaunch() async throws {
    let keyValues = try open()
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")
    settings.setBotVoice(BotVoice(source: .gateway), bot: "writer", gatewayID: "g1")
    await settings.settled()

    let again = VoiceSettings(keyValues: keyValues)
    await again.hydrate()

    #expect(again.speechSource == .gateway)
    #expect(again.gatewayVoice == "voice-rachel")
    #expect(again.botVoice(bot: "hermes", gatewayID: "g1") == BotVoice(source: .apple, voice: "apple.xander"))
    #expect(again.botVoice(bot: "writer", gatewayID: "g1") == BotVoice(source: .gateway))
  }

  // MARK: The provider a gateway voice was chosen from

  @Test func aGatewayVoiceKeepsTheProviderItWasChosenFromAndTheReaderHandsItOver() async throws {
    let keyValues = try open()
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("nl-NL-FennaNeural", provider: "edge")
    settings.setBotVoice(
      BotVoice(source: .gateway, voice: "voice-rachel", provider: "elevenlabs"), bot: "postman", gatewayID: "g1")
    await settings.settled()

    let again = VoiceSettings(keyValues: keyValues)
    await again.hydrate()

    #expect(again.gatewayVoiceProvider == "edge")
    #expect(again.botVoice(bot: "postman", gatewayID: "g1")?.provider == "elevenlabs")
    #expect(
      again.speech(bot: "hermes", gatewayID: "g1")
        == SpeechChoice(source: .gateway, gatewayVoice: "nl-NL-FennaNeural", gatewayProvider: "edge"))
    #expect(
      again.speech(bot: "postman", gatewayID: "g1")
        == SpeechChoice(source: .gateway, gatewayVoice: "voice-rachel", gatewayProvider: "elevenlabs"))

    let synth = FakeSynthesiser()
    reader(again, synth).enqueue(id: "a1", markdown: "Hello there.")

    #expect(synth.spoken[0].request.gatewayVoice == "nl-NL-FennaNeural")
    #expect(synth.spoken[0].request.gatewayProvider == "edge")
  }

  @Test func aVoiceKeptBeforeTheProviderWasKeptStillLoadsAndHasNone() async throws {
    let keyValues = try open()
    try await keyValues.set(
      try JSONValue(
        parsing:
          #"{"speechSource":"gateway","gatewayVoice":"nl-NL-FennaNeural","botVoices":{"postman@g1":{"source":"gateway","voice":"voice-rachel"}}}"#
      ).objectValue ?? [:], forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    #expect(settings.gatewayVoice == "nl-NL-FennaNeural")
    #expect(settings.gatewayVoiceProvider == nil)
    #expect(settings.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .gateway, gatewayVoice: "nl-NL-FennaNeural"))
    #expect(settings.speech(bot: "postman", gatewayID: "g1").gatewayProvider == nil)
  }

  @Test func theProviderGoesWhenTheVoiceDoesOrIsReplaced() {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("nl-NL-FennaNeural", provider: "edge")
    settings.setGatewayVoice("voice-rachel")

    #expect(settings.gatewayVoiceProvider == nil, "a voice chosen without its provider does not keep the last one's")

    settings.setGatewayVoice("nl-NL-FennaNeural", provider: "edge")
    settings.setGatewayVoice(nil, provider: "edge")

    #expect(settings.gatewayVoiceProvider == nil, "the gateway's own voice has no provider to keep")

    settings.setGatewayVoice("nl-NL-FennaNeural", provider: "edge")
    settings.reset()

    #expect(settings.gatewayVoiceProvider == nil)
  }

  @Test func whatIsStoredThatIsNotAVoiceIsIgnoredAndTheRestIsKept() async throws {
    let keyValues = try open()
    try await keyValues.set(
      try JSONValue(
        parsing:
          #"{"speechSource":"carrier pigeon","gatewayVoice":"","botVoices":{"hermes@g1":{"source":"apple","voice":"apple.x"},"bad@g1":{"source":"nothing"},"worse@g1":"text"},"somebodyElsesField":7}"#
      ).objectValue ?? [:], forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    #expect(settings.speechSource == .apple)
    #expect(settings.gatewayVoice == nil)
    #expect(settings.botVoices.keys.sorted().count == 1)
    #expect(settings.botVoice(bot: "hermes", gatewayID: "g1") == BotVoice(source: .apple, voice: "apple.x"))

    settings.setRate(1.5)
    await settings.settled()

    let blob = try await keyValues.value(JSONObject.self, forKey: StoreKeys.voice)
    #expect(blob?["somebodyElsesField"] == .number(7), "another app's field is written back as found")
  }

  @Test func resetPutsTheVoicesBack() {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    settings.setBotVoice(BotVoice(source: .gateway), bot: "hermes", gatewayID: "g1")

    settings.reset()

    #expect(settings.speechSource == .apple)
    #expect(settings.gatewayVoice == nil)
    #expect(settings.botVoices.isEmpty)
  }

  // MARK: What the reader hands over

  private func reader(_ settings: VoiceSettings, _ synth: FakeSynthesiser, bot: String = "hermes") -> ReadAloudModel {
    ReadAloudModel(engine: synth, settings: settings, bot: bot, gatewayID: "g1", codeBlock: { "Code, \($0) lines" })
  }

  @Test func aReplyIsSpokenInTheBotsSourceAndVoices() {
    let settings = VoiceSettings()
    settings.setVoiceIdentifier("apple.samantha")
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let synth = FakeSynthesiser()

    reader(settings, synth).enqueue(id: "a1", markdown: "Hello there.")

    #expect(synth.spoken.count == 1)
    #expect(synth.spoken[0].request.source == .gateway)
    #expect(synth.spoken[0].request.gatewayVoice == "voice-rachel")
    #expect(synth.spoken[0].voice == "apple.samantha", "the device's voice, for when the gateway cannot")
  }

  @Test func aBotsOwnDeviceVoiceReplacesTheScreensForThatBotOnly() {
    let settings = VoiceSettings()
    settings.setVoiceIdentifier("apple.samantha")
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")
    let own = FakeSynthesiser()
    let other = FakeSynthesiser()

    reader(settings, own).enqueue(id: "a1", markdown: "Hello there.")
    reader(settings, other, bot: "writer").enqueue(id: "a1", markdown: "Hello there.")

    #expect(own.spoken[0].voice == "apple.xander")
    #expect(own.spoken[0].request.source == .apple)
    #expect(other.spoken[0].voice == "apple.samantha")
  }

  @Test func theVoiceIsReadForEachSentenceNotOnceWhenTheReaderIsMade() {
    let settings = VoiceSettings()
    settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")
    let synth = FakeSynthesiser()
    let model = reader(settings, synth)

    model.enqueue(id: "a1", markdown: "First.")
    model.enqueue(id: "a2", markdown: "Second.")
    model.enqueue(id: "a3", markdown: "Third.")

    #expect(synth.prefetched.map(\.voice) == ["apple.xander"], "fetched ahead in the voice of the time")

    settings.setBotVoice(BotVoice(source: .gateway, voice: "voice-bella"), bot: "hermes", gatewayID: "g1")
    synth.finishCurrent()

    #expect(synth.spoken.map(\.request.id) == ["a1", "a2"])
    #expect(synth.spoken[0].voice == "apple.xander")
    #expect(synth.spoken[1].request.source == .gateway, "the sentence after the change is spoken in the new voice")
    #expect(synth.spoken[1].request.gatewayVoice == "voice-bella")

    settings.setBotVoice(nil, bot: "hermes", gatewayID: "g1")
    synth.finishCurrent()

    #expect(synth.spoken[2].request.source == .apple)
    #expect(synth.spoken[2].voice == nil)
  }

  @Test func theReplyAfterTheOneBeingReadIsPrefetchedWithTheSameSource() {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let synth = FakeSynthesiser()
    let model = reader(settings, synth)

    model.enqueue(id: "a1", markdown: "First.")

    #expect(synth.prefetched.isEmpty, "nothing is waiting")

    model.enqueue(id: "a2", markdown: "Second.")

    #expect(synth.prefetched.map(\.request.id) == ["a2"])
    #expect(synth.prefetched[0].request.source == .gateway)
    #expect(synth.prefetched[0].request.gatewayVoice == "voice-rachel")

    model.enqueue(id: "a3", markdown: "Third.")

    #expect(synth.prefetched.count == 1, "only what is next is fetched ahead")

    synth.finishCurrent()

    #expect(synth.spoken.map(\.request.id) == ["a1", "a2"])
    #expect(synth.prefetched.map(\.request.id) == ["a2", "a3"], "and then the one after that")
  }
}
