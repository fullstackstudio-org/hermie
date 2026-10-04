import Foundation
import HermieTranscript
import Testing

@testable import HermieCore

/// Voice mode as a state machine over a fake recogniser, speaker, audio session and clock: listen, send,
/// read the reply as it arrives, listen again; and everything that interrupts that.
@Suite(.timeLimit(.minutes(1))) @MainActor struct VoiceModeTests {
  @MainActor
  final class Harness {
    let recogniser = FakeCallRecogniser()
    let speaker = FakeCallSpeaker()
    let audio = FakeCallAudio()
    let clock = ManualVoiceClock()
    let settings = VoiceSettings()
    var sent: [VoiceSubmission] = []
    var accepts = true
    var items: [VisibleItem] = [CallItems.user("u0", "earlier"), CallItems.reply("a0", "An earlier reply.")]
    var turnActive = false
    var activity = TurnActivity.idle
    var requestUp = false
    private(set) var model: VoiceModeModel!

    init(confirm: Bool = false, echo: Bool = true) {
      settings.setConfirmBeforeSending(confirm)
      recogniser.cancelsEcho = echo
      model = VoiceModeModel(
        engines: VoiceModeEngines(recogniser: recogniser, speaker: speaker, audio: audio),
        settings: settings, bot: "hermes", gatewayID: "g1", language: { VoiceSettings.automatic }, clock: clock,
        codeBlock: { "A code block of \($0) lines." },
        fillers: [.generic: 3, .search: 2, .reading: 2, .working: 2],
        fillerText: { "\($0.kind.rawValue) \($0.variant)" },
        send: { [weak self] submission in
          self?.sent.append(submission)
          return self?.accepts ?? false
        })
      publish()
    }

    func publish() {
      model.chatChanged(VoiceChatState(items: items, turnActive: turnActive, activity: activity, requestUp: requestUp))
    }

    /// Put a reply in the transcript, or change it.
    func reply(_ id: String, _ text: String, streaming: Bool) {
      let item = CallItems.reply(id, text, streaming: streaming)

      if let index = items.firstIndex(where: { $0.item.id == id }) {
        items[index] = item
      } else {
        items.append(item)
      }

      publish()
    }

    /// Say `words` and stop talking: the pause sends it.
    func say(_ words: String) async {
      recogniser.hear(words)
      clock.advance(settings.voiceModeSilence)
      await model.settled()
    }

    /// The gateway paints the reader's bubble and starts the turn.
    func turnStarts(_ id: String, _ text: String) {
      items.append(CallItems.user(id, text))
      turnActive = true
      publish()
    }

    var said: [String] { speaker.spoken.map(\.text) }
  }

  // MARK: The loop

  @Test func listenSendSpeakAndListenAgain() async {
    let call = Harness(echo: false)
    await call.model.start()

    #expect(call.audio.active)
    #expect(call.model.phase == .listening)
    #expect(call.recogniser.listening)

    call.recogniser.hear("what's the")
    call.clock.advance(1)
    #expect(call.model.phase == .listening, "still talking: each word restarts the pause")
    await call.say("what's the weather")

    #expect(call.sent == [VoiceSubmission(text: "what's the weather", context: nil)])
    #expect(call.model.phase == .thinking)
    #expect(!call.recogniser.listening, "nothing listens while the bot works")

    call.turnStarts("u1", "what's the weather")
    call.reply("a1", "It is sunny. Tempera", streaming: true)
    #expect(call.model.phase == .speaking)
    #expect(call.said == ["It is sunny."], "the finished sentence is read while the rest streams")

    call.reply("a1", "It is sunny. Temperatures reach 20 degrees.", streaming: false)
    call.turnActive = false
    call.publish()
    call.speaker.finish()
    #expect(call.said == ["It is sunny.", "Temperatures reach 20 degrees."])
    #expect(call.model.phase == .speaking)

    call.speaker.finish()
    #expect(call.model.phase == .listening, "all said and the turn over: the microphone opens again")
    #expect(call.recogniser.listening)
    #expect(call.recogniser.starts == 2)
  }

  @Test func theNextPromptCarriesWhatWasSaidOnTheCall() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("hi")
    call.turnStarts("u1", "hi")
    call.reply("a1", "Hello! How can I help?", streaming: false)
    call.turnActive = false
    call.publish()
    call.speaker.finishAll()

    await call.say("tell me a joke")

    #expect(call.sent.last?.context == "User: hi\nAssistant: Hello! How can I help?")
  }

  @Test func aReplyThatWasThereBeforeTheSendIsNotRead() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("again")

    call.turnActive = true
    call.publish()
    #expect(call.said.isEmpty, "a0 is history")
    #expect(call.model.phase == .thinking)
  }

  @Test func codeIsReadAsItsShapeAndAnUnclosedFenceWaits() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("show me")
    call.turnStarts("u1", "show me")

    call.reply("a1", "Here it is:\n```swift\nlet a = 1\nlet b = 2\nlet c = 3\n", streaming: true)
    #expect(call.said == ["Here it is:"], "the block is not finished: its size is not known yet")

    call.reply("a1", "Here it is:\n```swift\nlet a = 1\nlet b = 2\nlet c = 3\n```\nDone.", streaming: false)
    call.speaker.finish()
    #expect(call.said == ["Here it is:", "A code block of 3 lines.\nDone."])
  }

  @Test func aTurnWithNothingToSayListensAgain() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("do the thing")
    call.turnStarts("u1", "do the thing")
    call.turnActive = false
    call.publish()

    #expect(call.model.phase == .listening)
    #expect(call.said.isEmpty)
  }

  @Test func silenceIsArmedOnlyOnceSomethingWasHeardAndIsTheSettingsLength() async {
    let call = Harness()
    call.settings.setVoiceModeSilence(2)
    await call.model.start()

    call.clock.advance(30)
    #expect(call.model.phase == .listening, "a reader who has not started is not cut off")
    #expect(call.sent.isEmpty)

    call.recogniser.hear("hello")
    call.clock.advance(1.9)
    #expect(call.model.phase == .listening)
    call.clock.advance(0.1)
    await call.model.settled()
    #expect(call.sent.map(\.text) == ["hello"])
  }

  @Test func nothingEmptyIsSent() async {
    let call = Harness()
    await call.model.start()

    call.recogniser.hear("   ")
    call.recogniser.end()

    #expect(call.sent.isEmpty)
    #expect(call.model.phase == .listening)
    #expect(call.recogniser.starts == 2)
  }

  @Test func sendNowTakesWhatWasHeardWithoutWaitingForThePause() async {
    let call = Harness()
    await call.model.start()
    call.recogniser.hear("quick one")
    call.model.sendNow()
    await call.model.settled()

    #expect(call.sent.map(\.text) == ["quick one"])
  }

  @Test func aFinalResultEndsWhatTheReaderSaid() async {
    let call = Harness()
    await call.model.start()
    call.recogniser.hearFinal("Done talking.")
    await call.model.settled()

    #expect(call.sent.map(\.text) == ["Done talking."])
  }

  // MARK: Confirm before sending

  @Test func confirmShowsTheWordsAndWaitsForSend() async {
    let call = Harness(confirm: true)
    await call.model.start()
    await call.say("send this")

    #expect(call.model.phase == .confirming)
    #expect(call.model.pending == "send this")
    #expect(!call.recogniser.listening)
    call.clock.advance(60)
    #expect(call.sent.isEmpty, "it waits: nothing goes by itself")

    call.model.confirmSend()
    await call.model.settled()
    #expect(call.sent.map(\.text) == ["send this"])
  }

  @Test func editChangesTheWordsBeforeTheyGo() async {
    let call = Harness(confirm: true)
    await call.model.start()
    await call.say("send tis")

    call.model.edit()
    #expect(call.model.editing)
    call.model.pending = "send this"
    call.model.sendNow()
    await call.model.settled()

    #expect(call.sent.map(\.text) == ["send this"])
  }

  @Test func discardThrowsTheWordsAwayAndListens() async {
    let call = Harness(confirm: true)
    await call.model.start()
    await call.say("never mind")

    call.model.discard()
    #expect(call.model.phase == .listening)
    #expect(call.model.pending.isEmpty)
    #expect(call.sent.isEmpty)
  }

  // MARK: Cutting in

  @Test func speakingOverAReplyStopsItAndBecomesWhatTheReaderSays() async {
    let call = Harness(echo: true)
    await call.model.start()
    await call.say("tell me a story")
    call.turnStarts("u1", "tell me a story")
    call.reply("a1", "Once upon a time. There was", streaming: true)
    #expect(call.model.phase == .speaking)
    #expect(call.recogniser.listening, "the cut-in microphone is open while the reply is read")

    call.recogniser.hear("uh")
    #expect(call.model.phase == .speaking, "a syllable is not cutting in")

    call.recogniser.hear("wait stop")
    #expect(call.model.phase == .listening)
    #expect(call.model.heard == "wait stop")
    #expect(call.speaker.stops >= 1)

    call.reply("a1", "Once upon a time. There was a dragon.", streaming: true)
    #expect(call.said == ["Once upon a time."], "the rest of the reply that was cut off is not read")

    call.clock.advance(call.settings.voiceModeSilence)
    await call.model.settled()
    #expect(call.sent.last?.text == "wait stop")
    #expect(call.sent.last?.context == "User: tell me a story\nAssistant: Once upon a time. …")
  }

  @Test func withoutEchoCancellingNothingListensWhileSpeakingAndATapCutsIn() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("hello")
    call.turnStarts("u1", "hello")
    call.reply("a1", "A long answer. Very long.", streaming: false)

    #expect(call.model.phase == .speaking)
    #expect(!call.recogniser.listening)

    call.model.interrupt()
    #expect(call.model.phase == .listening)
    #expect(call.recogniser.listening)
  }

  @Test func bargeInCanBeSwitchedOff() async {
    let call = Harness(echo: true)
    call.settings.setVoiceModeBargeIn(false)
    await call.model.start()
    await call.say("hello")
    call.turnStarts("u1", "hello")
    call.reply("a1", "An answer.", streaming: false)

    #expect(call.model.phase == .speaking)
    #expect(!call.recogniser.listening)
  }

  @Test func mutedNothingIsListenedToButTheReplyIsStillRead() async {
    let call = Harness(echo: true)
    await call.model.start()
    await call.say("hello")
    call.model.toggleMute()
    call.turnStarts("u1", "hello")
    call.reply("a1", "An answer.", streaming: false)
    call.turnActive = false
    call.publish()

    #expect(call.model.phase == .speaking)
    #expect(!call.recogniser.listening, "no cut-in microphone while muted")

    call.speaker.finishAll()
    #expect(call.model.phase == .muted)
    #expect(!call.recogniser.listening)

    call.model.toggleMute()
    #expect(call.model.phase == .listening)
    #expect(call.recogniser.listening)
  }

  // MARK: Requests

  @Test func aRequestPausesTheCallAndItResumesAfter() async {
    let call = Harness(echo: true)
    await call.model.start()
    await call.say("delete the logs")
    call.turnStarts("u1", "delete the logs")
    call.reply("a1", "I will ask first. Then", streaming: true)
    #expect(call.model.phase == .speaking)

    call.requestUp = true
    call.activity = .waiting
    call.publish()
    #expect(call.model.phase == .paused(.request))
    #expect(!call.recogniser.listening, "a request is never answered by voice")
    #expect(!call.speaker.speaking)

    call.requestUp = false
    call.activity = .typing
    call.reply("a1", "I will ask first. Then I deleted them.", streaming: false)
    #expect(call.said == ["I will ask first.", "I deleted them."], "what arrived after the answer is read")

    call.turnActive = false
    call.publish()
    call.speaker.finishAll()
    #expect(call.model.phase == .listening)
  }

  @Test func aRequestUpWhenTheCallStartsWaitsForIt() async {
    let call = Harness()
    call.requestUp = true
    call.publish()
    await call.model.start()

    #expect(call.model.phase == .paused(.request))
    #expect(!call.recogniser.listening)

    call.requestUp = false
    call.publish()
    #expect(call.model.phase == .listening)
  }

  // MARK: Background and interruptions

  @Test func leavingTheFrontClosesTheMicrophoneAndComingBackListens() async {
    let call = Harness()
    await call.model.start()
    call.recogniser.hear("half a")

    call.model.sceneChanged(active: false)
    #expect(call.model.phase == .paused(.background))
    #expect(!call.recogniser.listening)
    call.clock.advance(5)
    #expect(call.sent.isEmpty, "what was half said is not sent from the background")

    call.model.sceneChanged(active: true)
    #expect(call.model.phase == .listening)
    #expect(call.recogniser.listening)
  }

  @Test func aReplyGoesOnInTheBackgroundWhenTheSettingSaysSo() async {
    let call = Harness(echo: true)
    call.settings.setStopOnBackground(false)
    await call.model.start()
    await call.say("hello")
    call.turnStarts("u1", "hello")
    call.reply("a1", "An answer.", streaming: false)
    call.turnActive = false
    call.publish()

    call.model.sceneChanged(active: false)
    #expect(call.model.phase == .speaking)
    #expect(!call.recogniser.listening)

    call.speaker.finishAll()
    #expect(call.model.phase == .paused(.background), "done reading: it does not listen from the background")

    call.model.sceneChanged(active: true)
    #expect(call.model.phase == .listening)
  }

  @Test func thePermissionPromptTakingTheFrontDoesNotStopTheStart() async {
    let call = Harness()
    call.recogniser.holdsPermission = true
    let starting = Task { await call.model.start() }
    await call.recogniser.answerPermissionLater {
      call.model.sceneChanged(active: false)
      call.model.sceneChanged(active: true)
    }
    await starting.value

    #expect(call.model.phase == .listening)
  }

  @Test func anInterruptionPausesAndTheCallPicksUpWhenTheSystemSaysSo() async {
    let call = Harness()
    await call.model.start()

    call.audio.post(.interruptionBegan)
    #expect(call.model.phase == .paused(.interruption))
    #expect(!call.recogniser.listening)

    call.audio.post(.interruptionEnded(shouldResume: true))
    #expect(call.audio.reactivations == 1)
    #expect(call.model.phase == .listening)
  }

  @Test func anInterruptionTheSystemDoesNotResumeWaitsForTheReader() async {
    let call = Harness()
    await call.model.start()

    call.audio.post(.interruptionBegan)
    call.audio.post(.interruptionEnded(shouldResume: false))
    #expect(call.model.phase == .paused(.interruption))

    call.model.resumeAfterInterruption()
    #expect(call.model.phase == .listening)
  }

  @Test func aNewRouteRestartsTheMicrophone() async {
    let call = Harness()
    await call.model.start()
    let starts = call.recogniser.starts

    call.audio.post(.routeChanged)
    #expect(call.recogniser.starts == starts + 1)
    #expect(call.model.phase == .listening)
  }

  @Test func audioThatCannotBeRestartedFailsTheCall() async {
    let call = Harness()
    await call.model.start()
    call.audio.post(.failed)

    #expect(call.model.phase == .failed(.audio))
    #expect(!call.audio.active)
  }

  // MARK: The gateway's voice letting the call down

  @Test func aSentenceSpokenByTheDeviceInsteadIsAPassingNoticeSaidOncePerCall() async {
    let call = Harness()
    await call.model.start()
    #expect(call.model.notice == nil)

    call.audio.post(.speechFellBack)

    #expect(call.model.notice == .gatewayVoiceUnavailable)
    #expect(call.model.phase == .listening, "it is not a failure of the call")

    call.model.dismissNotice()
    call.audio.post(.speechFellBack)

    #expect(call.model.notice == nil, "said once, not every sentence")
  }

  @Test func aNewCallSaysItAgainAndAnEndedCallKeepsNothing() async {
    let call = Harness()
    await call.model.start()
    call.audio.post(.speechFellBack)
    call.model.end()

    #expect(call.model.notice == nil)

    await call.model.start()
    call.audio.post(.speechFellBack)

    #expect(call.model.notice == .gatewayVoiceUnavailable)
  }

  // MARK: Failures

  @Test func aRefusedMicrophoneFailsBeforeAnythingOpens() async {
    let call = Harness()
    call.recogniser.permission = .denied
    await call.model.start()

    #expect(call.model.phase == .failed(.recognition(.permission)))
    #expect(call.audio.activations == 0)
    #expect(call.recogniser.starts == 0)
  }

  @Test func audioThatCannotBeHadFailsTheStart() async {
    let call = Harness()
    call.audio.failsToActivate = true
    await call.model.start()

    #expect(call.model.phase == .failed(.audio))
  }

  @Test func noSpeechListensAgainButARecogniserThatKeepsEndingAtOnceFails() async {
    let call = Harness()
    await call.model.start()

    call.recogniser.fail(.noSpeech)
    call.recogniser.end()
    #expect(call.model.phase == .listening)

    for _ in 0..<VoiceModeModel.maxQuickEnds {
      call.recogniser.end()
    }

    #expect(call.model.phase == .failed(.recognition(.failed)))
  }

  @Test func aRecogniserFailureEndsTheCallWithItsReason() async {
    let call = Harness()
    await call.model.start()
    call.recogniser.fail(.unavailable)

    #expect(call.model.phase == .failed(.recognition(.unavailable)))
    #expect(!call.audio.active)
  }

  @Test func aSendTheGatewayRefusedFailsTheCall() async {
    let call = Harness()
    call.accepts = false
    await call.model.start()
    await call.say("hello")

    #expect(call.model.phase == .failed(.notSent))
  }

  @Test func tryingAgainAfterAFailureStartsListening() async {
    let call = Harness()
    call.accepts = false
    await call.model.start()
    await call.say("hello")
    call.accepts = true

    await call.model.start()
    #expect(call.model.phase == .listening)
    #expect(call.audio.active)
  }

  // MARK: Ending

  @Test func endingStopsEverythingFromAnyPhase() async {
    let call = Harness(echo: true)
    await call.model.start()
    await call.say("hello")
    call.turnStarts("u1", "hello")
    call.reply("a1", "Speaking now. More", streaming: true)
    #expect(call.recogniser.listening)
    #expect(call.speaker.speaking)

    call.model.end()

    #expect(call.model.phase == .off)
    #expect(!call.recogniser.listening)
    #expect(!call.speaker.speaking)
    #expect(!call.audio.active)
    call.reply("a1", "Speaking now. More words.", streaming: false)
    #expect(call.said == ["Speaking now."], "nothing is read after the end")
  }

  @Test func endingWhileThePromptIsUpOpensNothing() async {
    let call = Harness()
    call.recogniser.holdsPermission = true
    let starting = Task { await call.model.start() }
    await call.recogniser.answerPermissionLater {
      call.model.end()
    }
    await starting.value

    #expect(call.model.phase == .off)
    #expect(call.recogniser.starts == 0)
  }

  // MARK: Never silent

  @Test func aLineIsSaidWhenTheBotWorksQuietlyFittingItsTool() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("search the news")
    call.turnStarts("u1", "search the news")
    call.activity = .tool("web_search")
    call.publish()

    call.clock.advance(2.9)
    #expect(call.said.isEmpty)
    call.clock.advance(0.2)

    #expect(call.said.count == 1)
    #expect(call.said.first?.hasPrefix("search") == true)
    #expect(call.speaker.cues == 1)
    #expect(call.model.cues == 1)
    #expect(call.model.phase == .speaking)

    call.speaker.finish()
    #expect(call.model.phase == .thinking, "the turn still runs")

    call.clock.advance(5)
    #expect(call.said.count == 1, "not again within the spacing")
    call.clock.advance(8)
    #expect(call.said.count == 2)
    #expect(call.said[0] != call.said[1], "not the same line twice in a row")
  }

  @Test func noLineWhenTheBotSaidOneOfItsOwn() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("look it up")
    call.turnStarts("u1", "look it up")
    call.reply("a1", "Let me look that up.", streaming: false)
    call.speaker.finish()
    #expect(call.model.phase == .thinking)

    call.clock.advance(6)
    #expect(call.said == ["Let me look that up."], "the bot announced it: no filler on top")
  }

  @Test func fillerLinesAreNotPartOfTheContext() async {
    let call = Harness(echo: false)
    await call.model.start()
    await call.say("work")
    call.turnStarts("u1", "work")
    call.clock.advance(3)
    call.speaker.finish()
    call.reply("a1", "Done.", streaming: false)
    call.turnActive = false
    call.publish()
    call.speaker.finishAll()

    await call.say("thanks")
    #expect(call.sent.last?.context == "User: work\nAssistant: Done.")
  }

  // MARK: The orb

  @Test func theOrbFollowsThePhase() async {
    let call = Harness(echo: false)
    #expect(call.model.orbMode == .idle)
    await call.model.start()
    #expect(call.model.orbMode == .listening)
    await call.say("hello")
    #expect(call.model.orbMode == .thinking)
    call.turnStarts("u1", "hello")
    #expect(call.model.busy)
    call.reply("a1", "Hi.", streaming: false)
    #expect(call.model.orbMode == .speaking)
    call.model.toggleMute()
    call.turnActive = false
    call.publish()
    call.speaker.finishAll()
    #expect(call.model.orbMode == .muted)
    #expect(!call.model.busy)
  }
}
