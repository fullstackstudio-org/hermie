import HermieCore
import HermieTranscript

// Voice on a chat screen: the composer's microphone and reading replies aloud. The models are in
// HermieCore (`DictationModel`, `ReadAloudModel`); this wires them to the chat and to the device's
// settings, and keeps the two from using the audio at once.

extension ChatFeed {
  /**
   Give this chat its voice: the microphone on the composer, and the reader behind "Read aloud" and the
   chat's automatic read. Called once, by the screen, before the feed starts.

   Dictation and reading share the audio, and a person is either talking or listening: starting to
   dictate silences what is being read, and nothing is read while the microphone is open.
   */
  func attachVoice(settings: VoiceSettings, engines: VoiceEngines = .live) {
    guard readAloud == nil else {
      return
    }

    let reader = ReadAloudModel(
      engine: engines.speech(), settings: settings, bot: chat.bot, gatewayID: chat.gatewayId,
      codeBlock: { Strings.Chat.Voice.codeBlock(lines: $0) })
    let dictation = composer.enableDictation(engine: engines.dictation(), settings: settings)

    dictation.onListening = { [weak reader] in reader?.stop() }
    reader.blocked = { [weak dictation] in dictation?.isActive ?? false }
    readAloud = reader
    voiceSettings = settings
  }

  /// "Read aloud" appears where the device can speak and the microphone is not open.
  var canReadAloud: Bool {
    (readAloud?.isAvailable ?? false) && !(composer.dictation?.isActive ?? false)
  }

  /// A line of the menu was chosen: the reply's words are read off it now, not when the menu was built.
  func toggleReadAloud(_ item: TranscriptItem) {
    guard let reader = readAloud, let words = MessageMenu.readAloudText(of: item) else {
      return
    }

    reader.toggle(id: item.id, markdown: words)
  }

  /// The visible transcript changed while the chat is live: what has arrived is offered to the
  /// automatic read, which never speaks a reply that is still being written.
  func autoReadChanged(_ snapshot: ChatSnapshot) {
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
  }

  /// The screen is going: silence, and close the microphone.
  func stopVoice() {
    readAloud?.stop()
    composer.dictation?.cancel()
  }

  /// This chat reads each finished reply without being asked.
  var autoRead: Bool {
    get { readAloud?.autoReadEnabled ?? false }
    set { voiceSettings?.setAutoRead(newValue, bot: chat.bot, gatewayID: chat.gatewayId) }
  }
}
