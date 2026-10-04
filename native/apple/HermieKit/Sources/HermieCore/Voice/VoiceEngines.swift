import Foundation

/// Where a chat screen gets its recogniser and its synthesiser: the platform's in the app, fakes in the
/// tests. One of each per chat screen, not shared: each holds the one session it has started, and two
/// chats on one engine would cut each other off without either knowing.
public struct VoiceEngines: Sendable {
  public var dictation: @MainActor @Sendable () -> any DictationEngine
  public var speech: @MainActor @Sendable () -> any SpeechSynthesizing
  /// A voice mode call's engines, made fresh for each call.
  public var call: @MainActor @Sendable () -> VoiceModeEngines

  public init(
    dictation: @escaping @MainActor @Sendable () -> any DictationEngine,
    speech: @escaping @MainActor @Sendable () -> any SpeechSynthesizing,
    call: @escaping @MainActor @Sendable () -> VoiceModeEngines = { AppleVoiceModeEngine.call() }
  ) {
    self.dictation = dictation
    self.speech = speech
    self.call = call
  }

  /// `SFSpeechRecognizer` with `AVAudioEngine`, and `AVSpeechSynthesizer`; for a call, one
  /// `AVAudioEngine` that listens and speaks (`AppleVoiceModeEngine`).
  public static let live = VoiceEngines(
    dictation: { AppleSpeechRecognizer() },
    speech: { AppleSpeechSynthesizer() },
    call: { AppleVoiceModeEngine.call() }
  )
}
