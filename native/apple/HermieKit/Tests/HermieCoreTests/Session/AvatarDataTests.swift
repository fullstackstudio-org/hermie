import Foundation
import Testing

@testable import HermieCore

/// `profiles.get_asset` answers with a data URL; the list must read the image bytes out of it.
@Suite struct AvatarDataTests {
  static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0xFE, 0xFF])

  @Test func readsTheGatewaysDataURL() {
    let url = "data:image/png;base64,\(Self.png.base64EncodedString())"
    #expect(AvatarData.bytes(url) == Self.png)
    #expect(AvatarData.bytes("data:image/jpeg;base64,\(Self.png.base64EncodedString())\n") == Self.png)
  }

  @Test func readsBareBase64() {
    #expect(AvatarData.bytes(Self.png.base64EncodedString()) == Self.png)
  }

  @Test func refusesWhatIsNoBase64Image() {
    #expect(AvatarData.bytes("data:image/png,rawtext") == nil)
    #expect(AvatarData.bytes("data:image/png;base64,") == nil)
    #expect(AvatarData.bytes("") == nil)
  }
}
