import Foundation
import HermieMarkdown
import HermieTranscript
import Observation

/// Where a call is.
public enum VoiceModePhase: Sendable, Equatable {
  /// No call.
  case off
  /// Waiting for the system's permission prompts, and for the audio.
  case starting
  /// The microphone is open for what the reader says.
  case listening
  /// What was heard waits for Send, Edit or Discard ("Confirm before sending").
  case confirming
  /// Handed to the chat; waiting for the gateway to take it.
  case sending
  /// The bot works on it. Nothing is being said.
  case thinking
  /// A reply (or a short line while the bot works) is being read.
  case speaking
  /// The reader muted the microphone, and nothing is being said.
  case muted
  /// The call waits for something else to be done first.
  case paused(VoiceModePause)
  /// The call stopped; the screen says why and offers to try again.
  case failed(VoiceModeFailure)
}

public enum VoiceModePause: Sendable, Equatable {
  /// An approval, a question, a form: answered on its own sheet, never by voice.
  case request
  /// The app is not in front.
  case background
  /// The system took the audio (a phone call, an alarm).
  case interruption
}

/// A small, passing word about the call that is not a failure of it.
public enum VoiceModeNotice: Sendable, Equatable {
  /// The gateway's voice did not answer, so the device's speaks (this sentence, and for a while the next).
  case gatewayVoiceUnavailable
}

public enum VoiceModeFailure: Sendable, Equatable {
  case recognition(RecognitionFailure)
  /// The audio could not be had, or restarted.
  case audio
  /// The message could not be sent.
  case notSent
}

/// What the orb shows, in one of five looks.
public enum VoiceOrbMode: Sendable, Equatable {
  case idle
  case listening
  case thinking
  case speaking
  case muted
}

/// What voice mode needs to know about the chat, from each published snapshot.
public struct VoiceChatState: Sendable, Equatable {
  public var items: [VisibleItem]
  public var turnActive: Bool
  public var activity: TurnActivity
  /// An approval, a secure prompt or an interactive request is waiting for the reader.
  public var requestUp: Bool

  public init(items: [VisibleItem], turnActive: Bool, activity: TurnActivity, requestUp: Bool) {
    self.items = items
    self.turnActive = turnActive
    self.activity = activity
    self.requestUp = requestUp
  }
}

/**
 Voice mode: a hands-free call with a bot. Listen, send, read the reply as it arrives, listen again.

 A class with every side injected (the recogniser, the synthesiser, the audio session, the clock and
 the send), because what goes wrong in a loop like this is order and timing, and none of it can be
 produced by a person in front of a simulator: a reply that arrives while the microphone is open, a
 recogniser's last word landing after the reader cut in, a request arriving mid-sentence.

 # The rules

 1. **Nothing empty is sent.** A pause with nothing in it goes back to listening.
 2. **Silence ends what the reader says, and sends it.** `VoiceSettings.voiceModeSilence` after the
    last word heard (armed only once something has been heard, so a reader who takes a moment to start
    is not cut off), or a tap on Send now.
 3. **"Confirm before sending", where it is turned on, shows the words first,** with Send, Edit and
    Discard, and waits. Off by default: a call is hands-free.
 4. **The reply is read while it streams**, a sentence at a time as each one can no longer change
    (`SpokenReplyCutter`), code read as its shape. When the last of it has been said and the turn is
    over, the microphone opens again.
 5. **The call never hears itself.** On a loudspeaker the echo canceller lets some of the reply
    through, and the recogniser writes it down. So the microphone is closed while a reply is read (half
    duplex), and opens `echoTail` after the last of it; words that repeat what the call said lately
    are not the reader's (`VoiceEchoFilter`), wherever they are heard.
 6. **The reader can cut in.** A tap always stops the reading and listens. Speaking does too where the
    route keeps the speaker out of the microphone (a headset), or where the reader turned it on, and
    the recogniser cancels the speaker's echo: then the microphone stays open while a reply is read,
    and at least `bargeInWords` words of the reader's own stop it and become what the reader is saying.
 7. **A request is never answered by voice.** An approval, a question or a form pauses the call; it is
    answered on its own sheet, and the call picks up after.
 8. **Never silent without a reason.** While the bot works and nothing has been said for a few seconds,
    a short line fitting what it does is said (`VoiceFillerPolicy`), with a soft sound.
 9. **Leaving ends everything,** from any phase, in one call: no microphone stays open and no speaker
    keeps talking after the screen has gone. The app leaving the front closes the microphone.

 A `generation` is bumped by every microphone session started or closed, and a recogniser's report
 from an older one is dropped.
 */
