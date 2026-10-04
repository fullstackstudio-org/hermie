import Foundation
import HermieTranscript
import Testing

@testable import HermieCore

/// The queue of replies being read, over a fake synthesiser that never makes a sound.
@Suite(.timeLimit(.minutes(1))) @MainActor struct ReadAloudTests {
  private func make(
    autoRead: Bool = false, synth: FakeSynthesiser = FakeSynthesiser()
  ) -> (reader: ReadAloudModel, synth: FakeSynthesiser, settings: VoiceSettings) {
    let settings = VoiceSettings()

    if autoRead {
      settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")
    }

    let reader = ReadAloudModel(
      engine: synth, settings: settings, bot: "hermes", gatewayID: "g1",
      codeBlock: { "Code block, \($0) lines" })
    return (reader, synth, settings)
  }

  private func reply(_ id: String, _ text: String = "words") -> ReadableReply {
    ReadableReply(id: id, text: text)
  }

  // MARK: The queue

  @Test func aReplyIsSpokenFlattenedWithTheRateAndLanguageItNeeds() {
    let (reader, synth, settings) = make()
    settings.setRate(1.25)
    settings.setVoiceIdentifier("com.example.voice")

    reader.enqueue(id: "a1", markdown: "**Het** is niet duidelijk dat de gateway een antwoord voor ons heeft.")

    #expect(reader.speakingID == "a1")
    #expect(
      synth.spoken == [
        .init(
          request: ReadRequest(
            id: "a1", text: "Het is niet duidelijk dat de gateway een antwoord voor ons heeft.", language: "nl"),
          rate: 1.25, voice: "com.example.voice")
      ])
  }

  @Test func replyWithNothingToSayIsNotQueued() {
    let (reader, synth, _) = make()

    reader.enqueue(id: "a1", markdown: "   ")
    reader.enqueue(id: "a2", markdown: "---")

    #expect(!reader.isReading)
    #expect(synth.spoken.isEmpty)
  }

  @Test func aSecondReplyWaitsForTheFirstInsteadOfTalkingOverIt() {
    let (reader, synth, _) = make()

    reader.enqueue(id: "a1", markdown: "first")
    reader.enqueue(id: "a2", markdown: "second")

    #expect(reader.speakingID == "a1")
    #expect(reader.queuedIDs == ["a2"])
    #expect(synth.spoken.count == 1)

    synth.finishCurrent()
    #expect(reader.speakingID == "a2")
    #expect(reader.queuedIDs.isEmpty)

    synth.finishCurrent()
    #expect(!reader.isReading)
  }

  @Test func theSameReplyIsNeverInTheQueueTwice() {
    let (reader, synth, _) = make()

    reader.enqueue(id: "a1", markdown: "first")
    reader.enqueue(id: "a1", markdown: "first")
    reader.enqueue(id: "a2", markdown: "second")
    reader.enqueue(id: "a2", markdown: "second")

    #expect(reader.queuedIDs == ["a2"])
    #expect(synth.spoken.count == 1)
  }

  @Test func readAloudAndStopReadingAreOneGesture() {
    let (reader, _, _) = make()

    reader.toggle(id: "a1", markdown: "first")
    reader.toggle(id: "a2", markdown: "second")
    #expect(reader.has("a1") && reader.has("a2"))

    // A waiting reply is taken back out; the one being spoken keeps going.
    reader.toggle(id: "a2", markdown: "second")
    #expect(!reader.has("a2"))
    #expect(reader.speakingID == "a1")

    // Taking out the one being spoken stops everything.
    reader.toggle(id: "a1", markdown: "first")
    #expect(!reader.isReading)
  }

  @Test func aStopIsNotACompletion() {
    let (reader, synth, _) = make()

    reader.enqueue(id: "a1", markdown: "first")
    reader.enqueue(id: "a2", markdown: "second")
    reader.stop()

    #expect(synth.stops == 1)
    #expect(!reader.isReading)

    // The cancelled utterance reports its end, late: it must not start the next one, which is gone,
    // and must not disturb the one that follows.
    reader.enqueue(id: "a3", markdown: "third")
    synth.finishUtterance(at: 0)

    #expect(reader.speakingID == "a3")
    #expect(synth.spoken.count == 2)
  }

  @Test func aSynthesiserWithNoVoicesReadsNothing() {
    let synth = FakeSynthesiser()
    synth.isAvailable = false
    let (reader, _, _) = make(synth: synth)

    reader.enqueue(id: "a1", markdown: "first")
    #expect(!reader.isAvailable)
    #expect(synth.spoken.isEmpty)
  }

  @Test func nothingIsReadWhileTheMicrophoneHasTheAudio() {
    let (reader, synth, _) = make()
    reader.blocked = { true }

    reader.enqueue(id: "a1", markdown: "first")
    #expect(synth.spoken.isEmpty)
  }

  @Test func leavingTheFrontSilencesItOnlyWhenTheSettingSaysSo() {
    let (reader, _, settings) = make()

    reader.enqueue(id: "a1", markdown: "first")
    reader.sceneChanged(active: true)
    #expect(reader.isReading)

    settings.setStopOnBackground(false)
    reader.sceneChanged(active: false)
    #expect(reader.isReading, "the reader asked for it to carry on")

    settings.setStopOnBackground(true)
    reader.sceneChanged(active: false)
    #expect(!reader.isReading)
  }

  // MARK: The automatic read

  @Test func switchingItOnDoesNotReadTheBackCatalogue() {
    let (reader, synth, _) = make(autoRead: true)

    reader.autoRead(replies: [reply("a1"), reply("a2")], turnActive: false)
    #expect(synth.spoken.isEmpty, "the first pass only seeds")

    reader.autoRead(replies: [reply("a1"), reply("a2"), reply("a3", "news")], turnActive: false)
    #expect(synth.spoken.map(\.request.id) == ["a3"])
  }

  @Test func aReplyIsOfferedOnce() {
    let (reader, synth, _) = make(autoRead: true)
    reader.autoRead(replies: [], turnActive: false)

    let replies = [reply("a1")]
    reader.autoRead(replies: replies, turnActive: false)
    synth.finishCurrent()
    reader.autoRead(replies: replies, turnActive: false)
    reader.autoRead(replies: replies, turnActive: false)

    #expect(synth.spoken.count == 1, "a transcript that changes again is not a new reply")
  }

  @Test func nothingIsOfferedWhileATurnRuns() {
    let (reader, synth, _) = make(autoRead: true)
    reader.autoRead(replies: [], turnActive: false)

    reader.autoRead(replies: [reply("a1")], turnActive: true)
    #expect(synth.spoken.isEmpty, "a reply being written will be different in a moment")

    reader.autoRead(replies: [reply("a1")], turnActive: false)
    #expect(synth.spoken.count == 1)
  }

  @Test func olderHistoryPagedInLaterIsNotRead() {
    let (reader, synth, _) = make(autoRead: true)
    reader.autoRead(replies: [reply("a5"), reply("a6")], turnActive: false)

    reader.autoRead(replies: [reply("a1"), reply("a2"), reply("a5"), reply("a6")], turnActive: false)
    #expect(synth.spoken.isEmpty)

    reader.autoRead(replies: [reply("a1"), reply("a2"), reply("a5"), reply("a6"), reply("a7")], turnActive: false)
    #expect(synth.spoken.map(\.request.id) == ["a7"])
  }

  @Test func aNewConversationInTheSameChatReadsItsReplies() {
    let (reader, synth, _) = make(autoRead: true)
    reader.autoRead(replies: [reply("a1"), reply("a2")], turnActive: false)

    // `/new`: the transcript is replaced; the frontier is gone from it.
    reader.autoRead(replies: [reply("b1")], turnActive: false)
    #expect(synth.spoken.map(\.request.id) == ["b1"])
  }

  @Test func switchingItOffForgetsWhereItWasSoSwitchingBackOnSeedsAfresh() {
    let (reader, synth, settings) = make(autoRead: true)
    reader.autoRead(replies: [reply("a1")], turnActive: false)

    settings.setAutoRead(false, bot: "hermes", gatewayID: "g1")
    reader.autoRead(replies: [reply("a1"), reply("a2")], turnActive: false)
    #expect(synth.spoken.isEmpty)

    settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")
    reader.autoRead(replies: [reply("a1"), reply("a2")], turnActive: false)
    #expect(synth.spoken.isEmpty, "what arrived while it was off is not read")
  }

  @Test func theAutomaticReadIsPerChatAndPerGateway() {
    let settings = VoiceSettings()
    settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")

    #expect(settings.autoRead(bot: "hermes", gatewayID: "g1"))
    #expect(!settings.autoRead(bot: "hermes", gatewayID: "g2"))
    #expect(!settings.autoRead(bot: "other", gatewayID: "g1"))
  }

  // MARK: Which replies are readable

  private func item(_ id: String, _ text: String, streaming: Bool = false, interim: Bool = false) -> VisibleItem {
    VisibleItem(
      item: .assistant(
        AssistantItem(
          base: ItemBase(id: id, seq: 1, ts: 1, origin: .history, version: 1), text: text, streaming: streaming,
          interim: interim)),
      presentation: .full)
  }

  @Test func onlyFinishedRepliesOfTheBotAreReadable() {
    let items = [
      item("a1", "finished"), item("a2", "growing", streaming: true), item("a3", "a note", interim: true),
      item("a4", "  "),
      VisibleItem(
        item: .user(UserItem(base: ItemBase(id: "u1", seq: 1, ts: 1, origin: .history, version: 1), text: "mine")),
        presentation: .full)
    ]

    #expect(ReadableReply.replies(in: items) == [ReadableReply(id: "a1", text: "finished")])
  }
}
