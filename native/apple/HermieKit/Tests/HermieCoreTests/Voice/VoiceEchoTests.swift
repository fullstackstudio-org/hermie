import Foundation
import Testing

@testable import HermieCore

/// Telling the call's own voice, come back through the microphone, from the reader's.
@Suite struct VoiceEchoTests {
  private func saying(_ text: String) -> VoiceEchoFilter {
    var filter = VoiceEchoFilter()
    filter.said(text)
    return filter
  }

  @Test func whatTheCallIsSayingIsItsOwn() {
    let filter = saying("It is sunny in Amsterdam today.")

    #expect(filter.screen("It is sunny", at: 0) == "")
    #expect(filter.screen("sunny in Amsterdam today", at: 0) == "")
    #expect(filter.screen("It is sunny in Amsterdam today.", at: 0) == "")
  }

  @Test func aMisheardWordDoesNotSaveAnEcho() {
    let filter = saying("It is sunny in Amsterdam today. Temperatures reach twenty degrees.")

    #expect(filter.screen("it is funny in Amsterdam today", at: 0) == "")
    #expect(filter.screen("it is sunny in Amsterdam to day", at: 0) == "", "the last word heard split")
  }

  @Test func theReadersWordsAfterAnEchoAreKept() {
    let filter = saying("It is sunny in Amsterdam today.")

    #expect(filter.screen("it is sunny in Amsterdam no wait", at: 0) == "no wait")
    #expect(filter.screen("sunny in Amsterdam today what about Rotterdam", at: 0) == "what about Rotterdam")
  }

  @Test func whatTheReaderSaysIsKeptWhole() {
    var filter = saying("Do you want the red one or the blue one?")
    filter.stopped(at: 0)

    #expect(filter.screen("what is the weather", at: 0.5) == "what is the weather")
    #expect(filter.screen("yes", at: 0.5) == "yes", "one word of the question is an answer, not an echo")
    #expect(filter.screen("I think the red one is nicer than the green", at: 3) == "I think the red one is nicer than the green")
  }

  @Test func twoWordsInARowAreAnEchoOnlyWhileTheLineIsStillInTheRoom() {
    var filter = saying("Shall I book the table for two?")
    #expect(filter.screen("the table", at: 0) == "", "being said")

    filter.stopped(at: 10)
    #expect(filter.screen("the table", at: 10.5) == "", "just ended")
    #expect(filter.screen("the table", at: 13) == "the table", "later, two words are the reader's")
    #expect(filter.screen("book the table for two", at: 13) == "", "three or more still are not")
  }

  @Test func aLineIsForgottenAfterTheMemory() {
    var filter = saying("Shall I book the table for two?")
    filter.stopped(at: 0)

    #expect(filter.screen("book the table for two", at: VoiceEchoFilter.memory) == "")
    #expect(filter.screen("book the table for two", at: VoiceEchoFilter.memory + 1) == "book the table for two")

    filter.stopped(at: VoiceEchoFilter.memory + 1)
    filter.said("Something new.")
    #expect(filter.screen("book the table for two", at: VoiceEchoFilter.memory + 1) == "book the table for two")
  }

  @Test func aResetForgetsEverything() {
    var filter = saying("It is sunny in Amsterdam today.")
    filter.reset()

    #expect(filter.screen("it is sunny in Amsterdam", at: 0) == "it is sunny in Amsterdam")
  }

  @Test func accentsCaseAndPunctuationAreNotDifferences() {
    let filter = saying("Het café is morgen open, tot vijf uur.")

    #expect(filter.screen("het cafe is morgen open", at: 0) == "")
    #expect(VoiceEchoFilter.words("Het café, is — open!") == ["het", "cafe", "is", "open"])
  }
}
