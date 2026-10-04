import AVFoundation
import Foundation
import Synchronization
import Testing

@testable import HermieCore

/// A clip player that records instead of playing: no engine, no sound. `heardTheEnd` is the clip finishing.
@MainActor
final class FakeClipPlayer: GatewayClipPlaying {
  private(set) var played: [GatewayAudioClip] = []
  private(set) var stops = 0
  var failure: (any Error)?
  private var finishers: [@MainActor @Sendable () -> Void] = []

  func play(_ clip: GatewayAudioClip, finished: @escaping @MainActor @Sendable () -> Void) async throws {
    if let failure {
      throw failure
    }

    played.append(clip)
    finishers.append(finished)
  }

  func stop() {
    stops += 1
    finishers = []
  }

  func heardTheEnd() {
    let last = finishers.last
    finishers = []
    last?()
  }
}

/// A switch the test turns, read from whichever task.
final class SpeechSwitch: @unchecked Sendable {
  private let storage: Mutex<Bool>

  init(_ value: Bool) {
    storage = Mutex(value)
  }

  var value: Bool {
    get { storage.withLock { $0 } }
    set { storage.withLock { $0 = newValue } }
  }
}

/// Holds a fetch until the test lets it go.
final class FetchGate: @unchecked Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

  func wait() async {
    await withCheckedContinuation { continuation in
      let resume = state.withLock { state -> Bool in
        if state.open {
          return true
        }

        state.waiters.append(continuation)
        return false
      }

      if resume {
        continuation.resume()
      }
    }
  }

  func open() {
    let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }

    for waiter in waiters {
      waiter.resume()
    }
  }
}

private let rachel = GatewayVoice(id: "voice-rachel", name: "Rachel", label: "Rachel (premade)", hasSample: true)
private let silent = GatewayVoice(id: "voice-silent", name: "Silent", label: "Silent (premade)", hasSample: false)
private let adam = GatewayVoice(id: "voice-adam", name: "Adam", label: "Adam (premade)", hasSample: true)
private let colette = GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")

private func sampleClip() -> GatewayAudioClip {
  GatewayAudioClip(data: Data([0x49, 0x44, 0x33]), mimeType: "audio/mpeg")
}

