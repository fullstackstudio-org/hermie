import Foundation

@testable import HermieCore

/// A recogniser that says what the test tells it to: no microphone, no speech framework, no audio.
@MainActor
final class FakeRecogniser: DictationEngine {
  var isAvailable = true
  var permission = RecognitionPermission.granted
  var onDevice = RecognitionProcessing.onDevice
  var languages = ["nl-NL", "en-US"]

  private(set) var permissionAsks = 0
  private(set) var starts: [String?] = []
  private(set) var stops = 0
  private(set) var aborts = 0
  private var events: DictationEvents?

  /// When set, `requestPermission` waits until `answerPermission()` (a prompt that is still up).
  var holdsPermission = false
  private var waiting: CheckedContinuation<RecognitionPermission, Never>?

  func requestPermission() async -> RecognitionPermission {
    permissionAsks += 1

    guard holdsPermission else {
      return permission
    }

    return await withCheckedContinuation { waiting = $0 }
  }

  func answerPermission() {
    waiting?.resume(returning: permission)
    waiting = nil
  }

  func processing(language: String?) -> RecognitionProcessing { onDevice }

  func supportedLanguages() -> [String] { languages }

  func start(language: String?, events: DictationEvents) {
    starts.append(language)
    self.events = events
  }

  func stop() {
    stops += 1
  }

  func abort() {
    aborts += 1
    // A real recogniser says nothing after an abort.
    events = nil
  }

  // MARK: What the test makes it say

  func hear(_ words: String) { events?.onPartial(words) }
  func hearFinal(_ words: String) { events?.onFinal(words) }
  func fail(_ failure: RecognitionFailure) { events?.onError(failure) }
  func end() { events?.onEnd() }

  /// A report from a session that has been replaced: kept past the abort, as a real recogniser does.
  func keepEvents() -> DictationEvents? { events }
}

/// A synthesiser that never makes a sound: it holds what it was asked to say until the test finishes it.
@MainActor
final class FakeSynthesiser: SpeechSynthesizing {
  struct Spoken: Equatable {
    var request: ReadRequest
    var rate: Double
    var voice: String?
  }

  var isAvailable = true
  var installed: [SpeechVoice] = []

  private(set) var spoken: [Spoken] = []
  private(set) var prefetched: [Spoken] = []
  private(set) var stops = 0
  private var finishers: [@MainActor @Sendable () -> Void] = []

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append(Spoken(request: request, rate: rate, voice: voice))
    finishers.append(onDone)
  }

  func stop() {
    stops += 1
  }

  func prefetch(_ request: ReadRequest, rate: Double, voice: String?) {
    prefetched.append(Spoken(request: request, rate: rate, voice: voice))
  }

  func voices() -> [SpeechVoice] { installed }

  /// The utterance in flight ends the way one does: said, or failed (a queue sees no difference).
  func finishCurrent() {
    finishers.last?()
  }

  /// The end of an utterance the queue has moved past (a cancelled one that reports late).
  func finishUtterance(at index: Int) {
    finishers[index]()
  }
}
