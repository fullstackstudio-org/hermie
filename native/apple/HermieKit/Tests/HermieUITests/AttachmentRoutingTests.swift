import Foundation
import HermieCore
import HermieMarkdown
import HermieTranscript
import Testing

@testable import HermieUI

/// A chip does something: a picture opens in the gallery, any other file in Quick Look, and a
/// reference that cannot be had says so. Pictures a message holds itself are thumbnails from its bytes.
@MainActor
@Suite struct AttachmentRoutingTests {
  static let png = Data(
    base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!

  private func feed(files: @escaping @Sendable (String) -> Data?) throws -> ChatFeed {
    let session = GatewaySession(gatewayID: "routing-\(UUID().uuidString)", link: UnreachableLink(files: files))
    let owner = ChatFeedOwner<ChatFeed>()
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: session.gatewayID, bot: "writer"), session: session, standardActions: true) { _ in .none }
    }
    return try #require(owner.feed)
  }

  private func scratch(_ name: String, _ data: Data) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("routing-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(name)
    try data.write(to: url)
    return url
  }

  @Test func aFileGoesWhereItsKindSays() throws {
    #expect(ChatFeed.destination(of: try scratch("photo.PNG", Data("not read".utf8))) == .gallery, "the extension says picture")
    #expect(ChatFeed.destination(of: try scratch("9eh14f1h-Image-2026-10-04-at-16.31.52", Self.png)) == .gallery, "its bytes say picture")
    #expect(ChatFeed.destination(of: try scratch("report.pdf", Data("%PDF-1.7".utf8))) == .quickLook)
    #expect(ChatFeed.destination(of: try scratch("notes", Data("plain words".utf8))) == .quickLook)
    #expect(ChatFeed.destination(of: URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString)")) == .quickLook)
  }

  @Test func aChipForAPictureWithNoExtensionOpensTheGallery() async throws {
    let upload = "/root/.hermes/uploads/hermie/9eh14f1h-Image-2026-10-04-at-16.31.52"
    let png = Self.png
    let feed = try feed { $0 == "/api/files/download?path=\(upload)" ? png : nil }

    feed.itemActions.openAttachment("@file:\(upload)")
    await eventually("the gallery") { feed.itemActions.images?.presentation != nil }

    let gallery = try #require(feed.itemActions.images?.presentation?.model)
    #expect(gallery.images.count == 1)
    #expect(gallery.images.first?.reference == "@file:\(upload)")
    #expect(feed.attachmentPreview == nil)
    #expect(feed.attachmentNotice == nil)

    // The gallery draws it from the file the tap already fetched.
    let store = try #require(feed.itemActions.images)
    let drawn = await store.image("@file:\(upload)", maxPixel: 64)
    #expect(drawn != nil)
  }

  @Test func aChipForAnyOtherFileOpensQuickLook() async throws {
    let feed = try feed { $0.hasSuffix("report.pdf") ? Data("%PDF-1.7".utf8) : nil }

    feed.itemActions.openAttachment("@file:/root/uploads/report.pdf")
    await eventually("the preview") { feed.attachmentPreview != nil }

    #expect(feed.attachmentPreview?.lastPathComponent == "report.pdf")
    #expect(feed.itemActions.images?.presentation == nil)
  }

  @Test func aChipTheGatewayRefusesSaysSoInsteadOfDoingNothing() async throws {
    let feed = try feed { _ in nil }

    feed.itemActions.openAttachment("@file:/root/uploads/gone.pdf")
    await eventually("the notice") { feed.attachmentNotice != nil }

    #expect(feed.attachmentNotice == .failed(name: "gone.pdf"))
    #expect(feed.attachmentPreview == nil)
    #expect(feed.itemActions.images?.presentation == nil)
  }

  // MARK: What a message shows

  @Test func theHandleOfAnAttachedImageIsAThumbnailNotAChip() {
    let pictures = MessageImages.pictures(
      itemID: "r:1", inline: [], attachments: ["@image:/root/.hermes/profiles/marketing/images/upload_20261004_160406_1.png"],
      named: [], hasStore: true)

    #expect(pictures.images.map(\.name) == ["upload_20261004_160406_1.png"])
    #expect(pictures.chips.isEmpty)
  }

  @Test func aFileWithNoExtensionStaysAChipThatOpensWhatItIs() {
    let pictures = MessageImages.pictures(
      itemID: "r:1", inline: [], attachments: ["@file:/root/uploads/9eh14f1h-Image-2026-10-04-at-16.31.52"], named: [], hasStore: true)

    #expect(pictures.images.isEmpty)
    #expect(pictures.chips == ["@file:/root/uploads/9eh14f1h-Image-2026-10-04-at-16.31.52"])
  }

  @Test func aPictureTheMessageHoldsIsAThumbnailFromItsOwnBytes() async throws {
    let held = InlineImage(name: "shot.png", mime: "image/png", data: Self.png.base64EncodedString())
    let pictures = MessageImages.pictures(itemID: "r:7", inline: [held], attachments: ["@file:/x/a.pdf"], named: [], hasStore: true)

    #expect(pictures.images.count == 1)
    #expect(pictures.images.first?.isInline == true)
    #expect(pictures.chips == ["@file:/x/a.pdf"])

    let store = MessageImageStore { _ in nil }
    store.register(pictures.images)
    let reference = try #require(pictures.images.first?.reference)
    let drawn = await store.image(reference, maxPixel: 64)
    #expect(drawn != nil, "decoded from the message's bytes: the gateway is never asked")
    let file = await store.file(reference)
    #expect(file?.pathExtension == "png")
  }

  @Test func withoutAStoreEveryPictureIsAChip() {
    let held = InlineImage(name: "shot.png", mime: "image/png", data: Self.png.base64EncodedString())
    let pictures = MessageImages.pictures(itemID: "r:7", inline: [held], attachments: ["@image:/x/a.png"], named: [], hasStore: false)

    #expect(pictures.images.isEmpty)
    #expect(pictures.chips == ["@image:/x/a.png", "@image:shot.png"])
  }

  @Test func twoChatsThatBothHaveARowCalledTheSameNeverShareAFile() {
    let one = MessageImage.inline(item: "r:12", index: 0, name: "a.png", base64: "AAAA" + "QUJD")
    let other = MessageImage.inline(item: "r:12", index: 0, name: "a.png", base64: "AAAAAAAA" + "REVGR0hJ")
    #expect(one.reference != other.reference)
  }
}
