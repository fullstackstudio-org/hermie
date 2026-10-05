import Foundation
import HermieCore
import HermieStore
import Testing

@testable import HermieUI

/// A gateway's speech routes with fixed answers: nothing is fetched, nothing is spoken.
private struct StubSpeech: GatewaySpeechTransport {
  var config: GatewayVoiceConfig
  var voices: [GatewayVoice] = []
  var configFails = false
  /// What a voice's sample is, when the gateway has one.
  var sample: GatewayAudioClip?

  struct Down: Error {}

  func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig {
    if configFails {
      throw Down()
    }

    return config
  }

  func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice] { voices }
  func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip { throw Down() }
  func previewSample(voiceID: String, profile: String?) async throws -> GatewayAudioClip {
    guard let sample else {
      throw Down()
    }

    return sample
  }

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

  @Test func aGatewayChoiceStaysChosenWhileTheGatewayHasNotAnswered() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, _) = model(StubSpeech(config: elevenLabs), settings: settings)

    #expect(setup.gatewayState == .unknown)
    #expect(setup.source == .gateway, "not known yet: the choice is not undone")
    #expect(setup.showsSourceRow, "and the row it is chosen in is still there")
    #expect(!setup.gatewayUnavailable, "nothing is said of an answer that has not come")

    await setup.loadGateway()

    #expect(setup.gatewayState == .ready)
    #expect(setup.source == .gateway)
    #expect(settings.speechSource == .gateway)
  }

  @Test func aGatewayChoiceStaysChosenWhileTheVoiceListIsStillLoading() async {
    let loading = GatewayVoiceConfig(
      ttsAvailable: true, provider: "elevenlabs", voiceSelection: true, voicesError: .loading)
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let access = GatewaySpeechAccess(
      transport: StubSpeech(config: loading), profile: "hermes", loadingRetryDelay: .milliseconds(1))
    let setup = VoiceSetupModel(
      settings: settings, speaker: HeldSpeaker(), gateway: access, deviceTag: "en-US", sample: "Hello")

    await setup.loadGateway()

    #expect(setup.source == .gateway)
    #expect(settings.speechSource == .gateway)
    #expect(settings.gatewayVoice == "voice-rachel")
    #expect(setup.gatewayVoices.map(\.id) == ["voice-rachel"], "the chosen voice is on the screen, selected")
  }

  @Test func aStoredGatewayChoiceStaysWhereTheGatewayCannotSpeakAndTheScreenSaysSo() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let (setup, _) = model(StubSpeech(config: .unavailable), settings: settings)
    await setup.loadGateway()

    #expect(setup.gatewayState == .unavailable)
    #expect(!setup.offersGateway, "it cannot speak now")
    #expect(setup.source == .gateway, "but it is what was chosen")
    #expect(setup.showsSourceRow)
    #expect(setup.gatewayUnavailable, "the screen says the choice is kept and the device speaks meanwhile")
    #expect(setup.subtitle == NativeStrings.VoiceSetup.subtitle, "what is said does stay on the device then")
    #expect(settings.speechSource == .gateway)
    #expect(settings.gatewayVoice == "voice-rachel")
    #expect(setup.gatewayVoices.map(\.id) == ["voice-rachel"])
  }

  @Test func aGatewayThatCouldNotBeAskedKeepsAChoiceToo() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, _) = model(StubSpeech(config: .unavailable, configFails: true), settings: settings)
    await setup.loadGateway()

    #expect(setup.source == .gateway)
    #expect(setup.gatewayUnavailable)
    #expect(settings.speechSource == .gateway)
  }

  @Test func aScreenWithNoGatewayKeepsAStoredChoiceToo() {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    let (setup, _) = model(nil, settings: settings)

    #expect(setup.source == .gateway)
    #expect(setup.showsSourceRow)
    #expect(setup.gatewayUnavailable)
  }

  @Test func theSourceRowIsNotDrawnForAGatewayThatCannotSpeakWhenItWasNeverChosen() async {
    let (setup, _) = model(StubSpeech(config: .unavailable))
    await setup.loadGateway()

    #expect(!setup.showsSourceRow)
    #expect(setup.source == .device)
    #expect(!setup.gatewayUnavailable)
  }

  @Test func aGatewayVoiceNotInTheListYetIsKeptAndShown() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-not-listed")
    let (setup, _) = model(StubSpeech(config: elevenLabs, voices: [rachel, mine]), settings: settings)
    await setup.loadGateway()

    #expect(settings.gatewayVoice == "voice-not-listed")
    #expect(setup.gatewayVoices.map(\.id) == ["voice-not-listed", "voice-rachel", "voice-clone-1"])
    #expect(setup.listedGatewayVoices.map(\.id) == ["voice-rachel", "voice-clone-1"])
  }

  @Test func theChosenVoiceIsNotShownTwiceWhenTheListHasIt() {
    #expect(GatewayVoiceLogic.keeping("voice-rachel", in: [rachel, mine]) == [rachel, mine])
    #expect(GatewayVoiceLogic.keeping(nil, in: [rachel]) == [rachel])
    #expect(GatewayVoiceLogic.keeping("", in: [rachel]) == [rachel])
    #expect(GatewayVoiceLogic.keeping("x", in: []).map(\.id) == ["x"])
  }

  @Test func aGatewayChoiceSurvivesTheConfigLoadingFailingAndSucceedingAgain() async {
    let settings = VoiceSettings()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-rachel")
    let (down, _) = model(StubSpeech(config: .unavailable, configFails: true), settings: settings)
    await down.loadGateway()
    await down.retryGatewayVoices()

    #expect(down.source == .gateway)
    #expect(settings.speechSource == .gateway)
    #expect(settings.gatewayVoice == "voice-rachel")

    let (up, _) = model(StubSpeech(config: elevenLabs, voices: [rachel]), settings: settings)
    await up.loadGateway()

    #expect(up.source == .gateway)
    #expect(up.gatewayState == .ready)
    #expect(up.gatewayVoices.map(\.id) == ["voice-rachel"])
  }

  @Test func theStoredChoiceRoundTripsThroughTheDevice() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()
    settings.setSpeechSource(.gateway)
    settings.setGatewayVoice("voice-not-listed")
    settings.setBotVoice(BotVoice(source: .gateway, voice: "voice-clone-1"), bot: "hermes", gatewayID: "g1")
    settings.setBotVoice(BotVoice(source: .gateway), bot: "writer", gatewayID: "g1")
    await settings.settled()

    let again = VoiceSettings(keyValues: keyValues)
    await again.hydrate()

    #expect(again.speechSource == .gateway)
    #expect(again.gatewayVoice == "voice-not-listed")
    #expect(
      again.speech(bot: "scout", gatewayID: "g1") == SpeechChoice(source: .gateway, gatewayVoice: "voice-not-listed"))
    #expect(
      again.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .gateway, gatewayVoice: "voice-clone-1"))
    #expect(again.speech(bot: "writer", gatewayID: "g1") == SpeechChoice(source: .gateway))
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

  @Test func aBotsGatewayChoiceStaysOnItsPageWhileTheGatewayLoadsOrCannotBeReached() async {
    let settings = VoiceSettings()
    let own = BotVoice(source: .gateway, voice: "voice-not-listed")
    settings.setBotVoice(own, bot: "hermes", gatewayID: "g1")

    let access = GatewaySpeechAccess(transport: StubSpeech(config: .unavailable), profile: "hermes")

    #expect(GatewayVoiceLogic.state(of: access) == .unknown)
    #expect(BotVoiceLogic.showsGatewaySection(state: .unknown, current: own))
    #expect(BotVoiceLogic.showsGatewaySection(state: .unavailable, current: own))
    #expect(BotVoiceLogic.showsGatewaySection(state: .ready, current: nil))
    #expect(!BotVoiceLogic.showsGatewaySection(state: .unavailable, current: nil), "never chosen, and it cannot speak")
    #expect(!BotVoiceLogic.showsGatewaySection(state: .unknown, current: BotVoice(source: .apple)))

    await access.loadConfig()

    #expect(GatewayVoiceLogic.state(of: access) == .unavailable)
    #expect(GatewayVoiceLogic.state(of: nil) == .unavailable)
    #expect(settings.botVoice(bot: "hermes", gatewayID: "g1") == own, "nothing the page does undoes the choice")
    #expect(
      settings.speech(bot: "hermes", gatewayID: "g1") == SpeechChoice(source: .gateway, gatewayVoice: "voice-not-listed"))
    #expect(
      BotVoiceLogic.summary(own, appleVoices: [], gateway: access) == "Gateway · voice-not-listed",
      "the row names the voice by its id when the list has none")
  }

  @Test func aBotsGatewayVoiceNotInTheListIsKept() async {
    let access = GatewaySpeechAccess(transport: StubSpeech(config: elevenLabs, voices: [rachel]), profile: "hermes")
    await access.loadConfig()
    await access.loadVoices()

    #expect(GatewayVoiceLogic.state(of: access) == .ready)
    #expect(
      GatewayVoiceLogic.keeping("voice-not-listed", in: access.selectableVoices).map(\.id)
        == ["voice-not-listed", "voice-rachel"])
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

