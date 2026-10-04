import AVFoundation
import Foundation

/**
 `AVSpeechSynthesizer` behind `SpeechSynthesizing`: the device's own voices, speaking on the device.
 Nothing is sent anywhere.

 Two quirks it works around, both of them the same one: a cancelled utterance reports its end too,
 and a late report from one must never look like the completion of the one that replaced it. So the
 engine tracks the utterance it started, by identity, and drops what is not about that one.
 */
@MainActor
public final class AppleSpeechSynthesizer: NSObject, SpeechSynthesizing, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  /// The utterance this engine is responsible for, and what to call when it is over.
  private var current: (id: ObjectIdentifier, onDone: @MainActor @Sendable () -> Void)?

  public override init() {
    super.init()
    synthesizer.delegate = self
  }

  public var isAvailable: Bool { true }

  public func speak(
    _ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void
  ) {
    // The system's queue is not ours: one thing at a time, and the one before is cut first.
    synthesizer.stopSpeaking(at: .immediate)
    current = nil

    let utterance = AVSpeechUtterance(string: request.text)
    utterance.rate = Self.engineRate(forMultiplier: rate)
    utterance.voice = Self.voice(named: voice, language: request.language)
    utterance.pitchMultiplier = Float(request.pitch)

    current = (ObjectIdentifier(utterance), onDone)
    SpeechAudioSession.beginPlayback()
    synthesizer.speak(utterance)
  }

  public func stop() {
    // Ownership goes first, so the cancel this provokes is not mistaken for a completion.
    current = nil
    synthesizer.stopSpeaking(at: .immediate)
    SpeechAudioSession.end()
  }

  public func voices() -> [SpeechVoice] {
    Self.installedVoices()
  }

  public func personalVoiceAccess() -> PersonalVoiceAccess {
    Self.personalVoiceAccess(AVSpeechSynthesizer.personalVoiceAuthorizationStatus)
  }

  public func requestPersonalVoiceAccess() async -> PersonalVoiceAccess {
    Self.personalVoiceAccess(await Self.askPersonalVoice())
  }

  /// The system's Personal Voice prompt, answered on a queue of its own.
  private nonisolated static func askPersonalVoice() async -> AVSpeechSynthesizer.PersonalVoiceAuthorizationStatus {
    await withCheckedContinuation { (continuation: CheckedContinuation<AVSpeechSynthesizer.PersonalVoiceAuthorizationStatus, Never>) in
      AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
        continuation.resume(returning: status)
      }
    }
  }

  static func personalVoiceAccess(_ status: AVSpeechSynthesizer.PersonalVoiceAuthorizationStatus) -> PersonalVoiceAccess {
    switch status {
    case .authorized: .granted
    case .denied: .denied
    case .notDetermined: .notAsked
    case .unsupported: .unsupported
    @unknown default: .unsupported
    }
  }

  /// Every voice on this device, the reader's Personal Voice among them once it may be used.
  nonisolated static func installedVoices() -> [SpeechVoice] {
    AVSpeechSynthesisVoice.speechVoices()
      .map { voice in
        let quality: SpeechVoice.Quality =
          switch voice.quality {
          case .premium: .premium
          case .enhanced: .enhanced
          default: .compact
          }
        return SpeechVoice(
          id: voice.identifier, name: voice.name, language: voice.language, quality: quality,
          personal: voice.voiceTraits.contains(.isPersonalVoice))
      }
      .sorted { ($0.language, $0.name) < ($1.language, $1.name) }
  }

  // MARK: Mapping

  /// The engine's `rate` for a multiplier of its own normal: 1 is `AVSpeechUtteranceDefaultSpeechRate`,
  /// held between the engine's slowest and fastest.
  nonisolated static func engineRate(forMultiplier multiplier: Double) -> Float {
    let wanted = Float(AVSpeechUtteranceDefaultSpeechRate) * Float(multiplier)
    return min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, wanted))
  }

  /// The voice the reader named, when it can read this reply's language; else the best the system has
  /// for that language; else nil, which is the device's own.
  nonisolated static func voice(named identifier: String?, language: String?) -> AVSpeechSynthesisVoice? {
    if let identifier, let chosen = AVSpeechSynthesisVoice(identifier: identifier),
      language == nil || sameLanguage(chosen.language, language ?? "")
    {
      return chosen
    }

    return language.flatMap { AVSpeechSynthesisVoice(language: $0) }
  }

  /// `nl` and `nl-NL` are the same language.
  nonisolated static func sameLanguage(_ left: String, _ right: String) -> Bool {
    func code(_ tag: String) -> String {
      tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() } ?? ""
    }

    return code(left) == code(right)
  }

  // MARK: AVSpeechSynthesizerDelegate

  // Not isolated: the synthesiser may call from any queue, and only the utterance's identity crosses
  // to the main actor.

  public nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    let id = ObjectIdentifier(utterance)
    Task { @MainActor [weak self] in self?.ended(id) }
  }

  public nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    let id = ObjectIdentifier(utterance)
    Task { @MainActor [weak self] in self?.ended(id) }
  }

  private func ended(_ id: ObjectIdentifier) {
    guard let current, current.id == id else {
      return
    }

    self.current = nil
    SpeechAudioSession.end()
    current.onDone()
  }
}
