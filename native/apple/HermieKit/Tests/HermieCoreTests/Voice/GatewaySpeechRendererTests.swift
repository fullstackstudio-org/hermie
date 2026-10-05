import AVFoundation
import Foundation
import Synchronization
import Testing

@testable import HermieCore

/// The gateway's voice as a source of a call's audio, over a transport that never opens a socket and a
/// device renderer that never makes a sound.
@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewaySpeechRendererTests {
  private let sentence = ReadRequest(id: "a#0", text: "Hello there.", language: "en", source: .gateway)

  private func make(
    _ transport: FakeGatewayTransport = FakeGatewayTransport(), firstAudio: Duration = .seconds(5),
    cooldown: Double = 30, clock: SpeechTestClock = SpeechTestClock(), available: @escaping @MainActor () -> Bool = { true },
    provider: String? = nil, support: GatewayStreamSupport = GatewayStreamSupport()
  ) -> (renderer: GatewaySpeechRenderer, fallback: FakeFallbackRenderer, transport: FakeGatewayTransport) {
    let fallback = FakeFallbackRenderer()
    let renderer = GatewaySpeechRenderer(
      transport: transport, profile: "researcher", fallback: fallback,
      timing: .init(firstAudio: firstAudio, cooldown: cooldown, streamBackoff: 60), clock: clock.read,
      available: available, provider: { provider }, support: support)
    return (renderer, fallback, transport)
  }

  // MARK: The streamed route

  @Test func streamedAudioIsDeliveredInOrderAsItArrivesAndThenEnds() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([240, 480, 120]) }
    let (renderer, fallback, _) = make(transport)
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: "apple.voice", deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(delivered.all == [.buffer(frames: 240, rate: 24_000), .buffer(frames: 480, rate: 24_000), .buffer(frames: 120, rate: 24_000), .end])
    #expect(transport.streamCalls == [.init(kind: .stream, text: "Hello there.", profile: "researcher", voice: nil)])
    #expect(transport.speakCalls.isEmpty, "the file route is for when there is no stream")
    #expect(fallback.renders.isEmpty)
  }

  @Test func aFrameThatEndsBetweenTwoBytesOfASampleIsNotLost() async {
    let transport = FakeGatewayTransport()
    let bytes = AudioFixtures.pcm(frames: 4)
    transport.stream = { _ in
      .events([
        .start(sampleRate: 24_000, channels: 1), .pcm(bytes.prefix(3)), .pcm(bytes.dropFirst(3)), .end,
      ])
    }
    let (renderer, _, _) = make(transport)
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(delivered.buffers.reduce(0, +) == 4, "all four samples came out, whole")
  }

  @Test func theChosenGatewayVoiceIsSentWithTheRequest() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([100]) }
    let (renderer, _, _) = make(transport)
    let delivered = Delivered()
    var request = sentence
    request.gatewayVoice = "voice-adam"

    renderer.render(request, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.first?.voice == "voice-adam")
  }

  @Test func aProviderWithNoStreamIsSpokenFromTheFileRouteAndTheStreamIsNotTriedAgain() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .events([.fallback]) }
    transport.speak = { _ in AudioFixtures.clip(frames: 1_600) }
    let (renderer, fallback, _) = make(transport)
    let first = Delivered()
    let second = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }

    var next = sentence
    next.text = "Another one."
    renderer.render(next, rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(first.buffers.reduce(0, +) == 1_600)
    #expect(second.buffers.reduce(0, +) == 1_600)
    #expect(transport.streamCalls.count == 1, "the gateway said it has no stream: once is enough")
    #expect(transport.speakCalls.map(\.text) == ["Hello there.", "Another one."])
    #expect(fallback.renders.isEmpty)
  }

  @Test func aStreamThatDoesNotOpenIsSpokenFromTheFileRouteAndNotRetriedForAWhile() async {
    let transport = FakeGatewayTransport()
    let clock = SpeechTestClock()
    transport.stream = { _ in .fail }
    transport.speak = { _ in AudioFixtures.clip() }
    let (renderer, _, _) = make(transport, clock: clock)
    let first = Delivered()
    let second = Delivered()
    let third = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }
    renderer.render(sentence, rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(transport.streamCalls.count == 1, "a failed stream is left alone for the backoff")

    clock.advance(61)
    renderer.render(sentence, rate: 1, voice: nil, deliver: third.deliver)
    await eventually { third.ended }

    #expect(transport.streamCalls.count == 2, "and tried again once it has passed")
  }

  @Test func aStreamThatBreaksPartWayEndsWhatWasHeardInsteadOfSpeakingItAgain() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .eventsThenFail([.start(sampleRate: 24_000, channels: 1), .pcm(AudioFixtures.pcm(frames: 300))]) }
    let (renderer, fallback, _) = make(transport)
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(delivered.buffers == [300])
    #expect(fallback.renders.isEmpty, "half a sentence is not said twice")
    #expect(transport.speakCalls.isEmpty)
  }

  // MARK: The stream's error frame

  private func voiced(_ voice: String?, _ text: String = "Hello there.", provider: String? = nil) -> ReadRequest {
    var request = ReadRequest(id: "a#0", text: text, language: "en", source: .gateway)
    request.gatewayVoice = voice
    request.gatewayProvider = provider
    return request
  }

  @Test func anErrorFrameIsSpokenFromTheFileRouteInTheSameVoice() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .events([.error(code: "invalid_prosody", message: "bad pace")]) }
    transport.speak = { _ in AudioFixtures.clip(frames: 1_600) }
    let (renderer, fallback, _) = make(transport)
    let delivered = Delivered()

    renderer.render(voiced("voice-adam"), rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(delivered.buffers.reduce(0, +) == 1_600)
    #expect(transport.speakCalls.map(\.voice) == ["voice-adam"])
    #expect(fallback.renders.isEmpty)
  }

  @Test func anErrorFrameThenAFileRouteThatFailsTooIsSpokenByTheDevice() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .events([.error(code: "voice_unsupported", message: "")]) }
    let (renderer, fallback, _) = make(transport)
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }
    let delivered = Delivered()

    renderer.render(voiced("voice-adam"), rate: 1, voice: "apple.voice", deliver: delivered.deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(transport.speakCalls.count == 1, "the file route was tried first")
    #expect(fallback.renders == [.init(request: voiced("voice-adam"), voice: "apple.voice")])
    #expect(told.count == 1)
  }

  @Test(arguments: ["unknown_voice", "invalid_voice", "voice_failed"])
  func aVoiceTheStreamRefusesIsSpokenByTheGatewayWithoutAVoiceAndNotAskedForAgain(_ code: String) async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.voice == "ghost" ? .events([.error(code: code, message: "")]) : .pcm([100]) }
    transport.speak = { _ in AudioFixtures.clip() }
    let (renderer, fallback, _) = make(transport)
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }
    let first = Delivered()

    renderer.render(voiced("ghost"), rate: 1, voice: "apple.voice", deliver: first.deliver)
    await eventually { first.ended }

    #expect(first.buffers == [100], "the same sentence, from the gateway")
    #expect(transport.streamCalls.map(\.voice) == ["ghost", nil], "the voice was refused; the profile's own is asked for")
    #expect(transport.speakCalls.isEmpty)
    #expect(fallback.renders.isEmpty, "not the device")
    #expect(told.count == 0, "the call is not told of a switch to the gateway's other voice")

    let second = Delivered()
    renderer.render(voiced("ghost", "Again."), rate: 1, voice: "apple.voice", deliver: second.deliver)
    renderer.prefetch(voiced("ghost", "Later."), rate: 1, voice: nil)
    await eventually { second.ended }
    await eventually { transport.streamCalls.count == 4 }

    #expect(
      transport.streamCalls.map(\.voice) == ["ghost", nil, nil, nil],
      "the refused voice is not asked for again, not even by a prefetch: straight to no voice")
    #expect(fallback.renders.isEmpty)

    let other = Delivered()
    renderer.render(voiced("voice-adam", "Third."), rate: 1, voice: nil, deliver: other.deliver)
    await eventually { other.ended }

    #expect(transport.streamCalls.last?.voice == "voice-adam", "another voice is as good as ever")
  }

  @Test(arguments: ["unknown_voice", "invalid_voice", "voice_unsupported", "voice_failed"])
  func aVoiceTheFileRouteRefusesIsSpokenByTheGatewayWithoutAVoice(_ code: String) async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .fail }
    transport.speak = { call in
      if call.voice != nil {
        throw GatewaySpeechError.voiceRefused(code: code)
      }

      return AudioFixtures.clip(frames: 1_600)
    }
    let (renderer, fallback, _) = make(transport)
    let first = Delivered()
    let second = Delivered()

    renderer.render(voiced("ghost"), rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }
    renderer.render(voiced("ghost", "Again."), rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(first.buffers.reduce(0, +) == 1_600)
    #expect(second.buffers.reduce(0, +) == 1_600)
    #expect(transport.speakCalls.map(\.voice) == ["ghost", nil, nil], "asked once with the voice, then never again")
    #expect(fallback.renders.isEmpty)
  }

  @Test func aVoiceThatIsRefusedAndNoVoiceThatFailsTooIsSpokenByTheDevice() async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.voice == "ghost" ? .events([.error(code: "unknown_voice", message: "")]) : .fail }
    let (renderer, fallback, _) = make(transport)
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }

    renderer.render(voiced("ghost"), rate: 1, voice: "apple.voice", deliver: Delivered().deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(transport.streamCalls.map(\.voice) == ["ghost", nil])
    #expect(transport.speakCalls.map(\.voice) == [nil], "the file route without a voice was the last try")
    #expect(fallback.renders == [.init(request: voiced("ghost"), voice: "apple.voice")])
    #expect(told.count == 1, "this one the call is told of")
  }

  @Test func aVoiceTheFileRouteRefusesWhenNoVoiceIsSentIsNotRetriedAndTheDeviceSpeaks() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .fail }
    transport.speak = { _ in throw GatewaySpeechError.voiceRefused(code: "unknown_voice") }
    let (renderer, fallback, _) = make(transport)

    renderer.render(sentence, rate: 1, voice: nil, deliver: Delivered().deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(transport.speakCalls.count == 1, "no voice was named: there is nothing to give up and ask again without")
  }

  @Test func aRefusalIsKeptForTheSessionOfTheProfileAndNotJustOneRenderer() async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.voice == "ghost" ? .events([.error(code: "unknown_voice", message: "")]) : .pcm([100]) }
    let support = GatewayStreamSupport()
    let (first, _, _) = make(transport, support: support)
    let (second, _, _) = make(transport, support: support)
    let one = Delivered()
    let two = Delivered()

    first.render(voiced("ghost"), rate: 1, voice: nil, deliver: one.deliver)
    await eventually { one.ended }
    second.render(voiced("ghost", "Again."), rate: 1, voice: nil, deliver: two.deliver)
    await eventually { two.ended }

    #expect(transport.streamCalls.map(\.voice) == ["ghost", nil, nil], "the other renderer never asked for it")
  }

  // MARK: The voice and the profile's provider

  @Test func aVoiceChosenFromAnotherProviderIsNotSentAndTheProfilesOwnVoiceSpeaks() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([100]) }
    let (renderer, fallback, _) = make(transport, provider: "elevenlabs")
    let delivered = Delivered()

    renderer.render(voiced("nl-NL-FennaNeural", provider: "edge"), rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.map(\.voice) == [nil], "an Edge voice is not asked of an ElevenLabs profile")
    #expect(transport.streamCalls.count == 1, "and nothing was refused: it was never sent")
    #expect(fallback.renders.isEmpty)
  }

  @Test func aPrefetchOfAVoiceFromAnotherProviderIsTheOneThatIsPlayed() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([100]) }
    let (renderer, _, _) = make(transport, provider: "elevenlabs")
    let delivered = Delivered()
    let request = voiced("nl-NL-FennaNeural", provider: "edge")

    renderer.prefetch(request, rate: 1, voice: nil)
    await eventually { transport.streamCalls.count == 1 }
    renderer.render(request, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.map(\.voice) == [nil], "the fetch made ahead was in the same voice, so it was used")
  }

  @Test func aVoiceChosenFromTheProvidersOwnIsSent() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([100]) }
    let (renderer, _, _) = make(transport, provider: "ElevenLabs")
    let delivered = Delivered()

    renderer.render(voiced("voice-rachel", provider: "elevenlabs"), rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.map(\.voice) == ["voice-rachel"], "the same provider, however it is spelled")
  }

  @Test func aVoiceKeptWithoutItsProviderIsSentOnceAndGivenUpOnWhenRefused() async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.voice == nil ? .pcm([100]) : .events([.error(code: "unknown_voice", message: "")]) }
    let (renderer, fallback, _) = make(transport, provider: "elevenlabs")
    let first = Delivered()
    let second = Delivered()

    renderer.render(voiced("nl-NL-FennaNeural"), rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }
    renderer.render(voiced("nl-NL-FennaNeural", "Again."), rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(transport.streamCalls.map(\.voice) == ["nl-NL-FennaNeural", nil, nil], "sent once, refused, then not again")
    #expect(first.buffers == [100] && second.buffers == [100])
    #expect(fallback.renders.isEmpty)
  }

  @Test func aVoiceIsSentWhileTheProfilesProviderIsNotKnownYet() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([100]) }
    let (renderer, _, _) = make(transport, provider: nil)
    let delivered = Delivered()

    renderer.render(voiced("nl-NL-FennaNeural", provider: "edge"), rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.map(\.voice) == ["nl-NL-FennaNeural"])
  }

  @Test func aVoiceThatCannotBeStreamedIsSpokenFromTheFileRouteWithoutTryingTheStreamAgain() async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.voice == "plain" ? .events([.error(code: "voice_unsupported", message: "")]) : .pcm([100]) }
    transport.speak = { _ in AudioFixtures.clip() }
    let (renderer, _, _) = make(transport)
    let first = Delivered()
    let second = Delivered()
    let other = Delivered()

    renderer.render(voiced("plain"), rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }
    renderer.render(voiced("plain", "Again."), rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(transport.streamCalls.filter { $0.voice == "plain" }.count == 1, "streamed once, refused once")
    #expect(transport.speakCalls.map(\.text) == ["Hello there.", "Again."])

    renderer.render(voiced("voice-adam", "Third."), rate: 1, voice: nil, deliver: other.deliver)
    await eventually { other.ended }

    #expect(transport.streamCalls.last?.voice == "voice-adam", "the stream is still good for another voice")
  }

  @Test func anErrorFrameThatIsNotAboutTheVoiceLeavesTheNextSentenceToTheStream() async {
    let transport = FakeGatewayTransport()
    let refuse = SpeechSwitch(true)
    transport.stream = { _ in refuse.value ? .events([.error(code: "invalid_prosody", message: "")]) : .pcm([100]) }
    transport.speak = { _ in AudioFixtures.clip() }
    let (renderer, _, _) = make(transport)
    let first = Delivered()
    let second = Delivered()

    renderer.render(voiced("voice-adam"), rate: 1, voice: nil, deliver: first.deliver)
    await eventually { first.ended }
    refuse.value = false
    renderer.render(voiced("voice-adam", "Again."), rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(transport.streamCalls.count == 2)
    #expect(second.buffers == [100])
  }

  // MARK: Falling back to the device's voice

  @Test func aSentenceTheGatewayCannotSpeakIsSpokenByTheDeviceWithItsVoiceAndTheCallIsToldOnce() async {
    let transport = FakeGatewayTransport()
    let clock = SpeechTestClock()
    let (renderer, fallback, _) = make(transport, cooldown: 30, clock: clock)
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }
    let first = Delivered()
    let second = Delivered()

    renderer.render(sentence, rate: 1.25, voice: "apple.voice", deliver: first.deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(fallback.renders == [.init(request: sentence, voice: "apple.voice")])
    #expect(told.count == 1)

    // The next one, once the cooldown has passed, fails the same way: spoken by the device, not announced again.
    clock.advance(31)
    var next = sentence
    next.text = "Second."
    renderer.render(next, rate: 1, voice: "apple.voice", deliver: second.deliver)
    await eventually { fallback.renders.count == 2 }

    #expect(told.count == 1, "once per call")
  }

  @Test func afterAFallBackTheNextSentencesGoStraightToTheDeviceWithoutWaitingOnTheGateway() async {
    let transport = FakeGatewayTransport()
    let clock = SpeechTestClock()
    let (renderer, fallback, _) = make(transport, cooldown: 30, clock: clock)
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { fallback.renders.count == 1 }
    let asked = transport.calls.count

    for index in 0..<3 {
      var next = sentence
      next.text = "Sentence \(index)."
      renderer.render(next, rate: 1, voice: nil, deliver: delivered.deliver)
    }

    #expect(fallback.renders.count == 4, "each went to the device at once")
    #expect(transport.calls.count == asked, "and the gateway was not asked")

    clock.advance(61)
    transport.stream = { _ in .pcm([100]) }
    let after = Delivered()
    renderer.render(sentence, rate: 1, voice: nil, deliver: after.deliver)
    await eventually { after.ended }

    #expect(after.buffers == [100], "the gateway is tried again after the cooldown")
  }

  @Test func firstAudioThatIsTooSlowIsSpokenByTheDeviceAndTheGatewaysRequestIsDropped() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .hang }
    let (renderer, fallback, _) = make(transport, firstAudio: .milliseconds(80))
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: "apple.voice", deliver: delivered.deliver)
    await eventually { !fallback.renders.isEmpty }
    await eventually { transport.cancelled == 1 }

    #expect(fallback.renders == [.init(request: sentence, voice: "apple.voice")])
    #expect(told.count == 1)
    #expect(delivered.all.isEmpty, "nothing came from the gateway")
  }

  @Test func aStreamThatDeliversInTimeIsNotInterruptedByTheTimeout() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([200]) }
    let (renderer, fallback, _) = make(transport, firstAudio: .milliseconds(80))
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }
    try? await Task.sleep(for: .milliseconds(150))

    #expect(delivered.buffers == [200])
    #expect(fallback.renders.isEmpty)
  }

  @Test func theFileRoutesFailureIsAFallBackToo() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .fail }
    transport.speak = { _ in throw FakeGatewayTransport.GatewayFakeError.refused }
    let (renderer, fallback, _) = make(transport)

    renderer.render(sentence, rate: 1, voice: nil, deliver: Delivered().deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(fallback.renders.count == 1)
  }

  @Test func audioTheSystemCannotReadIsAFallBack() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .fail }
    transport.speak = { _ in GatewayAudioClip(data: Data("not audio at all".utf8), mimeType: "audio/ogg") }
    let (renderer, fallback, _) = make(transport)

    renderer.render(sentence, rate: 1, voice: nil, deliver: Delivered().deliver)
    await eventually { !fallback.renders.isEmpty }

    #expect(fallback.renders.count == 1)
  }

  // MARK: Which source

  @Test func aRequestForTheDeviceNeverTouchesTheGateway() {
    let (renderer, fallback, transport) = make()
    var request = sentence
    request.source = .apple

    renderer.render(request, rate: 1, voice: "apple.voice", deliver: Delivered().deliver)

    #expect(fallback.renders == [.init(request: request, voice: "apple.voice")])
    #expect(transport.calls.isEmpty)
  }

  @Test func aGatewayWithNoTextToSpeechIsLeftAloneAndNothingIsSaidAboutIt() {
    let (renderer, fallback, transport) = make(available: { false })
    let told = Told()
    renderer.setFallbackHandler { told.count += 1 }

    renderer.render(sentence, rate: 1, voice: nil, deliver: Delivered().deliver)

    #expect(fallback.renders.count == 1)
    #expect(transport.calls.isEmpty)
    #expect(told.count == 0)
  }

  // MARK: Ending and cutting in

  @Test func cuttingInStopsTheStreamAndDropsWhatIsStillComing() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .hang }
    let (renderer, fallback, _) = make(transport)
    let delivered = Delivered()

    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { transport.streamCalls.count == 1 }
    renderer.cancel()
    await eventually { transport.cancelled == 1 }

    #expect(fallback.cancels == 1, "the device's renderer is silenced as well")
    #expect(fallback.renders.isEmpty, "and a cut-in is not a failure of the gateway")
    #expect(delivered.all.isEmpty)
  }

  @Test func aNewSentenceReplacesTheOneBeforeIt() async {
    let transport = FakeGatewayTransport()
    transport.stream = { call in call.text == "first" ? FakeGatewayTransport.Stream.hang : .pcm([50]) }
    let (renderer, _, _) = make(transport)
    let first = Delivered()
    let second = Delivered()
    var one = sentence
    one.text = "first"
    var two = sentence
    two.text = "second"

    renderer.render(one, rate: 1, voice: nil, deliver: first.deliver)
    renderer.render(two, rate: 1, voice: nil, deliver: second.deliver)
    await eventually { second.ended }

    #expect(first.all.isEmpty)
    #expect(second.buffers == [50])
    #expect(transport.cancelledTexts.contains("first"), "the first one's request was let go of")
  }

  // MARK: Prefetching

  @Test func theNextSentenceIsRequestedBeforeItIsWantedAndUsedWithoutAskingAgain() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([160, 160]) }
    let (renderer, _, _) = make(transport)
    let delivered = Delivered()

    renderer.prefetch(sentence, rate: 1, voice: nil)
    await eventually { transport.streamCalls.count == 1 }
    renderer.render(sentence, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.count == 1, "asked once, ahead of time")
    #expect(delivered.buffers == [160, 160])
  }

  @Test func prefetchingTheSameSentenceTwiceAsksOnce() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .hang }
    let (renderer, _, _) = make(transport)

    renderer.prefetch(sentence, rate: 1, voice: nil)
    renderer.prefetch(sentence, rate: 1, voice: nil)
    await eventually { transport.streamCalls.count == 1 }
    try? await Task.sleep(for: .milliseconds(30))

    #expect(transport.streamCalls.count == 1)
  }

  @Test func onlyAFewSentencesAreFetchedAhead() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .hang }
    let (renderer, _, _) = make(transport)

    for index in 0..<4 {
      var request = sentence
      request.text = "Sentence \(index)."
      renderer.prefetch(request, rate: 1, voice: nil)
    }

    // Each fetch starts its request on a task of its own, so neither the four requests nor the two
    // let-goes have necessarily happened when `prefetch` returns, and not in any order: wait for both.
    await eventually { transport.streamCalls.count == 4 && transport.cancelled == 2 }

    #expect(transport.streamCalls.count == 4)
    #expect(transport.cancelled == 2, "the oldest two were let go of")
    #expect(Set(transport.cancelledTexts) == ["Sentence 0.", "Sentence 1."], "and they were the oldest")
  }

  @Test func discardingWhatWasFetchedAheadLetsGoOfIt() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .hang }
    let (renderer, _, _) = make(transport)

    renderer.prefetch(sentence, rate: 1, voice: nil)
    await eventually { transport.streamCalls.count == 1 }
    renderer.discardPrefetched()
    await eventually { transport.cancelled == 1 }

    #expect(transport.cancelled == 1)
  }

  @Test func aSentenceForTheDeviceIsNotPrefetched() {
    let (renderer, _, transport) = make()
    var request = sentence
    request.source = .apple

    renderer.prefetch(request, rate: 1, voice: nil)

    #expect(transport.calls.isEmpty)
  }

  @Test func aPrefetchedSentenceWithADifferentVoiceIsNotUsed() async {
    let transport = FakeGatewayTransport()
    transport.stream = { _ in .pcm([10]) }
    let (renderer, _, _) = make(transport)
    let delivered = Delivered()
    var asked = sentence
    asked.gatewayVoice = "voice-a"
    var wanted = sentence
    wanted.gatewayVoice = "voice-b"

    renderer.prefetch(asked, rate: 1, voice: nil)
    // The prefetch has asked before the sentence is rendered: two requests started together are recorded in
    // whichever order their tasks get to the transport.
    await eventually { transport.streamCalls.count == 1 }
    renderer.render(wanted, rate: 1, voice: nil, deliver: delivered.deliver)
    await eventually { delivered.ended }

    #expect(transport.streamCalls.map(\.voice) == ["voice-a", "voice-b"])
  }
}
