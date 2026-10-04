import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import HermieCore

/// The vectors of the fake gateway's allowlist (`Tests/Vectors/signature-svg.json`, written by
/// `packages/fake-gateway/scripts/dump-signature-svg-vectors.ts`): the port must agree with the gateway's rules on
/// every file.
@Suite("The signature SVG allowlist")
struct SignatureSVGRulesTests {
  struct Vector: Decodable, Sendable, CustomTestStringConvertible {
    var name: String
    var mime: String
    var base64: String
    var accepted: Bool
    var word: String?

    var testDescription: String { name }
    var bytes: Data { Data(base64Encoded: base64) ?? Data() }
  }

  private struct File: Decodable {
    var vectors: [Vector]
  }

  static let vectors: [Vector] = {
    let url = DeviceExamples.vectorsDirectory.appendingPathComponent("signature-svg.json")

    guard let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data) else {
      return []
    }

    return file.vectors
  }()

  @Test("the vectors are there, and both kinds of verdict are in them")
  func vectorsExist() {
    #expect(Self.vectors.count > 150)
    #expect(Self.vectors.filter(\.accepted).count > 40)
    #expect(Self.vectors.filter { !$0.accepted }.count > 100)
  }

  @Test("every file is taken or refused as the gateway takes or refuses it", arguments: SignatureSVGRulesTests.vectors)
  func agreesWithTheGateway(vector: Vector) {
    let problem = SignatureSVGRules.typeProblem(mime: vector.mime, data: vector.bytes)
    #expect((problem == nil) == vector.accepted, "\(vector.name): the gateway says \(vector.accepted ? "accepted" : "refused")")

    // For an SVG the word of the first problem is the gateway's too.
    if vector.mime == "image/svg+xml", !vector.accepted, let want = vector.word, want != "encoding" {
      #expect(SignatureSVGRules.problem(in: vector.bytes) == want, "\(vector.name)")
    }
  }

  @Test("a linear reading of a megabyte of anything")
  func linear() {
    let ns = "xmlns=\"http://www.w3.org/2000/svg\""
    let blobs = [
      String(repeating: "<!---->", count: 150_000) + "x",
      String(repeating: "<use ", count: 200_000),
      " on" + String(repeating: "a", count: 1_000_000),
      String(repeating: "<!--", count: 250_000),
      "<svg " + String(repeating: "onx ", count: 250_000),
      String(repeating: " ", count: 1_000_000) + "<svg>",
      "<svg \(ns)><path d=\"" + String(repeating: "M0 0 ", count: 80_000) + "X\"/></svg>",
      "<svg \(ns)><path transform=\"scale(" + String(repeating: "1 ", count: 200_000) + "x)\"/></svg>",
      "<svg \(ns)><path stroke=\"rgb(" + String(repeating: "1,", count: 200_000) + ")\"/></svg>",
    ]
    let started = ContinuousClock.now

    for blob in blobs {
      #expect(SignatureSVGRules.problem(in: blob) != nil)
    }

    #expect(ContinuousClock.now - started < .seconds(20))
  }
}

/// The two files of a signature, written from strokes.
@Suite("Signature files")
struct SignatureFilesTests {
  // MARK: Strokes

  /// A signature-like scribble: a few strokes with curves, a dot, and a long loop.
  private func scribble() -> SignatureInk {
    var ink = SignatureInk()

    ink.begin(at: SignaturePoint(x: 20, y: 120))
    for step in 1...40 {
      let t = Double(step) / 40
      ink.extend(to: SignaturePoint(x: 20 + 260 * t, y: 120 - 80 * sin(t * .pi * 3) * (1 - t * 0.4)))
    }

    ink.begin(at: SignaturePoint(x: 60, y: 160))
    ink.extend(to: SignaturePoint(x: 240, y: 164))

    // A tap.
    ink.begin(at: SignaturePoint(x: 150, y: 30))

    return ink
  }