/// What may be heard before it is chosen, and how a sample is fetched and played: one at a time, kept for
/// the screen, never during a call, and a failure said for the voice it happened to.
@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewayVoicePreviewTests {
  private func make(
    preview: GatewayVoicePreview?, provider: String = "elevenlabs", callActive: @escaping @MainActor () -> Bool = { false },
    transport: FakeGatewayTransport = FakeGatewayTransport()
  ) async -> (previewer: GatewayVoicePreviewer, player: FakeClipPlayer, transport: FakeGatewayTransport) {
    transport.config = GatewayVoiceConfig(
      ttsAvailable: true, provider: provider, voiceSelection: true, voices: [colette], voicePreview: preview)
    transport.preview = { _ in sampleClip() }
    transport.speak = { _ in sampleClip() }
    let access = GatewaySpeechAccess(transport: transport, profile: "hermes", loadingRetryDelay: .milliseconds(1))
    await access.loadConfig()
    let player = FakeClipPlayer()
    let previewer = GatewayVoicePreviewer(access: access, player: player, sentence: "Hello, this is me.", callActive: callActive)
    return (previewer, player, transport)
  }

  // MARK: Where a button is offered

  @Test func aButtonIsOfferedOnlyWhereTheGatewaySaysAPreviewIsFree() async {
    let (sample, _, _) = await make(preview: .sample)
    let (speak, _, _) = await make(preview: .speak, provider: "edge")
    let (paid, _, _) = await make(preview: nil, provider: "openai")

    #expect(sample.offers(rachel), "a voice that has a sample")
    #expect(!sample.offers(silent), "a voice that has none")
    #expect(speak.offers(colette), "a provider that speaks for nothing: every voice")
    #expect(!paid.offers(rachel), "a paid provider: never")
    #expect(!paid.offers(colette))
  }

  @Test func tappingAVoiceWithNoButtonDoesNothing() async {
    let (previewer, player, transport) = await make(preview: .sample)

    previewer.toggle(silent)

    #expect(previewer.activeVoice == nil)
    #expect(previewer.failure == nil)
    #expect(transport.calls.isEmpty)
    #expect(player.played.isEmpty)
  }

  // MARK: Fetching and playing

  @Test func aSampleIsFetchedWithItsVoiceThenPlayedAndTheButtonGoesBackWhenItEnds() async {
    let (previewer, player, transport) = await make(preview: .sample)

    previewer.toggle(rachel)

    #expect(previewer.phase(of: rachel.id) == .loading, "while it is fetched")
    #expect(previewer.phase(of: adam.id) == .idle)

    await eventually { previewer.phase(of: rachel.id) == .playing }

    #expect(transport.previewCalls.map(\.voice) == ["voice-rachel"])
    #expect(transport.previewCalls.first?.profile == "hermes")
    #expect(transport.speakCalls.isEmpty)
    #expect(player.played == [sampleClip()])

    player.heardTheEnd()

    #expect(previewer.phase(of: rachel.id) == .idle)
    #expect(previewer.activeVoice == nil)
    #expect(previewer.failure(of: rachel.id) == nil)
  }

  @Test func aProviderThatSpeaksForNothingIsAskedToSaySomethingInTheVoice() async {
    let (previewer, player, transport) = await make(preview: .speak, provider: "edge")

    previewer.toggle(colette)
    await eventually { previewer.phase(of: colette.id) == .playing }

    #expect(transport.speakCalls.map(\.voice) == ["nl-NL-ColetteNeural"])
    #expect(transport.speakCalls.map(\.text) == ["Hello, this is me."])
    #expect(transport.previewCalls.isEmpty)
    #expect(player.played.count == 1)
  }

  @Test func onlyOneSampleAtATimeAndTappingThePlayingOneStopsIt() async {
    let (previewer, player, _) = await make(preview: .sample)

    previewer.toggle(rachel)
    await eventually { previewer.phase(of: rachel.id) == .playing }
    let stopsBefore = player.stops

    previewer.toggle(adam)

    #expect(player.stops > stopsBefore, "the first is silenced")
    #expect(previewer.phase(of: rachel.id) == .idle)
    #expect(previewer.phase(of: adam.id) == .loading)

    await eventually { previewer.phase(of: adam.id) == .playing }
    previewer.toggle(adam)

    #expect(previewer.phase(of: adam.id) == .idle)
    #expect(previewer.activeVoice == nil)
  }

  @Test func tappingAVoiceThatIsStillLoadingCancelsIt() async {
    let transport = FakeGatewayTransport()
    let gate = FetchGate()
    let (previewer, player, _) = await make(preview: .sample, transport: transport)
    transport.preview = { _ in
      await gate.wait()
      return sampleClip()
    }

    previewer.toggle(rachel)
    await eventually { transport.previewCalls.count == 1 }
    previewer.toggle(rachel)

    #expect(previewer.phase(of: rachel.id) == .idle)

    gate.open()
    try? await Task.sleep(for: .milliseconds(50))

    #expect(player.played.isEmpty, "a sample that arrives after it was cancelled is not played")
    #expect(previewer.phase(of: rachel.id) == .idle)
  }

  @Test func leavingTheScreenStopsWhatPlays() async {
    let (previewer, player, _) = await make(preview: .sample)

    previewer.toggle(rachel)
    await eventually { previewer.phase(of: rachel.id) == .playing }
    let stopsBefore = player.stops

    previewer.stop()

    #expect(player.stops > stopsBefore)
    #expect(previewer.activeVoice == nil)
    #expect(previewer.phase(of: rachel.id) == .idle)
  }

  @Test func aFetchedSampleIsKeptForTheScreensLifetime() async {
    let (previewer, player, transport) = await make(preview: .sample)

    previewer.toggle(rachel)
    await eventually { previewer.phase(of: rachel.id) == .playing }
    player.heardTheEnd()
    previewer.toggle(rachel)
    await eventually { player.played.count == 2 }

    #expect(transport.previewCalls.count == 1, "heard twice, asked once")
  }

  // MARK: When it goes wrong

  @Test func aVoiceTheGatewayHasNoSampleOfSaysSoUnderItAndNeverPlays() async {
    let (previewer, player, transport) = await make(preview: .sample)
    transport.preview = { _ in throw GatewayPreviewError.noSample }

    previewer.toggle(rachel)
    await eventually { previewer.failure(of: rachel.id) != nil }

    #expect(previewer.failure(of: rachel.id) == .noSample)
    #expect(previewer.failure(of: adam.id) == nil, "it is about that voice only")
    #expect(previewer.phase(of: rachel.id) == .idle)
    #expect(player.played.isEmpty)
  }

  @Test func aGatewayThatCannotBeReachedSaysSoAndIsAskedAgainOnTheNextTap() async {
    let (previewer, player, transport) = await make(preview: .sample)
    let working = SpeechSwitch(false)
    transport.preview = { _ in
      if working.value {
        return sampleClip()
      }

      throw FakeGatewayTransport.GatewayFakeError.refused
    }

    previewer.toggle(rachel)
    await eventually { previewer.failure(of: rachel.id) == .unreachable }

    working.value = true
    previewer.toggle(rachel)

    #expect(previewer.failure(of: rachel.id) == nil, "the message goes with the next try")

    await eventually { previewer.phase(of: rachel.id) == .playing }

    #expect(transport.previewCalls.count == 2, "a failure is not kept")
    #expect(player.played.count == 1)
  }

  @Test func audioThatCannotBePlayedSaysSo() async {
    let (previewer, player, _) = await make(preview: .sample)
    player.failure = GatewayClipError.unreadable

    previewer.toggle(rachel)
    await eventually { previewer.failure(of: rachel.id) == .unplayable }

    #expect(previewer.phase(of: rachel.id) == .idle)
  }

  @Test func nothingPlaysWhileACallHasTheAudio() async {
    let onCall = SpeechSwitch(true)
    let (previewer, player, transport) = await make(preview: .sample, callActive: { onCall.value })

    previewer.toggle(rachel)

    #expect(previewer.failure(of: rachel.id) == .callActive)
    #expect(previewer.phase(of: rachel.id) == .idle)
    #expect(transport.calls.isEmpty, "not even fetched")
    #expect(player.played.isEmpty)

    onCall.value = false
    previewer.toggle(rachel)
    await eventually { previewer.phase(of: rachel.id) == .playing }

    #expect(previewer.failure(of: rachel.id) == nil)
  }

  @Test func aCallThatBeginsWhileTheSampleComesInKeepsItFromPlaying() async {
    let onCall = SpeechSwitch(false)
    let transport = FakeGatewayTransport()
    let gate = FetchGate()
    let (previewer, player, _) = await make(preview: .sample, callActive: { onCall.value }, transport: transport)
    transport.preview = { _ in
      await gate.wait()
      return sampleClip()
    }

    previewer.toggle(rachel)
    await eventually { transport.previewCalls.count == 1 }
    onCall.value = true
    gate.open()
    await eventually { previewer.failure(of: rachel.id) == .callActive }

    #expect(player.played.isEmpty)
  }

  // MARK: What the gateway's answer does to the screen

  @Test func aVoiceListTheGatewayCouldNotReadIsEmptyAndAskedForAgainOnRetry() async {
    let transport = FakeGatewayTransport()
    transport.config = GatewayVoiceConfig(
      ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [], voicesError: .unavailable)
    let access = GatewaySpeechAccess(transport: transport, profile: nil, loadingRetryDelay: .milliseconds(1))
    await access.loadConfig()
    await access.loadVoices()

    #expect(access.voicesError == .unavailable)
    #expect(access.selectableVoices.isEmpty)
    #expect(transport.configReads == 1, "`unavailable` is not asked again by itself")

    transport.config = GatewayVoiceConfig(ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [colette])
    await access.retryVoices()

    #expect(access.voicesError == nil)
    #expect(access.selectableVoices == [colette])
    #expect(transport.configReads == 2)
  }

  @Test func aGatewayStillLoadingItsVoicesIsAskedAgainUpToThreeTimesThenLeftToARetry() async {
    let transport = FakeGatewayTransport()
    transport.config = GatewayVoiceConfig(
      ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [], voicesError: .loading)
    let access = GatewaySpeechAccess(transport: transport, profile: nil, loadingRetryDelay: .milliseconds(1))
    await access.loadConfig()
    await access.loadVoices()

    #expect(transport.configReads == 1 + GatewaySpeechAccess.loadingRetries, "once, then three more")
    #expect(access.voicesError == .loading, "still loading: the screen offers a retry instead")
    #expect(!access.loadingVoices)
  }

  @Test func aGatewayThatFinishesLoadingWhileAskedAgainShowsItsVoices() async {
    let transport = FakeGatewayTransport()
    let loading = GatewayVoiceConfig(
      ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [], voicesError: .loading)
    let ready = GatewayVoiceConfig(ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [colette])
    transport.configAfter = { reads in reads < 2 ? loading : ready }
    let access = GatewaySpeechAccess(transport: transport, profile: nil, loadingRetryDelay: .milliseconds(1))
    await access.loadConfig()
    await access.loadVoices()

    #expect(transport.configReads == 3, "loading, loading, then the list: no more asking")
    #expect(access.voicesError == nil)
    #expect(access.selectableVoices == [colette])
  }

  @Test func theListIsShownAsLoadingWhileAGatewayThatIsLoadingIsAskedAgain() async {
    let transport = FakeGatewayTransport()
    transport.config = GatewayVoiceConfig(
      ttsAvailable: true, provider: "edge", voiceSelection: true, voices: [], voicesError: .loading)
    let access = GatewaySpeechAccess(transport: transport, profile: nil, loadingRetryDelay: .seconds(30))
    await access.loadConfig()

    let waiting = Task { await access.loadVoices() }
    await eventually { access.loadingVoices }

    #expect(access.loadingVoices)

    waiting.cancel()
    await waiting.value

    #expect(!access.loadingVoices, "leaving the screen ends the waiting")
  }
}

