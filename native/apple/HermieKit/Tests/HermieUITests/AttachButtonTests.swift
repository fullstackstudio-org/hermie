import Testing

@testable import HermieUI

/// The plus beside the composer's field is a flat grey disc with a white plus (as Messages draws
/// it), because a dark glass disc vanished on the black page.
struct AttachButtonTests {
  private static let white = (0xFF, 0xFF, 0xFF)
  private static let black = (0, 0, 0)

  @Test func theDiscStandsOutFromThePageInBothAppearances() {
    let light = AttachPalette.fillLight
    let dark = AttachPalette.fillDark

    // The page is white in light mode and black in dark mode; a shape needs 3:1 against it.
    #expect(ChatBubbleTests.ratio((light.red, light.green, light.blue), Self.white) >= 3)
    #expect(ChatBubbleTests.ratio((dark.red, dark.green, dark.blue), Self.black) >= 3)
  }

  @Test func theWhitePlusStandsOutFromTheDisc() {
    let light = AttachPalette.fillLight
    let dark = AttachPalette.fillDark

    #expect(ChatBubbleTests.ratio((light.red, light.green, light.blue), Self.white) >= 3)
    #expect(ChatBubbleTests.ratio((dark.red, dark.green, dark.blue), Self.white) >= 3)
  }
}