@MainActor
@Observable
public final class VoiceModeModel {
  public private(set) var phase = VoiceModePhase.off
  /// What the reader is saying, as the recogniser hears it now.
  public private(set) var heard = ""
  /// What was heard, waiting for Send (`confirming`); the screen edits it in place after Edit.
  public var pending = ""
  /// Edit was chosen: the words are in a field.
  public private(set) var editing = false
  /// The bot's reply as it arrives, as plain text, for the caption.
  public private(set) var reply = ""
  public private(set) var muted = false
  /// The bot is working on a turn of this call.
  public private(set) var busy = false
  /// Bumped each time a "still working" line is said: the screen's haptic hangs on it.
  public private(set) var cues = 0
  /// Something the reader should know that does not stop the call. Said once per call; the screen
  /// shows it for a moment and clears it with `dismissNotice()`.
  public private(set) var notice: VoiceModeNotice?

  @ObservationIgnored private let recogniser: any VoiceModeRecognising
  @ObservationIgnored private let speaker: any VoiceModeSpeaking
  @ObservationIgnored private let audio: any VoiceModeAudio
  @ObservationIgnored private let settings: VoiceSettings
  @ObservationIgnored private let reader: ReadAloudModel
  @ObservationIgnored private let clock: any VoiceModeClock
  @ObservationIgnored private let language: @MainActor () -> String
  @ObservationIgnored private let codeBlock: (Int) -> String
  @ObservationIgnored private let fillerText: @MainActor (VoiceFiller) -> String
  @ObservationIgnored private let send: @MainActor (VoiceSubmission) async -> Bool

  private enum MicRole {
    /// Listening for what the reader says next.
    case utterance
    /// Open while a reply is read, for the reader cutting in.
    case watch
  }

  /// What this call is doing with the reply to the last thing it sent.
  private struct Turn {
    /// The items there were before it was sent: none of them is its reply.
    var baseline: Set<String>
    /// The turn has been seen running, or a reply of it has arrived.
    var seen = false
    var cutters: [String: SpokenReplyCutter] = [:]
    var languages: [String: String] = [:]
    /// The pieces handed to the reader, in order.
    var pieces: [ReadRequest] = []
  }

  @ObservationIgnored private var mic: (session: Int, role: MicRole, opened: Double)?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var startTicket = 0
  @ObservationIgnored private var sendTicket = 0
  @ObservationIgnored private var sendTask: Task<Void, Never>?
  @ObservationIgnored private var silenceTimer: (any VoiceModeTimer)?
  /// The microphone opens when it runs out: the echo of what was just said has died away.
  @ObservationIgnored private var tailTimer: (any VoiceModeTimer)?
  @ObservationIgnored private var fillerTimer: (any VoiceModeTimer)?
  @ObservationIgnored private var turn: Turn?
  @ObservationIgnored private var latest: VoiceChatState?
  @ObservationIgnored private var audioActive = false
  /// A reply goes on being read with the app in the background (the setting says so); the call
  /// pauses when it is done.
  @ObservationIgnored private var backgroundSpeaking = false
  /// The cut-in microphone failed for this reply; it is not tried again until the next.
  @ObservationIgnored private var watchBroken = false
  /// Microphone sessions in a row that ended at once with nothing heard: a recogniser that cannot
  /// listen, not a quiet reader.
  @ObservationIgnored private var quickEnds = 0
  @ObservationIgnored private var fillers: VoiceFillerPolicy
  @ObservationIgnored private var fillerSerial = 0
  @ObservationIgnored private var log = VoiceContextLog()
  /// The notice has been raised on this call.
  @ObservationIgnored private var noticed = false
  /// What the call said lately, so that its echo is not taken for the reader.
  @ObservationIgnored private var echo = VoiceEchoFilter()
  /// When the call last stopped speaking.
  @ObservationIgnored private var quietSince: Double?

