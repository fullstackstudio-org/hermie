import Foundation
import HermieCore
import Testing
import UniformTypeIdentifiers

@testable import HermieUI

#if os(macOS)
  import AppKit
#endif

/// Files and pictures dropped on the chat: which road each dragged item takes, what is refused and
/// why, several items at once, and the copy that is made before the sender's own is gone. Item
/// providers are built by hand, as the system builds them for a drag out of the Finder, Photos or a
/// browser; no pasteboard, window or app is involved.
@MainActor
@Suite struct AttachmentDropTests {
  // MARK: Fakes

  private struct Scratch {
    let folder: URL

    init() throws {
      folder = FileManager.default.temporaryDirectory.appendingPathComponent("drop-tests-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    @discardableResult func write(_ name: String, _ text: String = "hello") throws -> URL {
      let url = folder.appendingPathComponent(name)
      try Data(text.utf8).write(to: url)
      return url
    }

    func sparse(_ name: String, size: Int) throws -> URL {
      let url = folder.appendingPathComponent(name)
      FileManager.default.createFile(atPath: url.path, contents: nil)
      let handle = try FileHandle(forWritingTo: url)
      try handle.truncate(atOffset: UInt64(size))
      try handle.close()
      return url
    }

    func remove() {
      try? FileManager.default.removeItem(at: folder)
    }
  }

  private func makeTray() -> AttachmentTray {
    AttachmentTray(
      AttachmentTray.Dependencies(upload: { file, _ in
        .file(filename: file.name, path: "/work/space/uploads/\(file.name)")
      }))
  }

  /// What the Finder hands over: the file's URL, named after the file.
  private func finderItem(_ url: URL) -> NSItemProvider {
    let provider = NSItemProvider(object: url as NSURL)
    provider.suggestedName = url.deletingPathExtension().lastPathComponent
    return provider
  }

  /// A picture with no file behind it (a screenshot dragged out of an app, an image out of a page).
  private func pictureItem(_ data: Data, type: UTType = .png, name: String? = nil) -> NSItemProvider {
    let provider = NSItemProvider()
    provider.suggestedName = name
    provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
      completion(data, nil)
      return nil
    }
    return provider
  }

  /// A file the sender writes when it is asked (a promised file: Photos, Mail), and takes away again
  /// when the callback returns.
  private func promisedItem(_ text: String, type: UTType, name: String, in scratch: Scratch) -> NSItemProvider {
    let provider = NSItemProvider()
    provider.suggestedName = name
    provider.registerFileRepresentation(
      forTypeIdentifier: type.identifier, fileOptions: [], visibility: .all
    ) { completion in
      let url = scratch.folder.appendingPathComponent("promise-\(UUID().uuidString)-\(name)")
      try? Data(text.utf8).write(to: url)
      completion(url, false, nil)
      return nil
    }
    return provider
  }

  private func wordsItem(_ text: String) -> NSItemProvider {
    NSItemProvider(object: text as NSString)
  }

  private let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  // MARK: Routes

  @Test func aDragIsRoutedByTheTypesItOffers() {
    let route = AttachmentIntake.route(forTypeIdentifiers:)

    // A file in place: the Finder.
    #expect(route([UTType.fileURL.identifier, UTType.url.identifier]) == .fileURL)
    // A file URL wins over whatever else the same item says (a name as words, a picture of the icon).
    #expect(route([UTType.utf8PlainText.identifier, UTType.fileURL.identifier, UTType.png.identifier]) == .fileURL)
    // Pictures with no file: Photos, a page, a screenshot. The picture's own type is asked for.
    #expect(route([UTType.png.identifier]) == .representation(.png))
    #expect(route([UTType.html.identifier, UTType.jpeg.identifier]) == .representation(.jpeg))
    #expect(route([UTType.url.identifier, UTType.tiff.identifier]) == .representation(.tiff))
    // Any other content a sender gives as data.
    #expect(route([UTType.zip.identifier]) == .representation(.zip))
    #expect(route([UTType.pdf.identifier]) == .representation(.pdf))
    // A promised file whose own type is not one the system knows: asked for as an item.
    #expect(route([AttachmentIntake.filePromiseType]) == .representation(.item))
    #expect(route([UTType.plainText.identifier, AttachmentIntake.filePromiseType]) == .representation(.item))
  }

