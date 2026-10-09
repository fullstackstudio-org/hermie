import Foundation
import HermieCore
import Testing
import UniformTypeIdentifiers

@testable import HermieUI

/// What a dropped item is once its bytes are read: a PDF stays a PDF whatever type the sender
/// declared (TestFlight: a dragged PDF arrived as "Image 2026-10-05 at 13.25.50"), a picture stays a
/// picture, text stays text, and what is not recognised keeps its own name as a plain file.
@MainActor
@Suite struct DroppedFileTypeTests {
  private let pdf = Data("%PDF-1.7\n%âãÏÓ\n1 0 obj".utf8)
  private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
  private let jpg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46])
  private let text = Data("Dear Sebas,\nthe invoice is attached.\n".utf8)
  private let unknown = Data([0x00, 0x01, 0xFE, 0xED, 0x13, 0x37, 0x00, 0x99])

  private func makeTray() -> AttachmentTray {
    AttachmentTray(
      AttachmentTray.Dependencies(upload: { file, _ in .file(filename: file.name, path: "/w/\(file.name)") }))
  }

  // MARK: Reading the bytes

  @Test func theFirstBytesNameAFormatTheyProve() {
    #expect(DroppedFileType.sniff(pdf) == .pdf)
    #expect(DroppedFileType.sniff(png) == .png)
    #expect(DroppedFileType.sniff(jpg) == .jpeg)
    #expect(DroppedFileType.sniff(Data("GIF89a....".utf8)) == .gif)
    #expect(DroppedFileType.sniff(Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)) == .webP)
    #expect(DroppedFileType.sniff(text) == nil)
    #expect(DroppedFileType.sniff(unknown) == nil)
    #expect(DroppedFileType.sniff(Data()) == nil)
    // A text that merely mentions the PDF header further in is not a PDF.
    #expect(DroppedFileType.sniff(Data("see the %PDF- header".utf8)) == nil)
  }

  @Test func textIsUTF8WithNoNul() {
    #expect(DroppedFileType.looksLikeText(text))
    #expect(DroppedFileType.looksLikeText(Data("héllo wörld".utf8)))
    #expect(!DroppedFileType.looksLikeText(unknown))
    #expect(!DroppedFileType.looksLikeText(Data()))
    // A read cut inside a multi-byte character is still text.
    #expect(DroppedFileType.looksLikeText(Data(Data("ab€".utf8).dropLast(1))))
  }

  // MARK: Deciding

  @Test func aPDFIsAPDFWhateverTheSenderCalledIt() {
    // Declared as a picture, as a catch-all, or as nothing: the bytes say PDF.
    #expect(DroppedFileType.resolve(declared: .png, names: [nil], head: pdf) == .pdf)
    #expect(DroppedFileType.resolve(declared: .image, names: [nil], head: pdf) == .pdf)
    #expect(DroppedFileType.resolve(declared: .data, names: [nil, "blob"], head: pdf) == .pdf)
    #expect(DroppedFileType.resolve(declared: nil, names: [], head: pdf) == .pdf)
  }

  @Test func pngAndJpegAreKnownFromTheirBytes() {
    #expect(DroppedFileType.resolve(declared: .image, names: [nil], head: png) == .png)
    #expect(DroppedFileType.resolve(declared: .item, names: [nil], head: jpg) == .jpeg)
    // The bytes outrank a name that says something else.
    #expect(DroppedFileType.resolve(declared: .png, names: ["scan.png"], head: jpg) == .jpeg)
  }

  @Test func theNamesExtensionServesWhenTheBytesProveNothing() {
    #expect(DroppedFileType.resolve(declared: .data, names: ["data.json"], head: text) == .json)
    #expect(DroppedFileType.resolve(declared: .item, names: [nil, "budget.csv"], head: unknown) == .commaSeparatedText)
    // An extension the system does not know is no evidence.
    #expect(DroppedFileType.resolve(declared: .data, names: ["thing.zzqx9"], head: unknown) == nil)
  }

  @Test func aSpecificDeclaredTypeIsTrustedAndACatchAllIsNot() {
    #expect(DroppedFileType.resolve(declared: .zip, names: [nil], head: unknown) == .zip)
    #expect(DroppedFileType.resolve(declared: .data, names: [nil], head: unknown) == nil)
    #expect(DroppedFileType.resolve(declared: .image, names: [nil], head: unknown) == nil)
  }

  @Test func textIsTextAndTheRestIsUnknown() {
    #expect(DroppedFileType.resolve(declared: .data, names: [nil], head: text) == .plainText)
    #expect(DroppedFileType.resolve(declared: .item, names: [nil], head: unknown) == nil)
  }

  // MARK: Naming

  @Test func aNamelessPDFIsNeverCalledAnImage() {
    let name = DroppedFileType.name(suggested: nil, fileName: nil, resolved: .pdf)

    #expect(name == "\(NativeStrings.Composer.Attach.item).pdf")
    #expect(!name.hasPrefix("Image"))
  }

  @Test func aNamelessPictureIsDatedAndGetsItsExtension() {
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    #expect(DroppedFileType.name(suggested: nil, fileName: nil, resolved: .png, now: now).hasPrefix("Image "))
    #expect(DroppedFileType.name(suggested: nil, fileName: nil, resolved: .png, now: now).hasSuffix(".png"))
    #expect(DroppedFileType.name(suggested: nil, fileName: nil, resolved: .jpeg, now: now).hasSuffix(".jpeg"))
  }

  @Test func theSendersNameIsKeptAndTheExtensionIsCompleted() {
    #expect(DroppedFileType.name(suggested: "Invoice", fileName: "x", resolved: .pdf) == "Invoice.pdf")
    #expect(DroppedFileType.name(suggested: "Invoice.pdf", fileName: "x", resolved: .pdf) == "Invoice.pdf")
    #expect(DroppedFileType.name(suggested: "photo.jpg", fileName: nil, resolved: .jpeg) == "photo.jpg")
    #expect(DroppedFileType.name(suggested: "Report v1.2", fileName: nil, resolved: .pdf) == "Report v1.2.pdf")
    // The copy's own name stands in when the sender gave none.
    #expect(DroppedFileType.name(suggested: nil, fileName: "contract.docx", resolved: nil) == "contract.docx")
    // A name that says one format over bytes of another is corrected.
    #expect(DroppedFileType.name(suggested: "scan.png", fileName: nil, resolved: .pdf) == "scan.pdf")
    // Unknown stays as it is.
    #expect(DroppedFileType.name(suggested: "blob", fileName: nil, resolved: nil) == "blob")
  }

  // MARK: Routes

  @Test func aFileOfItsOwnFormatBeatsThePictureBesideIt() {
    let route = AttachmentIntake.route(forTypeIdentifiers:)

    // A PDF dragged out of an app that also offers its first page as a picture.
    #expect(route([UTType.png.identifier, UTType.pdf.identifier]) == .representation(.pdf))
    #expect(route([UTType.tiff.identifier, UTType.pdf.identifier]) == .representation(.pdf))
    #expect(route([UTType.pdf.identifier, UTType.png.identifier]) == .representation(.pdf))
    // A catch-all next to a picture does not make the picture a "file".
    #expect(route([UTType.data.identifier, UTType.png.identifier]) == .representation(.png))
    // Real pictures, text and unknown stay as they were.
    #expect(route([UTType.jpeg.identifier]) == .representation(.jpeg))
    #expect(route([UTType.plainText.identifier]) == .unsupported)
    #expect(route([UTType.data.identifier]) == .representation(.data))
    // A file URL is still the file itself.
    #expect(route([UTType.png.identifier, UTType.pdf.identifier, UTType.fileURL.identifier]) == .fileURL)
  }

  // MARK: End to end

  @Test func aPDFOfferedUnderACatchAllTypeWithNoNameArrivesAsAPDF() async throws {
    let provider = NSItemProvider()
    let bytes = pdf
    provider.registerDataRepresentation(forTypeIdentifier: UTType.data.identifier, visibility: .all) { completion in
      completion(bytes, nil)
      return nil
    }
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([provider], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.problem == nil)
    #expect(chip.name.hasSuffix(".pdf"))
    #expect(!chip.name.hasPrefix("Image"))
    #expect(chip.kind == .file)
    #expect(chip.size == bytes.count)
    tray.clear()
  }

  @Test func aPDFOfferedBesideItsPagePictureStaysAFile() async throws {
    let provider = NSItemProvider()
    provider.suggestedName = "Invoice-0001"
    let bytes = pdf
    for type in [UTType.png, .pdf] {
      provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
        completion(bytes, nil)
        return nil
      }
    }
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([provider], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.name == "Invoice-0001.pdf")
    #expect(chip.kind == .file)
    #expect(chip.size == bytes.count)
    tray.clear()
  }
}
