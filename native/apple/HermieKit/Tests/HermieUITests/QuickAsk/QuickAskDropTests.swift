#if os(macOS)
  import AppKit
  import Foundation
  import HermieCore
  import Testing
  import UniformTypeIdentifiers

  @testable import HermieUI

  /// Files, pictures and words dropped on the quick ask: which road each dragged item takes and
  /// where it lands. Item providers are built by hand, as the system builds them for a drag out of the
  /// Finder or a browser; no pasteboard, window or drag is involved.
  @MainActor
  @Suite struct QuickAskDropTests {
    private func folder() throws -> URL {
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("quick-ask-drop-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      return url
    }

    private func finderItem(_ url: URL) -> NSItemProvider {
      let provider = NSItemProvider(object: url as NSURL)
      provider.suggestedName = url.deletingPathExtension().lastPathComponent
      return provider
    }

    // MARK: Routes

    @Test func aFileOrAPictureIsAnAttachmentAndWordsAndLinksAreWords() {
      let kind = QuickAskDrop.kind(forTypeIdentifiers:)

      #expect(kind([UTType.fileURL.identifier, UTType.url.identifier]) == .attachment, "the Finder")
      #expect(kind([UTType.png.identifier]) == .attachment, "a picture with no file")
      #expect(kind([UTType.pdf.identifier]) == .attachment)
      #expect(kind([UTType.utf8PlainText.identifier]) == .words, "selected text")
      #expect(kind([UTType.plainText.identifier, UTType.html.identifier, UTType.rtf.identifier]) == .words)
      #expect(kind([UTType.url.identifier]) == .words, "a link")
      #expect(kind(["com.example.something-else"]) == .ignored)
      #expect(kind([]) == .ignored)
    }

    // MARK: Taking a drop

    @Test func droppedFilesAreChipsInTheTrayOfTheQuickAsksChat() async throws {
      let fixture = QuickAskFixture()
      fixture.model.sync()
      let tray = try #require(fixture.model.composer?.tray)
      let scratch = try folder()
      defer { try? FileManager.default.removeItem(at: scratch) }
      let notes = scratch.appendingPathComponent("notes.txt")
      try Data("one".utf8).write(to: notes)

      let receipt = QuickAskDrop.take([finderItem(notes)], into: fixture.model)

      #expect(receipt.attached == 1)
      #expect(receipt.words == 0)
      #expect(tray.items.count == 1, "a chip at once")
      #expect(tray.items.first?.preparing == true)
      await receipt.finished.value
      #expect(tray.items.map(\.name) == ["notes.txt"], "named after the file once it is copied in")
      #expect(tray.items.first?.preparing == false)
      tray.clear()
    }

    @Test func droppedWordsAreTypedIntoTheFieldAndALinkIsWrittenOut() async throws {
      let fixture = QuickAskFixture()
      fixture.model.sync()
      let composer = try #require(fixture.model.composer)

      let words = QuickAskDrop.take([NSItemProvider(object: "a dragged sentence" as NSString)], into: fixture.model)
      #expect(words.words == 1)
      #expect(words.attached == 0)
      await words.finished.value
      #expect(composer.draft == "a dragged sentence")

      let link = QuickAskDrop.take(
        [NSItemProvider(object: URL(string: "https://example.com/page")! as NSURL)], into: fixture.model)
      await link.finished.value
      #expect(composer.draft == "a dragged sentence\n\nhttps://example.com/page")
      #expect(composer.tray.items.isEmpty, "words are not attachments")
    }

    @Test func longDroppedWordsBecomeATextFileInTheTrayThroughTheUploadPath() async throws {
      let fixture = QuickAskFixture()
      fixture.model.sync()
      let composer = try #require(fixture.model.composer)
      let long = String(repeating: "x", count: QuickAskModel.inlineTextLimit + 1)

      let receipt = QuickAskDrop.take([NSItemProvider(object: long as NSString)], into: fixture.model)
      await receipt.finished.value

      #expect(composer.draft.isEmpty)
      #expect(composer.tray.items.map(\.name) == [QuickAskModel.textAttachmentName])
      composer.tray.clear()
    }

    @Test func filesAndWordsDroppedTogetherEachTakeTheirOwnRoad() async throws {
      let fixture = QuickAskFixture()
      fixture.model.sync()
      let composer = try #require(fixture.model.composer)
      let scratch = try folder()
      defer { try? FileManager.default.removeItem(at: scratch) }
      let report = scratch.appendingPathComponent("report.txt")
      try Data("two".utf8).write(to: report)

      let receipt = QuickAskDrop.take(
        [finderItem(report), NSItemProvider(object: "see the report" as NSString)], into: fixture.model)
      #expect(receipt.attached == 1)
      #expect(receipt.words == 1)
      await receipt.finished.value

      #expect(composer.tray.items.map(\.name) == ["report.txt"])
      #expect(composer.draft == "see the report")
      composer.tray.clear()
    }

    @Test func nothingIsTakenWhereThereIsNoChat() async {
      let fixture = QuickAskFixture(withBots: false)
      fixture.model.sync()
      #expect(fixture.model.composer == nil)

      let receipt = QuickAskDrop.take([NSItemProvider(object: "words" as NSString)], into: fixture.model)

      #expect(receipt.attached == 0)
      #expect(receipt.words == 0)
      await receipt.finished.value
    }

    @Test func somethingThatIsNeitherIsLeftAlone() async throws {
      let fixture = QuickAskFixture()
      fixture.model.sync()
      let provider = NSItemProvider()
      provider.registerDataRepresentation(forTypeIdentifier: "com.example.something-else", visibility: .all) {
        $0(Data([1]), nil)
        return nil
      }

      let receipt = QuickAskDrop.take([provider], into: fixture.model)

      #expect(receipt.attached == 0)
      #expect(receipt.words == 0)
      await receipt.finished.value
      #expect(fixture.model.composer?.tray.items.isEmpty == true)
    }
  }

  /// The text and the files the Services menu hands over, from a pasteboard of this test's own.
  @MainActor
  @Suite struct QuickAskServiceInputTests {
    private func pasteboard() -> NSPasteboard {
      NSPasteboard.withUniqueName()
    }

    @Test func selectedTextIsTheHandoverWithTheBotPickerFocused() throws {
      let board = pasteboard()
      defer { board.releaseGlobally() }
      board.clearContents()
      board.setString("  the selected sentence \n", forType: .string)

      let handoff = try #require(QuickAskServiceInput.handoff(from: board))

      #expect(handoff.text == "the selected sentence")
      #expect(handoff.files.isEmpty)
      #expect(handoff.focus == .botPicker)
    }

    @Test func filesSelectedInTheFinderAreTheHandoverAndWinOverTheirNames() throws {
      let board = pasteboard()
      defer { board.releaseGlobally() }
      let a = URL(fileURLWithPath: "/tmp/quick-ask-a.txt")
      let b = URL(fileURLWithPath: "/tmp/quick-ask-b.pdf")
      board.clearContents()
      board.writeObjects([a as NSURL, b as NSURL])
      board.setString("quick-ask-a.txt\nquick-ask-b.pdf", forType: .string)

      let handoff = try #require(QuickAskServiceInput.handoff(from: board))

      #expect(handoff.files.map(\.lastPathComponent) == ["quick-ask-a.txt", "quick-ask-b.pdf"])
      #expect(handoff.text == nil)
      #expect(handoff.focus == .botPicker)
    }

    @Test func anEmptySelectionHandsOverNothing() {
      let board = pasteboard()
      defer { board.releaseGlobally() }
      board.clearContents()
      board.setString(" \n ", forType: .string)

      #expect(QuickAskServiceInput.handoff(from: board) == nil)
    }

    @Test func theProviderPassesWhatItFindsToThePresenterAndIgnoresAnEmptyPasteboard() throws {
      let board = pasteboard()
      defer { board.releaseGlobally() }
      var presented: [QuickAskHandoff] = []
      let provider = QuickAskServicesProvider { presented.append($0) }
      var error: NSString = ""

      board.clearContents()
      provider.sendToHermie(board, userData: "", error: &error)
      #expect(presented.isEmpty)

      board.setString("send this", forType: .string)
      provider.sendToHermie(board, userData: "", error: &error)
      #expect(presented.map(\.text) == ["send this"])
    }

    @Test func theInfoPlistNamesTheMessageThePortAndTheTypesTheProviderHandles() throws {
      // The app's Info.plist is read from the source tree: the service is declared there, not in code.
      let plist = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("macos/App/Info.plist")
      let data = try Data(contentsOf: plist)
      let info = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
      let services = try #require(info["NSServices"] as? [[String: Any]])
      let service = try #require(services.first)

      #expect(services.count == 1)
      #expect(service["NSMessage"] as? String == "sendToHermie")
      #expect(service["NSPortName"] as? String == "$(PRODUCT_NAME)")
      #expect((service["NSMenuItem"] as? [String: String])?["default"] == "Send to Hermie")
      let types = try #require(service["NSSendTypes"] as? [String])
      #expect(types.contains("NSStringPboardType"))
      #expect(types.contains("public.file-url"))
      #expect(
        QuickAskServicesProvider.instancesRespond(to: NSSelectorFromString("sendToHermie:userData:error:")),
        "the provider answers to the message the plist names")
    }
  }

  /// What a key press is while the shortcut field records.
  @MainActor
  @Suite struct ShortcutRecordingTests {
    @Test func theKeysThatMatterAreTheFourModifiersAndNothingElse() {
      let shortcut = HotKeyShortcut(keyCode: 49, flags: [.option, .capsLock, .function, .numericPad])

      #expect(shortcut == .standard)
      #expect(HotKeyShortcut(keyCode: 40, flags: [.command, .shift, .option, .control]).display == "⌃⌥⇧⌘K")
    }

    @Test func aCombinationIsChosenEscapeCancelsAndDeleteClears() {
      #expect(ShortcutRecording.of(keyCode: 49, flags: [.option]) == .choose(.standard))
      #expect(ShortcutRecording.of(keyCode: 53, flags: []) == .cancel)
      #expect(ShortcutRecording.of(keyCode: 51, flags: []) == .clear)
      #expect(ShortcutRecording.of(keyCode: 117, flags: []) == .clear)
      // With a modifier held they are keys like any other.
      #expect(ShortcutRecording.of(keyCode: 53, flags: [.command]) == .choose(HotKeyShortcut(keyCode: 53, modifiers: [.command])))
      #expect(ShortcutRecording.of(keyCode: 51, flags: [.control]) == .choose(HotKeyShortcut(keyCode: 51, modifiers: [.control])))
    }

    @Test func aKeyWithNoModifierIsChosenAsPressedAndJudgedAfterwards() {
      guard case .choose(let bare) = ShortcutRecording.of(keyCode: 0, flags: []) else {
        Issue.record("expected a choice")
        return
      }

      #expect(!bare.isValid, "a letter alone is refused by the field's caller, not swallowed")
    }
  }
#endif
