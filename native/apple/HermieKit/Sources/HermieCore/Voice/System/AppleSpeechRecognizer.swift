import AVFoundation
import Foundation
import Speech

/**
 `SFSpeechRecognizer` and `AVAudioEngine` behind `DictationEngine`.

 **The audio never leaves the device** (ADR-0022: voice on the device). The request is made with
 `requiresOnDeviceRecognition`, and a language with no on-device model is refused rather than handed to
 Apple's speech service: it is not offered, and `processing(language:)` says it is unavailable. A silent
 fallback would make the privacy claim false on exactly the devices whose owners cannot check it. Nothing
 is recorded to a file.

 Two things about the audio thread. The microphone's tap runs on a real-time thread, so it is built in
 a nonisolated function and captures nothing but the request it appends to. And the recogniser reports
 on a queue of its own, so its handler is nonisolated too and only plain values (the words, whether they
 are final, what went wrong) reach the main actor.
 */
@MainActor
public final class AppleSpeechRecognizer: DictationEngine {
  private let audio = AVAudioEngine()
  private var recogniser: SFSpeechRecognizer?
  private var task: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var events: DictationEvents?
  /// Bumped by every start and abort: a report from an older session is dropped.
  private var session = 0
  private var finishTimer: Task<Void, Never>?
  /// The microphone's tap is installed: the input node is not touched (a Mac without a microphone has
  /// trouble with it) until it is.
  private var tapInstalled = false

  /// How long a stopped session is given to deliver its final result before it is ended anyway.
  private static let finishGrace: Duration = .seconds(2)

  public init() {}

  /// The locales that have a model on this device, found once: asking each recogniser is not free.
  private lazy var onDeviceLocales: [Locale] = SFSpeechRecognizer.supportedLocales().filter {
    SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true
  }

  /// Whether any language can be dictated on this device. Static for a launch: a model that is
  /// downloaded later is found at the next one.
  public var isAvailable: Bool { !onDeviceLocales.isEmpty }

  // MARK: Permission

  public func requestPermission() async -> RecognitionPermission {
    guard isAvailable else {
      return .unavailable
    }

    guard await Self.speechAuthorised() else {
      return .denied
    }

    return await AVAudioApplication.requestRecordPermission() ? .granted : .denied
  }

