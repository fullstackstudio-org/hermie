import Foundation
import Testing

@testable import HermieUI

/// The composer's two shapes and the button at its trailing end.
@MainActor
@Suite struct ComposerStateMachineTests {
  private func shape(
    focused: Bool = false, content: Bool = false, listening: Bool = false, alwaysCard: Bool = false
  ) -> ComposerPresentation {
    ComposerPresentation.resolve(focused: focused, hasContent: content, listening: listening, alwaysCard: alwaysCard)
  }

  @Test func atRestWithNothingInItItIsAPill() {
    #expect(shape() == .pill)
  }

  @Test func theCaretWordsFilesOrTheMicrophoneOpenItIntoACard() {
    #expect(shape(focused: true) == .card)
    #expect(shape(content: true) == .card)
    #expect(shape(listening: true) == .card)
  }

  @Test func whereThereIsAPointerItIsTheCardAlways() {
    #expect(shape(alwaysCard: true) == .card)
  }

  private func primary(stopping: Bool = false, text: Bool = false, voice: Bool = false) -> ComposerView.PrimaryControl {
    ComposerView.PrimaryControl.resolve(stopping: stopping, hasText: text, voiceAvailable: voice)
  }

  @Test func anEmptyFieldOffersTheVoiceCallWhereThereIsOne() {
    #expect(primary(voice: true) == .voice)
  }

  @Test func anEmptyFieldWithoutVoiceHasASendThatCannotBePressedYet() {
    #expect(primary() == .send)
  }

  @Test func wordsOrFilesMakeItSend() {
    #expect(primary(text: true) == .send)
    #expect(primary(text: true, voice: true) == .send)
  }

  @Test func theBotAtWorkMakesItStopUnlessThereIsSomethingToQueue() {
    #expect(primary(stopping: true) == .stop)
    #expect(primary(stopping: true, voice: true) == .stop)
  }
}

/// The reading column and the prose rhythm the chat is laid out with.
@MainActor
@Suite struct ChatColumnTests {
  @Test func theColumnIsWiderThanAPhoneAndNarrowerThanAWindow() {
    #expect(ChatSpacing.readingColumn > 440)
    #expect(ChatSpacing.readingColumn < 900)
  }

  @Test func theJumpBadgeStopsAtNinetyNine() {
    #expect(JumpToLatestPill.badge(3) == "3")
    #expect(JumpToLatestPill.badge(100) == "99+")
  }
}
