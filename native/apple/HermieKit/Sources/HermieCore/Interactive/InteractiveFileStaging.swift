import CryptoKit
import CoreGraphics
import Foundation
import HermieProtocol
import ImageIO
import UniformTypeIdentifiers

/// Making the files of an `input.file` request ready to upload: a copy the app owns (a picked file
/// is only readable inside its security scope), its metadata removed when the request asks for it,
/// a scan assembled into a PDF, and the SHA-256 of the bytes that will go out. Nothing here talks
/// to the gateway or draws anything.
public enum InteractiveFileStaging {
  /// What a request's `accept` lets through, as the content types a file picker is told to offer.
  public static func contentTypes(for accept: FileAccept?) -> [UTType] {
    switch accept {
    case .image?:
      return [.image]
    case .audio?:
      return [.audio]
    case .document?:
      let office = ["org.openxmlformats.wordprocessingml.document", "com.microsoft.word.doc"].compactMap {
        UTType($0)
      }
      return [.pdf, .text, .rtf, .spreadsheet, .presentation] + office
    default:
      return [.item]
    }
  }

  public static func mimeType(forFileNamed name: String) -> String? {
    let ext = (name as NSString).pathExtension
    return ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType ?? fallbackTypes[ext.lowercased()]
  }

  /// Audio the system knows by extension but names no MIME type for (a recording the person picks for a voice note
  /// must still say it is audio: the contract's example is a `.caf`, `audio/x-caf`).
  private static let fallbackTypes = ["caf": "audio/x-caf"]

  // MARK: Copies

  /// A copy of a picked file in the app's own staging folder, read inside its security scope. A
  /// file over `limit` is refused before a byte is copied.
  public static func copy(_ source: URL, limit: Int? = nil) throws(StagingFailure) -> PickedFile {
    let scoped = source.startAccessingSecurityScopedResource()

    defer {
      if scoped {
        source.stopAccessingSecurityScopedResource()
      }
    }

    let name = source.lastPathComponent
    let known = AttachmentStaging.size(of: source)

    if let known, let limit, known > limit {
      throw .tooLarge(limitBytes: limit, size: known)
    }

    do {
      let destination = try AttachmentStaging.slot(for: name)
      try FileManager.default.copyItem(at: source, to: destination)
      return PickedFile(
        name: name, mimeType: mimeType(forFileNamed: name), size: AttachmentStaging.size(of: destination) ?? known ?? 0,
        url: destination)
    } catch {
      throw .unreadable(message: (error as NSError).localizedDescription)
    }
  }

  /// "Photo 2026-10-04 at 14.05.09.jpg".
  public static func dated(_ prefix: String, ext: String, now: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    return "\(prefix) \(formatter.string(from: now)).\(ext)"
  }

  // MARK: Metadata

  /// The file with its EXIF and GPS data removed, for `strip_metadata`: an image is written again
  /// from its pixels (orientation kept, nothing else), a HEIC or other photo as a JPEG, and what is
  /// not a picture (a document, an SVG) is left as it is. The copy `file` is replaced.
  public static func strippingMetadata(_ file: PickedFile) throws(StagingFailure) -> PickedFile {
    let ext = file.url.pathExtension.lowercased()

    guard let type = UTType(filenameExtension: ext), type.conforms(to: .image), !type.conforms(to: .svg) else {
      return file
    }

    var name = file.name
    let target: UTType

    if type.conforms(to: .jpeg) {
      target = .jpeg
    } else if type.conforms(to: .png) {
      target = .png
    } else if type.conforms(to: .tiff) {
      target = .tiff
    } else if type.conforms(to: .bmp) {
      target = .bmp
    } else {
      // HEIC and the rest: the one format every gateway reads.
      target = .jpeg
      name = AttachmentStaging.jpegName(for: file.name)
    }

    do {
      let destination = try AttachmentStaging.slot(for: name)

      do {
        try AttachmentPrivacy.reencode(from: file.url, to: destination, as: target)
      } catch {
        AttachmentStaging.discard(destination)
        throw StagingFailure.unreadable(message: (error as NSError).localizedDescription)
      }

      AttachmentStaging.discard(file.url)
      return PickedFile(
        name: name, mimeType: target.preferredMIMEType, size: AttachmentStaging.size(of: destination) ?? 0, url: destination)
    } catch let failure as StagingFailure {
      throw failure
    } catch {
      throw .unreadable(message: (error as NSError).localizedDescription)
    }
  }

  // MARK: Scans

  /// The pages of a scan, each a JPEG, as one PDF in the staging folder (`accept: document`). The
  /// JPEG bytes go into the PDF as they are, so a page is not compressed a second time.
  public static func pdf(fromPages pages: [Data], named name: String) throws(StagingFailure) -> PickedFile {
    guard !pages.isEmpty else {
      throw .unreadable(message: "The scan has no pages.")
    }

    do {
      let destination = try AttachmentStaging.slot(for: name)

      guard let consumer = CGDataConsumer(url: destination as CFURL), let context = CGContext(consumer: consumer, mediaBox: nil, nil)
      else {
        throw StagingFailure.unreadable(message: "The scan could not be written as a PDF.")
      }

      for page in pages {
        guard let image = Self.image(from: page) else {
          context.closePDF()
          AttachmentStaging.discard(destination)
          throw StagingFailure.unreadable(message: "A page of the scan could not be read.")
        }

        // Points: the longest side is an A4's, whatever the camera's resolution.
        let scale = 842 / CGFloat(max(image.width, image.height))
        var box = CGRect(x: 0, y: 0, width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)

        context.beginPage(mediaBox: &box)
        context.draw(image, in: box)
        context.endPage()
      }

      context.closePDF()
      return PickedFile(
        name: name, mimeType: "application/pdf", size: AttachmentStaging.size(of: destination) ?? 0, url: destination)
    } catch let failure as StagingFailure {
      throw failure
    } catch {
      throw .unreadable(message: (error as NSError).localizedDescription)
    }
  }

  /// The page as an image that keeps its JPEG bytes when a PDF context draws it.
  private static func image(from data: Data) -> CGImage? {
    if let provider = CGDataProvider(data: data as CFData),
      let image = CGImage(
        jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    {
      return image
    }

    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
      return nil
    }

    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }

  /// The pages of a scan as one JPEG each, in the staging folder.
  public static func jpegs(fromPages pages: [Data], baseName: String) throws(StagingFailure) -> [PickedFile] {
    var files: [PickedFile] = []

    for (index, page) in pages.enumerated() {
      let name = pages.count == 1 ? "\(baseName).jpg" : "\(baseName) page \(index + 1).jpg"

      do {
        files.append(try AttachmentStaging.stage(data: page, name: name, mimeType: "image/jpeg"))
      } catch {
        for staged in files {
          AttachmentStaging.discard(staged.url)
        }

        throw error
      }
    }

    return files
  }

  // MARK: Digest

  /// The SHA-256 of a file, 64 lowercase hex, read in chunks off the calling actor.
  public static func sha256(of file: URL) async throws -> String {
    try await Task.detached(priority: .userInitiated) {
      let handle = try FileHandle(forReadingFrom: file)

      defer { try? handle.close() }

      var hash = SHA256()

      while let chunk = try handle.read(upToCount: 256 * 1024), !chunk.isEmpty {
        hash.update(data: chunk)
      }

      return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }.value
  }
}
