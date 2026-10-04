import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// A synthesiser that holds what it was asked to say: no sound.
@MainActor
private final class SilentSynthesiser: SpeechSynthesizing {
  var isAvailable = true
  private(set) var spoken: [ReadRequest] = []
  private(set) var stops = 0

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append(request)
  }

  func stop() { stops += 1 }
  func voices() -> [SpeechVoice] { [] }
}

/// A recogniser that never opens a microphone.
@MainActor
private final class MutedRecogniser: DictationEngine {
  var isAvailable = true
  private(set) var starts = 0
  private(set) var aborts = 0

  func requestPermission() async -> RecognitionPermission { .granted }
  func processing(language: String?) -> RecognitionProcessing { .onDevice }
  func supportedLanguages() -> [String] { ["nl-NL"] }
  func start(language: String?, events: DictationEvents) { starts += 1 }
  func stop() {}
  func abort() { aborts += 1 }
}

/// Voice on the chat screen's feed: the menu line, what choosing it does, the automatic read, and the
/// microphone and the speaker never using the audio at once. Fake engines: no audio, no speech framework.
@MainActor
@Suite struct ChatFeedVoiceTests {
  let session = GatewaySession(gatewayID: "feed-voice", link: UnreachableLink())

  private func makeFeed(
    _ owner: ChatFeedOwner<ChatFeed>, synth: SilentSynthesiser, recogniser: MutedRecogniser, settings: VoiceSettings
  ) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      let feed = ChatFeed(chat: ChatRef(gatewayId: "feed-voice", bot: "writer"), session: session, standardActions: true) {
        _ in .none
      }
      feed.attachVoice(
        settings: settings, engines: VoiceEngines(dictation: { recogniser }, speech: { synth }))
      return feed
    }
    return owner.feed
  }

  private static func base(_ id: String, _ seq: Int) -> ItemBase {
    ItemBase(id: id, seq: seq, ts: 1, origin: .history, version: 1)
  }

  private static let answer = AssistantItem(
    base: base("a1", 2), text: "Autumn **moonlight**", streaming: false, interim: false)

  private func snapshot(_ items: [AssistantItem], turnActive: Bool = false) -> ChatSnapshot {
    ChatSnapshot(
      key: "writer", items: items.map { VisibleItem(item: .assistant($0), presentation: .full) },
      hydration: .live, busy: turnActive, turnActive: turnActive, activity: turnActive ? .working : .idle,
      openRequests: [], queue: [], attached: true, canLoadOlder: false, revision: 1)
  }

  @Test func aChatWithNoVoiceSettingsHasNoMicrophoneAndNoReadAloud() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "feed-voice", bot: "writer"), session: session, standardActions: true) {
        _ in .none
      }
    }
    let feed = try #require(owner.feed)

    #expect(feed.composer.dictation == nil)
    #expect(!feed.canReadAloud)
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.readAloud) == nil)
  }

  @Test func theMenuOffersReadAloudAndChoosingItSpeaksTheReplyFlattened() throws {
    let synth = SilentSynthesiser()
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: MutedRecogniser(), settings: VoiceSettings()))

    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.readAloud) != nil)

    feed.chooseMessageAction(.readAloud, .assistant(Self.answer))
    #expect(synth.spoken.map(\.text) == ["Autumn moonlight."])
    #expect(feed.readAloud?.speakingID == "a1")

    // The same row now offers Stop reading, and choosing it silences the speaker.
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.stopReading) != nil)
    feed.chooseMessageAction(.stopReading, .assistant(Self.answer))
    #expect(feed.readAloud?.isReading == false)
    #expect(synth.stops == 1)
  }

  @Test func aDeviceThatCannotSpeakHasNoReadAloudLine() throws {
    let synth = SilentSynthesiser()
    synth.isAvailable = false
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: MutedRecogniser(), settings: VoiceSettings()))

    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.readAloud) == nil)
  }

  @Test func theMicrophoneSilencesTheReaderAndNothingIsReadWhileItIsOpen() async throws {
    let synth = SilentSynthesiser()
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: MutedRecogniser(), settings: VoiceSettings()))
    let dictation = try #require(feed.composer.dictation)

    feed.chooseMessageAction(.readAloud, .assistant(Self.answer))
    #expect(feed.readAloud?.isReading == true)

    await dictation.start()
    #expect(dictation.isListening)
    #expect(feed.readAloud?.isReading == false, "starting to dictate cuts the reading")
    #expect(!feed.canReadAloud)
    #expect(feed.messageMenu(for: .assistant(Self.answer)).entry(.readAloud) == nil)
  }

  @Test func leavingTheChatSilencesTheReaderAndClosesTheMicrophone() async throws {
    let synth = SilentSynthesiser()
    let recogniser = MutedRecogniser()
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: recogniser, settings: VoiceSettings()))

    await feed.composer.dictation?.start()
    feed.stop()

    #expect(feed.composer.dictation?.isActive == false)
    #expect(recogniser.aborts >= 1)
  }

  @Test func theAppLeavingTheFrontStopsTheMicrophoneAndTheReaderAsTheSettingSays() async throws {
    let synth = SilentSynthesiser()
    let settings = VoiceSettings()
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: MutedRecogniser(), settings: settings))

    feed.chooseMessageAction(.readAloud, .assistant(Self.answer))
    await feed.composer.dictation?.start()
    // Dictation cut the reading above; read again once the microphone is closed.
    feed.sceneChanged(active: false)
    #expect(feed.composer.dictation?.isActive == false, "the microphone is never kept open behind the reader's back")

    feed.chooseMessageAction(.readAloud, .assistant(Self.answer))
    settings.setStopOnBackground(false)
    feed.sceneChanged(active: false)
    #expect(feed.readAloud?.isReading == true)

    settings.setStopOnBackground(true)
    feed.sceneChanged(active: false)
    #expect(feed.readAloud?.isReading == false)
  }

  @Test func aLiveChatThatReadsAloudSpeaksWhatArrivesAfterItWasSwitchedOn() throws {
    let synth = SilentSynthesiser()
    let settings = VoiceSettings()
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner, synth: synth, recogniser: MutedRecogniser(), settings: settings))

    feed.autoRead = true
    #expect(settings.autoRead(bot: "writer", gatewayID: "feed-voice"))

    feed.autoReadChanged(snapshot([Self.answer]))
    #expect(synth.spoken.isEmpty, "what was already there is seeded, not read")

    let fresh = AssistantItem(base: Self.base("a2", 3), text: "A new reply.", streaming: false, interim: false)
    feed.autoReadChanged(snapshot([Self.answer, fresh], turnActive: true))
    #expect(synth.spoken.isEmpty, "never while a turn runs")

    feed.autoReadChanged(snapshot([Self.answer, fresh]))
    #expect(synth.spoken.map(\.id) == ["a2"])
  }
}
