import Foundation
import HermieMarkdown
import HermieTranscript
import Observation

/// One reply, flattened for speech: what to say, and the language it is probably in.
public struct ReadRequest: Sendable, Equatable {
  /// The transcript item it came from; unique within one chat.
  public var id: String
  /// Already flattened for speech (`MarkdownSpeech`).
  public var text: String
  /// A BCP-47 tag, or nil for the device's own voice.
  public var language: String?
  /// The voice's pitch, 1 being its own (`VoiceProsody`).
  public var pitch: Double
  /// Where it is spoken from. Set by the reader when it starts the request, from the settings, so a
  /// request made anywhere is spoken the way its bot is set up to be.
  public var source: SpeechSource
  /// The gateway's voice for it, when `source` is the gateway and a voice is chosen.
  public var gatewayVoice: String?

  public init(
    id: String, text: String, language: String? = nil, pitch: Double = 1, source: SpeechSource = .apple,
    gatewayVoice: String? = nil
  ) {
    self.id = id
    self.text = text
    self.language = language
    self.pitch = pitch
    self.source = source
    self.gatewayVoice = gatewayVoice
  }
}

/// A voice the synthesiser can read in, for the settings picker.
public struct SpeechVoice: Sendable, Equatable, Identifiable {
  /// How good a voice sounds, as the system grades it: an enhanced or premium voice is a download.
  public enum Quality: Int, Sendable, Comparable {
    case compact = 0
    case enhanced = 1
    case premium = 2

    public static func < (left: Quality, right: Quality) -> Bool { left.rawValue < right.rawValue }
  }

  public var id: String
  public var name: String
  /// A BCP-47 tag.
  public var language: String
  public var quality: Quality
  /// The reader's own Personal Voice, made on this device and kept on it.
  public var personal: Bool

  public init(id: String, name: String, language: String, quality: Quality = .compact, personal: Bool = false) {
    self.id = id
    self.name = name
    self.language = language
    self.quality = quality
    self.personal = personal
  }
}

/// The platform's synthesiser, behind one seam (`AVSpeechSynthesizer` in the app, a fake in the tests).
/// It speaks ONE thing and knows nothing about messages: the queue that does is `ReadAloudModel`.
@MainActor
public protocol SpeechSynthesizing: AnyObject {
  var isAvailable: Bool { get }
  /// Say `request` at `rate` (1 is the engine's own normal), in `voice` when it is named and fits the
  /// request's language. `onDone` is called once when it has been said or could not be: a failure is a
  /// completion as far as a queue is concerned. It is NOT called for an utterance `stop()` cut.
  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void)
  /// Silence, now.
  func stop()
  /// `request` is next in line: a source that has to fetch its audio may start now. The same arguments
  /// `speak` will get. A synthesiser that has nothing to fetch does nothing (the default).
  func prefetch(_ request: ReadRequest, rate: Double, voice: String?)
  /// The voices this device has, as BCP-47 tags.
  func voices() -> [SpeechVoice]
  /// Whether the reader's Personal Voice may be read with.
  func personalVoiceAccess() -> PersonalVoiceAccess
  /// Ask the system for it (its prompt), and wait.
  func requestPersonalVoiceAccess() async -> PersonalVoiceAccess
}

/// A reply the automatic read may offer: the visible, finished ones, as the transcript shows them.
public struct ReadableReply: Sendable, Equatable {
  public var id: String
  /// The Markdown, not yet flattened.
  public var text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }

  /// The replies of the visible transcript that can be read: the bot's own words, finished (not
  /// streaming, not an interim note, not a failure) and drawn. A reply the reader has chosen not to
  /// see is not a reply they asked to hear. Arriving bot-to-bot traffic is not either, though it can
  /// be read from its menu.
  public static func replies(in items: [VisibleItem]) -> [ReadableReply] {
    items.compactMap { entry in
      guard case .assistant(let reply) = entry.item,
        entry.presentation == .full || entry.presentation == .collapsed,
        !reply.streaming, !reply.interim, reply.error == nil, reply.replyToBotHandle == nil,
        !reply.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else {
        return nil
      }

      return ReadableReply(id: reply.id, text: reply.text)
    }
  }
}

