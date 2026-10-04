import Foundation

/// A recogniser voice mode can listen with: dictation's, plus whether it can tell the reader's voice
/// from what the device's own speaker is saying (echo cancellation). Only a recogniser that can is
/// left open while a reply is read, which is what lets the reader cut in by speaking.
@MainActor
public protocol VoiceModeRecognising: DictationEngine {
  /// Known once a session has started; false before.
  var cancelsEcho: Bool { get }
}

/// A synthesiser voice mode can speak with: the reader's, plus a soft sound that says "still working".
@MainActor
public protocol VoiceModeSpeaking: SpeechSynthesizing {
  /// A short, quiet tone. Never cuts what is being said.
  func playCue()
}

/// What happens to the audio that voice mode did not do itself.
public enum VoiceAudioEvent: Sendable, Equatable {
  /// A call, an alarm, another app took the audio: everything stops.
  case interruptionBegan
  /// The audio is back. `shouldResume` is the system's hint that picking up where it left off is
  /// expected (it is false after a phone call the reader took, say).
  case interruptionEnded(shouldResume: Bool)
  /// The route changed (a headset in or out, Bluetooth): the microphone's format may have too.
  case routeChanged
  /// The audio could not be restarted.
  case failed
  /// A sentence was meant for the gateway's voice and was spoken in the device's: the gateway did not
  /// answer in time, or at all. Not a failure of the call.
  case speechFellBack
}

/// The audio session of a call: one category for listening and speaking at once (on iOS
/// `.playAndRecord` in `.voiceChat` mode, which is what turns echo cancellation on), held for the whole
/// call rather than switched per utterance, and handed back at the end.
@MainActor
public protocol VoiceModeAudio: AnyObject {
  /// The microphone's and the speaker's levels, for the orb.
  var meters: VoiceMeters { get }
  /// Set by voice mode before `activate`.
  var onEvent: (@MainActor (VoiceAudioEvent) -> Void)? { get set }
  /// Take the audio for the call. Throws where it cannot be had (a phone call is up).
  func activate() throws
  /// Take it again after an interruption.
  func reactivate() throws
  /// Give it back.
  func deactivate()
}

/// One call's engines. In the app a single object is all three (`AppleVoiceModeEngine`: the
/// recogniser and the synthesiser share one audio engine, which is what makes echo cancellation work);
/// in the tests, three fakes.
public struct VoiceModeEngines {
  public var recogniser: any VoiceModeRecognising
  public var speaker: any VoiceModeSpeaking
  public var audio: any VoiceModeAudio

  public init(recogniser: any VoiceModeRecognising, speaker: any VoiceModeSpeaking, audio: any VoiceModeAudio) {
    self.recogniser = recogniser
    self.speaker = speaker
    self.audio = audio
  }
}

/// A timer voice mode can cancel.
@MainActor
public protocol VoiceModeTimer: AnyObject {
  func cancel()
}

/// Where voice mode's timers come from, and what time it is: the real clock in the app, a hand-turned
/// one in the tests.
@MainActor
public protocol VoiceModeClock: AnyObject {
  /// Seconds on a clock that does not jump.
  var now: Double { get }
  /// Run `action` after `seconds`, unless cancelled first.
  func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> any VoiceModeTimer
}

/// The real clock: `Task.sleep`, and the system's uptime.
@MainActor
public final class SystemVoiceModeClock: VoiceModeClock {
  private final class Sleeper: VoiceModeTimer {
    var task: Task<Void, Never>?
    func cancel() { task?.cancel() }
  }

  public init() {}

  public var now: Double { ProcessInfo.processInfo.systemUptime }

  public func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> any VoiceModeTimer {
    let sleeper = Sleeper()
    sleeper.task = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(Int(max(0, seconds) * 1000)))

      if !Task.isCancelled {
        action()
      }
    }
    return sleeper
  }
}

/// What voice mode puts on the conversation: the words, and the call's recent exchange for the bot
/// (`voice_context`). Always sent with `surface: "voice-call"`, which tells the gateway the reply is
/// going to be heard rather than read.
public struct VoiceSubmission: Sendable, Equatable {
  /// The `surface` of every prompt sent during a call.
  public static let surface = "voice-call"

  public var text: String
  public var context: String?

  public init(text: String, context: String?) {
    self.text = text
    self.context = context
  }
}
