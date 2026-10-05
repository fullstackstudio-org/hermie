import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import Vision

/**
 The QR code of a pairing link, drawn, and the QR codes in a picture, read (NX-14).

 Both halves are Apple's own: CoreImage draws the code (error correction `M`, so a screen photo or a
 printout survives a little damage) and Vision reads them back, the same barcode request the code
 scanner uses for frames. Reading a picture is how "import a photo of a code" works on the iPhone,
 the iPad and the Mac alike, and what the tests round-trip.

 What is read is text and nothing else: it is handed to `GatewayPairingOffer`, which decides whether
 it is an offer. Nothing here opens a link, and a picture that is not a picture, or is far too big,
 reads as no codes.
 */
public enum PairingQRCode {
  /// The quiet zone the standard asks for, in modules.
  static let quietZone = 4
  /// The largest picture read, in bytes: a photo from a camera is a few megabytes.
  public static let maxImageBytes = 32 * 1024 * 1024
  /// The largest picture read, in pixels on a side and in all: a picture bigger than any camera makes is
  /// refused unread (a small file can hold a decompression bomb), and one that is read is scaled down.
  public static let maxSide = 20_000
  public static let maxPixels = 120_000_000
  /// What a picture is scaled down to before Vision looks at it: far more than a code needs.
  public static let readSide = 3_000

  /// The code for `text` as an image: black modules on white with the quiet zone, `scale` pixels to
  /// a module, no smoothing. Nil when the text cannot be encoded (empty, or too long for a code).
  public static func image(for text: String, scale: Int = 8) -> CGImage? {
    guard !text.isEmpty, scale > 0 else {
      return nil
    }

    let filter = CIFilter.qrCodeGenerator()

    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"

    guard let output = filter.outputImage else {
      return nil
    }

    let modules = Int(output.extent.width.rounded())

    guard modules > 0, let core = CIContext().createCGImage(output, from: output.extent) else {
      return nil
    }

    let side = (modules + 2 * quietZone) * scale

    guard
      let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else {
      return nil
    }

    context.setFillColor(gray: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    // Modules stay square: no interpolation when the small image is blown up.
    context.interpolationQuality = .none
    context.draw(
      core, in: CGRect(x: quietZone * scale, y: quietZone * scale, width: modules * scale, height: modules * scale))

    return context.makeImage()
  }

  /// The text of every QR code in a picture's bytes (PNG, JPEG, HEIC…), in the order Vision found them.
  public static func payloads(in data: Data) -> [String] {
    guard !data.isEmpty, data.count <= maxImageBytes else {
      return []
    }

    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= maxSide, height <= maxSide, width * height <= maxPixels
    else {
      return []
    }

    // Decoded at no more than `readSide`, with its orientation applied: the full-size bitmap of a big
    // photo is never made.
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: readSide
    ]

    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      return []
    }

    return payloads(handler: VNImageRequestHandler(cgImage: image, options: [:]))
  }

  /// The text of every QR code in an image, unless the image is bigger than `maxSide` and `maxPixels`.
  public static func payloads(in image: CGImage) -> [String] {
    guard image.width <= maxSide, image.height <= maxSide, image.width * image.height <= maxPixels else {
      return []
    }

    return payloads(handler: VNImageRequestHandler(cgImage: image, options: [:]))
  }

  private static func payloads(handler: VNImageRequestHandler) -> [String] {
    let request = VNDetectBarcodesRequest()

    request.symbologies = [.qr]

    // A picture Vision cannot read is no code.
    guard (try? handler.perform([request])) != nil else {
      return []
    }

    return (request.results ?? []).compactMap { observation in
      guard let value = observation.payloadStringValue, !value.isEmpty else {
        return nil
      }

      return value
    }
  }
}