/**
 Which reply is being read, which ones are waiting, and what stops, for one chat
 (`features/voice/reader.ts` and `auto-read.ts` in the Expo app).

 The synthesiser speaks one thing. This is the queue that knows about messages, and a plain class with
 an injected synthesiser so the whole state machine runs without a speaker.

 - **A queue, because "read replies aloud" arms a read on every finished reply**, and a bot can finish
   a second one while the first is still being spoken. Talking over it is unusable and dropping it loses
   a reply the reader asked to hear, so it waits.
 - **Everything is keyed by the message id**, which lets a menu say "Stop reading" on the row being read
   and "Read aloud" on the others, and makes `enqueue` idempotent.
 - **A stop is not a completion.** `stop()` clears the queue and silences the synthesiser, and the
   utterance it just cut must not advance anything: every start captures a generation, and a callback
   from an older one is dropped.
 - **Switching auto-read on does not read the back catalogue**: the replies already on screen are seeded
   as seen, and only what arrives after is offered. Older history paged in later is before the newest
   reply seen and is not offered either. Never while a turn runs: a reply being written is one whose
   text will be different in a moment.
 - **Leaving stops it.** The chat going away, and the app leaving the front when the setting says so,
   silence the speaker.
 */
@MainActor
@Observable
public final class ReadAloudModel {
  /// The id being spoken now.
  public private(set) var speakingID: String?
  /// The ids waiting, in the order they will be read.
  public private(set) var queuedIDs: [String] = []

  @ObservationIgnored private let engine: any SpeechSynthesizing
  @ObservationIgnored private let settings: VoiceSettings
  @ObservationIgnored private let bot: String
  @ObservationIgnored private let gatewayID: String
  @ObservationIgnored private let codeBlock: (Int) -> String
  @ObservationIgnored private var queue: [ReadRequest] = []
  @ObservationIgnored private var generation = 0
  /// Dictation has the microphone (and the audio session): nothing is read until it lets go.
  @ObservationIgnored public var blocked: @MainActor () -> Bool = { false }
  /// The last thing in line has been said (not called for a `stop()`): voice mode listens again.
  @ObservationIgnored public var onDrained: (@MainActor () -> Void)?
  /// A reply is about to be spoken: whatever else plays (a sound a bot shared) stops first.
  @ObservationIgnored public var onSpeak: (@MainActor () -> Void)?

  // The automatic read's bookkeeping.
  @ObservationIgnored private var seeded = false
  @ObservationIgnored private var offered: Set<String> = []
  /// The newest reply seen or offered: what is before it is history.
  @ObservationIgnored private var frontier: String?

  /// - Parameter codeBlock: the sentence for a code block that is summarised, from its line count.
  public init(
    engine: any SpeechSynthesizing, settings: VoiceSettings, bot: String, gatewayID: String,
    codeBlock: @escaping (Int) -> String
  ) {
    self.engine = engine
    self.settings = settings
    self.bot = bot
    self.gatewayID = gatewayID
    self.codeBlock = codeBlock
  }

  /// False where there is no synthesiser: the menu line is not drawn.
  public var isAvailable: Bool { engine.isAvailable }

  /// Something is being read or waits to be.
  public var isReading: Bool { speakingID != nil || !queuedIDs.isEmpty }

  /// Being spoken now, or waiting to be: the menu draws "Stop reading" for both.
  public func has(_ id: String) -> Bool {
    speakingID == id || queuedIDs.contains(id)
  }

  /// Every reply being read or waiting, for the menu's context.
  public var readingIDs: Set<String> {
    Set(queuedIDs).union(speakingID.map { [$0] } ?? [])
  }

  /// This chat reads each finished reply without being asked (`VoiceSettings.setAutoRead`).
  public var autoReadEnabled: Bool { settings.autoRead(bot: bot, gatewayID: gatewayID) }

  /// The voices this device has, for the settings page.
  public var voices: [SpeechVoice] { engine.voices() }

  // MARK: Reading

  /// The request for a reply: flattened for speech, its language guessed from its own words. Per
  /// reply rather than per chat, because a bot that answers in the language it was asked in will switch
  /// mid-conversation. Where the guess declines (most short replies) the device's own voice is right.
  func request(id: String, markdown: String) -> ReadRequest {
    let text = MarkdownSpeech.text(markdown, codeBlock: codeBlock)
    return ReadRequest(
      id: id, text: text, language: MarkdownSpeech.guessLanguage(text),
      pitch: VoiceProsody.pitch(expressivity: settings.expressivity, sentence: 0))
  }

  /// "Read aloud" and "Stop reading" as one gesture: a reply in flight is taken back out, anything else
  /// is queued. Taking out the one being SPOKEN stops everything: a reader who says "stop reading
  /// this" is not asking for the next one to begin at once.
  public func toggle(id: String, markdown: String) {
    if speakingID == id {
      stop()
    } else if queuedIDs.contains(id) {
      queue.removeAll { $0.id == id }
      publish()
    } else {
      enqueue(id: id, markdown: markdown)
    }
  }