  private func randomInk(_ generator: inout SeededGenerator, strokes: Int, scale: Double) -> SignatureInk {
    var ink = SignatureInk()

    for _ in 0..<strokes {
      var x = Double.random(in: -scale...scale, using: &generator)
      var y = Double.random(in: -scale...scale, using: &generator)
      ink.begin(at: SignaturePoint(x: x, y: y))

      for _ in 0..<Int.random(in: 0..<60, using: &generator) {
        x += Double.random(in: -scale / 20...scale / 20, using: &generator)
        y += Double.random(in: -scale / 20...scale / 20, using: &generator)
        ink.extend(to: SignaturePoint(x: x, y: y))
      }
    }

    return ink
  }

  @Test("the ink keeps what is drawn, drops what is not a place or no distance, and stops at its bounds")
  func ink() {
    var ink = SignatureInk()
    #expect(ink.isEmpty && !ink.isSignature && ink.artwork() == nil)

    let notANumber = ink.begin(at: SignaturePoint(x: .nan, y: 0))
    let infinite = ink.begin(at: SignaturePoint(x: 0, y: .infinity))
    let faraway = ink.begin(at: SignaturePoint(x: 1e9, y: 0))
    #expect(!notANumber && !infinite && !faraway)
    // Nothing is drawn until a stroke began.
    ink.extend(to: SignaturePoint(x: 5, y: 5))
    #expect(ink.isEmpty)

    ink.begin(at: SignaturePoint(x: 0, y: 0))
    ink.extend(to: SignaturePoint(x: 0.1, y: 0.1))
    ink.extend(to: SignaturePoint(x: .nan, y: 3))
    ink.extend(to: SignaturePoint(x: 10, y: 0))
    #expect(ink.strokes.first?.points == [SignaturePoint(x: 0, y: 0), SignaturePoint(x: 10, y: 0)], "too near and not a number are dropped")
    #expect(!ink.isSignature, "a short line is not a signature")

    ink.begin(at: SignaturePoint(x: 0, y: 20))
    ink.extend(to: SignaturePoint(x: 30, y: 20))
    #expect(ink.isSignature && ink.strokes.count == 2)

    ink.undo()
    #expect(ink.strokes.count == 1)
    ink.clear()
    #expect(ink.isEmpty)

    // The bounds: a hand that never lifts cannot grow without end.
    var long = SignatureInk()
    long.begin(at: SignaturePoint(x: 0, y: 0))
    for step in 1...(SignatureInk.maxPoints + 500) {
      long.extend(to: SignaturePoint(x: Double(step), y: 0))
    }
    #expect(long.pointCount == SignatureInk.maxPoints)
    let another = long.begin(at: SignaturePoint(x: 0, y: 5))
    #expect(!another, "no more strokes once the points are used up")

    var many = SignatureInk()
    for index in 0..<(SignatureInk.maxStrokes + 5) {
      many.begin(at: SignaturePoint(x: Double(index), y: 0))
    }
    #expect(many.strokes.count == SignatureInk.maxStrokes)
  }

  // MARK: The SVG

  @Test("the SVG of a scribble is the allowlist's, written in the plain form: one line, a group, numbers and lowercase words")
  func svgOfAScribble() throws {
    let ink = scribble()
    let artwork = try #require(ink.artwork())
    let text = SignatureFiles.svgText(from: artwork)

    #expect(SignatureSVGRules.problem(in: text) == nil)
    #expect(text.hasPrefix("<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\""))
    #expect(text.hasSuffix("</g></svg>"))
    #expect(!text.contains("\n") && !text.contains("\t") && !text.contains("> <") && !text.contains(">\n"), "no padding")
    #expect(!text.contains("<title") && !text.contains("<desc") && !text.contains("style") && !text.contains("<text"))
    #expect(!text.contains("&") && !text.lowercased().contains("url(") && !text.contains("\\") && !text.contains("href"))
    #expect(text.contains("<circle"), "the tap is a dot")
    #expect(text.components(separatedBy: "<path ").count == 3, "two strokes")
    #expect(text.contains("stroke-linecap=\"round\"") && text.contains("fill=\"none\"") && text.contains("stroke=\"#000000\""))
    #expect(text.contains("viewBox=\"0 0 \(artwork.width) \(artwork.height)\""))
  }

