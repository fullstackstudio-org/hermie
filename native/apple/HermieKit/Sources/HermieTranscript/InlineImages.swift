import Foundation
import HermieProtocol

// Pictures a message carries inside its own text (`inline-images.ts`).
//
// The gateway writes an image a person attached into the turn as a handle line,
// `[Image attached at: <path>]` (a file on its own disk) or `[Image attached: <url>]`, and older
// sessions also hold the picture itself as a `data:image/<type>;base64,<data>` blob beside it.
// Neither is for the reader. This lifts both out of the text:
//
// - a blob that decodes (png, jpeg, gif, webp, heic; at most 20 MiB; the first bytes say what the
//   declared type claims) becomes an `InlineImage` the view draws from the bytes it already holds;
// - a handle with no usable blob becomes an `@image:<path>` reference, which is what an attachment
//   already is: fetched through the gateway's files route, or an honest "cannot";
// - a blob that does not decode becomes the `@image:Image` reference: a compact chip, never the blob;
// - an unnamed image the gateway shows as a line of just `[image]` becomes that same `@image:Image`
//   reference: a chip with nothing to fetch, which the views draw as a plain label.
//
// The text is read as UTF-8 bytes: every marker is ASCII, so cutting at a marker never splits a
// character. The vectors in `contract/transcript/golden/inline-images.json` hold both ports to the
// same answers.

/// A picture held by the message itself.
public struct InlineImage: TranscriptJSONCodable, Hashable, Sendable {
  /// The file's name for the label (`upload_1.png`), or `Image`.
  public var name: String
  /// The type the first bytes show: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/heic`.
  public var mime: String
  /// The picture, base64, as the message held it.
  public var data: String

  public init(name: String, mime: String, data: String) {
    self.name = name
    self.mime = mime
    self.data = data
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "InlineImage")
    name = try reader.required("name")
    mime = try reader.required("mime")
    data = try reader.required("data")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("name", name)
    writer.set("mime", mime)
    writer.set("data", data)
    return writer.json
  }

  /// The picture's bytes, when `data` is base64 (it is, for an image the engine produced).
  public var bytes: Data? { Data(base64Encoded: data) }
}

/// `InlineImageScan`.
public struct InlineImageScan: Equatable, Sendable {
  /// The text without the handles and the blobs.
  public var text: String
  /// Blobs that decode, in the order they appeared.
  public var images: [InlineImage]
  /// `@image:` references for handles whose picture the message does not hold, and for blobs that cannot be shown.
  public var references: [String]

  public init(text: String, images: [InlineImage] = [], references: [String] = []) {
    self.text = text
    self.images = images
    self.references = references
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("text", text)
    writer.set("images", images)
    writer.set("references", references)
    return writer.json
  }
}

/// `INLINE_IMAGE_MAX_BYTES`: the largest picture kept in a message, decoded.
public let inlineImageMaxBytes = 20 * 1024 * 1024
/// `INLINE_IMAGE_MAX_COUNT`: how many pictures one message gives up; the rest are dropped without a trace.
public let inlineImageMaxCount = 12
/// `INLINE_IMAGE_FALLBACK_NAME`: what a rejected blob is called.
public let inlineImageFallbackName = "Image"

/// `isImagePlaceholder`: whether `reference` is the chip an unnamed image gets (`@image:Image`): nothing to
/// fetch, nothing to open.
public func isImagePlaceholder(_ reference: String) -> Bool {
  JS.trim(reference) == "@image:\(inlineImageFallbackName)"
}

/// `sniffImageType`: the type a picture's first bytes show, or `nil` when they show none of the five.
public func sniffImageType(_ bytes: [UInt8]) -> String? {
  func at(_ index: Int) -> Int { index < bytes.count ? Int(bytes[index]) : -1 }
  func text(_ from: Int, _ value: String) -> Bool {
    for (offset, byte) in value.utf8.enumerated() where at(from + offset) != Int(byte) { return false }
    return true
  }

  if at(0) == 0x89 && text(1, "PNG") && at(4) == 0x0d && at(5) == 0x0a { return "image/png" }
  if at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff { return "image/jpeg" }
  if text(0, "GIF87a") || text(0, "GIF89a") { return "image/gif" }
  if text(0, "RIFF") && text(8, "WEBP") { return "image/webp" }
  if text(4, "ftyp"), ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"].contains(where: { text(8, $0) }) {
    return "image/heic"
  }
  return nil
}