  /// Put a reply in line, and start it if nothing is being read. Silently nothing for an empty text,
  /// an id already in flight, or a platform with no synthesiser.
  public func enqueue(id: String, markdown: String) {
    enqueue(request(id: id, markdown: markdown))
  }

  func enqueue(_ request: ReadRequest) {
    guard engine.isAvailable, !blocked(), !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !has(request.id)
    else {
      return
    }

    queue.append(request)

    if speakingID == nil {
      advance()
    } else {
      publish()

      if queue.count == 1 {
        prefetchNext()
      }
    }
  }

  /// Silence, and forget everything waiting.
  public func stop() {
    generation += 1
    queue = []
    speakingID = nil
    engine.stop()
    publish()
  }

  /// The app moved: leaving the front silences the reader when the setting says so.
  public func sceneChanged(active: Bool) {
    if !active, settings.stopOnBackground {
      stop()
    }
  }

  private func advance() {
    guard !queue.isEmpty else {
      speakingID = nil
      publish()
      return
    }

    let (next, voice) = spoken(queue.removeFirst())
    generation += 1
    let current = generation
    speakingID = next.id
    publish()

    onSpeak?()
    engine.speak(next, rate: settings.rate, voice: voice) { [weak self] in
      self?.finished(current)
    }

    prefetchNext()
  }

  /// `request` as this bot speaks it: its source and voices from the settings, and the device voice
  /// that goes with it.
  private func spoken(_ request: ReadRequest) -> (ReadRequest, String?) {
    let choice = settings.speech(bot: bot, gatewayID: gatewayID)
    var resolved = request
    resolved.source = choice.source
    resolved.gatewayVoice = choice.gatewayVoice
    return (resolved, choice.appleVoice)
  }

  /// What is next in line is fetched while the current one is spoken, so there is no gap between two.
  private func prefetchNext() {
    guard let upcoming = queue.first else {
      return
    }

    let (request, voice) = spoken(upcoming)
    engine.prefetch(request, rate: settings.rate, voice: voice)
  }

  private func finished(_ generation: Int) {
    // From an utterance this queue no longer owns.
    guard generation == self.generation else {
      return
    }

    speakingID = nil
    advance()

    if speakingID == nil {
      onDrained?()
    }
  }

  private func publish() {
    let ids = queue.map(\.id)

    if queuedIDs != ids {
      queuedIDs = ids
    }
  }

  // MARK: The automatic read

  /**
   Offer what arrived since the last call to the reader, when this chat reads its replies aloud.

   Called by the chat on every change of the visible transcript, once it is live (a cached copy is not
   a conversation). The first call after the switch is a seed and nothing else.
   */
  public func autoRead(replies: [ReadableReply], turnActive: Bool) {
    guard settings.autoRead(bot: bot, gatewayID: gatewayID) else {
      // Off: forget where we were, so switching it on later seeds afresh rather than reading what
      // arrived in between.
      seeded = false
      offered = []
      frontier = nil
      return
    }

    guard seeded else {
      seeded = true
      offered = Set(replies.map(\.id))
      frontier = replies.last?.id
      return
    }

    for reply in Self.candidates(in: replies, offered: offered, after: frontier, turnActive: turnActive) {
      offered.insert(reply.id)
      frontier = reply.id
      enqueue(id: reply.id, markdown: reply.text)
    }
  }

  /// The replies to read, oldest first: not offered yet, and newer than `frontier` (what is above it
  /// is older history that was paged in). A frontier no longer in the transcript (a new conversation
  /// replaced it) is no limit. None at all while a turn runs.
  static func candidates(
    in replies: [ReadableReply], offered: Set<String>, after frontier: String?, turnActive: Bool
  ) -> [ReadableReply] {
    guard !turnActive else {
      return []
    }

    let start = frontier.flatMap { id in replies.firstIndex { $0.id == id } }.map { $0 + 1 } ?? 0

    return replies[start...].filter { !offered.contains($0.id) }
  }
}

/// Whether the reader's own Personal Voice may be used to read (iOS 17 and macOS 14 on): it is made
/// on the device, kept on it, and the system asks before an app may speak with it.
public enum PersonalVoiceAccess: Sendable, Equatable {
  case notAsked
  case granted
  case denied
  /// This device cannot have one.
  case unsupported
}

extension SpeechSynthesizing {
  public func prefetch(_ request: ReadRequest, rate: Double, voice: String?) {}

  /// Where the synthesiser knows nothing of Personal Voice (the tests' fake).
  public func personalVoiceAccess() -> PersonalVoiceAccess { .unsupported }
  public func requestPersonalVoiceAccess() async -> PersonalVoiceAccess { .unsupported }
}
