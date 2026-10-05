import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import HermieCore

/// The pairing code drawn and read back (NX-14): CoreImage draws it, Vision reads it, and what comes out is
/// exactly what went in, for the link and for the offer inside it.
@Suite("Pairing QR codes")
struct PairingQRCodeTests {
  private func png(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))

    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return data as Data
  }

  @Test("the code for a link reads back as that link")
  func roundTrip() throws {
    let offer = GatewayPairingOffer(address: "https://gw.example.test:8443", name: "Home lab", authHint: .nativePKCE)
    let text = try #require(offer.linkString)
    let image = try #require(PairingQRCode.image(for: text))

    #expect(PairingQRCode.payloads(in: image) == [text])
    #expect(PairingQRCode.payloads(in: try png(image)) == [text])
    #expect(try GatewayPairingOffer.offer(fromPayloads: PairingQRCode.payloads(in: image)).get() == offer)
  }

  @Test("a code is drawn with its quiet zone, in whole pixels per module")
  func drawing() throws {
    let small = try #require(PairingQRCode.image(for: "hermie://add-gateway?url=https%3A%2F%2Fa.example", scale: 4))
    let large = try #require(PairingQRCode.image(for: "hermie://add-gateway?url=https%3A%2F%2Fa.example", scale: 8))

    #expect(small.width == small.height)
    #expect(large.width == small.width * 2)
    #expect(small.width % 4 == 0)
    #expect(PairingQRCode.image(for: "") == nil)
    #expect(PairingQRCode.image(for: "x", scale: 0) == nil)
  }

  @Test("a long name still fits a code and reads back whole")
  func longName() throws {
    let name = String(repeating: "Gateway ", count: 8).trimmingCharacters(in: .whitespaces)
    let offer = GatewayPairingOffer(address: "https://a-rather-long-hostname.example.test/prefix", name: name)
    let text = try #require(offer.linkString)
    let image = try #require(PairingQRCode.image(for: text))

    #expect(try GatewayPairingOffer.offer(fromPayloads: PairingQRCode.payloads(in: image)).get() == offer)
  }

  @Test("a picture with no code, a picture that is not one and nothing at all read as no codes")
  func noCodes() throws {
    let blank = try #require(
      CGContext(
        data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue)?.makeImage())

    #expect(PairingQRCode.payloads(in: blank).isEmpty)
    #expect(PairingQRCode.payloads(in: try png(blank)).isEmpty)
    #expect(PairingQRCode.payloads(in: Data("not a picture".utf8)).isEmpty)
    #expect(PairingQRCode.payloads(in: Data()).isEmpty)
  }

  @Test("a hostile code is read as text and is not an offer: another link, a web address, a credential-bearing address")
  func hostileCodes() throws {
    let hostile = [
      "https://evil.example/login",
      "hermie://chat/researcher",
      "hermie://add-gateway?url=https%3A%2F%2Fuser%3Apass%40gw.example.test",
      "hermie://add-gateway?url=http%3A%2F%2Fevil.example",
      "hermie://add-gateway?url=file%3A%2F%2F%2Fetc%2Fpasswd"
    ]

    for text in hostile {
      let image = try #require(PairingQRCode.image(for: text))

      #expect(PairingQRCode.payloads(in: image) == [text], "\(text)")

      let result = GatewayPairingOffer.offer(fromPayloads: PairingQRCode.payloads(in: image))

      #expect((try? result.get()) == nil, "\(text) must not become an offer")
    }
  }
}
