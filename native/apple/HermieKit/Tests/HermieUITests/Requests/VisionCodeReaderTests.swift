import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import HermieCore
import HermieProtocol
import Testing
import Vision

@testable import HermieUI

/// The reader the Mac's scanner falls back to when its capture metadata output offers no barcode type: Vision on an
/// image. Run on a QR code drawn here, so the decoding is real; the camera, and so the frames, are not.
@Suite("Code scanner: Vision on frames")
struct VisionCodeReaderTests {
  /// A QR code of `text`, big enough for any reader, on white.
  private static func qr(_ text: String) throws -> CGImage {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"

    let output = try #require(filter.outputImage).transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let padded = output.composited(over: CIImage(color: .white).cropped(to: output.extent.insetBy(dx: -40, dy: -40)))
    return try #require(CIContext().createCGImage(padded, from: padded.extent))
  }

  @Test("a QR code in an image is read, as the kind it is, when the request asks for it")
  func readsAQRCode() throws {
    let image = try Self.qr("https://example.com/box?id=42")
    let code = try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: [.qr, .ean13])
    #expect(code?.value == "https://example.com/box?id=42" && code?.symbology == .qr)

    let any = try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: ScanSymbology.knownCases)
    #expect(any?.symbology == .qr)
  }

  @Test("a code of a kind the request did not ask for is looked past")
  func onlyTheKindsAsked() throws {
    let image = try Self.qr("hello")
    #expect(try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: [.ean13, .ean8]) == nil)
    #expect(try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: []) == nil)
    #expect(try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: [.unknown("upca")]) == nil)
  }

  @Test("an image with no code reads nothing")
  func blank() throws {
    let blank = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 400, height: 400))
    let image = try #require(CIContext().createCGImage(blank, from: blank.extent))
    #expect(try VisionCodeReader.read(VNImageRequestHandler(cgImage: image), wanting: ScanSymbology.knownCases) == nil)
  }

  @Test("the contract's kinds map to Vision's and back")
  func mapping() {
    for kind in ScanSymbology.knownCases {
      let vision = kind.visionSymbology
      #expect(vision != nil, "\(kind.rawValue)")
      #expect(vision.flatMap(ScanSymbology.init(vision:)) == kind)
    }

    #expect(ScanSymbology.unknown("upca").visionSymbology == nil)
    #expect(ScanSymbology(vision: .upce) == nil, "a kind the contract does not name")
  }
}