  /// Words heard while a reply is read count as the reader cutting in from this many words of the
  /// reader's own on (the call's echo taken out): a cough, a stray syllable or a word of the reply that
  /// came back through the echo canceller does not.
  public static let bargeInWords = 2
  /// How long after the call stops speaking the microphone stays closed, in seconds: the room's echo
  /// and the speaker's last buffer die away.
  public static let echoTail = 0.4
  /// A microphone session that ends sooner than this with nothing heard is a quick end.
  static let quickEnd = 0.5
  static let maxQuickEnds = 5

  /// - Parameters:
  ///   - language: the dictation language setting, read at each listen.
  ///   - codeBlock: the sentence for a code block that is summarised, from its line count.
  ///   - fillers: how many lines each kind of "still working" line has; `fillerText` says one.
  ///   - send: put the words on the conversation; true when the gateway took them.
  public init(
    engines: VoiceModeEngines,
    settings: VoiceSettings,
    bot: String,
    gatewayID: String,
    language: @escaping @MainActor () -> String,
    clock: any VoiceModeClock,
    codeBlock: @escaping (Int) -> String,
    fillers: [VoiceFillerKind: Int],
    fillerText: @escaping @MainActor (VoiceFiller) -> String,
    send: @escaping @MainActor (VoiceSubmission) async -> Bool
  ) {
    recogniser = engines.recogniser
    speaker = engines.speaker
    audio = engines.audio
    self.settings = settings
    self.clock = clock
    self.language = language
    self.codeBlock = codeBlock
    self.fillerText = fillerText
    self.send = send
    self.fillers = VoiceFillerPolicy(variants: fillers)
    reader = ReadAloudModel(engine: engines.speaker, settings: settings, bot: bot, gatewayID: gatewayID, codeBlock: codeBlock)
    reader.onDrained = { [weak self] in self?.drained() }
  }

  /// The device can listen and speak: the entry points are drawn only where it can.
  public var isAvailable: Bool { recogniser.isAvailable && speaker.isAvailable }

  /// A call is on (in any phase, failed included, until it is ended).
  public var isActive: Bool { phase != .off }

  /// The microphone's and the speaker's levels, for the orb.
  public var meters: VoiceMeters { audio.meters }

  /// What the orb shows.
  public var orbMode: VoiceOrbMode {
    switch phase {
    case .listening: .listening
    case .speaking: .speaking
    case .starting, .sending, .thinking: .thinking
    case .muted, .paused: .muted
    case .off, .confirming, .failed: .idle
    }
  }

  /// The id being read now (a piece of a reply, or a filler line), for the tests.
  var speakingID: String? { reader.speakingID }

  /// What has been said on this call, for `voice_context`.
  var context: String? { log.rendered() }

  // MARK: The call

  /// Ask for the microphone, take the audio and start listening. Again after a failure.
  public func start() async {
    switch phase {
    case .off, .failed: break
    default: return
    }

    startTicket += 1
    let ticket = startTicket
    phase = .starting
    muted = false
    quickEnds = 0
    log = VoiceContextLog()
    notice = nil
    noticed = false
    echo.reset()
    quietSince = nil

    guard recogniser.isAvailable else {
      phase = .failed(.recognition(.unavailable))
      return
    }

    let permission = await recogniser.requestPermission()

    // Ended while the prompt was up.
    guard ticket == startTicket, phase == .starting else {
      return
    }

    switch permission {
    case .granted: break
    case .denied:
      phase = .failed(.recognition(.permission))
      return
    case .unavailable:
      phase = .failed(.recognition(.unavailable))
      return
    }

    audio.onEvent = { [weak self] event in self?.audioEvent(event) }

    do {
      try audio.activate()
      audioActive = true
    } catch {
      phase = .failed(.audio)
      return
    }

    if latest?.requestUp == true {
      phase = .paused(.request)
    } else {
      listen()
    }
  }

  /// End the call: the microphone closes, the speaker stops, the audio is handed back.
  public func end() {
    startTicket += 1
    sendTicket += 1
    sendTask?.cancel()
    sendTask = nil
    closeMic()
    cancelTimers()
    reader.stop()
    turn = nil
    backgroundSpeaking = false
    watchBroken = false
    releaseAudio()
    phase = .off
    heard = ""
    pending = ""
    editing = false
    reply = ""
    busy = false
    notice = nil
  }

  /// The screen has shown the notice.
  public func dismissNotice() {
    notice = nil
  }

