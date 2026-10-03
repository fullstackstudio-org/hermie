import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import HermieCore

/// What a library photo says about where it was taken, and that it no longer does when it leaves.
@Suite struct AttachmentPrivacyTests {
  private let folder: URL

  init() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("privacy-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  /// A small picture, drawn so its pixels are not flat.
  private func picture() throws -> CGImage {
    let width = 32
    let height = 24
    let context = try #require(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))

    for x in 0..<width {
      context.setFillColor(red: CGFloat(x) / CGFloat(width), green: 0.4, blue: 0.7, alpha: 1)
      context.fill(CGRect(x: x, y: 0, width: 1, height: height))
    }

    return try #require(context.makeImage())
  }

  /// An image of `type` that says where it was taken, in every place a photo says it.
  private func located(_ type: UTType, as name: String, orientation: Int = 1) throws -> URL {
    let url = folder.appendingPathComponent(name)
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))

    let xmp = CGImageMetadataCreateMutable()
    CGImageMetadataRegisterNamespaceForPrefix(
      xmp, kCGImageMetadataNamespacePhotoshop, kCGImageMetadataPrefixPhotoshop, nil)
    CGImageMetadataSetValueWithPath(xmp, nil, "photoshop:City" as CFString, "Amsterdam" as CFString)

    let properties: [CFString: Any] = [
      kCGImagePropertyOrientation: orientation,
      kCGImagePropertyGPSDictionary: [
        kCGImagePropertyGPSLatitude: 52.3676, kCGImagePropertyGPSLatitudeRef: "N",
        kCGImagePropertyGPSLongitude: 4.9041, kCGImagePropertyGPSLongitudeRef: "E"
      ],
      kCGImagePropertyIPTCDictionary: [
        kCGImagePropertyIPTCCity: "Amsterdam", kCGImagePropertyIPTCProvinceState: "Noord-Holland",
        kCGImagePropertyIPTCCountryPrimaryLocationName: "Netherlands", kCGImagePropertyIPTCSubLocation: "Centrum"
      ],
      kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "kept"]
    ]

    CGImageDestinationAddImageAndMetadata(destination, try picture(), xmp, properties as CFDictionary)
    #expect(CGImageDestinationFinalize(destination))
    return url
  }

  private func pixels(_ url: URL) throws -> [UInt8] {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let context = try #require(
      CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let data = try #require(context.data)
    return Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: context.bytesPerRow * image.height))
  }

  @Test func theFixtureSaysWhereItWasTaken() throws {
    let keys = AttachmentPrivacy.locationKeys(in: try located(.jpeg, as: "a.jpg"))

    #expect(keys.contains("GPS"))
    #expect(keys.contains("IPTC City"))
    #expect(keys.contains("IPTC Country"))
    #expect(keys.contains("photoshop:City"))
  }

  @Test func aJPEGIsCopiedWithoutItsLocationAndWithoutBeingEncodedAgain() throws {
    let original = try located(.jpeg, as: "a.jpg")
    let copy = folder.appendingPathComponent("copy.jpg")

    try AttachmentPrivacy.copyWithoutLocation(from: original, to: copy)

    #expect(AttachmentPrivacy.locationKeys(in: copy) == [], "nothing that names a place is left")
    #expect(try pixels(copy) == pixels(original), "the pixels are the picture's own: no second compression")

    let source = try #require(CGImageSourceCreateWithURL(copy as CFURL, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
    #expect(exif?[kCGImagePropertyExifUserComment] as? String == "kept", "what is not about a place stays")
  }

  @Test func aPNGThatImageIOWillNotStripByCopyingIsWrittenAgainLosslesslyAsAPNG() throws {
    let original = try located(.png, as: "a.png")
    #expect(throws: (any Error).self) {
      try AttachmentPrivacy.copyWithoutLocation(from: original, to: folder.appendingPathComponent("copy.png"))
    }

    let staged = try AttachmentStaging.stage(libraryItem: original, name: "a.png")
    defer { AttachmentStaging.discard(staged.url) }

    #expect(staged.name == "a.png", "still a PNG, still the image road")
    #expect(AttachmentPrivacy.locationKeys(in: staged.url) == [], "\(AttachmentPrivacy.locationKeys(in: staged.url))")
    #expect(try pixels(staged.url) == pixels(original), "lossless: the pixels are the picture's own")
  }

  @Test func theConversionKeepsTheOrientationAndNothingElse() throws {
    let original = try located(.png, as: "a.png", orientation: 6)
    let converted = folder.appendingPathComponent("a.jpg")

    try AttachmentPrivacy.convertToJPEG(from: original, to: converted)

    #expect(AttachmentPrivacy.locationKeys(in: converted) == [])
    let source = try #require(CGImageSourceCreateWithURL(converted as CFURL, nil))
    #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    #expect(properties[kCGImagePropertyOrientation] as? Int == 6)
  }

  @Test func aLibraryJPEGIsStagedWithItsNameKeptAndNoLocation() throws {
    let original = try located(.jpeg, as: "IMG_0111.jpeg")

    let staged = try AttachmentStaging.stage(libraryItem: original, name: "IMG_0111.jpeg")
    defer { AttachmentStaging.discard(staged.url) }

    #expect(staged.name == "IMG_0111.jpeg")
    #expect(staged.mimeType == "image/jpeg")
    #expect(AttachmentPrivacy.locationKeys(in: staged.url) == [])
    #expect(AttachmentRules.imageName(for: staged.name, mimeType: staged.mimeType) != nil, "still the image road")
  }

  @Test func aLibraryHEICBecomesAJPEGTheGatewayTakesAsAnImage() throws {
    let original = try located(.heic, as: "IMG_0005.HEIC")
    // The simulator may not write HEIC: then the fixture is not one, and the test has nothing to say.
    try #require(UTType(filenameExtension: "heic")?.conforms(to: .image) == true)
    let source = try #require(CGImageSourceCreateWithURL(original as CFURL, nil))
    try #require(CGImageSourceGetType(source) as String? == UTType.heic.identifier)

    let staged = try AttachmentStaging.stage(libraryItem: original, name: "IMG_0005.HEIC")
    defer { AttachmentStaging.discard(staged.url) }

    #expect(staged.name == "IMG_0005.jpg")
    #expect(AttachmentPrivacy.locationKeys(in: staged.url) == [])
    #expect(AttachmentRules.imageName(for: staged.name, mimeType: staged.mimeType) != nil)
  }

  @Test func aVideoIsStagedAsAFileAsItIs() throws {
    let video = folder.appendingPathComponent("clip.mov")
    try Data(repeating: 0x11, count: 64).write(to: video)

    let staged = try AttachmentStaging.stage(libraryItem: video, name: "clip.mov")
    defer { AttachmentStaging.discard(staged.url) }

    #expect(staged.name == "clip.mov")
    #expect(try Data(contentsOf: staged.url) == Data(repeating: 0x11, count: 64))
    #expect(AttachmentRules.imageName(for: staged.name, mimeType: staged.mimeType) == nil)
  }

  @Test func aFileThatIsNotAnImageAtAllIsRefusedNotSentUnstripped() throws {
    let broken = folder.appendingPathComponent("broken.jpg")
    try Data("not a picture".utf8).write(to: broken)

    #expect(throws: StagingFailure.self) {
      _ = try AttachmentStaging.stage(libraryItem: broken, name: "broken.jpg")
    }
  }

  @Test func jpegNamesFollowTheOriginals() {
    #expect(AttachmentStaging.jpegName(for: "IMG_0005.HEIC") == "IMG_0005.jpg")
    #expect(AttachmentStaging.jpegName(for: "a.b.heif") == "a.b.jpg")
    #expect(AttachmentStaging.jpegName(for: "") == "image.jpg")
  }
}
