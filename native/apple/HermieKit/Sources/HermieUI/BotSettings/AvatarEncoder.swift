import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/**
 Prepares a picked photo to be a bot's picture: turned upright, cropped to a square from the
 middle, scaled down to `side` points and written as a JPEG, and handed back as the bare base64
 `profiles.set_asset` takes (PNG, JPEG or WebP up to 2 MB).

 Nothing of the original is kept but its pixels: the photo is decoded and drawn again, so its
 metadata, location included, does not travel to the gateway, where every client can read the
 picture.
 */
enum AvatarEncoder {
  /// The gateway's own limit on a picture's bytes.
  static let byteLimit = 2_000_000
  /// The edge of the square picture, in pixels. The largest place it is drawn is smaller.
  static let side = 512

  /// The base64 of the prepared picture, or nil when `data` is not an image this can read or the
  /// result would not fit the gateway's limit.
  static func base64(from data: Data) -> String? {
    guard let square = squareImage(from: data) else {
      return nil
    }

    // Quality steps down until it fits; a 512-pixel square at 0.85 is far below the limit.
    for quality in [0.85, 0.7, 0.5] {
      if let jpeg = jpeg(square, quality: quality), jpeg.count <= byteLimit {
        return jpeg.base64EncodedString()
      }
    }

    return nil
  }

  /// The picture's middle square at `side` pixels (smaller when the photo is), upright.
  static func squareImage(from data: Data) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
      return nil
    }

    // The thumbnail path applies the photo's orientation and never decodes more than it must.
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: side * 2
    ]

    guard let upright = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      return nil
    }

    let edge = min(upright.width, upright.height)

    guard edge > 0 else {
      return nil
    }

    let crop = CGRect(x: (upright.width - edge) / 2, y: (upright.height - edge) / 2, width: edge, height: edge)

    guard let cropped = upright.cropping(to: crop) else {
      return nil
    }

    let target = min(edge, side)

    guard
      let context = CGContext(
        data: nil, width: target, height: target, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else {
      return nil
    }

    context.interpolationQuality = .high
    context.draw(cropped, in: CGRect(x: 0, y: 0, width: target, height: target))
    return context.makeImage()
  }

  /// The image as JPEG, with no properties of its own: only the pixels are written.
  static func jpeg(_ image: CGImage, quality: Double) -> Data? {
    let output = NSMutableData()

    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
      return nil
    }

    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)

    return CGImageDestinationFinalize(destination) ? output as Data : nil
  }
}