/// `scanInlineImages`: lift the handles and the blobs out of `text`. Returns `text` itself,
/// untouched, when it holds neither.
public func scanInlineImages(_ text: String) -> InlineImageScan {
  let scanner = InlineImageScanner(Array(text.utf8))
  return scanner.run(original: text)
}

private struct InlineImageScanner {
  struct Span {
    var start: Int
    var end: Int
  }

  struct Blob {
    var span: Span
    var type: String
    var bodyStart: Int
    var bodyEnd: Int
  }

  struct Marker {
    var span: Span
    var isPath: Bool
    var value: String
  }

  enum Event {
    case blob(Blob)
    case marker(Marker)

    var start: Int {
      switch self {
      case .blob(let blob): blob.span.start
      case .marker(let marker): marker.span.start
      }
    }
  }

  static let dataPrefix = Array("data:image/".utf8)
  static let markerPrefix = Array("[Image attached".utf8)
  static let placeholder = Array("[image]".utf8)
  static let base64Tag = Array(";base64,".utf8)
  static let declaredTypes: Set<String> = ["png", "x-png", "jpeg", "jpg", "pjpeg", "gif", "webp", "heic", "heif"]

  let bytes: [UInt8]

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  // MARK: Searching

  private func find(_ needle: [UInt8], from: Int) -> Int? {
    guard from >= 0, from + needle.count <= bytes.count else { return nil }
    return bytes.withUnsafeBufferPointer { buffer -> Int? in
      needle.withUnsafeBufferPointer { pattern -> Int? in
        guard let base = buffer.baseAddress, let target = pattern.baseAddress,
          let hit = memmem(base + from, buffer.count - from, target, pattern.count)
        else { return nil }
        return base.distance(to: hit.assumingMemoryBound(to: UInt8.self))
      }
    }
  }

  // MARK: Handles

  /// The line terminator starting at `index` (`\n`, `\r`, U+2028, U+2029), as its length, or 0.
  private func terminator(at index: Int) -> Int {
    guard index < bytes.count else { return 0 }
    if bytes[index] == 0x0a || bytes[index] == 0x0d { return 1 }
    if bytes[index] == 0xe2, index + 2 < bytes.count, bytes[index + 1] == 0x80, bytes[index + 2] == 0xa8 || bytes[index + 2] == 0xa9 {
      return 3
    }
    return 0
  }

  /// Whether a line terminator ends just before `index`.
  private func terminatorEnds(at index: Int) -> Bool {
    guard index > 0 else { return false }
    if bytes[index - 1] == 0x0a || bytes[index - 1] == 0x0d { return true }
    return index >= 3 && bytes[index - 3] == 0xe2 && bytes[index - 2] == 0x80
      && (bytes[index - 1] == 0xa8 || bytes[index - 1] == 0xa9)
  }

  private func isBlank(_ byte: UInt8) -> Bool { byte == 0x20 || byte == 0x09 }

  private func findMarkers() -> [Marker] {
    var found: [Marker] = []
    var from = 0
    while let hit = find(Self.markerPrefix, from: from) {
      from = hit + Self.markerPrefix.count
      // The line holds nothing but blanks before it.
      var lineStart = hit
      while lineStart > 0, isBlank(bytes[lineStart - 1]) { lineStart -= 1 }
      guard lineStart == 0 || terminatorEnds(at: lineStart) else { continue }

      var cursor = from
      var isPath = false
      if cursor + 3 <= bytes.count, Array(bytes[cursor..<cursor + 3]) == Array(" at".utf8) {
        isPath = true
        cursor += 3
      }
      guard cursor + 2 <= bytes.count, bytes[cursor] == 0x3a, bytes[cursor + 1] == 0x20 else { continue }
      cursor += 2

      var lineEnd = cursor
      while lineEnd < bytes.count, terminator(at: lineEnd) == 0 { lineEnd += 1 }
      var close = lineEnd
      while close > cursor, isBlank(bytes[close - 1]) { close -= 1 }
      guard close - 1 > cursor, bytes[close - 1] == 0x5d else { continue }

      let value = JS.trim(String(decoding: bytes[cursor..<close - 1], as: UTF8.self))
      guard !value.isEmpty else { continue }
      found.append(Marker(span: Span(start: lineStart, end: lineEnd), isPath: isPath, value: value))
      from = lineEnd
    }
    return found
  }