  /// The system's speech recognition prompt. Asked from a nonisolated function: the system answers on a
  /// queue of its own, and a closure formed on the main actor would be checked to run on it.
  private nonisolated static func speechAuthorised() async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
  }

  // MARK: Languages

  public func supportedLanguages() -> [String] {
    onDeviceLocales.map { $0.identifier(.bcp47) }.sorted()
  }

  public func processing(language: String?) -> RecognitionProcessing {
    Self.recogniser(for: language)?.supportsOnDeviceRecognition == true ? .onDevice : .unavailable
  }

  /// The recogniser for a BCP-47 tag (`nl`, `nl-NL`), or for the device's own language when there is
  /// none. A bare language takes the supported locale that has it, the device's region first.
  static func recogniser(for language: String?) -> SFSpeechRecognizer? {
    let supported = SFSpeechRecognizer.supportedLocales()

    guard let language else {
      return SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer()
    }

    let wanted = Locale(identifier: language)

    if let exact = supported.first(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) }) {
      return SFSpeechRecognizer(locale: exact)
    }

    let same = supported.filter { $0.language.languageCode == wanted.language.languageCode }
    let chosen = same.first { $0.region == Locale.current.region } ?? same.first

    return chosen.flatMap { SFSpeechRecognizer(locale: $0) }
  }

  // MARK: A session

  public func start(language: String?, events: DictationEvents) {
    abort()
    session += 1
    let current = session

    guard let recogniser = Self.recogniser(for: language), recogniser.isAvailable,
      recogniser.supportsOnDeviceRecognition
    else {
      events.onError(.unavailable)
      events.onEnd()
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.addsPunctuation = true
    // Always: the request fails rather than reaching Apple's service (and the guard above has
    // already refused a language that has no model here).
    request.requiresOnDeviceRecognition = true

    do {
      try SpeechAudioSession.beginRecording()

      let input = audio.inputNode
      let format = input.outputFormat(forBus: 0)

      // No microphone, or one that is not producing audio (a Mac with no input).
      guard format.sampleRate > 0, format.channelCount > 0 else {
        SpeechAudioSession.end()
        events.onError(.unavailable)
        events.onEnd()
        return
      }

      input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(into: RequestBox(request)))
      tapInstalled = true
      audio.prepare()
      try audio.start()
    } catch {
      teardownAudio()
      events.onError(.failed)
      events.onEnd()
      return
    }

    self.recogniser = recogniser
    self.request = request
    self.events = events
    task = recogniser.recognitionTask(with: request, resultHandler: Self.handler(for: self, session: current))
  }

  public func stop() {
    guard request != nil else {
      return
    }

    // Closing the audio asks the recogniser for its final result, which arrives as the last report.
    teardownAudio()
    request?.endAudio()

    let current = session
    finishTimer?.cancel()
    finishTimer = Task { [weak self] in
      try? await Task.sleep(for: Self.finishGrace)

      if !Task.isCancelled {
        self?.finish(current)
      }
    }
  }

  public func abort() {
    // Ownership goes first: nothing the recogniser still says is about a session that is wanted.
    session += 1
    finishTimer?.cancel()
    finishTimer = nil
    task?.cancel()
    task = nil
    request = nil
    events = nil
    recogniser = nil
    teardownAudio()
  }

  private func teardownAudio() {
    if tapInstalled {
      if audio.isRunning {
        audio.stop()
      }

      audio.inputNode.removeTap(onBus: 0)
      tapInstalled = false
      SpeechAudioSession.end()
    }
  }

  // MARK: What the recogniser says

  private func report(_ words: String?, final: Bool, failure: RecognitionFailure?, session reported: Int) {
    guard reported == session, let events else {
      return
    }

    if let words {
      if final {
        events.onFinal(words)
      } else {
        events.onPartial(words)
      }
    }

    if let failure {
      events.onError(failure)
    }

    if final || failure != nil {
      finish(reported)
    }
  }

  /// The session is over, however it ended: audio closed, the end told once.
  private func finish(_ reported: Int) {
    guard reported == session, let events else {
      return
    }

    session += 1
    finishTimer?.cancel()
    finishTimer = nil
    task?.cancel()
    task = nil
    request = nil
    self.events = nil
    recogniser = nil
    teardownAudio()
    events.onEnd()
  }

  // MARK: Off the main actor

  /// The recogniser's request, carried into the audio thread.
  private final class RequestBox: @unchecked Sendable {
    let request: SFSpeechAudioBufferRecognitionRequest

    init(_ request: SFSpeechAudioBufferRecognitionRequest) {
      self.request = request
    }
  }

  /// The microphone's tap. Real-time thread: it appends the buffer and does nothing else.
  private nonisolated static func tap(into box: RequestBox) -> AVAudioNodeTapBlock {
    { buffer, _ in box.request.append(buffer) }
  }

  /// The recogniser's result handler, which it calls on a queue of its own.
  private nonisolated static func handler(
    for engine: AppleSpeechRecognizer, session: Int
  ) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
    { [weak engine] result, error in
      let words = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      let failure = error.flatMap { Self.failure(for: $0) }
      let ended = error != nil

      Task { @MainActor in
        // A cancellation is this app's own doing and says nothing; any other error ends the session.
        engine?.report(words, final: final, failure: failure, session: session)

        if ended, failure == nil {
          engine?.finish(session)
        }
      }
    }
  }

  /// What an error from the recogniser means for the reader, nil for a cancellation.
  ///
  /// The codes are the speech service's own and undocumented; the ones named here are the ones seen in
  /// practice. Anything else is a plain failure.
  nonisolated static func failure(for error: any Error) -> RecognitionFailure? {
    let error = error as NSError

    switch (error.domain, error.code) {
    case ("kLSRErrorDomain", 301), ("kAFAssistantErrorDomain", 216), ("kAFAssistantErrorDomain", 209):
      // Cancelled (by us), or ended by closing the audio.
      return nil
    case ("kAFAssistantErrorDomain", 1110):
      return .noSpeech
    case ("kAFAssistantErrorDomain", 1101), ("kAFAssistantErrorDomain", 1107):
      return .unavailable
    default:
      return .failed
    }
  }
}