  @Test("the numbers are written plainly: two decimals at most, no exponent, no -0, short")
  func numbers() {
    typealias Files = SignatureFiles
    #expect(Files.number(0) == "0" && Files.number(-0.0) == "0" && Files.number(-0.004) == "0")
    #expect(Files.number(1) == "1" && Files.number(-1) == "-1")
    #expect(Files.number(1.5) == "1.5" && Files.number(1.25) == "1.25" && Files.number(1.05) == "1.05")
    #expect(Files.number(1.004) == "1" && Files.number(1.006) == "1.01" && Files.number(0.1 + 0.2) == "0.3")
    #expect(Files.number(123456.789) == "123456.79")
    #expect(Files.number(.nan) == "0" && Files.number(.infinity) == "0" && Files.number(-.infinity) == "0")
    #expect(Files.number(1e300) == "999999999" && Files.number(-1e300) == "-999999999")
    #expect(Files.number(1e-7) == "0")
  }

  @Test("whatever is drawn, the SVG passes the gateway's rules: random strokes, wild coordinates, taps, empty-ish scribbles")
  func svgProperty() throws {
    var generator = SeededGenerator(seed: 2026_10_04)

    for round in 0..<300 {
      let scale = [1, 10, 300, 5_000, 90_000].randomElement(using: &generator) ?? 10
      let ink = randomInk(&generator, strokes: Int.random(in: 1...6, using: &generator), scale: Double(scale))

      guard let artwork = ink.artwork() else {
        Issue.record("round \(round): ink with a stroke has no artwork")
        continue
      }

      let text = SignatureFiles.svgText(from: artwork)
      #expect(SignatureSVGRules.problem(in: text) == nil, "round \(round): \(SignatureSVGRules.problem(in: text) ?? "") in \(text.prefix(300))")
      #expect(text.unicodeScalars.allSatisfy { $0.isASCII && $0.value >= 0x20 }, "round \(round): plain ASCII, no control character")

      // Every run of digits, signs, points and `e` is a number of at most 32 characters.
      var run = 0
      var longest = 0

      for scalar in text.unicodeScalars {
        if "0123456789.eE+-".unicodeScalars.contains(scalar) {
          run += 1
          longest = max(longest, run)
        } else {
          run = 0
        }
      }

      #expect(longest <= 32, "round \(round)")
      #expect(artwork.width >= 1 && artwork.height >= 1 && artwork.width <= 800 && artwork.height <= 400, "round \(round)")

      // The files come out whole.
      let files = try SignatureFiles.make(from: ink)
      #expect(files.png.starts(with: SignatureSVGRules.pngSignature) && !files.svg.isEmpty)
      #expect(files.svg == Data(text.utf8))
    }
  }

  @Test("a drawing is cropped to its ink with a margin, scaled down and never up, and centred")
  func artwork() throws {
    var ink = SignatureInk()
    ink.begin(at: SignaturePoint(x: 100, y: 500))
    ink.extend(to: SignaturePoint(x: 200, y: 540))

    let small = try #require(ink.artwork(margin: 10, lineWidth: 2))
    #expect(small.width == 122 && small.height == 62, "100 × 40 of ink, a margin and half a line on each side")
    #expect(small.strokes[0].first == SignaturePoint(x: 11, y: 11))
    #expect(small.strokes[0].last == SignaturePoint(x: 111, y: 51))

    var wide = SignatureInk()
    wide.begin(at: SignaturePoint(x: 0, y: 0))
    wide.extend(to: SignaturePoint(x: 1_600, y: 0))
    wide.extend(to: SignaturePoint(x: 1_600, y: 100))
    let scaled = try #require(wide.artwork(margin: 10, maxWidth: 800, maxHeight: 400, lineWidth: 2))
    #expect(scaled.width <= 800 && scaled.height <= 400 && scaled.width >= 799, "scaled to fit")

    // A single tap is one dot in a small frame.
    var tap = SignatureInk()
    tap.begin(at: SignaturePoint(x: -50, y: 9_000))
    let dot = try #require(tap.artwork())
    #expect(dot.width >= 1 && dot.height >= 1 && dot.strokes.count == 1)
    #expect(SignatureArtwork.segments(of: dot.strokes[0]) == [.dot(dot.strokes[0][0])])
  }

