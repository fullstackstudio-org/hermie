import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The vectors (`contract/transcript/golden/inline-images.json`) replay in `ParityGates`; these are the
/// inputs too big to record, and the transcript's use of the scan.
@Suite struct InlineImagesTests {
  static let png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

  /// A PNG signature, then zeros: a body of about `bytes` decoded bytes, in whole groups.
  static func pngBody(_ bytes: Int) -> String {
    let groups = bytes / 3
    return "iVBORw0KGgo" + String(repeating: "A", count: groups * 4 - 11)
  }

  @Test func aPictureOverTheCapIsRefusedAndNeverPrinted() {
    let body = Self.pngBody(inlineImageMaxBytes + 4096)
    let scan = scanInlineImages("[Image attached at: /x/huge.png]\ndata:image/png;base64,\(body)\nafter")

    #expect(scan.text == "after")
    #expect(scan.images.isEmpty)
    #expect(scan.references == ["@image:/x/huge.png"])
  }

  @Test func aPictureJustUnderTheCapIsKept() {
    let body = Self.pngBody(inlineImageMaxBytes - 16)
    let scan = scanInlineImages("data:image/png;base64,\(body)")

    #expect(scan.images.count == 1)
    #expect(scan.images.first?.data.utf8.count == body.utf8.count)
  }

  @Test func aVeryLongTextIsReadInOnePass() {
    let filler = String(repeating: "x", count: 2_000_000)
    let started = Date()
    let scan = scanInlineImages("\(filler)\ndata:image/png;base64,\(Self.png)\n\(filler)")

    #expect(scan.images.count == 1)
    #expect(scan.text.utf8.count == filler.utf8.count * 2 + 1)
    #expect(Date().timeIntervalSince(started) < 2)
  }

  @Test func aMessageGivesUpPicturesPastTheCapWithoutPrintingThem() {
    let many = Array(repeating: "data:image/png;base64,\(Self.png)", count: inlineImageMaxCount + 5).joined(separator: "\n")
    let scan = scanInlineImages("hi\n\(many)")

    #expect(scan.text == "hi")
    #expect(scan.images.count == inlineImageMaxCount)
  }

  @Test func textAroundMultibyteCharactersIsNotSplit() {
    let scan = scanInlineImages("héllo 🙂\n[Image attached at: /x/é.png]\ndata:image/png;base64,\(Self.png)\nwörld")

    #expect(scan.text == "héllo 🙂\nwörld")
    #expect(scan.images.first?.name == "é.png")
  }

  @Test func theTranscriptUsesIt() {
    let text = "what is this?\n\n[Image attached at: /root/.hermes/images/upload_1.png]\ndata:image/png;base64,\(Self.png)"
    let stripped = stripUserText(text)

    #expect(stripped.text == "what is this?")
    #expect(stripped.inlineImages == [InlineImage(name: "upload_1.png", mime: "image/png", data: Self.png)])
    #expect(stripped.attachments == nil)

    let handle = stripUserText("look @file:/x/report.pdf\n[Image attached at: /x/shot.png]")
    #expect(handle.text == "look")
    #expect(handle.attachments == ["@file:/x/report.pdf", "@image:/x/shot.png"])
  }

  @Test func theLineOfAnUnnamedImageBecomesThePlaceholderReference() {
    let stripped = stripUserText("what is this?\n[image]")

    #expect(stripped.text == "what is this?")
    #expect(stripped.attachments == ["@image:Image"])
    #expect(stripped.inlineImages == nil)

    // Only a line of its own: inside a sentence it is words.
    #expect(scanInlineImages("an [image] here").references.isEmpty)
    #expect(scanInlineImages("an [image] here").text == "an [image] here")
  }

  @Test func onlyThePlaceholderReferenceIsThePlaceholder() {
    #expect(isImagePlaceholder("@image:Image"))
    #expect(!isImagePlaceholder("@image:photo.png"))
    #expect(!isImagePlaceholder("@image:/x/Image"))
    #expect(!isImagePlaceholder("@file:Image"))
  }

  @Test func aHistoryRowBecomesItemsWithTheirPicturesAndNoMarker() throws {
    let rows: [JSONValue] = [
      .object(["role": .string("user"), "content": .string("hi\n[Image attached at: /x/a.png]\ndata:image/png;base64,\(Self.png)")]),
      .object(["role": .string("user"), "content": .string("data:image/png;base64,\(Self.png)")]),
      .object(["role": .string("assistant"), "content": .string("Here\n\n![chart](data:image/png;base64,\(Self.png))")])
    ]
    let items = rowsToItems(rows.map { TranscriptRow(json: $0.objectValue ?? [:]) }, .rest)

    #expect(items.count == 3)
    guard case .user(let first) = items[0], case .user(let second) = items[1], case .assistant(let reply) = items[2] else {
      Issue.record("unexpected item kinds")
      return
    }
    #expect(first.text == "hi")
    #expect(first.inlineImages?.count == 1)
    #expect(second.text.isEmpty && second.inlineImages?.count == 1)
    #expect(reply.text == "Here")
    #expect(reply.inlineImages?.first?.name == "Image")
  }
}
