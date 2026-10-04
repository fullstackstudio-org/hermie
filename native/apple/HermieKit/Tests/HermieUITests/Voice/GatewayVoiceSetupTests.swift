import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// A gateway's speech routes with fixed answers: nothing is fetched, nothing is spoken.
private struct StubSpeech: GatewaySpeechTransport {
  var config: GatewayVoiceConfig
  var voices: [GatewayVoice] = []
  var configFails = false

  struct Down: Error {}

  func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig {
    if configFails {
      throw Down()
    }

    return config
  }

  func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice] { voices }
  func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip { throw Down() }

  func stream(text: String, profile: String?, voice: String?) -> AsyncThrowingStream<GatewayStreamEvent, any Error> {
    AsyncThrowingStream { $0.finish(throwing: Down()) }
  }
}

/// A synthesiser that holds what it was asked to say: no sound.
@MainActor
private final class HeldSpeaker: SpeechSynthesizing {
  var isAvailable = true
  private(set) var spoken: [(request: ReadRequest, voice: String?)] = []
  private(set) var stops = 0

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append((request, voice))
  }

  func stop() { stops += 1 }
  func voices() -> [SpeechVoice] { [] }
}

private let rachel = GatewayVoice(id: "voice-rachel", name: "Rachel", label: "Rachel (premade)")
private let mine = GatewayVoice(id: "voice-clone-1", name: "Mine", label: "Mine (cloned)")

/// The Voice screen with the gateway as a second source, and the bot's voice row.
@MainActor
@Suite struct GatewayVoiceSetupTests {
  private func model(
    _ stub: StubSpeech?, settings: VoiceSettings = VoiceSettings(), speaker: HeldSpeaker = HeldSpeaker()
  ) -> (VoiceSetupModel, HeldSpeaker) {
    let access = stub.map { GatewaySpeechAccess(transport: $0, profile: "hermes") }
    return (VoiceSetupModel(settings: settings, speaker: speaker, gateway: access, deviceTag: "en-US", sample: "Hello"), speaker)
  }

  private let elevenLabs = GatewayVoiceConfig(
    ttsAvailable: true, provider: "elevenlabs", defaultVoice: "voice-rachel", voiceSelection: true)

  // MARK: The Source row

  @Test func theSourceRowIsOnlyOfferedWhenTheGatewayHasTextToSpeech() async {
    let (none, _) = model(nil)
    let (unknown, _) = model(StubSpeech(config: .unavailable))
    let (speaks, _) = model(StubSpeech(config: GatewayVoiceConfig(ttsAvailable: true, provider: "edge")))
    let (down, _) = model(StubSpeech(config: .unavailable, configFails: true))

    for setup in [none, unknown, speaks, down] {
      await setup.loadGateway()
    }

    #expect(!none.offersGateway, "a screen with no gateway to ask")
    #expect(!unknown.offersGateway, "a gateway that says it cannot speak")
    #expect(speaks.offersGateway)
    #expect(!down.offersGateway, "a gateway that could not be asked")
  }

