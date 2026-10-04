import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// A synthesiser that holds what it was asked to say: no sound.
@MainActor
private final class MuteSpeaker: VoiceModeSpeaking {
  var isAvailable = true
  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {}
  func stop() {}
  func voices() -> [SpeechVoice] { [] }
  func playCue() {}
}

/// A recogniser that never opens a microphone.
@MainActor
private final class MuteRecogniser: VoiceModeRecognising {
  var isAvailable = true
  var cancelsEcho = false
  func requestPermission() async -> RecognitionPermission { .granted }
  func processing(language: String?) -> RecognitionProcessing { .onDevice }
  func supportedLanguages() -> [String] { ["en-US"] }
  func start(language: String?, events: DictationEvents) {}
  func stop() {}
  func abort() {}
}

/// An audio session that is only ever counted.
@MainActor
private final class MuteAudio: VoiceModeAudio {
  let meters = VoiceMeters()
  var onEvent: (@MainActor (VoiceAudioEvent) -> Void)?
  func activate() throws {}
  func reactivate() throws {}
  func deactivate() {}
}

/// What the chat screen's feed does with the files its bot shared: it holds their media, a voice call has the audio
/// to itself, and leaving the chat stops what plays.
@MainActor
@Suite struct ChatFeedOutboxTests {
  let session = GatewaySession(gatewayID: "feed-outbox", link: UnreachableLink())

  private func feed(_ owner: ChatFeedOwner<ChatFeed>, standardActions: Bool = true) throws -> ChatFeed {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-outbox", bot: "writer"), session: session, standardActions: standardActions) {
        _ in .none
      }
    }
    return try #require(owner.feed)
  }

  @Test func aChatScreensFeedHoldsTheMediaOfItsSharedFilesAndAnotherCallerDoesNot() throws {
    #expect(try feed(ChatFeedOwner<ChatFeed>()).itemActions.outbox != nil)
    #expect(try feed(ChatFeedOwner<ChatFeed>(), standardActions: false).itemActions.outbox == nil)
  }

  @Test func aVoiceCallStopsWhatPlaysAndKeepsAnythingFromStartingUntilItIsOver() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    let media = try #require(feed.itemActions.outbox)
    let settings = VoiceSettings()
    settings.setVoiceModeSetUp(true)
    feed.attachVoice(
      settings: settings,
      engines: VoiceEngines(
        dictation: { MuteRecogniser() }, speech: { MuteSpeaker() },
        call: { VoiceModeEngines(recogniser: MuteRecogniser(), speaker: MuteSpeaker(), audio: MuteAudio()) }))

    var paused = false
    #expect(media.playback.arbiter.claim("sound") { paused = true }, "nothing blocks a sound before the call")

    feed.openVoiceMode()
    #expect(feed.voiceMode != nil)
    #expect(paused, "the call took the audio from the sound")
    #expect(!media.playback.arbiter.claim("another") {}, "and nothing starts while it is on")

    feed.endVoiceMode()
    #expect(feed.voiceMode == nil)
    #expect(media.playback.arbiter.claim("again") {}, "playing is allowed again once the call is over")
    media.stop()
  }

  @Test func leavingTheChatStopsWhatPlaysAndPutsAwayWhatIsUp() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try feed(owner)
    let media = try #require(feed.itemActions.outbox)
    var paused = false
    _ = media.playback.arbiter.claim("sound") { paused = true }
    media.present(pdf: media.files.model(for: OutboxUIFixtures.attachment(.pdf, name: "a.pdf")))

    feed.stop()

    #expect(paused)
    #expect(media.pdf == nil)
    #expect(media.playback.arbiter.activeID == nil)
  }
}
