import CoreGraphics
import Foundation
import HermieCore
import ImageIO
import Testing

@testable import HermieUI

/// The parts of the bot settings screen that are plain functions: the picture a photo becomes, which
/// models a search lets through, the words for a failure, and the router's way in. (The views
/// themselves are not driven by UI tests.)
struct BotSettingsViewTests {
  // MARK: The picture

  /// A solid-colour image of `width` by `height`, encoded as `type`.
  private static func image(width: Int, height: Int, type: String = "public.png", properties: [CFString: Any] = [:]) -> Data
  {
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // A mark off the middle, so a crop that lost the middle would be seen.
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: width / 2 - 5, y: height / 2 - 5, width: 10, height: 10))

    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(output, type as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, properties as CFDictionary)
    CGImageDestinationFinalize(destination)
    return output as Data
  }

  @Test func aPhotoBecomesASquareJpegOfTheLimitedSize() throws {
    let encoded = try #require(AvatarEncoder.base64(from: Self.image(width: 1600, height: 900)))
    let jpeg = try #require(Data(base64Encoded: encoded))

    // JPEG's own signature, not the PNG it came in as.
    #expect(Array(jpeg.prefix(3)) == [0xFF, 0xD8, 0xFF])
    #expect(jpeg.count <= AvatarEncoder.byteLimit)

    let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    #expect(properties[kCGImagePropertyPixelWidth] as? Int == AvatarEncoder.side)
    #expect(properties[kCGImagePropertyPixelHeight] as? Int == AvatarEncoder.side)
  }

  @Test func aSmallPhotoIsCroppedButNeverBlownUp() throws {
    let encoded = try #require(AvatarEncoder.base64(from: Self.image(width: 120, height: 200)))
    let jpeg = try #require(Data(base64Encoded: encoded))
    let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])

    #expect(properties[kCGImagePropertyPixelWidth] as? Int == 120)
    #expect(properties[kCGImagePropertyPixelHeight] as? Int == 120)
  }

  @Test func theLocationOfAPhotoDoesNotTravel() throws {
    let located = Self.image(
      width: 400, height: 400, type: "public.jpeg",
      properties: [
        kCGImagePropertyGPSDictionary: [
          kCGImagePropertyGPSLatitude: 52.37, kCGImagePropertyGPSLatitudeRef: "N",
          kCGImagePropertyGPSLongitude: 4.89, kCGImagePropertyGPSLongitudeRef: "E"
        ],
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "private"]
      ])

    // The input really has it.
    let before = try #require(CGImageSourceCreateWithData(located as CFData, nil))
    let beforeProperties = try #require(CGImageSourceCopyPropertiesAtIndex(before, 0, nil) as? [CFString: Any])
    #expect(beforeProperties[kCGImagePropertyGPSDictionary] != nil)

    let encoded = try #require(AvatarEncoder.base64(from: located))
    let jpeg = try #require(Data(base64Encoded: encoded))
    let after = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let afterProperties = try #require(CGImageSourceCopyPropertiesAtIndex(after, 0, nil) as? [CFString: Any])

    #expect(afterProperties[kCGImagePropertyGPSDictionary] == nil)
    // ImageIO writes a few technical Exif fields of its own; what the photo carried is gone.
    let exif = afterProperties[kCGImagePropertyExifDictionary] as? [CFString: Any]
    #expect(exif?[kCGImagePropertyExifUserComment] == nil)
  }

  @Test func whatIsNotAnImageIsNotAPicture() {
    #expect(AvatarEncoder.base64(from: Data("not an image".utf8)) == nil)
    #expect(AvatarEncoder.base64(from: Data()) == nil)
  }

  // MARK: The model picker

  private let choices = [
    BotModelChoice(provider: "example-provider", providerName: "Example Provider", model: "example-model"),
    BotModelChoice(provider: "example-provider", providerName: "Example Provider", model: "expensive-model"),
    BotModelChoice(provider: "second-provider", providerName: "Second Provider", model: "reasoner-2")
  ]

  @Test func choicesAreSectionedByProviderInTheGatewaysOrder() {
    let sections = ModelChoiceList.sections(of: choices)

    #expect(sections.map(\.id) == ["example-provider", "second-provider"])
    #expect(sections.map(\.name) == ["Example Provider", "Second Provider"])
    #expect(sections.map { $0.choices.count } == [2, 1])
    #expect(ModelChoiceList.sections(of: []).isEmpty)
  }

  @Test func aSearchMatchesTheIdThePrettyNameOrTheProvider() {
    #expect(ModelChoiceList.matching(choices, query: "").count == 3)
    #expect(ModelChoiceList.matching(choices, query: "  ").count == 3)
    #expect(ModelChoiceList.matching(choices, query: "expensive").map(\.model) == ["expensive-model"])
    #expect(ModelChoiceList.matching(choices, query: "second").map(\.model) == ["reasoner-2"])
    // Every word has to match, in any order.
    #expect(ModelChoiceList.matching(choices, query: "model example").map(\.model) == ["example-model", "expensive-model"])
    #expect(ModelChoiceList.matching(choices, query: "nothing like it").isEmpty)
  }

  @Test func theCurrentModelIsTheOneWithTheSameProviderAndTheSameId() {
    let bare = BotModelPin(provider: "second-provider", model: "reasoner-2")
    let prefixed = BotModelPin(provider: "second-provider", model: "second-provider/reasoner-2")

    #expect(ModelChoiceList.isCurrent(choices[2], pin: bare))
    // A leading `provider/` is part of another model's name, not a spelling of this one.
    #expect(!ModelChoiceList.isCurrent(choices[2], pin: prefixed))
    #expect(!ModelChoiceList.isCurrent(choices[0], pin: bare))
    // The same id under another provider is another model; an unpinned bot has none.
    #expect(!ModelChoiceList.isCurrent(choices[2], pin: BotModelPin(provider: "example-provider", model: "reasoner-2")))
    #expect(!ModelChoiceList.isCurrent(choices[0], pin: BotModelPin()))
  }

  @Test func onTheMacTheModelSearchIsNotInTheWindowsToolbar() {
    // A `.searchable` on a page pushed beside the sidebar's own search makes AppKit raise while it
    // inserts the second search item into the one NSToolbar, and the app ends (0.2.6, macOS).
    #if os(macOS)
      #expect(ModelSearchPlacement.current == .inline)
    #else
      #expect(ModelSearchPlacement.current == .navigationBar)
    #endif
  }

  // MARK: Words

  @Test func everyFailureHasWordsAndTheGatewaysAreOnlyUsedWhenItSentSome() {
    let failures: [BotSettingsFailure] = [
      .forbidden("no"), .unsupported, .offline, .notFound("x"), .notApplied, .lastToolset, .refused("disk full"),
      .refused("")
    ]

    for failure in failures {
      #expect(!BotSettingsText.message(for: failure, handle: "researcher").isEmpty)
    }

    #expect(BotSettingsText.message(for: .refused("disk full"), handle: "r").contains("disk full"))
    #expect(!BotSettingsText.message(for: .refused(""), handle: "r").contains("disk full"))
    // An access denial says the same thing whatever the gateway's words were.
    #expect(
      BotSettingsText.message(for: .forbidden("x"), handle: "r") == BotSettingsText.message(for: .forbidden("y"), handle: "r"))
    #expect(BotSettingsText.message(for: .notFound("x"), handle: "researcher").contains("researcher"))
  }

  @Test func everyColourHasAName() {
    let names = BotAccent.allCases.map { BotSettingsText.name(of: $0) }

    #expect(names.allSatisfy { !$0.isEmpty })
    #expect(Set(names).count == BotAccent.allCases.count)
  }

  // MARK: The way in

  @MainActor
  @Test func openingTheSettingsSelectsTheChatAndPushesThePageOnce() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")

    router.showBotSettings(chat)
    #expect(router.selectedChat == chat)
    #expect(router.detailPath == [.botProfile(chat)])

    // Asked again while it is showing: nothing is stacked.
    router.showBotSettings(chat)
    #expect(router.detailPath == [.botProfile(chat)])

    // From another chat's page, the new chat opens clean and gets its own settings.
    let other = ChatRef(gatewayId: "g1", bot: "writer")
    router.showBotSettings(other)
    #expect(router.selectedChat == other)
    #expect(router.detailPath == [.botProfile(other)])
  }

  // MARK: Long text fields

  @Test func equalBoundsSelectTheFixedHeightEditorAndUnequalBoundsKeepTheGrowingField() {
    #expect(BotLongTextLayout.isFixedHeight(12...12))
    #expect(BotLongTextLayout.isFixedHeight(18...18))
    #expect(!BotLongTextLayout.isFixedHeight(3...8))
  }

  @Test func theEditorIsAsTallAsItsLinesPlusTheInset() {
    let inset = BotLongTextLayout.verticalInset

    #expect(BotLongTextLayout.height(lines: 12, lineHeight: 20) == 240 + 2 * inset)
    #expect(BotLongTextLayout.height(lines: 18, lineHeight: 17.5) == 315 + 2 * inset)
    // Never less than one line.
    #expect(BotLongTextLayout.height(lines: 0, lineHeight: 20) == 20 + 2 * inset)
  }

  @Test func aBodyLineHasARealHeight() {
    #expect(BotLongTextLayout.baseLineHeight > 10)
    #expect(BotLongTextLayout.baseLineHeight < 40)
  }
}