  /// The lines of nothing but `[image]` (blanks around it allowed): what the gateway's history says for
  /// an attached image it has no name for. They are markers with no path, called `Image`.
  private func findPlaceholders() -> [Marker] {
    var found: [Marker] = []
    var from = 0
    while let hit = find(Self.placeholder, from: from) {
      from = hit + Self.placeholder.count
      var lineStart = hit
      while lineStart > 0, isBlank(bytes[lineStart - 1]) { lineStart -= 1 }
      guard lineStart == 0 || terminatorEnds(at: lineStart) else { continue }

      var lineEnd = from
      while lineEnd < bytes.count, isBlank(bytes[lineEnd]) { lineEnd += 1 }
      guard lineEnd == bytes.count || terminator(at: lineEnd) > 0 else { continue }

      found.append(Marker(span: Span(start: lineStart, end: lineEnd), isPath: false, value: inlineImageFallbackName))
      from = lineEnd
    }
    return found
  }

  // MARK: Blobs

  private func isBodyByte(_ byte: UInt8) -> Bool {
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || byte == 0x2b || byte == 0x2f || byte == 0x3d || byte == 0x5f || byte == 0x2d
  }

  private func isTypeByte(_ byte: UInt8) -> Bool {
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x7a) || byte == 0x2e || byte == 0x2b || byte == 0x2d
  }

  private func findBlobs() -> [Blob] {
    var found: [Blob] = []
    var from = 0
    while from < bytes.count, let start = find(Self.dataPrefix, from: from) {
      let typeStart = start + Self.dataPrefix.count
      // The type is at most 40 characters, so `;base64,` is looked for in a window that long.
      let window = Array(bytes[typeStart..<min(bytes.count, typeStart + 48)])
      let tag = Self.base64Tag
      var offset: Int?
      if window.count >= tag.count {
        for index in 0...(window.count - tag.count) where Array(window[index..<index + tag.count]) == tag {
          offset = index
          break
        }
      }
      guard let offset, (1...40).contains(offset), bytes[typeStart..<typeStart + offset].allSatisfy(isTypeByte) else {
        from = typeStart
        continue
      }

      let type = String(decoding: bytes[typeStart..<typeStart + offset], as: UTF8.self)
      let bodyStart = typeStart + offset + tag.count
      var end = bodyStart
      while end < bytes.count, isBodyByte(bytes[end]) { end += 1 }

      // `=` belongs at the very end of a body, never inside it.
      if let pad = bytes[bodyStart..<end].firstIndex(of: 0x3d) {
        var stop = pad
        while stop < end, bytes[stop] == 0x3d { stop += 1 }
        end = stop
      }

      found.append(Blob(span: Span(start: start, end: end), type: type, bodyStart: bodyStart, bodyEnd: end))
      from = end
    }
    return found
  }

  /// A blob written as a Markdown image or link: the whole `![alt](…)` goes, not just what is inside it.
  private func widenToLink(_ span: Span) -> Span {
    guard span.start >= 2, bytes[span.start - 2] == 0x5d, bytes[span.start - 1] == 0x28,
      span.end < bytes.count, bytes[span.end] == 0x29
    else { return span }

    var open = span.start - 3
    while open >= 0, bytes[open] != 0x5b { open -= 1 }
    guard open >= 0, !bytes[open..<span.start].contains(0x0a) else { return span }

    return Span(start: open > 0 && bytes[open - 1] == 0x21 ? open - 1 : open, end: span.end + 1)
  }

  /// `readInlineImage`: a base64 picture this client will draw, or `nil`.
  private func readImage(_ blob: Blob, name: String) -> InlineImage? {
    guard Self.declaredTypes.contains(blob.type) else { return nil }
    let body = bytes[blob.bodyStart..<blob.bodyEnd]

    var significantEnd = body.endIndex
    while significantEnd > body.startIndex, body[significantEnd - 1] == 0x3d { significantEnd -= 1 }
    let padding = body.endIndex - significantEnd
    let significant = body[body.startIndex..<significantEnd]

    guard padding <= 2, significant.count % 4 != 1 else { return nil }
    guard significant.allSatisfy({ $0 != 0x5f && $0 != 0x2d }) else { return nil }
    if padding > 0, body.count % 4 != 0 { return nil }

    let decoded = significant.count * 3 / 4
    guard decoded >= 8, decoded <= inlineImageMaxBytes else { return nil }

    let usable = min(32, significant.count / 4 * 4)
    guard usable >= 12 else { return nil }
    let head = Data(base64Encoded: Data(significant.prefix(usable)))
    guard let head, let mime = sniffImageType([UInt8](head)) else { return nil }

    return InlineImage(name: name, mime: mime, data: String(decoding: body, as: UTF8.self))
  }

  // MARK: Names

  static func handleName(_ value: String) -> String {
    var bare = Substring(value)
    if let cut = bare.firstIndex(where: { $0 == "?" || $0 == "#" }) { bare = bare[..<cut] }
    let last = bare.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? String(bare)
    return last.removingPercentEncoding ?? last
  }

  static func reference(_ value: String) -> String {
    let clean = JS.trim(value)
    let spaced = clean.unicodeScalars.contains { $0.properties.isWhitespace }
    return spaced ? "@image:\"\(clean.replacingOccurrences(of: "\"", with: "'"))\"" : "@image:\(clean)"
  }

  // MARK: Running

  func run(original: String) -> InlineImageScan {
    let hasBlob = find(Self.dataPrefix, from: 0) != nil
    let hasMarker = find(Self.markerPrefix, from: 0) != nil
    let hasPlaceholder = find(Self.placeholder, from: 0) != nil
    guard hasBlob || hasMarker || hasPlaceholder else { return InlineImageScan(text: original) }

    var events: [Event] = findBlobs().map(Event.blob)
    if hasMarker { events += findMarkers().map(Event.marker) }
    if hasPlaceholder { events += findPlaceholders().map(Event.marker) }
    guard !events.isEmpty else { return InlineImageScan(text: original) }
    events.sort { $0.start < $1.start }

    var images: [InlineImage] = []
    var references: [String] = []
    var cuts: [Span] = []
    var count = 0
    var pending: Marker?

    func addReference(_ reference: String) {
      if count <= inlineImageMaxCount, !references.contains(reference) { references.append(reference) }
    }
    func flushPending() {
      if let handle = pending {
        addReference(Self.reference(handle.value))
        pending = nil
      }
    }

    for event in events {
      switch event {
      case .marker(let marker):
        flushPending()
        count += 1
        pending = marker
        cuts.append(marker.span)

      case .blob(let blob):
        let handle = pending
        let handleName = handle.map { Self.handleName($0.value) } ?? ""
        let name = handleName.isEmpty ? inlineImageFallbackName : handleName
        let image = readImage(blob, name: name)

        pending = nil
        cuts.append(widenToLink(blob.span))
        if handle == nil { count += 1 }
        if count > inlineImageMaxCount { continue }

        if let image {
          images.append(image)
        } else if let handle {
          addReference(Self.reference(handle.value))
        } else {
          addReference(Self.reference(inlineImageFallbackName))
        }
      }
    }
    flushPending()

    var out: [UInt8] = []
    out.reserveCapacity(bytes.count)
    var cursor = 0
    for cut in cuts {
      if cut.start < cursor { continue }
      out.append(contentsOf: bytes[cursor..<cut.start])
      cursor = cut.end
      // A handle line takes its line break with it.
      if cursor < bytes.count, bytes[cursor] == 0x0a, out.isEmpty || out.last == 0x0a { cursor += 1 }
    }
    out.append(contentsOf: bytes[cursor...])

    return InlineImageScan(text: Self.tidy(out), images: images, references: references)
  }

  /// `.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()`
  static func tidy(_ input: [UInt8]) -> String {
    var out: [UInt8] = []
    out.reserveCapacity(input.count)
    var index = 0
    var newlines = 0
    while index < input.count {
      let byte = input[index]
      if byte == 0x20 || byte == 0x09 {
        var end = index
        while end < input.count, input[end] == 0x20 || input[end] == 0x09 { end += 1 }
        if end < input.count, input[end] == 0x0a {
          index = end
          continue
        }
        out.append(contentsOf: input[index..<end])
        newlines = 0
        index = end
        continue
      }
      if byte == 0x0a {
        newlines += 1
        if newlines <= 2 { out.append(byte) }
      } else {
        newlines = 0
        out.append(byte)
      }
      index += 1
    }
    return JS.trim(String(decoding: out, as: UTF8.self))
  }
}

extension InlineImage: JSONField {}
