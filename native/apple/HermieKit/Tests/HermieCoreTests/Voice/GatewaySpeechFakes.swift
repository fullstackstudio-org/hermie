import AVFoundation
import Foundation
import Synchronization
import Testing

@testable import HermieCore

/// A gateway's speech routes that never touch a network: the test says what each one does.
final class FakeGatewayTransport: GatewaySpeechTransport, @unchecked Sendable {
  struct Call: Equatable, Sendable {
    enum Kind: Sendable { case stream, speak, preview }
    var kind: Kind
    var text: String
    var profile: String?
    var voice: String?
  }

  /// What the streamed route does for one call.
  enum Stream: Sendable {
    /// These events, then a clean finish.
    case events([GatewayStreamEvent])
    /// These events, then the socket breaks.
    case eventsThenFail([GatewayStreamEvent])
    /// Throws at once: the socket never opened.
    case fail
    /// Says nothing and does not end, until the consumer goes away.
    case hang

    /// A start, one frame of PCM per entry (that many samples), and an end.
    static func pcm(_ frames: [Int], rate: Double = 24_000) -> Stream {
      .events([.start(sampleRate: rate, channels: 1)] + frames.map { .pcm(AudioFixtures.pcm(frames: $0)) } + [.end])
    }
  }

  private struct State {
    var calls: [Call] = []
    var cancelledTexts: [String] = []
    var configReads = 0
  }

  private let state = Mutex(State())
  /// Called for every streamed call.
  var stream: @Sendable (Call) -> Stream = { _ in .fail }
  /// Called for every file call.
  var speak: @Sendable (Call) async throws -> GatewayAudioClip = { _ in throw GatewayFakeError.refused }
  /// Called for every sample of a voice.
  var preview: @Sendable (Call) async throws -> GatewayAudioClip = { _ in throw GatewayFakeError.refused }
  var config = GatewayVoiceConfig(ttsAvailable: true, provider: "edge")
  var voices: [GatewayVoice] = []

  enum GatewayFakeError: Error { case refused }

  var calls: [Call] { state.withLock { $0.calls } }
  var streamCalls: [Call] { calls.filter { $0.kind == .stream } }
  var speakCalls: [Call] { calls.filter { $0.kind == .speak } }
  var previewCalls: [Call] { calls.filter { $0.kind == .preview } }
  /// Streams whose consumer went away before they ended (one that was let go of after its last event too).
  var cancelled: Int { state.withLock { $0.cancelledTexts.count } }
  /// The text of each of those.
  var cancelledTexts: [String] { state.withLock { $0.cancelledTexts } }

  /// How the config changes from one read to the next, by the number of reads before it (default: it does not).
  var configAfter: (@Sendable (Int) -> GatewayVoiceConfig)?
  var configReads: Int { state.withLock { $0.configReads } }

  func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig {
    let before = state.withLock { state -> Int in
      defer { state.configReads += 1 }
      return state.configReads
    }

    return configAfter?(before) ?? config
  }
  func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice] { voices }

  func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip {
    let call = Call(kind: .speak, text: text, profile: profile, voice: voice)
    state.withLock { $0.calls.append(call) }
    return try await speak(call)
  }

  func previewSample(voiceID: String, profile: String?) async throws -> GatewayAudioClip {
    let call = Call(kind: .preview, text: "", profile: profile, voice: voiceID)
    state.withLock { $0.calls.append(call) }
    return try await preview(call)
  }

  func stream(text: String, profile: String?, voice: String?) -> AsyncThrowingStream<GatewayStreamEvent, any Error> {
    let call = Call(kind: .stream, text: text, profile: profile, voice: voice)
    state.withLock { $0.calls.append(call) }
    let plan = stream(call)

    return AsyncThrowingStream { continuation in
      switch plan {
      case .events(let events):
        for event in events {
          continuation.yield(event)
        }

        continuation.finish()
      case .eventsThenFail(let events):
        for event in events {
          continuation.yield(event)
        }

        continuation.finish(throwing: GatewayFakeError.refused)
      case .fail:
        continuation.finish(throwing: GatewayFakeError.refused)
      case .hang:
        break
      }

      continuation.onTermination = { [weak self] termination in
        if case .cancelled = termination {
          self?.state.withLock { $0.cancelledTexts.append(call.text) }
        }
      }
    }
  }
}

