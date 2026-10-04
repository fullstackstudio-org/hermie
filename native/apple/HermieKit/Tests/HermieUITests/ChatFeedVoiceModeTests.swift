import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// A synthesiser that holds what it was asked to say: no sound.
@MainActor
private final class QuietSpeaker: VoiceModeSpeaking {
  var isAvailable = true
  private(set) var spoken: [ReadRequest] = []
  private(set) var stops = 0

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append(request)
  }

  func stop() { stops += 1 }
  func voices() -> [SpeechVoice] { [] }
  func playCue() {}
}

/// A recogniser that never opens a microphone.
@MainActor
private final class DeafRecogniser: VoiceModeRecognising {
  var isAvailable = true
  var cancelsEcho = false
  private(set) var starts = 0
  private(set) var aborts = 0

  func requestPermission() async -> RecognitionPermission { .granted }
  func processing(language: String?) -> RecognitionProcessing { .onDevice }
  func supportedLanguages() -> [String] { ["en-US"] }
  func start(language: String?, events: DictationEvents) { starts += 1 }
  func stop() {}
  func abort() { aborts += 1 }
}

/// An audio session that is only ever counted.
@MainActor
private final class CountedAudio: VoiceModeAudio {
  let meters = VoiceMeters()
  var onEvent: (@MainActor (VoiceAudioEvent) -> Void)?
  private(set) var active = false

  func activate() throws { active = true }
  func reactivate() throws { active = true }
  func deactivate() { active = false }
}

/// Voice mode on the chat screen's feed: the setup that comes first, the call taking the audio from
/// dictation and reading, a request pausing it, and leaving ending it. Fake engines: no audio.
@MainActor
@Suite struct ChatFeedVoiceModeTests {
  let session = GatewaySession(gatewayID: "feed-call", link: UnreachableLink())

  private struct Fixture {
    let feed: ChatFeed
    let speaker: QuietSpeaker
    let recogniser: DeafRecogniser
    let audio: CountedAudio
    let settings: VoiceSettings
  }

  private func make(_ owner: ChatFeedOwner<ChatFeed>, setUp: Bool = true) throws -> Fixture {
    let speaker = QuietSpeaker()
    let recogniser = DeafRecogniser()
    let audio = CountedAudio()
    let settings = VoiceSettings()
    settings.setVoiceModeSetUp(setUp)
    let session = self.session

    owner.appeared {
      let feed = ChatFeed(chat: ChatRef(gatewayId: "feed-call", bot: "writer"), session: session, standardActions: true) {
        _ in .none
      }
      feed.attachVoice(
        settings: settings,
        engines: VoiceEngines(
          dictation: { recogniser }, speech: { speaker },
          call: { VoiceModeEngines(recogniser: recogniser, speaker: speaker, audio: audio) }))
      return feed
    }

    return Fixture(
      feed: try #require(owner.feed), speaker: speaker, recogniser: recogniser, audio: audio, settings: settings)
  }

  /// Wait for the call's start (it runs in a task of its own) to be over.
  private func started(_ feed: ChatFeed) async {
    for _ in 0..<1000 {
      guard let phase = feed.voiceMode?.phase, phase == .off || phase == .starting else {
        return
      }

      await Task.yield()
    }
  }

  private static let answer = AssistantItem(
    base: ItemBase(id: "a1", seq: 2, ts: 1, origin: .history, version: 1), text: "An answer.", streaming: false,
    interim: false)

  @Test func theFirstCallOpensTheVoiceSetupAndStartsWhenItIsDone() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner, setUp: false)

    #expect(call.feed.offersVoiceMode)
    call.feed.openVoiceMode()
    #expect(call.feed.showingVoiceSetup)
    #expect(call.feed.voiceMode == nil)

    call.settings.setVoiceModeSetUp(true)
    call.feed.voiceSetupClosed()
    #expect(!call.feed.showingVoiceSetup)
    #expect(call.feed.voiceMode != nil)

    await started(call.feed)
    #expect(call.feed.voiceMode?.phase == .listening)
    #expect(call.audio.active)
  }

  @Test func closingTheFirstSetupWithoutDoneStartsNoCall() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner, setUp: false)

    call.feed.openVoiceMode()
    call.feed.voiceSetupClosed()
    #expect(call.feed.voiceMode == nil)
  }

  @Test func aCallTakesTheAudioFromReadingAndDictation() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner)

    call.feed.chooseMessageAction(.readAloud, .assistant(Self.answer))
    #expect(call.feed.readAloud?.isReading == true)

    call.feed.openVoiceMode()
    await started(call.feed)

    #expect(call.feed.readAloud?.isReading == false, "the call silences the chat's reader")
    #expect(!call.feed.canReadAloud)

    let dictation = try #require(call.feed.composer.dictation)
    await dictation.start()
    #expect(!dictation.isActive, "the composer's microphone does not open during a call")
  }

  @Test func theCallsSettingsPauseItAndClosingThemPicksItUp() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner)
    call.feed.openVoiceMode()
    await started(call.feed)

    call.feed.openVoiceSetupFromCall()
    #expect(call.feed.voiceMode?.phase == .paused(.request))

    call.feed.voiceSetupClosed()
    #expect(call.feed.voiceMode?.phase == .listening)
  }

  @Test func leavingTheChatEndsTheCall() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner)
    call.feed.openVoiceMode()
    await started(call.feed)

    call.feed.stop()

    #expect(call.feed.voiceMode == nil)
    #expect(!call.audio.active)
    #expect(call.recogniser.aborts >= 1)
  }

  @Test func endingTheCallHandsTheAudioBack() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let call = try make(owner)
    call.feed.openVoiceMode()
    await started(call.feed)

    call.feed.endVoiceMode()
    #expect(call.feed.voiceMode == nil)
    #expect(!call.audio.active)
    #expect(call.feed.canReadAloud)
  }

  @Test func theFillerLinesExistForEveryVariantThePolicyCanChoose() {
    for (kind, count) in VoiceFillerLines.counts {
      let lines = (0..<count).map { VoiceFillerLines.text(VoiceFiller(kind: kind, variant: $0)) }
      #expect(Set(lines).count == count, "\(kind) has \(count) different lines")
      #expect(lines.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    }
  }

  @Test func theStatusLineSaysEveryPhase() {
    let phases: [VoiceModePhase] = [
      .starting, .listening, .confirming, .sending, .thinking, .speaking, .muted, .paused(.request),
      .paused(.background), .paused(.interruption), .failed(.audio), .failed(.notSent),
      .failed(.recognition(.permission)), .failed(.recognition(.unavailable)), .failed(.recognition(.failed))
    ]

    for phase in phases {
      let status = VoiceModeView.status(phase)
      #expect(!status.isEmpty && !status.hasPrefix("native."), "\(phase)")
    }
  }
}