  /// Send what has been heard now rather than waiting for the pause; on the confirmation, Send.
  public func sendNow() {
    switch phase {
    case .listening: finishUtterance()
    case .confirming: confirmSend()
    default: break
    }
  }

  /// Send what waits for confirmation (as edited).
  public func confirmSend() {
    guard phase == .confirming else {
      return
    }

    let text = pending.trimmingCharacters(in: .whitespacesAndNewlines)

    if text.isEmpty {
      listen()
    } else {
      dispatch(text)
    }
  }

  /// Edit what waits for confirmation before sending it.
  public func edit() {
    if phase == .confirming {
      editing = true
    }
  }

  /// Throw away what waits for confirmation, and listen again.
  public func discard() {
    if phase == .confirming {
      listen()
    }
  }

  /// A tap while a reply is read: stop reading and listen.
  public func interrupt() {
    guard phase == .speaking else {
      return
    }

    cutOff()
    listen()
  }

  /// Mute or unmute the microphone. Muted, nothing is listened to; a reply is still read.
  public func toggleMute() {
    muted.toggle()

    if muted {
      if mic != nil {
        closeMic()
      }

      if phase == .listening {
        tailTimer?.cancel()
        tailTimer = nil
        heard = ""
        phase = .muted
      }
    } else if phase == .muted {
      listen()
    } else if phase == .speaking {
      watchIfEligible()
    }
  }

  /// Pick up after an interruption the system did not say to resume from.
  public func resumeAfterInterruption() {
    guard phase == .paused(.interruption) else {
      return
    }

    do {
      try audio.reactivate()
      audioActive = true
    } catch {
      fail(.audio)
      return
    }

    resume()
  }

  /// Wait for a send in flight to be answered (the tests).
  func settled() async {
    await sendTask?.value
  }

  // MARK: What happens around the call

  /// The chat published a new snapshot.
  public func chatChanged(_ state: VoiceChatState) {
    latest = state

    guard phase != .off else {
      return
    }

    if state.requestUp {
      pauseForRequest()
      return
    }

    if phase == .paused(.request) {
      resume()
      return
    }

    switch phase {
    case .sending, .thinking, .speaking: follow(state)
    default: break
    }
  }

  /// A request came up or went without a new snapshot (a secure prompt, a form, the voice setup).
  public func requestChanged(up: Bool) {
    var state = latest ?? VoiceChatState(items: [], turnActive: false, activity: .idle, requestUp: up)
    state.requestUp = up
    chatChanged(state)
  }

  /// The app came to the front or left it.
  public func sceneChanged(active: Bool) {
    guard phase != .off else {
      return
    }

    if active {
      backgroundSpeaking = false

      if phase == .paused(.background) {
        resume()
      } else if phase == .speaking {
        watchIfEligible()
      }

      return
    }

    // The microphone is never kept open behind the reader's back.
    closeMic()

    switch phase {
    case .speaking where !settings.stopOnBackground:
      backgroundSpeaking = true
    case .listening, .muted, .sending, .thinking, .speaking:
      pause(.background)
    case .off, .starting, .confirming, .paused, .failed:
      // Starting: the permission prompt itself takes the app out of the front.
      break
    }
  }

