import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The two files of a signature: a PNG and an SVG, written from the same strokes (`SignatureArtwork`).
///
/// The SVG is written to the allowlist of `contract/requests/README.md` §8 and nothing else: the root with its
/// namespace, one group of paths and circles, numbers and lowercase keywords in the plain form, no style, no text
/// (`title` and `desc` are left out), no white space between the tags. `SignatureSVGRules` checks the bytes before
/// they leave the device.
///
/// The PNG is opaque white with black ink, so it reads the same wherever it is placed and whatever the viewer
/// puts behind a transparent picture. It carries no metadata of any kind: it is drawn from the strokes, not
/// taken from a screen or a camera.
public enum SignatureFiles {
  /// Pixels per point of the PNG.
  public static let pngScale = 2

  /// What went wrong making the files.
  public enum Failure: Error, Sendable, Equatable {
    /// Nothing was drawn.
    case empty
    /// The PNG could not be drawn or encoded.
    case png
    /// The SVG this app wrote is not one the gateway takes: a bug in the writer, caught before upload. `word`
    /// is the rule's own word.
    case notConformant(word: String)
  }

  /// The files of `ink`: nil when nothing is drawn.
  public static func make(from ink: SignatureInk) throws(Failure) -> (png: Data, svg: Data) {
    guard let artwork = ink.artwork() else {
      throw .empty
    }

    let svg = svg(from: artwork)

    if let word = SignatureSVGRules.problem(in: svg) {
      throw .notConformant(word: word)
    }

    return (try png(from: artwork), svg)
  }

  // MARK: SVG

  /// The SVG as UTF-8, one line.
  public static func svg(from artwork: SignatureArtwork) -> Data {
    Data(svgText(from: artwork).utf8)
  }

  public static func svgText(from artwork: SignatureArtwork) -> String {
    let size = "\(artwork.width)"
    let height = "\(artwork.height)"
    var body = ""

    for stroke in artwork.strokes {
      let segments = SignatureArtwork.segments(of: stroke)

      if case .dot(let point)? = segments.first {
        let radius = number(artwork.lineWidth / 2)
        body += "<circle cx=\"\(number(point.x))\" cy=\"\(number(point.y))\" r=\"\(radius)\" fill=\"#000000\" stroke=\"none\"/>"
        continue
      }

      body += "<path d=\"\(pathData(segments))\"/>"
    }

    return "<svg xmlns=\"\(SignatureSVGRules.namespace)\" version=\"1.1\" width=\"\(size)\" height=\"\(height)\" "
      + "viewBox=\"0 0 \(size) \(height)\"><g fill=\"none\" stroke=\"#000000\" stroke-width=\"\(number(artwork.lineWidth))\" "
      + "stroke-linecap=\"round\" stroke-linejoin=\"round\">\(body)</g></svg>"
  }

  /// `M10.5 20Q12 22 13 23L14 24`: command letters and numbers, nothing else.
  static func pathData(_ segments: [SignatureArtwork.Segment]) -> String {
    var data = ""

    for segment in segments {
      switch segment {
      case .move(let point): data += "M\(number(point.x)) \(number(point.y))"
      case .line(let point): data += "L\(number(point.x)) \(number(point.y))"
      case .quad(let control, let end):
        data += "Q\(number(control.x)) \(number(control.y)) \(number(end.x)) \(number(end.y))"
      case .dot: continue
      }
    }

    return data
  }

  /// A number in the plain form the allowlist reads: an optional minus, digits, and at most two decimals with no
  /// trailing zero; no exponent, never `-0`, at most nine digits before the point. Not a number is `0`.
  static func number(_ value: Double) -> String {
    guard value.isFinite else {
      return "0"
    }

    let clamped = min(max(value, -999_999_999), 999_999_999)
    let hundredths = Int((abs(clamped) * 100).rounded())

    if hundredths == 0 {
      return "0"
    }

    var text = clamped < 0 ? "-" : ""
    text += "\(hundredths / 100)"

    let fraction = hundredths % 100

    if fraction != 0 {
      text += fraction % 10 == 0 ? ".\(fraction / 10)" : (fraction < 10 ? ".0\(fraction)" : ".\(fraction)")
    }

    return text
  }

  // MARK: PNG

  public static func png(from artwork: SignatureArtwork) throws(Failure) -> Data {
    let scale = pngScale
    let width = artwork.width * scale
    let height = artwork.height * scale

    guard width > 0, height > 0, width <= 16_384, height <= 16_384,
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else {
      throw .png
    }

    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // The artwork's origin is the top left, CoreGraphics' the bottom left.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))

    context.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.setLineWidth(artwork.lineWidth)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    for stroke in artwork.strokes {
      let segments = SignatureArtwork.segments(of: stroke)

      if case .dot(let point)? = segments.first {
        let radius = artwork.lineWidth / 2
        context.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
        continue
      }

      let path = CGMutablePath()

      for segment in segments {
        switch segment {
        case .move(let point): path.move(to: CGPoint(x: point.x, y: point.y))
        case .line(let point): path.addLine(to: CGPoint(x: point.x, y: point.y))
        case .quad(let control, let end):
          path.addQuadCurve(to: CGPoint(x: end.x, y: end.y), control: CGPoint(x: control.x, y: control.y))
        case .dot: continue
        }
      }

      context.addPath(path)
      context.strokePath()
    }

    guard let image = context.makeImage() else {
      throw .png
    }

    let data = NSMutableData()

    // No properties: nothing but the pixels is written.
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
      throw .png
    }

    CGImageDestinationAddImage(destination, image, nil)

    guard CGImageDestinationFinalize(destination) else {
      throw .png
    }

    // ImageIO adds an Exif chunk of its own (the pixel size, in a place the reader would not look for it): the
    // file keeps only the chunks a picture is made of.
    guard let clean = onlyPictureChunks(data as Data) else {
      throw .png
    }

    return clean
  }

  /// The chunks a PNG keeps: the header, a palette, the pixels, the end, and the colour space (`sRGB`). Every other
  /// chunk (text, time, Exif, physical size, ICC profile) is left out; the kept ones are copied as they are, CRC
  /// included. Nil for bytes that are not a PNG.
  static func onlyPictureChunks(_ png: Data) -> Data? {
    let signature = SignatureSVGRules.pngSignature
    let kept: Set<String> = ["IHDR", "PLTE", "IDAT", "IEND", "sRGB"]
    let bytes = [UInt8](png)

    guard bytes.count >= signature.count, Array(bytes[0..<signature.count]) == signature else {
      return nil
    }

    var out = Data(signature)
    var offset = signature.count
    var sawEnd = false

    while offset + 12 <= bytes.count {
      let length = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
      let end = offset + 12 + length

      guard length >= 0, end <= bytes.count else {
        return nil
      }

      let type = String(decoding: bytes[(offset + 4)..<(offset + 8)], as: UTF8.self)

      if kept.contains(type) {
        out.append(contentsOf: bytes[offset..<end])
      }

      offset = end

      if type == "IEND" {
        sawEnd = true
        break
      }
    }

    return sawEnd ? out : nil
  }
}
