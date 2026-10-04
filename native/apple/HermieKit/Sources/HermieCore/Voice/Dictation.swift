import Foundation
import Observation

/// Why a recogniser said no, as a closed set: each failure has a different answer for the reader. A
/// session this app cancels itself is not among them, and neither is its own `abort`.
public enum RecognitionFailure: Sendable, Equatable {
  /// The microphone or the speech recogniser was refused: the one the reader can act on.
  case permission
  /// The reader tapped and said nothing. Not an error as such: the draft is left exactly as it was.
  case noSpeech
  /// This device, or this language on it, cannot do it at all.
  case unavailable
  /// Anything else, said plainly rather than with a code.
  case failed
}

/// What the system answered when asked for the microphone and the recogniser.
public enum RecognitionPermission: Sendable, Equatable {
  case granted
  case denied
  /// No recogniser here (no microphone, no model, restricted by a profile).
  case unavailable
}

/// Whether a language can be dictated here, and where: only on the device. A language with no model on
/// the device is not recognised by a service instead (ADR-0022), so the audio never leaves the device.
public enum RecognitionProcessing: Sendable, Equatable {
  /// On this device: the audio never leaves it.
  case onDevice
  /// This language has no model on this device.
  case unavailable
}

/// What a recogniser reports about a session, on the main actor. `onPartial` and `onFinal` carry the
/// WHOLE transcript of the session so far, not a delta: the recogniser revises what it heard.
public struct DictationEvents: Sendable {
  public var onPartial: @MainActor @Sendable (String) -> Void
  public var onFinal: @MainActor @Sendable (String) -> Void
  public var onError: @MainActor @Sendable (RecognitionFailure) -> Void
  /// The session is over, however it ended. Always the last call.
  public var onEnd: @MainActor @Sendable () -> Void

  public init(
    onPartial: @escaping @MainActor @Sendable (String) -> Void,
    onFinal: @escaping @MainActor @Sendable (String) -> Void,
    onError: @escaping @MainActor @Sendable (RecognitionFailure) -> Void,
    onEnd: @escaping @MainActor @Sendable () -> Void
  ) {
    self.onPartial = onPartial
    self.onFinal = onFinal
    self.onError = onError
    self.onEnd = onEnd
  }
}

/// The platform's recogniser, behind one seam (`SFSpeechRecognizer` and `AVAudioEngine` in the app, a
/// fake in the tests). Nothing above it touches a microphone.
@MainActor
public protocol DictationEngine: AnyObject {
  /// Whether this device can dictate at all. Static for a launch: a recogniser does not appear later.
  var isAvailable: Bool { get }
  /// Ask for the microphone and the recogniser (the system's prompts), once each, and wait.
  func requestPermission() async -> RecognitionPermission
  /// Whether `language` (a BCP-47 tag, nil for the device's own) can be recognised here.
  func processing(language: String?) -> RecognitionProcessing
  /// The languages the recogniser takes on this device, as BCP-47 tags.
  func supportedLanguages() -> [String]
  /// Start listening. Permission has been granted. At most one session at a time.
  func start(language: String?, events: DictationEvents)
  /// Stop listening and deliver the final result, then `onEnd`. What a second tap on the mic does.
  func stop()
  /// Stop and throw away what was heard. No call comes after it.
  func abort()
}

/// Where the words of a dictation go: the composer's field, as the model reads and writes it.
public struct DictationField {
  public var read: @MainActor () -> String
  public var write: @MainActor (String) -> Void

  public init(read: @escaping @MainActor () -> String, write: @escaping @MainActor (String) -> Void) {
    self.read = read
    self.write = write
  }
}

/**
 Where dictated words land. A partial result is not an append: the recogniser revises what it thinks
 it heard ("recognise" becomes "recognise their"), so a field that appended every event would collect
 every revision. So the session takes an anchor when it starts, the draft as it stood, and every result
 (partial or final) is the anchor plus the WHOLE transcript so far. A dropped event cannot desynchronise
 the field, and the final result is nothing special: the last partial that happens to be true.
 */
public struct DictationAnchor: Sendable, Equatable {
  public var base: String

  public init(base: String) {
    self.base = base
  }

  /// The draft with `transcript` after what was there. A space goes between them unless the draft is
  /// empty or already ends in white space; an empty transcript is the draft as it was.
  public func applying(_ transcript: String) -> String {
    let words = transcript.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !words.isEmpty else {
      return base
    }

    let needsSpace = base.last.map { !$0.isWhitespace } ?? false
    return base + (needsSpace ? " " : "") + words
  }
}

/// Where the model is in a session.
public enum DictationPhase: Sendable, Equatable {
  case idle
  /// Waiting for the system's permission prompts.
  case starting
  case listening
  /// The last session ended in a failure; the reader has not dismissed or retried it yet.
  case failed(RecognitionFailure)
}

/**
 The composer's microphone: one dictation session at a time, into the field.

 Nothing here knows about a microphone or a text view, which is what makes the two things most likely
 to be wrong testable: where the words go (`DictationAnchor`) and what happens when the recogniser says
 no. The permission prompts are awaited, not fired and forgotten: a recogniser started while the
 system's dialog is up ends the moment the dialog appears, which reads as a mic button that flashes and
 does nothing.

 A `generation` is bumped by every start and every cancel. A recogniser can deliver a result, or its
 end, for a session that has already been replaced, and acting on one would put the previous
 utterance's words into the field the reader is dictating into now.

 Dictation only ever writes the field. It never sends: what was heard is the reader's to read, change
 and send.
 */
