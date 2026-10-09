import Testing

@testable import HermieUI

/// The one button inside the composer's capsule, as Messages has it: the waveform while the field is
/// empty, send once there is something to send, stop while the bot works.
@MainActor
struct ComposerTrailingControlTests {
  private func resolve(
    listening: Bool = false, stopping: Bool = false, hasText: Bool = false, glyph: Bool = true
  ) -> ComposerView.TrailingControl {
    ComposerView.TrailingControl.resolve(
      listening: listening, stopping: stopping, hasText: hasText, glyphAvailable: glyph)
  }

  @Test func anEmptyFieldOffersDictationWhereTheDeviceCanDictate() {
    #expect(resolve() == .dictation)
  }

  @Test func anEmptyFieldWithoutDictationHasASendThatCannotBePressedYet() {
    #expect(resolve(glyph: false) == .send)
  }

  @Test func textOrAttachmentsMakeItSend() {
    #expect(resolve(hasText: true) == .send)
    #expect(resolve(hasText: true, glyph: false) == .send)
  }

  @Test func theBotAtWorkMakesItStopUnlessThereIsSomethingToQueue() {
    #expect(resolve(stopping: true) == .stop)
    #expect(resolve(stopping: true, glyph: false) == .stop)
    #expect(resolve(stopping: false, hasText: true) == .send)
  }

  @Test func listeningKeepsTheButtonSoItCanBeStopped() {
    // What is heard lands in the field as it is heard: the button must not turn into send under the reader.
    #expect(resolve(listening: true, hasText: true) == .dictation)
    #expect(resolve(listening: true, stopping: true) == .dictation)
  }
}