  @Test func wordsAndLinksAreNotAttachments() {
    let route = AttachmentIntake.route(forTypeIdentifiers:)

    #expect(route([UTType.utf8PlainText.identifier]) == .unsupported)
    #expect(route([UTType.plainText.identifier, UTType.html.identifier, UTType.rtf.identifier]) == .unsupported)
    // A link out of a browser's address bar: a web address is not a file URL.
    #expect(route([UTType.url.identifier, UTType.utf8PlainText.identifier]) == .unsupported)
    #expect(route([]) == .unsupported)

    #expect(!AttachmentIntake.isAttachable(wordsItem("just words")))
    #expect(AttachmentIntake.isAttachable(pictureItem(pngBytes)))
  }

  @Test func theChatSaysWhyWhenARequestHasTheComposer() {
    typealias Gate = AttachmentDropGate

    #expect(Gate.verdict(attachable: 0, blocked: false) == .notAnAttachment)
    // Words are not announced at all, blocked or not: there is nothing to refuse.
    #expect(Gate.verdict(attachable: 0, blocked: true) == .notAnAttachment)
    #expect(Gate.verdict(attachable: 3, blocked: false) == .accept)
    #expect(Gate.verdict(attachable: 1, blocked: true) == .blocked)
  }

  // MARK: What a provider's item can be

  @Test func aFileURLIsReadFromAURLItsDataOrItsText() throws {
    let url = URL(fileURLWithPath: "/tmp/some file.txt")

    #expect(AttachmentIntake.fileURL(fromItem: url) == url)
    #expect(AttachmentIntake.fileURL(fromItem: url as NSURL) == url)
    #expect(AttachmentIntake.fileURL(fromItem: url.dataRepresentation)?.path == url.path)
    #expect(AttachmentIntake.fileURL(fromItem: url.absoluteString)?.path == url.path)
    // Not a file: a link, nothing, or something else entirely.
    #expect(AttachmentIntake.fileURL(fromItem: URL(string: "https://example.com/a.png")!) == nil)
    #expect(AttachmentIntake.fileURL(fromItem: nil) == nil)
    #expect(AttachmentIntake.fileURL(fromItem: 42) == nil)
  }

  // MARK: Dropping

  @Test func aFileDroppedFromTheFinderIsCopiedAndTheOriginalLeftAlone() async throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let original = try scratch.write("report.csv", "a,b\n1,2")
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([finderItem(original)], to: tray)

    // At once, before anything is read: a chip, preparing, so the send waits for it.
    #expect(tray.items.count == 1)
    #expect(tray.items.first?.preparing == true)
    #expect(tray.blocked)

    await receipt.finished.value

