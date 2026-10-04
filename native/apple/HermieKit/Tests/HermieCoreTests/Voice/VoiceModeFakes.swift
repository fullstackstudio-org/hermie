import Foundation
import HermieTranscript

@testable import HermieCore

/// A call's recogniser that never hears a sound: the test says what it heard.
@MainActor
final class FakeCallRecogniser: VoiceModeRecognising {
  var isAvailable = true
  var permission = RecognitionPermission.granted
  var cancelsEcho = true

  private(set) var starts = 0
  private(set) var aborts = 0
  private(set) var permissionAsks = 0
  private var events: DictationEvents?

  /// A session is open.
  var listening: Bool { events != nil }

  /// When set, `requestPermission` waits until `answerPermission()` (the system's prompt is up).
  var holdsPermission = false
  private var waiting: CheckedContinuation<RecognitionPermission, Never>?

  func requestPermission() async -> RecognitionPermission {
    permissionAsks += 1

    guard holdsPermission else {
      return permission
    }

    return await withCheckedContinuation { waiting = $0 }
  }

  /// Wait for the prompt to be up, do `meanwhile`, then answer it.
  func answerPermissionLater(_ meanwhile: () -> Void) async {
    while waiting == nil {
      await Task.yield()
    }

    meanwhile()
    waiting?.resume(returning: permission)
    waiting = nil
  }

  func processing(language: String?) -> RecognitionProcessing { .onDevice }
  func supportedLanguages() -> [String] { ["en-US"] }

  func start(language: String?, events: DictationEvents) {
    starts += 1
    self.events = events
  }

  func stop() {}

  func abort() {
    aborts += 1
    events = nil
  }

  func hear(_ words: String) { events?.onPartial(words) }
  func hearFinal(_ words: String) { events?.onFinal(words) }
  func fail(_ failure: RecognitionFailure) { events?.onError(failure) }

  /// The session ends by itself, as a recogniser's does.
  func end() {
    let ending = events
    events = nil
    ending?.onEnd()
  }
}

/// A call's speaker that makes no sound: it holds what it was asked to say until the test finishes it.
@MainActor
final class FakeCallSpeaker: VoiceModeSpeaking {
  var isAvailable = true
  private(set) var spoken: [ReadRequest] = []
  private(set) var stops = 0
  private(set) var cues = 0
  private var finisher: (@MainActor @Sendable () -> Void)?

  /// Something is being said.
  var speaking: Bool { finisher != nil }

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append(request)
    finisher = onDone
  }

  func stop() {
    stops += 1
    finisher = nil
  }

  func voices() -> [SpeechVoice] { [] }

  func playCue() {
    cues += 1
  }

  /// What is being said has been said.
  func finish() {
    let done = finisher
    finisher = nil
    done?()
  }

  /// Say everything in line to the end.
  func finishAll() {
    while speaking {
      finish()
    }
  }
}

/// A call's audio session.
@MainActor
final class FakeCallAudio: VoiceModeAudio {
  let meters = VoiceMeters()
  var onEvent: (@MainActor (VoiceAudioEvent) -> Void)?
  var failsToActivate = false
  private(set) var activations = 0
  private(set) var reactivations = 0
  private(set) var deactivations = 0
  private(set) var active = false

  struct Refused: Error {}

  func activate() throws {
    guard !failsToActivate else {
      throw Refused()
    }

    activations += 1
    active = true
  }

  func reactivate() throws {
    reactivations += 1
    active = true
  }

  func deactivate() {
    deactivations += 1
    active = false
  }

  func post(_ event: VoiceAudioEvent) {
    onEvent?(event)
  }
}

/// A clock the test turns by hand.
@MainActor
final class ManualVoiceClock: VoiceModeClock {
  final class Timer: VoiceModeTimer {
    let due: Double
    let action: @MainActor () -> Void
    var cancelled = false

    init(due: Double, action: @escaping @MainActor () -> Void) {
      self.due = due
      self.action = action
    }

    func cancel() { cancelled = true }
  }

  private(set) var now: Double = 100
  private(set) var timers: [Timer] = []

  func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> any VoiceModeTimer {
    let timer = Timer(due: now + seconds, action: action)
    timers.append(timer)
    return timer
  }

  /// The timers still waiting.
  var pending: [Timer] { timers.filter { !$0.cancelled } }

  /// Move on by `seconds`, running every timer that comes due, in order.
  func advance(_ seconds: Double) {
    let end = now + seconds

    while let next = pending.filter({ $0.due <= end }).min(by: { $0.due < $1.due }) {
      now = next.due
      next.cancelled = true
      next.action()
    }

    now = end
  }
}

/// Transcript items for a call's chat.
enum CallItems {
  static func base(_ id: String) -> ItemBase {
    ItemBase(id: id, seq: 1, ts: 1, origin: .live, version: 1)
  }

  static func user(_ id: String, _ text: String) -> VisibleItem {
    VisibleItem(item: .user(UserItem(base: base(id), text: text)), presentation: .full)
  }

  static func reply(_ id: String, _ text: String, streaming: Bool = false) -> VisibleItem {
    VisibleItem(
      item: .assistant(AssistantItem(base: base(id), text: text, streaming: streaming, interim: false)),
      presentation: .full)
  }
}