/// A player that records and says nothing.
@MainActor
private final class SilentPlayer: GatewayClipPlaying {
  private(set) var played = 0
  private(set) var stops = 0

  func play(_ clip: GatewayAudioClip, finished: @escaping @MainActor @Sendable () -> Void) async throws { played += 1 }
  func stop() { stops += 1 }
}

private let withSample = GatewayVoice(id: "voice-rachel", name: "Rachel", label: "Rachel (premade)", hasSample: true)

/// Hearing a gateway voice on the Voice screen, and what the screen says of a voice list it could not get.
@MainActor
@Suite struct GatewayVoicePreviewScreenTests {
  private func model(
    _ config: GatewayVoiceConfig, speaker: HeldSpeaker = HeldSpeaker(), player: SilentPlayer = SilentPlayer(),
    callActive: @escaping @MainActor () -> Bool = { false }
  ) async -> (VoiceSetupModel, HeldSpeaker, SilentPlayer) {
    let clip = GatewayAudioClip(data: Data([1]), mimeType: "audio/mpeg")
    let stub = StubSpeech(config: config, voices: [withSample], sample: clip)
    let access = GatewaySpeechAccess(transport: stub, profile: "hermes", loadingRetryDelay: .milliseconds(1))
    let setup = VoiceSetupModel(
      settings: VoiceSettings(), speaker: speaker, gateway: access, deviceTag: "en-US", sample: "Hello", clipPlayer: player,
      callActive: callActive)
    await setup.loadGateway()
    return (setup, speaker, player)
  }