    #expect(receipt.accepted == 1)
    #expect(receipt.refused == 0)
    let chip = try #require(tray.items.first)
    #expect(chip.preparing == false)
    #expect(chip.name == "report.csv")
    #expect(chip.kind == .file)
    #expect(chip.size == 7)
    #expect(chip.problem == nil)
    #expect(FileManager.default.fileExists(atPath: original.path))
    tray.clear()
  }

  @Test func aPictureWithNoFileBehindItIsStagedAsAnImage() async throws {
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([pictureItem(pngBytes, name: "Screenshot")], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.name == "Screenshot.png", "the picture's type gives a nameless item its extension")
    #expect(chip.kind == .image)
    #expect(chip.size == pngBytes.count)
    #expect(chip.problem == nil)
    tray.clear()
  }

  @Test func aPromisedFileIsCopiedInsideTheCallbackThatIsGivenIt() async throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped(
      [promisedItem("ab,cd", type: .pdf, name: "export.pdf", in: scratch)], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.problem == nil)
    #expect(chip.size == 5)
    #expect(chip.name == "export.pdf")
    #expect(chip.kind == .file)
    #expect(chip.status != .failed)
    tray.clear()
  }

  @Test func severalItemsBecomeOneChipEachInTheOrderTheyWereDropped() async throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let tray = makeTray()
    let a = try scratch.write("a.txt", "1")
    let b = try scratch.write("b.txt", "22")

    let receipt = AttachmentIntake.addDropped(
      [finderItem(a), pictureItem(pngBytes, name: "shot"), finderItem(b), wordsItem("note")], to: tray)

    #expect(tray.items.count == 4)
    await receipt.finished.value

    #expect(receipt.accepted == 3)
    #expect(receipt.refused == 1)
    #expect(tray.items.map(\.name).prefix(3) == ["a.txt", "shot.png", "b.txt"])
    #expect(tray.items.map(\.size).prefix(3) == [1, pngBytes.count, 2])
    tray.clear()
  }

  @Test func wordsInAMixedDropAreRefusedWithAChipThatSaysSo() async throws {
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([wordsItem("a sentence")], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(receipt.accepted == 0)
    #expect(receipt.refused == 1)
    #expect(chip.status == .failed)
    #expect(chip.problem == .unsupported(.notAttachable))
    #expect(chip.canRetry == false)
    #expect(chip.problem?.message == NativeStrings.Composer.Attach.notAttachable)
    // A refused chip holds the send back until it is removed: what is shown is what goes.
    #expect(tray.blocked)
    tray.remove(chip.id)
    #expect(!tray.blocked)
  }

  @Test func aFolderIsRefusedBeforeAnythingIsCopied() async throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let folder = scratch.folder.appendingPathComponent("photos")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data("x".utf8).write(to: folder.appendingPathComponent("1.txt"))
    let tray = makeTray()

    let receipt = AttachmentIntake.addDropped([finderItem(folder)], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.status == .failed)
    #expect(chip.problem == .unsupported(.folder))
    #expect(chip.problem?.message == NativeStrings.Composer.Attach.folder)
    #expect(chip.canRetry == false)
  }

  @Test func aFileOverItsCapFailsWithItsSize() async throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let tray = makeTray()
    let bigImage = try scratch.sparse("huge.png", size: AttachmentRules.maxImageBytes + 1)
    let bigFile = try scratch.sparse("huge.bin", size: AttachmentRules.maxFileBytes + 1)

    let receipt = AttachmentIntake.addDropped([finderItem(bigImage), finderItem(bigFile)], to: tray)
    await receipt.finished.value

    #expect(tray.items.map(\.status) == [.failed, .failed])
    #expect(tray.items.first?.problem == .tooLarge(limitBytes: AttachmentRules.maxImageBytes))
    #expect(tray.items.last?.problem == .tooLarge(limitBytes: AttachmentRules.maxFileBytes))
    #expect(tray.items.map(\.canRetry) == [false, false])
    #expect(tray.items.map(\.size) == [AttachmentRules.maxImageBytes + 1, AttachmentRules.maxFileBytes + 1])
  }

  @Test func aFileThatCannotBeReadFails() async throws {
    let tray = makeTray()
    let gone = URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)/missing.txt")

    let receipt = AttachmentIntake.addDropped([finderItem(gone)], to: tray)
    await receipt.finished.value

    let chip = try #require(tray.items.first)
    #expect(chip.status == .failed)
    guard case .unreadable? = chip.problem else {
      Issue.record("expected an unreadable problem, got \(String(describing: chip.problem))")
      return
    }
  }

  // MARK: The field leaves files to the chat

  #if os(macOS)
    @Test func theFieldDoesNotRegisterForFilesOrPicturesSoTheyReachTheChat() {
      let types: [NSPasteboard.PasteboardType] = [
        .string, .rtf, .html, .fileURL, .tiff, .png, .pdf,
        NSPasteboard.PasteboardType("NSFilenamesPboardType"),
        NSPasteboard.PasteboardType("public.jpeg"),
        NSPasteboard.PasteboardType(AttachmentIntake.filePromiseType)
      ]

      #expect(KeyTextView.textDragTypes(in: types) == [.string, .rtf, .html])
    }

    @Test func aDragOfFilesIsNeverTheFieldsEvenWhenItCarriesWordsToo() {
      let board = NSPasteboard(name: NSPasteboard.Name("hermie-drop-test-\(UUID().uuidString)"))
      defer { board.releaseGlobally() }

      board.declareTypes([.string, .fileURL], owner: nil)
      #expect(KeyTextView.carriesAttachment(board))

      board.declareTypes([.string, .rtf], owner: nil)
      #expect(!KeyTextView.carriesAttachment(board))
    }
  #endif
}
