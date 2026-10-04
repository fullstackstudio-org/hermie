import HermieCore
import HermieTranscript

// Voice on a chat screen: the composer's microphone, reading replies aloud, and voice mode's call. The
// models are in HermieCore (`DictationModel`, `ReadAloudModel`, `VoiceModeModel`); this wires them to
// the chat and to the device's settings, and keeps them from using the audio at once.

extension ChatFeed {
  /**
   Give this chat its voice: the microphone on the composer, the reader behind "Read aloud" and the
   chat's automatic read, and the engines a call is made with. Called once, by the screen, before the
   feed starts.

   Dictation and reading share the audio, and a person is either talking or listening: starting to
   dictate silences what is being read, and nothing is read while the microphone is open. A call has
   the audio to itself: neither dictates nor reads while it is on.
   */
  func attachVoice(settings: VoiceSettings, engines: VoiceEngines = .live) {
    guard readAloud == nil else {
      return
    }

    let access = session.speechAccess(profile: chat.bot)
    let reader = ReadAloudModel(
      engine: engines.speech(gateway: access), settings: settings, bot: chat.bot, gatewayID: chat.gatewayId,
      codeBlock: { Strings.Chat.Voice.codeBlock(lines: $0) })
    let dictation = composer.enableDictation(engine: engines.dictation(), settings: settings)

    dictation.onListening = { [weak reader] in reader?.stop() }
    dictation.blocked = { [weak self] in (self?.composer.held ?? true) || self?.voiceMode != nil }
    reader.blocked = { [weak dictation, weak self] in (dictation?.isActive ?? false) || self?.voiceMode != nil }
    readAloud = reader
    voiceSettings = settings
    voiceEngines = engines
    gatewaySpeech = access

    // Whether the gateway can speak is known by the time a reply is read or a call is started.
    if let access {
      Task { await access.loadConfig() }
    }
  }

  /// "Read aloud" appears where the device can speak and the microphone is not open.
  var canReadAloud: Bool {
    (readAloud?.isAvailable ?? false) && !(composer.dictation?.isActive ?? false) && voiceMode == nil
  }

  /// A line of the menu was chosen: the reply's words are read off it now, not when the menu was built.
  func toggleReadAloud(_ item: TranscriptItem) {
    guard let reader = readAloud, let words = MessageMenu.readAloudText(of: item) else {
      return
    }

    reader.toggle(id: item.id, markdown: words)
  }

  /// The visible transcript changed while the chat is live: what has arrived is offered to the
  /// automatic read, which never speaks a reply that is still being written, and to a call.
  func autoReadChanged(_ snapshot: ChatSnapshot) {
    if let call = voiceMode {
      call.chatChanged(voiceState(snapshot))
      return
    }

    guard let reader = readAloud else {
      return
    }

    // Nothing is mapped while the chat does not read aloud: a transcript is walked once per frame.
    let replies = reader.autoReadEnabled ? ReadableReply.replies(in: snapshot.items) : []
    reader.autoRead(replies: replies, turnActive: snapshot.turnActive)
  }

  /// The app moved: what is read stops when the reader asked for it, and the microphone always does.
  func voiceSceneChanged(active: Bool) {
    readAloud?.sceneChanged(active: active)
    composer.dictation?.sceneChanged(active: active)
    voiceMode?.sceneChanged(active: active)
  }

  /// The screen is going: silence, close the microphone, end a call.
  func stopVoice() {
    readAloud?.stop()
    composer.dictation?.cancel()
    endVoiceMode()
  }

  /// This chat reads each finished reply without being asked.
  var autoRead: Bool {
    get { readAloud?.autoReadEnabled ?? false }
    set { voiceSettings?.setAutoRead(newValue, bot: chat.bot, gatewayID: chat.gatewayId) }
  }

  // MARK: Voice mode

  /// Voice mode is offered where the device can listen and speak, and the chat can send.
  var offersVoiceMode: Bool {
    voiceSettings != nil && (composer.dictation?.isAvailable ?? false) && (readAloud?.isAvailable ?? false)
  }

  /**
   The Voice mode button. The first time, the voice setup comes first (choosing the voice the call will
   speak in), and the call starts when it is done.
   */
  func openVoiceMode() {
    guard let settings = voiceSettings, voiceMode == nil else {
      return
    }

    if !settings.voiceModeSetUp {
      pendingCallAfterSetup = true
      showingVoiceSetup = true
      return
    }

    startVoiceMode()
  }

  /// The setup screen was closed. Done on a first run starts the call it was opened for.
  func voiceSetupClosed() {
    showingVoiceSetup = false
    let startCall = pendingCallAfterSetup && voiceSettings?.voiceModeSetUp == true
    pendingCallAfterSetup = false

    if startCall {
      startVoiceMode()
    } else {
      // A call paused for the setup picks up.
      voiceRequestsChanged()
    }
  }

  /// The setup screen, opened from a call's settings glyph: the call pauses under it.
  func openVoiceSetupFromCall() {
    pendingCallAfterSetup = false
    showingVoiceSetup = true
    voiceRequestsChanged()
  }

  /// Start a call on this chat: the composer's microphone and the reader step aside.
  func startVoiceMode() {
    guard let settings = voiceSettings, voiceMode == nil, !stopped else {
      return
    }

    readAloud?.stop()
    composer.dictation?.cancel()
    // A call has the audio to itself: what a bot shared stops, and stays stopped until it ends.
    itemActions.outbox?.playback.stopAll()

    let composer = self.composer
    let call = VoiceModeModel(
      engines: voiceEngines.call(gateway: gatewaySpeech), settings: settings, bot: chat.bot,
      gatewayID: chat.gatewayId,
      language: { settings.dictationLanguage }, clock: SystemVoiceModeClock(),
      codeBlock: { Strings.Chat.Voice.codeBlock(lines: $0) },
      fillers: VoiceFillerLines.counts, fillerText: { VoiceFillerLines.text($0) },
      send: { [weak composer] submission in await composer?.sendSpoken(submission) ?? false })
    voiceMode = call

    if let snapshot = model.snapshot {
      call.chatChanged(voiceState(snapshot))
    } else {
      call.requestChanged(up: voiceRequestPending)
    }

    Task { await call.start() }
  }

  /// End the call; its screen goes with it.
  func endVoiceMode() {
    voiceMode?.end()
    voiceMode = nil
  }

  /// A request came up or went (they are not all in the snapshot): the call pauses or picks up.
  func voiceRequestsChanged() {
    voiceMode?.requestChanged(up: voiceRequestPending)
  }

  /// An approval, a question, a secure prompt or a form is up, or about to be, or the voice setup is
  /// over the call: a call does not listen (or speak) over it.
  var voiceRequestPending: Bool {
    requestUp || requests.nextToPresent != nil || secureInput.nextToPresent != nil
      || interactive.nextToPresent != nil || showingVoiceSetup
  }

  private func voiceState(_ snapshot: ChatSnapshot) -> VoiceChatState {
    VoiceChatState(
      items: snapshot.items, turnActive: snapshot.turnActive, activity: snapshot.activity,
      requestUp: voiceRequestPending)
  }
}