/// The player of a sample, on an output that makes no sound.
@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewayClipPlayerTests {
  private func make(opens: Bool = true) -> (player: GatewayClipPlayer, output: FakeOutput) {
    let output = FakeOutput()
    output.opens = opens
    return (GatewayClipPlayer(output: { output }), output)
  }

  @Test func aClipIsDecodedPlayedAndReportedWhenItsEndHasBeenHeard() async throws {
    let (player, output) = make()
    let finished = Told()

    try await player.play(AudioFixtures.clip(frames: 1_600)) { finished.count += 1 }

    #expect(output.openCount == 1)
    #expect(output.fake.played.reduce(0, +) == 1_600, "every frame was handed to the player")
    #expect(output.fake.ended == 1)
    #expect(finished.count == 0, "not before the end is heard")

    output.fake.heardTheEnd()
    await eventually { finished.count == 1 }

    #expect(output.closeCount == 1, "the engine is let go when it is over")
  }

  @Test func aClipThatIsStoppedIsNotReportedAsFinished() async throws {
    let (player, output) = make()
    let finished = Told()

    try await player.play(AudioFixtures.clip()) { finished.count += 1 }
    player.stop()
    output.fake.heardTheEnd()
    try? await Task.sleep(for: .milliseconds(30))

    #expect(finished.count == 0)
    #expect(output.closeCount == 1)
  }

  @Test func stoppingWithNothingPlayingDoesNotWakeTheEngine() {
    let made = Told()
    let player = GatewayClipPlayer(output: {
      made.count += 1
      return FakeOutput()
    })

    player.stop()

    #expect(made.count == 0)
  }

  @Test func bytesThatAreNotAudioAreUnreadable() async {
    let (player, output) = make()

    await #expect(throws: GatewayClipError.unreadable) {
      try await player.play(GatewayAudioClip(data: Data("not audio".utf8), mimeType: "audio/mpeg")) {}
    }

    #expect(output.openCount == 0)
  }

  @Test func anOutputThatCannotStartIsReported() async {
    let (player, _) = make(opens: false)

    await #expect(throws: GatewayClipError.noOutput) {
      try await player.play(AudioFixtures.clip()) {}
    }
  }
}