  @Test("a stroke is a dot, a line or a curve through its ends")
  func segments() {
    let a = SignaturePoint(x: 0, y: 0)
    let b = SignaturePoint(x: 10, y: 0)
    let c = SignaturePoint(x: 10, y: 10)
    #expect(SignatureArtwork.segments(of: []) == [])
    #expect(SignatureArtwork.segments(of: [a]) == [.dot(a)])
    #expect(SignatureArtwork.segments(of: [a, SignaturePoint(x: 0.5, y: 0)]) == [.dot(a)], "shorter than a dot's length")
    #expect(SignatureArtwork.segments(of: [a, b]) == [.move(a), .line(b)])
    #expect(
      SignatureArtwork.segments(of: [a, b, c])
        == [.move(a), .quad(control: b, end: SignaturePoint(x: 10, y: 5)), .line(c)])
  }

  @Test("a path is command letters and numbers: M, L and Q, separated by spaces")
  func pathData() {
    let a = SignaturePoint(x: 0, y: 0.5)
    let b = SignaturePoint(x: 10.25, y: 0)
    let c = SignaturePoint(x: 10, y: 10)
    let data = SignatureFiles.pathData(SignatureArtwork.segments(of: [a, b, c]))
    #expect(data == "M0 0.5Q10.25 0 10.13 5L10 10")
    #expect(SignatureSVGRules.problem(in: "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"\(data)\"/></svg>") == nil)
  }

  // MARK: The PNG

  @Test("the PNG is drawn from the strokes: its signature, its size at two pixels a point, opaque white and black, and no metadata")
  func png() throws {
    let ink = scribble()
    let artwork = try #require(ink.artwork())
    let data = try SignatureFiles.png(from: artwork)

    #expect(data.starts(with: SignatureSVGRules.pngSignature))
    #expect(SignatureSVGRules.typeProblem(mime: "image/png", data: data) == nil)

    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    #expect(CGImageSourceGetCount(source) == 1)
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(image.width == artwork.width * 2 && image.height == artwork.height * 2)

    // Nothing of the device or the time: the properties hold the pixel facts and no EXIF, GPS, TIFF or text.
    let properties = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
    #expect(properties[kCGImagePropertyExifDictionary] == nil && properties[kCGImagePropertyGPSDictionary] == nil)
    #expect(properties[kCGImagePropertyTIFFDictionary] == nil && properties[kCGImagePropertyIPTCDictionary] == nil)
    #expect(properties[kCGImagePropertyPNGDictionary] == nil || (properties[kCGImagePropertyPNGDictionary] as? [CFString: Any])?.keys.allSatisfy {
      $0 != kCGImagePropertyPNGDescription && $0 != kCGImagePropertyPNGAuthor && $0 != kCGImagePropertyPNGCreationTime
    } == true)
    #expect(!data.contains(Data("tEXt".utf8)) && !data.contains(Data("iTXt".utf8)) && !data.contains(Data("eXIf".utf8)))

    // Black ink on white, the corners untouched.
    let rendered = try pixels(of: image)
    #expect(rendered.first == [255, 255, 255], "the corner is white")
    #expect(rendered.contains { $0[0] < 40 && $0[1] < 40 && $0[2] < 40 }, "there is ink")
    #expect(rendered.allSatisfy { $0[0] == $0[1] && $0[1] == $0[2] }, "greys only")
  }

  private func pixels(of image: CGImage) throws -> [[UInt8]] {
    let width = image.width
    let height = image.height
    var buffer = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = try #require(
      CGContext(
        data: &buffer, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    drawn.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return stride(from: 0, to: buffer.count, by: 4).map { [buffer[$0], buffer[$0 + 1], buffer[$0 + 2]] }
  }

  @Test("nothing drawn makes no files")
  func emptyInk() {
    #expect(throws: SignatureFiles.Failure.empty) { try SignatureFiles.make(from: SignatureInk()) }
  }

  @Test("a writer that drifted from the rules is caught before anything is uploaded")
  func conformanceGuard() {
    // The guard is the validator itself: the artwork's own text passes it, and a text that breaks a rule does not.
    let bad = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\" style=\"fill:red\"/></svg>"
    #expect(SignatureSVGRules.problem(in: bad) == "attribute")
    #expect(SignatureSVGRules.problem(in: "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>Ada</title></svg>") == "text")
  }
}

extension Data {
  fileprivate func contains(_ other: Data) -> Bool {
    range(of: other) != nil
  }
}
