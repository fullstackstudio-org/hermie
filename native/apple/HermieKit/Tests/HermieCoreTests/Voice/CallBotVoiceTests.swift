import Foundation
import Testing

@testable import HermieCore

/// A call reads the bot's voice for each sentence it says, not once when it starts: a voice chosen in the
/// call's voice sheet is heard from the next sentence on.
@Suite(.timeLimit(.minutes(1))) @MainActor struct CallBotVoiceTests {
  /// A call whose bot is mid-reply: the first sentence is being said, the rest has not arrived.
  private func speaking(_ configure: (VoiceSettings) -> Void) async -> VoiceModeTests.Harness {
    let call = VoiceModeTests.Harness(echo: false)
    configure(call.settings)
    await call.model.start()
    await call.say("tell me a story")
    call.turnStarts("u1", "tell me a story")
    call.reply("a1", "Once upon a time. There", streaming: true)
    return call
  }

  @Test func aVoiceChosenDuringTheCallIsUsedFromTheNextSentence() async {
    let call = await speaking {
      $0.setSpeechSource(.gateway)
      $0.setGatewayVoice("voice-rachel")
      $0.setBotVoice(BotVoice(source: .gateway, voice: "voice-adam"), bot: "hermes", gatewayID: "g1")
    }

    #expect(call.said == ["Once upon a time."])
    #expect(call.speaker.spoken[0].source == .gateway)
    #expect(call.speaker.spoken[0].gatewayVoice == "voice-adam", "the bot's own voice, from the first sentence")

    // The voice sheet is open over the call and another voice is chosen for this bot; the next sentence arrives.
    call.settings.setBotVoice(BotVoice(source: .gateway, voice: "voice-bella"), bot: "hermes", gatewayID: "g1")
    call.reply("a1", "Once upon a time. There was a dragon. And", streaming: true)
    call.speaker.finish()

    #expect(call.said == ["Once upon a time.", "There was a dragon."])
    #expect(call.speaker.spoken[1].gatewayVoice == "voice-bella", "the next sentence is in the new voice")

    // Back to Default: the Voice screen's gateway voice speaks.
    call.settings.setBotVoice(nil, bot: "hermes", gatewayID: "g1")
    call.reply("a1", "Once upon a time. There was a dragon. And a knight.", streaming: false)
    call.turnActive = false
    call.publish()
    call.speaker.finish()

    #expect(call.said.last == "And a knight.")
    #expect(call.speaker.spoken[2].gatewayVoice == "voice-rachel")
  }

  @Test func aSentenceAlreadyWaitingInLineIsSpokenInTheVoiceOfTheTimeItIsSaid() async {
    let call = await speaking {
      $0.setBotVoice(BotVoice(source: .gateway, voice: "voice-adam"), bot: "hermes", gatewayID: "g1")
    }

    // The second sentence arrives while the first is still being said, so it waits in line...
    call.reply("a1", "Once upon a time. There was a dragon. And", streaming: true)
    #expect(call.said == ["Once upon a time."])

    // ...and the voice changes before it is its turn.
    call.settings.setBotVoice(BotVoice(source: .gateway, voice: "voice-bella"), bot: "hermes", gatewayID: "g1")
    call.speaker.finish()

    #expect(call.said == ["Once upon a time.", "There was a dragon."])
    #expect(call.speaker.spoken[1].gatewayVoice == "voice-bella")
  }

  @Test func switchingTheBotToTheDeviceMidCallStopsAskingTheGateway() async {
    let call = await speaking { $0.setSpeechSource(.gateway) }

    #expect(call.speaker.spoken[0].source == .gateway)

    call.settings.setBotVoice(BotVoice(source: .apple, voice: "apple.xander"), bot: "hermes", gatewayID: "g1")
    call.reply("a1", "Once upon a time. There was a dragon. And", streaming: true)
    call.speaker.finish()

    #expect(call.speaker.spoken[1].source == .apple)
    #expect(call.speaker.spoken[1].gatewayVoice == nil)
  }
}
