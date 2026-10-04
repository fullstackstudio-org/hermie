import CoreGraphics
import CryptoKit
import Foundation
import HermieGateway
import HermieProtocol
import ImageIO
import PDFKit
import Synchronization
import Testing
import UniformTypeIdentifiers

@testable import HermieCore

/// What an uploader was asked, in order.
private final class UploadLog: Sendable {
  struct Call: Sendable, Equatable {
    var name: String
    var mime: String
    var path: String
    var bytes: Int
  }

  private let calls = Mutex<[Call]>([])
  var all: [Call] { calls.withLock { $0 } }

  /// An uploader that stores nothing and answers the path it was asked for.
  func recording(progress: [Double] = [0.25, 1]) -> InteractiveUploader {
    { [self] file, name, mime, path, onProgress in
      let bytes = (try? Data(contentsOf: file).count) ?? -1
      calls.withLock { $0.append(Call(name: name, mime: mime, path: path, bytes: bytes)) }

      for step in progress {
        onProgress?(step)
      }

      return path
    }
  }
}

private let dir = "/work/up"

private func fileParams(
  multiple: Bool = true, maxFiles: Int = 3, maxBytes: Int = 1_000_000, maxTotal: Int = 2_000_000, strip: Bool = false,
  accept: String = "any"
) -> InputFileParams {
  InputFileParams(json: [
    "v": 1, "title": "t", "summary": "s", "accept": .string(accept), "multiple": .bool(multiple),
    "upload": [
      "dir": .string(dir), "max_bytes": .number(Double(maxBytes)), "max_total_bytes": .number(Double(maxTotal)),
      "max_files": .number(Double(maxFiles)), "strip_metadata": .bool(strip)
    ]
  ])
}

/// A folder of the test's own, removed afterwards.
private final class Scratch {
  let folder: URL

  init() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("interactive-file-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  deinit {
    try? FileManager.default.removeItem(at: folder)
  }

  @discardableResult
  func write(_ name: String, _ data: Data) throws -> URL {
    let url = folder.appendingPathComponent(name)
    try data.write(to: url)
    return url
  }