  private func audioEvent(_ event: VoiceAudioEvent) {
    guard phase != .off else {
      return
    }

    switch event {
    case .interruptionBegan:
      switch phase {
      case .off, .starting, .failed, .paused(.interruption): break
      default:
        backgroundSpeaking = false
        pause(.interruption)
      }
    case .interruptionEnded(let shouldResume):
      if shouldResume {
        resumeAfterInterruption()
      }
    case .routeChanged:
      guard let mic else {
        // A headset came in while a reply is read: the reader may cut in by voice now.
        watchIfEligible()
        return
      }

      // The microphone's format went with the route: a session on the old one hears nothing more.
      closeMic()

      if mic.role == .watch {
        watchIfEligible()
      } else if phase == .listening {
        let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)

        if words.isEmpty {
          listen()
        } else {
          commit(words)
        }
      }
    case .failed:
      fail(.audio)
    case .speechFellBack:
      if !noticed {
        noticed = true
        notice = .gatewayVoiceUnavailable
      }
    }
  }

  // MARK: Listening

  private var recognitionLanguage: String? {
    let setting = language()
    return setting == VoiceSettings.automatic ? nil : setting
  }

  private func listen() {
    cancelTimers()
    editing = false
    pending = ""
    heard = ""

    if muted {
      closeMic()
      phase = .muted
      return
    }

    phase = .listening

    // Just after the call spoke, the room still has its voice in it.
    let wait = quietSince.map { $0 + Self.echoTail - clock.now } ?? 0

    guard wait > 0 else {
      openMic(.utterance)
      return
    }

    tailTimer = clock.after(wait) { [weak self] in
      guard let self else {
        return
      }

      tailTimer = nil

      if phase == .listening, mic == nil, !muted {
        openMic(.utterance)
      }
    }
  }

  private func openMic(_ role: MicRole) {
    closeMic()
    generation += 1
    let session = generation
    mic = (session, role, clock.now)

    recogniser.start(
      language: recognitionLanguage,
      events: DictationEvents(
        onPartial: { [weak self] text in self?.partial(text, session: session, final: false) },
        onFinal: { [weak self] text in self?.partial(text, session: session, final: true) },
        onError: { [weak self] failure in self?.micFailed(failure, session: session) },
        onEnd: { [weak self] in self?.micEnded(session) }
      ))
  }

  private func closeMic() {
    silenceTimer?.cancel()
    silenceTimer = nil

    guard mic != nil else {
      return
    }

    generation += 1
    mic = nil
    recogniser.abort()
  }

  private func partial(_ text: String, session: Int, final: Bool) {
    guard session == generation, let mic else {
      return
    }

    // The call's own voice, come back through the microphone, is not the reader's.
    let own = echo.screen(text, at: clock.now)
    let words = own.trimmingCharacters(in: .whitespacesAndNewlines)

    switch (mic.role, phase) {
    case (.utterance, .listening):
      heard = own

      if !words.isEmpty {
        quickEnds = 0
      }

      if final {
        finishUtterance()
      } else if !words.isEmpty {
        armSilence()
      }
    case (.watch, .speaking):
      guard Self.cutsIn(words) else {
        return
      }

      bargeIn(own)

      if final {
        finishUtterance()
      }
    default:
      break
    }
  }

  /// Words heard over a reply (the call's echo taken out) that count as the reader cutting in.
  static func cutsIn(_ words: String) -> Bool {
    words.split(whereSeparator: \.isWhitespace).filter { $0.contains(where: \.isLetter) }.count >= bargeInWords
  }

  private func micFailed(_ failure: RecognitionFailure, session: Int) {
    guard session == generation, let mic else {
      return
    }

    // Nothing said yet is not an error on a call: the end that follows listens again.
    guard failure != .noSpeech else {
      return
    }

    if mic.role == .watch {
      closeMic()
      watchBroken = true
      return
    }

    fail(.recognition(failure))
  }

  private func micEnded(_ session: Int) {
    guard session == generation, let ended = mic else {
      return
    }

    mic = nil
    let quick = clock.now - ended.opened < Self.quickEnd

    switch (ended.role, phase) {
    case (.utterance, .listening):
      let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)

      if !words.isEmpty {
        commit(words)
      } else if quick, quickEnds + 1 >= Self.maxQuickEnds {
        fail(.recognition(.failed))
      } else {
        quickEnds = quick ? quickEnds + 1 : 0
        listen()
      }
    case (.watch, .speaking):
      if quick {
        quickEnds += 1
        watchBroken = quickEnds >= Self.maxQuickEnds
      }

      watchIfEligible()
    default:
      break
    }
  }

  private func armSilence() {
    silenceTimer?.cancel()
    silenceTimer = clock.after(settings.voiceModeSilence) { [weak self] in
      self?.silenceTimer = nil
      self?.finishUtterance()
    }
  }

  /// The reader has finished: take what was heard.
  private func finishUtterance() {
    guard phase == .listening else {
      return
    }

    let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)
    closeMic()
    commit(words)
  }

  private func commit(_ words: String) {
    guard !words.isEmpty else {
      listen()
      return
    }

    if settings.confirmBeforeSending {
      closeMic()
      cancelTimers()
      heard = ""
      pending = words
      editing = false
      phase = .confirming
    } else {
      dispatch(words)
    }
  }

  // MARK: Sending

  private func dispatch(_ text: String) {
    closeMic()
    cancelTimers()
    editing = false
    pending = ""
    heard = text
    reply = ""
    watchBroken = false
    phase = .sending

    let context = log.rendered()
    sendTicket += 1
    let ticket = sendTicket
    turn = Turn(baseline: Set((latest?.items ?? []).map(\.item.id)))

    sendTask = Task { [weak self, send] in
      let taken = await send(VoiceSubmission(text: text, context: context))
      self?.sent(taken, text: text, ticket: ticket)
    }
  }

  private func sent(_ taken: Bool, text: String, ticket: Int) {
    guard ticket == sendTicket else {
      return
    }

    sendTask = nil

    guard taken else {
      turn = nil
      fail(.notSent)
      return
    }

    log.add(.user, text)
    fillers.began(at: clock.now)

    guard phase == .sending else {
      // Paused (or already reading) while the send was out.
      return
    }

    phase = .thinking
    busy = true
    scheduleFiller()

    if let latest {
      follow(latest)
    }
  }

  // MARK: The reply

  /// Read what has arrived of the reply that can no longer change; listen again when it is all said
  /// and the turn is over.
  private func follow(_ state: VoiceChatState) {
    guard var turn else {
      return
    }

    if state.turnActive {
      turn.seen = true
    }

    if case .tool(let name) = state.activity {
      fillers.toolStarted(name)
    }

    var said = false
    var caption: String?

    for item in Self.replies(in: state.items, after: turn.baseline) {
      turn.seen = true
      var cutter = turn.cutters[item.id] ?? SpokenReplyCutter()
      let finished = !item.streaming || !state.turnActive

      if let words = cutter.take(item.text, finished: finished, codeBlock: codeBlock) {
        let language = turn.languages[item.id] ?? MarkdownSpeech.guessLanguage(
          MarkdownSpeech.text(item.text, codeBlock: codeBlock))

        if let language {
          turn.languages[item.id] = language
        }

        let piece = ReadRequest(
          id: "\(item.id)#\(turn.pieces.count)", text: words, language: language,
          pitch: VoiceProsody.pitch(expressivity: settings.expressivity, sentence: turn.pieces.count))
        turn.pieces.append(piece)
        echo.said(words)
        reader.enqueue(piece)
        said = true
      }

      turn.cutters[item.id] = cutter
      caption = item.text
    }

    self.turn = turn

    if let caption {
      let plain = MarkdownPlainText.block(caption)

      if reply != plain {
        reply = plain
      }
    }

    if busy != state.turnActive {
      busy = state.turnActive
    }

    if said {
      fillers.botSpoke(at: clock.now)
    }

    if said, reader.isReading, phase == .thinking || phase == .sending {
      beginSpeaking()
    } else if phase == .thinking, !state.turnActive, turn.seen, !reader.isReading {
      finishTurn()
      listen()
    }
  }

  /// The bot's replies after the reader's last message that were not there before it was sent.
  static func replies(in items: [VisibleItem], after baseline: Set<String>) -> [AssistantItem] {
    let lastUser = items.lastIndex { entry in
      if case .user = entry.item { true } else { false }
    }
    let start = lastUser.map { $0 + 1 } ?? 0

    return items[start...].compactMap { entry in
      guard case .assistant(let reply) = entry.item, !baseline.contains(reply.id), reply.error == nil,
        reply.replyToBotHandle == nil
      else {
        return nil
      }

      return reply
    }
  }

  private func beginSpeaking() {
    fillerTimer?.cancel()
    fillerTimer = nil
    phase = .speaking
    watchIfEligible()
  }

  /// Speaking cuts in on a reply: on a headset, or where the reader turned it on. On a loudspeaker the
  /// echo canceller lets enough of the reply through for the recogniser to hear the bot as the reader,
  /// so there it takes a tap unless the reader asked for it.
  public var cutsInBySpeaking: Bool {
    recogniser.cancelsEcho && (settings.voiceModeBargeIn || audio.headsetRoute)
  }

  /// Open the cut-in microphone, where it can be.
  private func watchIfEligible() {
    guard phase == .speaking, mic == nil, cutsInBySpeaking, !muted, !watchBroken, !backgroundSpeaking else {
      return
    }

    openMic(.watch)
  }

  /// Everything in line has been said.
  private func drained() {
    guard phase == .speaking else {
      return
    }

    // What the cut-in microphone heard while the reply was read is not carried over.
    closeMic()
    quiet()

    if backgroundSpeaking {
      backgroundSpeaking = false
      pause(.background)
      return
    }

    if let turn, latest?.turnActive == true || !turn.seen {
      phase = .thinking
      scheduleFiller()
      return
    }

    finishTurn()
    listen()
  }

  /// The reader cut in: what was read so far goes on record, the rest of the reply is not read.
  private func bargeIn(_ text: String) {
    guard let current = mic else {
      return
    }

    cutOff()
    mic = (current.session, .utterance, current.opened)
    phase = .listening
    heard = text
    armSilence()
  }

  /// Stop reading the reply here.
  private func cutOff() {
    let speaking = reader.speakingID

    if let turn {
      let through = turn.pieces.firstIndex { $0.id == speaking }.map { $0 + 1 } ?? turn.pieces.count
      let heard = turn.pieces.prefix(through).map(\.text).joined(separator: " ")

      if !heard.isEmpty {
        log.add(.assistant, heard + " …")
      }
    }

    turn = nil
    busy = false
    reader.stop()
    quiet()
    cancelTimers()
  }

  /// The call stopped speaking (the reply was said, cut off or put aside): the microphone waits for
  /// the echo to die away, and the echo filter starts counting.
  private func quiet() {
    quietSince = clock.now
    echo.stopped(at: clock.now)
  }

  /// The reply has been read to the end.
  private func finishTurn() {
    if let turn {
      log.add(.assistant, turn.pieces.map(\.text).joined(separator: " "))
    }

    turn = nil
    busy = false
  }

  // MARK: Saying something while the bot works

  private func scheduleFiller() {
    fillerTimer?.cancel()
    fillerTimer = nil

    guard phase == .thinking, turn != nil else {
      return
    }

    fillerTimer = clock.after(fillers.wait(from: clock.now)) { [weak self] in
      self?.fillerTimer = nil
      self?.fillerDue()
    }
  }

  private func fillerDue() {
    guard phase == .thinking, turn != nil else {
      return
    }

    let now = clock.now

    guard fillers.due(at: now) else {
      scheduleFiller()
      return
    }

    let filler = fillers.next(at: now)
    fillerSerial += 1
    speaker.playCue()
    cues += 1
    let line = fillerText(filler)
    echo.said(line)
    reader.enqueue(
      ReadRequest(
        id: "filler#\(fillerSerial)", text: line,
        pitch: VoiceProsody.pitch(expressivity: settings.expressivity, sentence: 0)))

    if reader.isReading {
      beginSpeaking()
    } else {
      scheduleFiller()
    }
  }

  // MARK: Pausing

  private func pauseForRequest() {
    switch phase {
    case .listening, .muted, .sending, .thinking, .speaking:
      backgroundSpeaking = false
      pause(.request)
    case .off, .starting, .confirming, .paused, .failed:
      break
    }
  }

  /// Stop listening and reading; what has arrived of the reply by now is not read later.
  private func pause(_ reason: VoiceModePause) {
    closeMic()
    cancelTimers()

    if reader.isReading {
      quiet()
    }

    reader.stop()

    if var turn, let latest {
      for item in Self.replies(in: latest.items, after: turn.baseline) {
        var cutter = turn.cutters[item.id] ?? SpokenReplyCutter()
        cutter.skip(item.text)
        turn.cutters[item.id] = cutter
      }

      self.turn = turn
    }

    heard = ""
    phase = .paused(reason)
  }

  /// Pick up where the call was: still waiting on the bot, or listening.
  private func resume() {
    if latest?.requestUp == true {
      phase = .paused(.request)
      return
    }

    guard turn != nil else {
      listen()
      return
    }

    phase = .thinking
    busy = latest?.turnActive ?? false
    scheduleFiller()

    if let latest {
      follow(latest)
    } else {
      finishTurn()
      listen()
    }
  }

  private func fail(_ failure: VoiceModeFailure) {
    closeMic()
    cancelTimers()
    reader.stop()
    turn = nil
    busy = false
    backgroundSpeaking = false
    releaseAudio()
    heard = ""
    phase = .failed(failure)
  }

  private func cancelTimers() {
    silenceTimer?.cancel()
    silenceTimer = nil
    tailTimer?.cancel()
    tailTimer = nil
    fillerTimer?.cancel()
    fillerTimer = nil
  }

  private func releaseAudio() {
    if audioActive {
      audio.deactivate()
      audioActive = false
    }

    audio.onEvent = nil
  }
}