/// The device's renderer, as a fall-back: it records what it was asked and delivers nothing until told.
@MainActor
final class FakeFallbackRenderer: VoiceSpeechRenderer {
  struct Render: Equatable {
    var request: ReadRequest
    var voice: String?
  }

  private(set) var renders: [Render] = []
  private(set) var cancels = 0
  private var deliveries: [@Sendable (AVAudioPCMBuffer?) -> Void] = []

  func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    renders.append(Render(request: request, voice: voice))
    deliveries.append(deliver)
  }

  func cancel() { cancels += 1 }
  func voices() -> [SpeechVoice] { [] }

  /// The device finishes the last sentence it was given.
  func finish() { deliveries.last?(nil) }
}

/// How many times something was announced.
@MainActor
final class Told {
  var count = 0
}

/// What a renderer delivered, in order, from whichever thread.
final class Delivered: @unchecked Sendable {
  enum Event: Equatable, Sendable {
    case buffer(frames: Int, rate: Double)
    case end
  }

  private let events = Mutex<[Event]>([])

  var all: [Event] { events.withLock { $0 } }
  var buffers: [Int] { all.compactMap { if case .buffer(let frames, _) = $0 { frames } else { nil } } }
  var ended: Bool { all.contains(.end) }

  var deliver: @Sendable (AVAudioPCMBuffer?) -> Void {
    { [self] buffer in
      events.withLock {
        if let buffer {
          $0.append(.buffer(frames: Int(buffer.frameLength), rate: buffer.format.sampleRate))
        } else {
          $0.append(.end)
        }
      }
    }
  }
}

/// A clock the test turns.
final class SpeechTestClock: @unchecked Sendable {
  private let time = Mutex<Double>(1_000)

  var now: Double { time.withLock { $0 } }
  func advance(_ seconds: Double) { time.withLock { $0 += seconds } }
  var read: @Sendable () -> Double { { [self] in time.withLock { $0 } } }
}

enum AudioFixtures {
  /// `frames` samples of raw int16 little-endian PCM.
  static func pcm(frames: Int) -> Data {
    var data = Data()

    for frame in 0..<frames {
      var sample = Int16(truncatingIfNeeded: frame * 100).littleEndian
      withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
    }

    return data
  }

  /// A 16-bit mono WAV file of `frames` samples.
  static func wav(frames: Int, rate: Int = 16_000) -> Data {
    let body = pcm(frames: frames)
    var data = Data()

    func u32(_ value: Int) { var v = UInt32(value).littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
    func u16(_ value: Int) { var v = UInt16(value).littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }

    data.append(contentsOf: Array("RIFF".utf8))
    u32(36 + body.count)
    data.append(contentsOf: Array("WAVEfmt ".utf8))
    u32(16)
    u16(1)
    u16(1)
    u32(rate)
    u32(rate * 2)
    u16(2)
    u16(16)
    data.append(contentsOf: Array("data".utf8))
    u32(body.count)
    data.append(body)
    return data
  }

  static func clip(frames: Int = 1_600) -> GatewayAudioClip {
    GatewayAudioClip(data: wav(frames: frames), mimeType: "audio/wav")
  }
}

/// Wait for something that happens on another task, without a fixed sleep.
@MainActor
func eventually(
  timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  let deadline = ContinuousClock.now.advanced(by: timeout)

  while !condition() {
    if ContinuousClock.now >= deadline {
      Issue.record("Timed out waiting for a condition.", sourceLocation: sourceLocation)
      return
    }

    try? await Task.sleep(for: .milliseconds(5))
  }
}