  /// A picture, drawn so its pixels are not flat, as JPEG or PNG, with where it was taken and a
  /// comment in it when asked.
  func picture(_ name: String, type: UTType = .jpeg, located: Bool = true) throws -> URL {
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

    let url = folder.appendingPathComponent(name)
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
    var properties: [CFString: Any] = [:]

    if located {
      properties[kCGImagePropertyGPSDictionary] = [
        kCGImagePropertyGPSLatitude: 52.3676, kCGImagePropertyGPSLatitudeRef: "N",
        kCGImagePropertyGPSLongitude: 4.9041, kCGImagePropertyGPSLongitudeRef: "E"
      ]
      properties[kCGImagePropertyExifDictionary] = [kCGImagePropertyExifUserComment: "private note"]
    }

    CGImageDestinationAddImage(destination, try #require(context.makeImage()), properties as CFDictionary)
    #expect(CGImageDestinationFinalize(destination))
    return url
  }
}

private func sha(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func properties(_ url: URL) throws -> [CFString: Any] {
  let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
  return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
}

@MainActor
@Suite("Interactive file model")
struct InteractiveFileTests {
  // MARK: Limits

  @Test("max_files, max_bytes and max_total_bytes are enforced as files are added, and a refused copy is deleted")
  func limits() throws {
    let files = InteractiveFileModel(params: fileParams(maxFiles: 2, maxBytes: 100, maxTotal: 150))

    func staged(_ name: String, bytes: Int) throws -> PickedFile {
      try AttachmentStaging.stage(data: Data(repeating: 1, count: bytes), name: name)
    }

    let a = try staged("a.bin", bytes: 90)
    #expect(files.add(a))
    #expect(files.rejection == nil)

    let big = try staged("big.bin", bytes: 101)
    #expect(!files.add(big))
    #expect(files.rejection == .tooLarge(name: "big.bin", limit: 100))
    #expect(!FileManager.default.fileExists(atPath: big.url.path), "the refused copy is gone")

    let heavy = try staged("heavy.bin", bytes: 70)
    #expect(!files.add(heavy))
    #expect(files.rejection == .totalTooLarge(limit: 150))

    let b = try staged("b.bin", bytes: 50)
    #expect(files.add(b))
    #expect(files.rejection == nil)
    #expect(files.totalBytes == 140)
    #expect(!files.hasRoom)

    let third = try staged("c.bin", bytes: 1)
    #expect(!files.add(third))
    #expect(files.rejection == .tooMany(limit: 2))

    files.remove(files.items[0].id)
    #expect(files.items.map(\.file.name) == ["b.bin"])
    #expect(!FileManager.default.fileExists(atPath: a.url.path))
    files.discardAll()
    #expect(files.items.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: b.url.path))
  }

  @Test("a request for one file takes the newest in place of the one before")
  func singleFile() throws {
    let files = InteractiveFileModel(params: fileParams(multiple: false, maxFiles: 5))
    let first = try AttachmentStaging.stage(data: Data([1]), name: "first.bin")
    let second = try AttachmentStaging.stage(data: Data([2]), name: "second.bin")

    #expect(files.maxFiles == 1)
    #expect(files.add(first))
    #expect(files.add(second))
    #expect(files.items.map(\.file.name) == ["second.bin"])
    #expect(!FileManager.default.fileExists(atPath: first.url.path))
    files.discardAll()
  }

  @Test("the request's own bounds are read, with the contract's ceilings when it names none")
  func bounds() {
    let files = InteractiveFileModel(params: InputFileParams(json: ["upload": ["dir": "/a"]]))
    #expect(files.maxFiles == 1, "without `multiple` one file")
    #expect(files.maxBytes == 104_857_600)
    #expect(files.maxTotalBytes == 104_857_600)
    #expect(!files.stripsMetadata)
    #expect(InteractiveFileModel(params: fileParams(strip: true)).stripsMetadata)
  }

  // MARK: Importing

  @Test("a picked file is copied in; one over max_bytes is refused before it is copied")
  func importing() async throws {
    let scratch = try Scratch()
    let ok = try scratch.write("note.txt", Data("hello".utf8))
    let big = try scratch.write("big.bin", Data(repeating: 7, count: 2_000))
    let files = InteractiveFileModel(params: fileParams(maxBytes: 1_000))

    await files.importFiles([ok, big])
    #expect(files.items.map(\.file.name) == ["note.txt"])
    #expect(files.items.first?.file.mimeType == "text/plain")
    #expect(files.rejection == .tooLarge(name: "big.bin", limit: 1_000))
    #expect(files.preparing == 0)
    // A copy of the app's own: the picked file is not the one that is uploaded.
    #expect(files.items.first?.file.url != ok)
    files.discardAll()
    #expect(FileManager.default.fileExists(atPath: ok.path), "the person's file is left alone")
  }

  @Test("strip_metadata writes an image again without its EXIF and GPS, keeps its type, and leaves documents alone")
  func stripping() async throws {
    let scratch = try Scratch()
    let jpeg = try scratch.picture("receipt.jpg")
    let png = try scratch.picture("scan.png", type: .png)
    let text = try scratch.write("terms.txt", Data("EXIF-looking text".utf8))

    // The input really has it.
    #expect(try properties(jpeg)[kCGImagePropertyGPSDictionary] != nil)

    let files = InteractiveFileModel(params: fileParams(strip: true))
    await files.importFiles([jpeg, png, text])
    #expect(files.items.map(\.file.name) == ["receipt.jpg", "scan.png", "terms.txt"])
    #expect(files.items.map(\.file.mimeType) == ["image/jpeg", "image/png", "text/plain"])

    for item in files.items.prefix(2) {
      let found = try properties(item.file.url)
      #expect(found[kCGImagePropertyGPSDictionary] == nil, "\(item.file.name)")
      let exif = found[kCGImagePropertyExifDictionary] as? [CFString: Any]
      #expect(exif?[kCGImagePropertyExifUserComment] == nil, "\(item.file.name)")
      #expect(AttachmentPrivacy.locationKeys(in: item.file.url).isEmpty)
    }

    #expect(try Data(contentsOf: files.items[2].file.url) == Data("EXIF-looking text".utf8), "documents go as they are")
    files.discardAll()
  }

  @Test("without strip_metadata a picked image goes as it is")
  func notStripping() async throws {
    let scratch = try Scratch()
    let jpeg = try scratch.picture("receipt.jpg")
    let files = InteractiveFileModel(params: fileParams(strip: false))

    await files.importFiles([jpeg])
    #expect(try Data(contentsOf: files.items[0].file.url) == Data(contentsOf: jpeg))
    files.discardAll()
  }

  @Test("a library photo already staged is stripped when asked")
  func strippingStaged() async throws {
    let scratch = try Scratch()
    let jpeg = try scratch.picture("lib.jpg")
    let staged = try AttachmentStaging.stage(copying: jpeg)
    let files = InteractiveFileModel(params: fileParams(strip: true))

    await files.importStaged(staged)
    #expect(files.items.count == 1)
    #expect(try properties(files.items[0].file.url)[kCGImagePropertyGPSDictionary] == nil)
    #expect(!FileManager.default.fileExists(atPath: staged.url.path), "the unstripped copy is gone")
    files.discardAll()
  }

  @Test("a camera photo is a JPEG file with a dated name")
  func cameraPhoto() async throws {
    let scratch = try Scratch()
    let jpeg = try Data(contentsOf: scratch.picture("x.jpg", located: false))
    let files = InteractiveFileModel(params: fileParams())
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    await files.importPhoto(jpeg, now: now)
    #expect(files.items.count == 1)
    #expect(files.items[0].file.name.hasPrefix("Photo 20"))
    #expect(files.items[0].file.name.hasSuffix(".jpg"))
    #expect(files.items[0].file.mimeType == "image/jpeg")
    #expect(try Data(contentsOf: files.items[0].file.url) == jpeg)
    files.discardAll()
  }

  // MARK: Scans

  /// A few JPEG pages of different sizes.
  private func pages(_ count: Int) throws -> [Data] {
    let scratch = try Scratch()
    return try (0..<count).map { index in
      try Data(contentsOf: scratch.picture("p\(index).jpg", located: false))
    }
  }

  @Test("a scan for a document becomes one PDF with a page for each scanned page")
  func scanToPDF() async throws {
    let files = InteractiveFileModel(params: fileParams(accept: "document"))

    await files.importScan(pages: try pages(3))
    #expect(files.items.count == 1)
    let item = try #require(files.items.first)
    #expect(item.file.mimeType == "application/pdf")
    #expect(item.file.name.hasPrefix("Scan 20") && item.file.name.hasSuffix(".pdf"))

    let document = try #require(PDFDocument(url: item.file.url))
    #expect(document.pageCount == 3)
    #expect(Data(try Data(contentsOf: item.file.url).prefix(5)) == Data("%PDF-".utf8))
    files.discardAll()
  }

  @Test("a scan for anything else becomes one image per page, within what the request allows")
  func scanToImages() async throws {
    let files = InteractiveFileModel(params: fileParams(maxFiles: 2, accept: "image"))

    await files.importScan(pages: try pages(3))
    #expect(files.items.count == 2)
    #expect(files.items.map(\.file.mimeType) == ["image/jpeg", "image/jpeg"])
    #expect(files.items[0].file.name.contains("page 1"))
    #expect(files.rejection == .tooMany(limit: 2))
    files.discardAll()
  }

  @Test("a scan with no readable page is a rejection, not a crash")
  func badScan() async throws {
    let files = InteractiveFileModel(params: fileParams(accept: "document"))

    await files.importScan(pages: [Data("not an image".utf8)])
    #expect(files.items.isEmpty)
    #expect(files.rejection == .unreadable(name: "Scan"))
  }

  // MARK: Uploading

  @Test("each file is uploaded directly into the request's directory under <16 hex>-<name>, with its SHA-256 and size")
  func uploading() async throws {
    let scratch = try Scratch()
    let one = Data("first file".utf8)
    let two = Data(repeating: 0xAB, count: 700_000)
    let files = InteractiveFileModel(params: fileParams())
    let log = UploadLog()

    await files.importFiles([try scratch.write("Receipt (1).txt", one), try scratch.write("big.zzzz", two)])
    let references = try #require(await files.upload(through: log.recording()))

    #expect(files.phase == .uploaded)
    #expect(files.canAnswer)
    #expect(references.count == 2)

    for (reference, call) in zip(references, log.all) {
      let path = try #require(reference.path)
      // Flat: directly in the directory, a 16 hex token, a safe name.
      #expect(path == call.path)
      #expect(files.params.upload?.contains(path: path) == true)
      #expect(path.range(of: #"^/work/up/[0-9a-f]{16}-[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil, "\(path)")
    }

    #expect(log.all.map(\.name) == ["Receipt-1-.txt", "big.zzzz"], "the name the gateway gets is safe")
    #expect(references.map(\.name) == ["Receipt (1).txt", "big.zzzz"], "the answer keeps the name the person knows")
    #expect(references.map(\.mime) == ["text/plain", "application/octet-stream"])
    #expect(references.map(\.bytes) == [one.count, two.count])
    #expect(references.map(\.sha256) == [sha(one), sha(two)])
    #expect(log.all.map(\.bytes) == [one.count, two.count])
    #expect(files.progress == 1)

    // The prompt takes them as an answer, with the count its card keeps.
    let prompt = InteractivePrompt(
      id: "srq-1",
      content: InteractiveContent(
        body: .file(files.params), title: "t", summary: "s", detail: nil, offersSkip: true, actingUser: nil,
        expiresAt: nil),
      chatKey: "bot", sessionID: "s", deadline: nil)
    let reply = try #require(prompt.reply(to: .files(references, text: nil)))
    #expect(reply.summary == ["status": "answered", "count": 2])
    #expect(reply.result["files"]?.arrayValue?.count == 2)

    files.discardAll()
  }

  @Test("the answer's name is at most 120 code points with its extension kept, and its type at most 80")
  func answerLimits() async throws {
    let long = String(repeating: "a", count: 126) + ".pdf"
    #expect(long.count == 130)

    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    await files.importFiles([try scratch.write(long, Data("x".utf8))])
    let references = try #require(await files.upload(through: UploadLog().recording()))
    let name = try #require(references.first?.name)
    #expect(name.unicodeScalars.count == 120)
    #expect(name.hasSuffix(".pdf"))
    #expect(name.hasPrefix("aaaa"))
    files.discardAll()

    #expect(InteractiveFileModel.answerName("short.txt") == "short.txt")
    #expect(InteractiveFileModel.answerName("") == "file")
    // No extension, a huge "extension", and code points that are several UTF-16 units.
    #expect(InteractiveFileModel.answerName(String(repeating: "b", count: 200)).unicodeScalars.count == 120)
    #expect(InteractiveFileModel.answerName("x." + String(repeating: "c", count: 200)).unicodeScalars.count == 120)
    #expect(InteractiveFileModel.answerName(String(repeating: "😀", count: 130) + ".png").unicodeScalars.count == 120)
    #expect(InteractiveFileModel.answerMime("image/jpeg") == "image/jpeg")
    #expect(InteractiveFileModel.answerMime(nil) == "application/octet-stream")
    #expect(InteractiveFileModel.answerMime("application/" + String(repeating: "x", count: 80)) == "application/octet-stream")
  }

  @Test("two uploads of one name do not collide, and the token is fresh each time")
  func tokens() {
    let tokens = Set((0..<200).map { _ in InteractiveFileModel.randomToken() })
    #expect(tokens.count == 200)
    #expect(tokens.allSatisfy { $0.range(of: #"^[0-9a-f]{16}$"#, options: .regularExpression) != nil })
  }

  @Test("progress runs over all the files by bytes")
  func progress() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let seen = Mutex<[Double]>([])
    let uploader: InteractiveUploader = { _, _, _, path, onProgress in
      onProgress?(0.5)
      onProgress?(1)
      seen.withLock { $0.append(1) }
      return path
    }

    await files.importFiles([try scratch.write("a.bin", Data(count: 100)), try scratch.write("b.bin", Data(count: 300))])
    _ = await files.upload(through: uploader)
    #expect(seen.withLock { $0.count } == 2)
    #expect(files.progress == 1)
    files.discardAll()
  }

  @Test("an upload that is done is not sent twice when the answer is sent again")
  func uploadedOnce() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let log = UploadLog()

    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])
    let first = await files.upload(through: log.recording())
    let second = await files.upload(through: log.recording())
    #expect(first == second)
    #expect(log.all.count == 1)

    // Going back to choosing sends them again, to new names.
    files.reopen()
    #expect(files.phase == .choosing)
    #expect(files.uploaded.isEmpty)
    let third = await files.upload(through: log.recording())
    #expect(log.all.count == 2)
    #expect(third?.first?.path != first?.first?.path)
    files.discardAll()
  }

  @Test("the path the gateway answers is used when it is still directly in the directory, the asked one when it is not")
  func landedPath() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let inside: InteractiveUploader = { _, _, _, _, _ in "/work/up/3f9c2a7b1d4e8f60-renamed.txt" }
    let outside: InteractiveUploader = { _, _, _, _, _ in "/etc/elsewhere/x.txt" }

    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])
    #expect(await files.upload(through: inside)?.first?.path == "/work/up/3f9c2a7b1d4e8f60-renamed.txt")
    files.reopen()

    let asked = try #require(await files.upload(through: outside)?.first?.path)
    #expect(asked.hasPrefix("/work/up/"), "a path outside the directory is never answered")
    files.discardAll()
  }

  @Test("an upload that fails answers nothing and says how; Try again uploads, with the files still there")
  func failure() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let failing: InteractiveUploader = { _, _, _, _, _ in
      throw GatewayError(.server, "The gateway answered HTTP 502 on the upload.", status: 502)
    }

    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])
    #expect(await files.upload(through: failing) == nil)
    #expect(files.phase == .failed)
    #expect(files.failure == .failed(message: "The gateway answered HTTP 502 on the upload."))
    #expect(files.items.count == 1)
    #expect(files.canUpload, "Try again")

    let log = UploadLog()
    #expect(await files.upload(through: log.recording()) != nil)
    #expect(files.phase == .uploaded)
    #expect(files.failure == nil)
    files.discardAll()
  }

  @Test("a 413 is the gateway's size limit, and a refusal keeps its own words")
  func failureKinds() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])

    _ = await files.upload(through: { _, _, _, _, _ in throw GatewayError(.protocol, "x", status: 413) })
    #expect(files.failure == .tooLarge(limitBytes: AttachmentRules.maxFileBytes))
    _ = await files.upload(through: { _, _, _, _, _ in
      throw GatewayError(.protocol, "The upload failed.", status: 403, hint: "Outside the allowed workspace")
    })
    #expect(files.failure == .refused(detail: "Outside the allowed workspace"))
    files.discardAll()
  }

  @Test("Cancel stops the upload on its way: nothing is answered and the files can be sent again")
  func cancelling() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let started = Mutex(false)
    let hanging: InteractiveUploader = { _, _, _, path, _ in
      started.withLock { $0 = true }
      try await Task.sleep(for: .seconds(60))
      return path
    }

    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])

    let running = Task { await files.upload(through: hanging) }
    let deadline = ContinuousClock.now + .seconds(10)

    while !started.withLock({ $0 }), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }

    #expect(files.phase == .uploading)
    files.cancel()
    #expect(await running.value == nil)
    #expect(files.phase == .choosing)
    #expect(files.failure == nil, "cancelling is not a failure")
    #expect(files.items.count == 1)
    #expect(files.canUpload)
    files.discardAll()
  }

  @Test("files cannot be added or removed while they are on their way")
  func lockedWhileUploading() async throws {
    let scratch = try Scratch()
    let files = InteractiveFileModel(params: fileParams())
    let started = Mutex(false)
    let hanging: InteractiveUploader = { _, _, _, path, _ in
      started.withLock { $0 = true }
      try await Task.sleep(for: .seconds(60))
      return path
    }

    await files.importFiles([try scratch.write("a.txt", Data("a".utf8))])
    let running = Task { await files.upload(through: hanging) }

    while !started.withLock({ $0 }) {
      try await Task.sleep(for: .milliseconds(5))
    }

    let extra = try AttachmentStaging.stage(data: Data([1]), name: "late.bin")
    #expect(!files.add(extra))
    files.remove(files.items[0].id)
    #expect(files.items.count == 1)
    files.cancel()
    _ = await running.value
    files.discardAll()
  }

  @Test("the SHA-256 of a file is read in chunks and matches the whole")
  func digest() async throws {
    let scratch = try Scratch()
    // Larger than one chunk, and not a multiple of it.
    let data = Data((0..<700_001).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
    let url = try scratch.write("big.bin", data)

    #expect(try await InteractiveFileStaging.sha256(of: url) == sha(data))
    #expect(try await InteractiveFileStaging.sha256(of: try scratch.write("empty", Data()))
      == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  }

  @Test("the pickers are told what the request accepts")
  func contentTypes() {
    #expect(InteractiveFileStaging.contentTypes(for: .image) == [.image])
    #expect(InteractiveFileStaging.contentTypes(for: .audio) == [.audio])
    #expect(InteractiveFileStaging.contentTypes(for: .any) == [.item])
    #expect(InteractiveFileStaging.contentTypes(for: nil) == [.item])
    #expect(InteractiveFileStaging.contentTypes(for: .document).contains(.pdf))
    #expect(!InteractiveFileStaging.contentTypes(for: .document).contains(.image))
  }
}