  @Test func theSourceIsTheDevicesUntilTheGatewayHasSaidItCanSpeak() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, _) = model(StubSpeech(config: elevenLabs), settings: settings)

    #expect(setup.source == .device, "not known yet: the device speaks")

    await setup.loadGateway()

    #expect(setup.source == .gateway)
  }

  @Test func aStoredGatewaySourceIsTheDevicesWhereTheGatewayCannotSpeak() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, _) = model(StubSpeech(config: .unavailable), settings: settings)
    await setup.loadGateway()

    #expect(setup.source == .device)
    #expect(setup.subtitle == NativeStrings.VoiceSetup.subtitle)
  }

  @Test func choosingTheGatewaySavesItAndSpeaksTheSampleThroughIt() async {
    let (setup, speaker) = model(StubSpeech(config: elevenLabs))
    await setup.loadGateway()

    setup.source = .gateway

    #expect(setup.settings.speechSource == .gateway)
    #expect(setup.subtitle == NativeStrings.VoiceSetup.subtitleGateway, "what is said leaves the device: the screen says so")
    #expect(speaker.spoken.count == 1)
    #expect(speaker.spoken[0].request.source == .gateway)
    #expect(speaker.spoken[0].request.gatewayVoice == nil, "the gateway's own voice until one is chosen")
    #expect(speaker.spoken[0].request.text == "Hello")
  }

  @Test func goingBackToTheDeviceSpeaksTheSampleOnTheDevice() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let (setup, speaker) = model(StubSpeech(config: elevenLabs), settings: settings)
    await setup.loadGateway()

    setup.source = .device

    #expect(speaker.spoken[0].request.source == .apple)
    #expect(speaker.spoken[0].request.gatewayVoice == nil)
  }

  // MARK: The gateway's voices

  @Test func elevenLabsIsNamedAndItsVoicesAreListedWhereTheGatewayTakesOne() async {
    let (setup, _) = model(StubSpeech(config: elevenLabs, voices: [rachel, mine]))
    await setup.loadGateway()

    #expect(setup.gatewayProviderLine == NativeStrings.VoiceSetup.gatewayProvider("ElevenLabs"))
    #expect(setup.canChooseGatewayVoice)
    #expect(setup.gatewayVoices.map(\.id) == ["voice-rachel", "voice-clone-1"])
    #expect(!setup.loadingGatewayVoices)
  }

  @Test func aGatewayThatTakesNoVoiceOffersNoneAndSaysSo() async {
    let shipped = GatewayVoiceConfig(ttsAvailable: true, provider: "elevenlabs", defaultVoice: "voice-rachel")
    let (setup, _) = model(StubSpeech(config: shipped, voices: [rachel]))
    await setup.loadGateway()

    #expect(!setup.canChooseGatewayVoice)
    #expect(setup.gatewayVoices.isEmpty)
  }

  @Test func aProviderThatIsNotNamedIsDescribedWithoutOne() async {
    let (setup, _) = model(StubSpeech(config: GatewayVoiceConfig(ttsAvailable: true)))
    await setup.loadGateway()

    #expect(setup.gatewayProviderLine == NativeStrings.VoiceSetup.gatewayProviderUnknown)
  }

  @Test func edgeVoicesTheGatewayListsAreChosenFrom() async {
    let colette = GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")
    let config = GatewayVoiceConfig(ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [colette])
    let (setup, _) = model(StubSpeech(config: config))
    await setup.loadGateway()

    #expect(setup.canChooseGatewayVoice)
    #expect(setup.gatewayVoices == [colette])
  }

  @Test func edgeVoicesAreShownForTheDevicesLanguageAndAlwaysTheChosenOne() async {
    let nl = GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")
    let en = GatewayVoice(id: "en-US-AriaNeural", name: "Aria", language: "en-US")
    let de = GatewayVoice(id: "de-DE-KatjaNeural", name: "Katja", language: "de-DE")
    let config = GatewayVoiceConfig(ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [nl, en, de])
    let settings = VoiceSettings()
    let (setup, _) = model(StubSpeech(config: config), settings: settings)
    await setup.loadGateway()

    #expect(setup.gatewayVoices == [en], "the device is en-US")

    settings.setGatewayVoice("de-DE-KatjaNeural")

    #expect(setup.gatewayVoices == [en, de], "a voice already chosen stays on the screen")
  }

  @Test func edgeVoicesOfNoMatchingLanguageAllShow() async {
    let nl = GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")
    let de = GatewayVoice(id: "de-DE-KatjaNeural", name: "Katja", language: "de-DE")
    let config = GatewayVoiceConfig(ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [nl, de])
    let (setup, _) = model(StubSpeech(config: config))
    await setup.loadGateway()

    #expect(setup.gatewayVoices == [nl, de])
  }

  @Test func choosingAGatewayVoiceSavesItAndSpeaksTheSampleInIt() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, speaker) = model(StubSpeech(config: elevenLabs, voices: [rachel, mine]), settings: settings)
    await setup.loadGateway()

    setup.selectGatewayVoice("voice-clone-1")

    #expect(settings.gatewayVoice == "voice-clone-1")
    #expect(speaker.spoken.last?.request.source == .gateway)
    #expect(speaker.spoken.last?.request.gatewayVoice == "voice-clone-1")

    setup.selectGatewayVoice(nil)

    #expect(settings.gatewayVoice == nil)
    #expect(speaker.spoken.last?.request.gatewayVoice == nil)
  }

  // MARK: The bot's voice row

  @Test func theRowSaysDefaultWhenTheBotHasNoVoiceOfItsOwn() {
    #expect(BotVoiceLogic.summary(nil, appleVoices: [], gateway: nil) == NativeStrings.BotSettings.voiceDefault)
  }

  @Test func aDeviceVoiceIsNamedAndAutomaticIsAutomatic() {
    let voices = [SpeechVoice(id: "apple.xander", name: "Xander", language: "nl-NL")]

    #expect(BotVoiceLogic.summary(BotVoice(source: .apple, voice: "apple.xander"), appleVoices: voices, gateway: nil) == "Apple · Xander")
    #expect(
      BotVoiceLogic.summary(BotVoice(source: .apple), appleVoices: voices, gateway: nil)
        == "Apple · \(NativeStrings.VoiceSetup.automatic)")
    #expect(
      BotVoiceLogic.summary(BotVoice(source: .apple, voice: "gone"), appleVoices: voices, gateway: nil)
        == "Apple · \(NativeStrings.VoiceSetup.automatic)", "a voice the device no longer has is not named")
  }

  @Test func aGatewayVoiceIsNamedByItsLabelAndTheGatewaysOwnIsSaidSo() async {
    let access = GatewaySpeechAccess(transport: StubSpeech(config: elevenLabs, voices: [rachel, mine]), profile: "hermes")
    await access.loadConfig()
    await access.loadVoices()

    #expect(BotVoiceLogic.summary(BotVoice(source: .gateway, voice: "voice-clone-1"), appleVoices: [], gateway: access) == "Gateway · Mine (cloned)")
    #expect(
      BotVoiceLogic.summary(BotVoice(source: .gateway), appleVoices: [], gateway: access)
        == "Gateway · \(NativeStrings.VoiceSetup.gatewayDefaultVoice)")
    #expect(BotVoiceLogic.summary(BotVoice(source: .gateway, voice: "elsewhere"), appleVoices: [], gateway: access) == "Gateway · elsewhere")
  }

  @Test func thePageListsTheDeviceLanguagesVoicesAndAlwaysTheChosenOne() {
    let voices = [
      SpeechVoice(id: "en-a", name: "Ava", language: "en-US", quality: .enhanced),
      SpeechVoice(id: "en-b", name: "Allison", language: "en-US", quality: .compact),
      SpeechVoice(id: "nl-a", name: "Xander", language: "nl-NL", quality: .compact)
    ]

    #expect(BotVoiceLogic.appleChoices(voices: voices, chosen: nil, deviceTag: "en-US").map(\.id) == ["en-a", "en-b"])
    #expect(
      BotVoiceLogic.appleChoices(voices: voices, chosen: "nl-a", deviceTag: "en-US").map(\.id) == ["nl-a"],
      "a chosen voice sets the language the page opens on")
    #expect(BotVoiceLogic.appleChoices(voices: [], chosen: "x", deviceTag: "en-US").isEmpty)
  }
}
