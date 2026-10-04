import AVFoundation
import Foundation

/// What `GatewaySpeechSynthesizer` plays gateway audio through, apart from voice mode's call: something
/// that can be opened, and a player the rendering side feeds from any thread.
@MainActor
protocol RenderedOutput: AnyObject {
  var playing: any RenderedPlaying { get }
  /// Make it ready to play. False where it cannot (no audio hardware): the device's voice speaks.
  func open() -> Bool
  /// Let go of the hardware.
  func close()
}

/// The player's side of one sentence, callable from the thread audio is handed over on.
protocol RenderedPlaying: Sendable {
  func begin(_ token: Int)
  func play(_ buffer: AVAudioPCMBuffer?, token: Int, finished: @escaping @Sendable () -> Void)
}

extension RenderedPlayback: RenderedPlaying {}

/// An `AVAudioEngine` with one player node, started for a reply and stopped when it is over.
@MainActor
final class EngineOutput: RenderedOutput {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
  private let playback: RenderedPlayback
  private var attached = false

  init() {
    playback = RenderedPlayback(player: player, format: format)
  }

  var playing: any RenderedPlaying { playback }

  func open() -> Bool {
    if !attached {
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      attached = true
    }

    SpeechAudioSession.beginPlayback()

    do {
      if !engine.isRunning {
        engine.prepare()
        try engine.start()
      }
    } catch {
      SpeechAudioSession.end()
      return false
    }

    if !player.isPlaying {
      player.play()
    }

    return true
  }

  func close() {
    player.stop()
    engine.stop()
    SpeechAudioSession.end()
  }
}

/**
 Reading a reply aloud with a voice that is the gateway's, outside a call (`ReadAloudModel`'s own
 synthesiser, for "Read aloud" and the chat's automatic read).

 A request whose source is the device is the device's synthesiser's, untouched: nothing here is on
 its path. A request for the gateway's voice is rendered by `GatewaySpeechRenderer` and played on an
 engine of its own, started for the reply and stopped when it is said. Where that engine cannot start,
 the device speaks it.
 */
@MainActor
public final class GatewaySpeechSynthesizer: SpeechSynthesizing {
  private let apple: any SpeechSynthesizing
  private let renderer: any VoiceSpeechRenderer
  private let output: any RenderedOutput
  private var token = 0
  private var done: (@MainActor @Sendable () -> Void)?
  private var open = false

  public convenience init(apple: any SpeechSynthesizing, renderer: any VoiceSpeechRenderer) {
    self.init(apple: apple, renderer: renderer, output: EngineOutput())
  }

  init(apple: any SpeechSynthesizing, renderer: any VoiceSpeechRenderer, output: any RenderedOutput) {
    self.apple = apple
    self.renderer = renderer
    self.output = output
  }

  public var isAvailable: Bool { apple.isAvailable }

  public func speak(
    _ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void
  ) {
    stopOwn(discardingPrefetched: false)

    guard request.source == .gateway else {
      apple.speak(request, rate: rate, voice: voice, onDone: onDone)
      return
    }

    apple.stop()

    guard output.open() else {
      apple.speak(request, rate: rate, voice: voice, onDone: onDone)
      return
    }

    open = true
    token += 1
    let current = token
    done = onDone

    let playing = output.playing
    playing.begin(current)

    let finished = Self.finished(for: self, token: current)
    renderer.render(request, rate: rate, voice: voice) { buffer in
      playing.play(buffer, token: current, finished: finished)
    }
  }

  public func stop() {
    stopOwn(discardingPrefetched: true)
    apple.stop()
  }

  public func prefetch(_ request: ReadRequest, rate: Double, voice: String?) {
    renderer.prefetch(request, rate: rate, voice: voice)
  }

  public func voices() -> [SpeechVoice] { apple.voices() }
  public func personalVoiceAccess() -> PersonalVoiceAccess { apple.personalVoiceAccess() }
  public func requestPersonalVoiceAccess() async -> PersonalVoiceAccess { await apple.requestPersonalVoiceAccess() }

  /// Ownership first: what the renderer and the player still report is about nothing wanted.
  private func stopOwn(discardingPrefetched discard: Bool) {
    token += 1
    done = nil
    output.playing.begin(-1)
    renderer.cancel()

    if discard {
      renderer.discardPrefetched()
    }

    if open {
      open = false
      output.close()
    }
  }

  private nonisolated static func finished(for synthesizer: GatewaySpeechSynthesizer, token: Int) -> @Sendable () -> Void {
    { [weak synthesizer] in
      Task { @MainActor in synthesizer?.spoken(token) }
    }
  }

  private func spoken(_ finished: Int) {
    guard finished == token, let done else {
      return
    }

    self.done = nil

    if open {
      open = false
      output.close()
    }

    done()
  }
}
