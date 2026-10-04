import AVFoundation
import Foundation
import Synchronization
import Testing

@testable import HermieCore

/// A player that records instead of playing: no engine, no hardware, no sound.
final class FakePlaying: RenderedPlaying, @unchecked Sendable {
  private struct State {
    var begun: [Int] = []
    var played: [Int] = []
    var ended = 0
    var finishers: [@Sendable () -> Void] = []
  }

  private let state = Mutex(State())

  var begun: [Int] { state.withLock { $0.begun } }
  var played: [Int] { state.withLock { $0.played } }
  var ended: Int { state.withLock { $0.ended } }

  func begin(_ token: Int) {
    state.withLock { $0.begun.append(token) }
  }

  func play(_ buffer: AVAudioPCMBuffer?, token: Int, finished: @escaping @Sendable () -> Void) {
    state.withLock { state in
      guard token == state.begun.last else {
        return
      }

      if let buffer {
        state.played.append(Int(buffer.frameLength))
      } else {
        state.ended += 1
        state.finishers.append(finished)
      }
    }
  }

  /// The silence that marks the end has been heard.
  func heardTheEnd() {
    let finishers = state.withLock { state -> [@Sendable () -> Void] in
      defer { state.finishers = [] }
      return state.finishers
    }

    for finish in finishers {
      finish()
    }
  }
}

@MainActor
final class FakeOutput: RenderedOutput {
  let fake = FakePlaying()
  var opens = true
  private(set) var openCount = 0
  private(set) var closeCount = 0

  var playing: any RenderedPlaying { fake }

  func open() -> Bool {
    openCount += 1
    return opens
  }

  func close() { closeCount += 1 }
}

/// A renderer the test drives by hand.
@MainActor
final class ScriptedRenderer: VoiceSpeechRenderer {
  private(set) var rendered: [ReadRequest] = []
  private(set) var prefetched: [ReadRequest] = []
  private(set) var cancels = 0
  private(set) var discards = 0
  private var delivers: [@Sendable (AVAudioPCMBuffer?) -> Void] = []

  func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    rendered.append(request)
    delivers.append(deliver)
  }

  func cancel() { cancels += 1 }
  func prefetch(_ request: ReadRequest, rate: Double, voice: String?) { prefetched.append(request) }
  func discardPrefetched() { discards += 1 }
  func voices() -> [SpeechVoice] { [] }

  /// A buffer of `frames` samples, then the end.
  func speakAll(frames: Int = 100) {
    let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    delivers.last?(buffer)
    delivers.last?(nil)
  }
}

/// Reading a reply in the gateway's voice outside a call: what is the device's stays the device's, what is the
/// gateway's is rendered and played, and neither makes a sound here.
@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewaySpeechSynthesizerTests {
  private func make(opens: Bool = true) -> (
    synth: GatewaySpeechSynthesizer, apple: FakeSynthesiser, renderer: ScriptedRenderer, output: FakeOutput
  ) {
    let apple = FakeSynthesiser()
    let renderer = ScriptedRenderer()
    let output = FakeOutput()
    output.opens = opens
    return (GatewaySpeechSynthesizer(apple: apple, renderer: renderer, output: output), apple, renderer, output)
  }

  private func request(_ source: SpeechSource) -> ReadRequest {
    ReadRequest(id: "a1", text: "Hello there.", language: "en", source: source)
  }

  @Test func aRequestForTheDeviceIsTheDevicesAndNothingElseIsTouched() {
    let (synth, apple, renderer, output) = make()
    let done = Told()

    synth.speak(request(.apple), rate: 1.25, voice: "apple.voice") { done.count += 1 }
    apple.finishCurrent()

    #expect(apple.spoken.map(\.voice) == ["apple.voice"])
    #expect(apple.spoken.map(\.rate) == [1.25])
    #expect(done.count == 1)
    #expect(renderer.rendered.isEmpty)
    #expect(output.openCount == 0)
  }

  @Test func aRequestForTheGatewayIsRenderedAndPlayedAndThenDone() async {
    let (synth, apple, renderer, output) = make()
    let done = Told()

    synth.speak(request(.gateway), rate: 1, voice: "apple.voice") { done.count += 1 }

    #expect(output.openCount == 1)
    #expect(renderer.rendered.count == 1)
    #expect(apple.spoken.isEmpty)
    #expect(apple.stops == 1, "the device's own voice is silenced first")

    renderer.speakAll(frames: 120)

    #expect(output.fake.played == [120])
    #expect(output.fake.ended == 1)
    #expect(done.count == 0, "done when the end has been heard, not when it was handed over")

    output.fake.heardTheEnd()
    await eventually { done.count == 1 }

    #expect(done.count == 1)
    #expect(output.closeCount == 1, "the audio hardware is let go of")
  }

  @Test func stoppingBeforeTheEndIsNotACompletion() async {
    let (synth, _, renderer, output) = make()
    let done = Told()

    synth.speak(request(.gateway), rate: 1, voice: nil) { done.count += 1 }
    synth.stop()
    renderer.speakAll()
    output.fake.heardTheEnd()
    try? await Task.sleep(for: .milliseconds(30))

    #expect(done.count == 0)
    #expect(output.fake.played.isEmpty, "what the renderer still hands over is about nothing wanted")
    #expect(renderer.cancels >= 1)
    #expect(renderer.discards == 1, "a stop clears what was fetched ahead")
    #expect(output.closeCount == 1)
  }

  @Test func speakingTheNextOneDoesNotThrowAwayWhatWasFetchedForIt() {
    let (synth, _, renderer, _) = make()

    synth.speak(request(.gateway), rate: 1, voice: nil) {}
    synth.prefetch(request(.gateway), rate: 1, voice: nil)
    synth.speak(request(.gateway), rate: 1, voice: nil) {}

    #expect(renderer.prefetched.count == 1)
    #expect(renderer.discards == 0)
  }

  @Test func whereTheAudioCannotBeOpenedTheDeviceSpeaksIt() {
    let (synth, apple, renderer, _) = make(opens: false)
    let done = Told()

    synth.speak(request(.gateway), rate: 1, voice: "apple.voice") { done.count += 1 }
    apple.finishCurrent()

    #expect(apple.spoken.map(\.voice) == ["apple.voice"])
    #expect(renderer.rendered.isEmpty)
    #expect(done.count == 1)
  }

  @Test func theDevicesVoicesAndAvailabilityAreTheDevices() {
    let (synth, apple, _, _) = make()
    apple.installed = [SpeechVoice(id: "x", name: "X", language: "en-US")]

    #expect(synth.isAvailable)
    #expect(synth.voices().map(\.id) == ["x"])

    apple.isAvailable = false

    #expect(!synth.isAvailable)
  }
}