  private func elevenLabs(_ preview: GatewayVoicePreview?) -> GatewayVoiceConfig {
    GatewayVoiceConfig(
      ttsAvailable: true, provider: "elevenlabs", defaultVoice: "voice-rachel", voiceSelection: true, voicePreview: preview)
  }

  @Test func theButtonIsOfferedOnlyWhereThePreviewIsFree() async {
    let (free, _, _) = await model(elevenLabs(.sample))
    let (paid, _, _) = await model(elevenLabs(nil))

    #expect(free.previewer?.offers(withSample) == true)
    #expect(paid.previewer?.offers(withSample) == false)
  }

  @Test func playingASampleDoesNotChangeTheSelectionAndSilencesTheDevicesSentence() async {
    let (setup, speaker, player) = await model(elevenLabs(.sample))
    let stopsBefore = speaker.stops

    setup.togglePreview(withSample)
    await eventually("the sample plays") { setup.previewer?.phase(of: withSample.id) == .playing }

    #expect(setup.settings.gatewayVoice == nil, "the voice is chosen by the row, never by its play button")
    #expect(setup.settings.speechSource == .apple)
    #expect(speaker.spoken.isEmpty)
    #expect(speaker.stops > stopsBefore)
    #expect(player.played == 1)
  }

  @Test func choosingAVoiceOrLeavingTheScreenStopsTheSample() async {
    let (setup, _, player) = await model(elevenLabs(.sample))

    setup.togglePreview(withSample)
    await eventually("the sample plays") { setup.previewer?.phase(of: withSample.id) == .playing }
    let stops = player.stops

    setup.selectGatewayVoice("voice-rachel")

    #expect(player.stops > stops, "picking a voice says its own sentence, and the sample stops")
    #expect(setup.previewer?.activeVoice == nil)

    setup.togglePreview(withSample)
    await eventually("the sample plays") { setup.previewer?.phase(of: withSample.id) == .playing }
    setup.stop()

    #expect(setup.previewer?.activeVoice == nil)
  }

  @Test func nothingPlaysDuringACallAndTheRowSaysSo() async {
    let (setup, _, player) = await model(elevenLabs(.sample), callActive: { true })

    setup.togglePreview(withSample)

    #expect(setup.previewer?.failure(of: withSample.id) == .callActive)
    #expect(player.played == 0)
    #expect(GatewayVoicePreviewLogic.message(for: .callActive) == NativeStrings.VoiceSetup.previewCallActive)
  }

  @Test func aVoiceListTheGatewayCouldNotReadIsEmptyWithAMessageAndARetry() async {
    let failed = GatewayVoiceConfig(
      ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [], voicesError: .unavailable)
    let (setup, _, _) = await model(failed)

    #expect(setup.gatewayVoices.isEmpty)
    #expect(setup.gatewayVoicesError == .unavailable)
    #expect(!setup.loadingGatewayVoices)
    #expect(GatewayVoicePreviewLogic.message(for: GatewayVoicesError.unavailable) == NativeStrings.VoiceSetup.voicesUnavailable)
    #expect(GatewayVoicePreviewLogic.message(for: GatewayVoicesError.loading) == NativeStrings.VoiceSetup.voicesStillLoading)
  }

  @Test func anElevenLabsListThatCouldNotBeReadIsNotShownAsLoadingForEver() async {
    var config = elevenLabs(.sample)
    config.voicesError = .unavailable
    let (setup, _, _) = await model(config)

    #expect(!setup.loadingGatewayVoices)
    #expect(setup.gatewayVoicesError == .unavailable)
  }

  @Test func theButtonsAreNamedForTheVoiceAndStop() {
    #expect(
      GatewayVoicePreviewLogic.accessibilityLabel(name: "Rachel (premade)", phase: .idle)
        == NativeStrings.VoiceSetup.previewPlay("Rachel (premade)"))
    #expect(GatewayVoicePreviewLogic.accessibilityLabel(name: "Rachel", phase: .playing) == NativeStrings.VoiceSetup.previewStop)
    #expect(GatewayVoicePreviewLogic.accessibilityLabel(name: "Rachel", phase: .loading) == NativeStrings.VoiceSetup.previewStop)
  }
}