@MainActor
@Observable
public final class DictationModel {
  public private(set) var phase = DictationPhase.idle
  /// What has been heard so far in this session; empty until the first result.
  public private(set) var partial = ""

  @ObservationIgnored private let engine: any DictationEngine
  @ObservationIgnored private let language: @MainActor () -> String
  @ObservationIgnored private let field: DictationField
  /// Called when a session begins listening, so a reply being read aloud does not talk over it.
  @ObservationIgnored public var onListening: (@MainActor () -> Void)?
  /// Something has the field (a request over the composer): no session starts.
  @ObservationIgnored public var blocked: @MainActor () -> Bool = { false }
  @ObservationIgnored private var anchor = DictationAnchor(base: "")
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var heard = false

  /// - Parameters:
  ///   - language: read at the start of each session: `VoiceSettings.automatic` or a BCP-47 tag.
  ///   - field: the composer's draft.
  public init(engine: any DictationEngine, language: @escaping @MainActor () -> String, field: DictationField) {
    self.engine = engine
    self.language = language
    self.field = field
  }

  /// Whether the device can dictate at all: the mic is drawn only where it can.
  public var isAvailable: Bool { engine.isAvailable }

  /// A session is starting or running.
  public var isActive: Bool { phase == .starting || phase == .listening }

  public var isListening: Bool { phase == .listening }

  /// The failure the mic is showing, if the last session ended in one.
  public var failure: RecognitionFailure? {
    if case .failed(let failure) = phase { failure } else { nil }
  }

  /// Whether the language dictation would use now can be recognised here (for the settings footer).
  public var processing: RecognitionProcessing {
    engine.processing(language: tag(for: language()))
  }

  private func tag(for setting: String) -> String? {
    setting == VoiceSettings.automatic ? nil : setting
  }

  // MARK: A session

  /// A tap on the mic: start when idle, stop when listening. A tap while the prompts are up cancels.
  public func toggle() async {
    switch phase {
    case .starting:
      cancel()
    case .listening:
      stop()
    case .idle, .failed:
      await start()
    }
  }

  /// Ask for the microphone and start listening. Does nothing while a session is on.
  public func start() async {
    guard engine.isAvailable else {
      phase = .failed(.unavailable)
      return
    }

    guard !isActive, !blocked() else {
      return
    }

    generation += 1
    let session = generation
    phase = .starting
    partial = ""
    heard = false

    let permission = await engine.requestPermission()

    // The reader cancelled, or left, while the prompt was up.
    guard session == generation else {
      return
    }

    switch permission {
    case .granted:
      break
    case .denied:
      phase = .failed(.permission)
      return
    case .unavailable:
      phase = .failed(.unavailable)
      return
    }

    anchor = DictationAnchor(base: field.read())
    phase = .listening
    onListening?()

    engine.start(
      language: tag(for: language()),
      events: DictationEvents(
        onPartial: { [weak self] text in self?.result(text, in: session) },
        onFinal: { [weak self] text in self?.result(text, in: session) },
        onError: { [weak self] failure in self?.failed(failure, in: session) },
        onEnd: { [weak self] in self?.ended(session) }
      ))
  }

  /// Stop listening and take the final result: what a second tap does.
  public func stop() {
    switch phase {
    case .starting:
      cancel()
    case .listening:
      engine.stop()
    case .idle, .failed:
      break
    }
  }

  /// Stop and throw away what the recogniser had not delivered yet. The words already in the field
  /// stay. Leaving the screen, the app going to the background, and a field changed by hand.
  public func cancel() {
    guard isActive else {
      return
    }

    generation += 1
    engine.abort()
    phase = .idle
    partial = ""
  }

  /// Put an explanation away, so it does not outlive its usefulness.
  public func clearFailure() {
    if failure != nil {
      phase = .idle
    }
  }

  /// The field was changed by something other than this session (typing, a send, a command): the
  /// anchor no longer describes it, and a result written now would overwrite the change.
  public func fieldChangedElsewhere() {
    cancel()
  }

  /// The app is no longer in front: the microphone is not kept open behind the reader's back.
  public func sceneChanged(active: Bool) {
    if !active {
      cancel()
    }
  }

  // MARK: What the recogniser says

  private func result(_ text: String, in session: Int) {
    guard session == generation, isActive else {
      return
    }

    partial = text

    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      heard = true
    }

    field.write(anchor.applying(text))
  }

  private func failed(_ failure: RecognitionFailure, in session: Int) {
    guard session == generation else {
      return
    }

    phase = .failed(failure)
  }

  private func ended(_ session: Int) {
    guard session == generation else {
      return
    }

    // A session that was stopped, or ran out, having heard nothing is said so, in a line: a tap that
    // silently did nothing would read as a broken button. The draft is untouched either way.
    if phase == .listening {
      phase = heard ? .idle : .failed(.noSpeech)
    }

    partial = ""
  }
}
