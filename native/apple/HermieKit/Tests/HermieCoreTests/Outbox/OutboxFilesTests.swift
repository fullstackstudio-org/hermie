import CryptoKit
import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

/// A shared file as the transcript keeps it, for the tests of what reads it.
enum OutboxFixtures {
  static let id = "q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe"
  static let digest = String(repeating: "a", count: 64)

  static func attachment(
    _ kind: OutboxKind = .file, name: String = "report.zip", size: Int = 1000, id: String = Self.id
  ) -> OutboxAttachment {
    OutboxAttachment(
      id: id, name: name, mime: "application/octet-stream", kind: kind, size: size, sha256: digest, createdAt: 1_791_148_287,
      url: "/api/files/outbox/\(id)/\(OutboxAttachment.encodedName(name))")
  }

  /// A 32-character token that is `number`.
  static func token(_ number: Int) -> String {
    String(format: "%032d", number)
  }
}

@Suite struct OutboxRouteTests {
  @Test func theRouteIsTheAttachmentsOwnUrlWithTheChatsProfile() {
    let attachment = OutboxFixtures.attachment(.audio, name: "Q3 report.mp3")

    #expect(
      OutboxRoute.path(for: attachment, profile: "writer")
        == "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/Q3%20report.mp3?profile=writer")
    #expect(OutboxRoute.path(for: attachment, profile: nil) == attachment.url)
    #expect(OutboxRoute.path(for: attachment, profile: "") == attachment.url)
  }

  @Test func theRouteIsBuiltFromTheTokenAndTheNameNeverFromTheUrlAsItArrived() {
    var attachment = OutboxFixtures.attachment(.audio, name: "Q3 report.mp3")
    // What a sender could have slipped past a check: another route, a query, a different spelling.
    attachment.url = "/api/files/download/elsewhere?token=x"

    #expect(OutboxRoute.path(for: attachment, profile: nil) == "/api/files/outbox/\(attachment.id)/Q3%20report.mp3")
    #expect(
      OutboxRoute.path(for: attachment, profile: "w") == "/api/files/outbox/\(attachment.id)/Q3%20report.mp3?profile=w")
  }

  @Test func aProfileIsEncodedAsAQueryValueAndNeverCarriesAnythingElse() {
    let attachment = OutboxFixtures.attachment()

    #expect(OutboxRoute.path(for: attachment, profile: "a&token=x").hasSuffix("?profile=a%26token%3Dx"))
    #expect(OutboxRoute.path(for: attachment, profile: "a b#c").hasSuffix("?profile=a%20b%23c"))
    #expect(!OutboxRoute.path(for: attachment, profile: "w").contains("token"))
  }

  @Test func eachKindHasItsCapAndTheCapIsWhatAFileIsAllowedBy() {
    #expect(OutboxLimits.maxBytes(for: .image) == 25 * 1024 * 1024)
    for kind in [OutboxKind.video, .audio, .pdf, .file] {
      #expect(OutboxLimits.maxBytes(for: kind) == 200 * 1024 * 1024)
    }

    #expect(OutboxLimits.allows(OutboxFixtures.attachment(.image, size: 25 * 1024 * 1024)))
    #expect(!OutboxLimits.allows(OutboxFixtures.attachment(.image, size: 25 * 1024 * 1024 + 1)))
    #expect(OutboxLimits.allows(OutboxFixtures.attachment(.video, size: 200 * 1024 * 1024)))
    #expect(!OutboxLimits.allows(OutboxFixtures.attachment(.pdf, size: 200 * 1024 * 1024 + 1)))
  }
}

@Suite struct OutboxPresentationTests {
  @Test func eachKindIsItsOwnCard() {
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.image, name: "a.png")) == .picture)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.video, name: "a.mp4")) == .video)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.audio, name: "a.mp3")) == .audio)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.pdf, name: "a.pdf")) == .document)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.file, name: "a.zip")) == .file)
  }

  @Test func aFileThatClaimsToBeSomethingButIsOverWhatIsTakenIsAChip() {
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.image, size: OutboxLimits.imageBytes + 1)) == .file)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.video, size: OutboxLimits.imageBytes + 1)) == .video)
    #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.video, size: OutboxLimits.fileBytes + 1)) == .file)
  }

  @Test func anActiveFileIsAChipWhateverItsNameLooksLike() {
    // The gateway calls HTML, SVG and scripts `file`; a name that says `.png` or `.pdf` changes nothing.
    for name in ["page.html", "image.svg", "run.sh", "photo.png", "doc.pdf"] {
      #expect(OutboxPresentation.card(for: OutboxFixtures.attachment(.file, name: name)) == .file, Comment(rawValue: name))
    }
  }

  @Test func theLayoutPutsThePicturesTogetherFirstAndKeepsTheRestInOrder() {
    let list = [
      OutboxFixtures.attachment(.audio, name: "a.mp3", id: OutboxFixtures.token(1)),
      OutboxFixtures.attachment(.image, name: "one.png", id: OutboxFixtures.token(2)),
      OutboxFixtures.attachment(.file, name: "b.zip", id: OutboxFixtures.token(3)),
      OutboxFixtures.attachment(.image, name: "two.png", id: OutboxFixtures.token(4)),
      OutboxFixtures.attachment(.pdf, name: "c.pdf", id: OutboxFixtures.token(5)),
    ]
    let layout = OutboxPresentation.layout(list)

    #expect(layout.pictures.map(\.name) == ["one.png", "two.png"])
    #expect(layout.others.map(\.name) == ["a.mp3", "b.zip", "c.pdf"])
  }

  @Test func onlyAPictureAndASmallPDFAreFetchedBeforeAnyoneAsks() {
    #expect(OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.image, name: "a.png")))
    #expect(OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.pdf, name: "a.pdf", size: OutboxLimits.pdfPrefetchBytes)))
    #expect(!OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.pdf, name: "a.pdf", size: OutboxLimits.pdfPrefetchBytes + 1)))
    #expect(!OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.video, name: "a.mp4", size: 10)))
    #expect(!OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.audio, name: "a.mp3", size: 10)))
    #expect(!OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.file, name: "a.zip", size: 10)))
    // An image over the cap is a chip, and a chip waits to be asked.
    #expect(!OutboxPresentation.fetchesOnAppear(OutboxFixtures.attachment(.image, size: OutboxLimits.imageBytes + 1)))
  }

  @Test func aChipsIconFollowsTheExtensionOfItsNameAndNothingElse() {
    #expect(OutboxPresentation.symbol(forName: "backup.ZIP") == "doc.zipper")
    #expect(OutboxPresentation.symbol(forName: "notes.md") == "doc.text")
    #expect(OutboxPresentation.symbol(forName: "table.csv") == "tablecells")
    #expect(OutboxPresentation.symbol(forName: "page.html") == "chevron.left.forwardslash.chevron.right")
    #expect(OutboxPresentation.symbol(forName: "run.exe") == "gearshape")
    #expect(OutboxPresentation.symbol(forName: "README") == "doc")
    #expect(OutboxPresentation.symbol(forName: "trailing.") == "doc")
    #expect(OutboxPresentation.symbol(forName: "unknown.xyzzy") == "doc")
  }

  @Test func aTimeReadsLikeAScrubber() {
    #expect(OutboxPresentation.clock(0) == "0:00")
    #expect(OutboxPresentation.clock(7.9) == "0:07")
    #expect(OutboxPresentation.clock(723) == "12:03")
    #expect(OutboxPresentation.clock(3723) == "1:02:03")
    #expect(OutboxPresentation.clock(-4) == "0:00")
    #expect(OutboxPresentation.clock(.nan) == "0:00")
    #expect(OutboxPresentation.clock(.infinity) == "0:00")
  }
}

/// A count the downloads bump from wherever they run.
private final class Counter: Sendable {
  private let storage = Mutex(0)
  var value: Int { storage.withLock { $0 } }

  @discardableResult func bump() -> Int { storage.withLock { $0 += 1; return $0 } }
}

/// Holds a download until the test lets it go.
private final class Gate: Sendable {
  private let continuation = Mutex<CheckedContinuation<Void, Never>?>(nil)
  private let opened = Mutex(false)

  func wait() async {
    await withCheckedContinuation { next in
      let go = opened.withLock { $0 }
      if go {
        next.resume()
      } else {
        continuation.withLock { $0 = next }
      }
    }
  }

  func open() {
    opened.withLock { $0 = true }
    continuation.withLock { held in
      held?.resume()
      held = nil
    }
  }
}

@MainActor @Suite(.serialized) struct OutboxFileModelTests {
  /// An `OutboxFiles` whose downloads are what `body` says, counted.
  private func files(
    _ body: @escaping @Sendable (OutboxAttachment, @Sendable (Double) -> Void) async throws -> URL
  ) -> (OutboxFiles, Counter) {
    let count = Counter()
    let files = OutboxFiles(
      download: { attachment, progress in
        count.bump()
        return try await body(attachment, progress)
      },
      mediaSource: { _, _, _, _ in throw FileDownloadError.unreachable })
    return (files, count)
  }

  private func temporaryFile(_ name: String = "x.bin") throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-model-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(name)
    try Data("x".utf8).write(to: url)
    return url
  }

  @Test func aFileIsFetchedOnceAndThenIsReady() async throws {
    let url = try temporaryFile()
    let (files, count) = files { _, _ in url }
    let model = files.model(for: OutboxFixtures.attachment())

    #expect(model.state == .idle)
    #expect(await model.ensure() == .ready(url))
    #expect(model.fileURL == url)

    // Asked again, it is where it was.
    #expect(await model.ensure() == .ready(url))
    #expect(count.value == 1)
  }

  @Test func theModelOfAFileIsTheOneAlreadyMadeForItsToken() {
    let (files, _) = files { _, _ in URL(fileURLWithPath: "/dev/null") }
    let attachment = OutboxFixtures.attachment()

    #expect(files.model(for: attachment) === files.model(for: attachment))
    #expect(files.model(for: attachment) !== files.model(for: OutboxFixtures.attachment(id: OutboxFixtures.token(2))))
  }

  @Test func twoCardsAskingForOneFileMakeOneRequest() async throws {
    let gate = Gate()
    let url = try temporaryFile()
    let (files, count) = files { _, _ in
      await gate.wait()
      return url
    }
    let model = files.model(for: OutboxFixtures.attachment())

    model.load()
    model.load()
    let waiting = Task { await model.ensure() }
    gate.open()

    #expect(await waiting.value == .ready(url))
    #expect(count.value == 1)
  }

  @Test func progressIsReportedWhileItIsOnItsWayAndTheStateIsLoadingUntilThen() async throws {
    let gate = Gate()
    let url = try temporaryFile()
    let (files, _) = files { _, progress in
      progress(0.25)
      await gate.wait()
      return url
    }
    let model = files.model(for: OutboxFixtures.attachment())

    model.load()
    #expect(model.state == .loading(progress: nil))
    // The progress arrives through the main actor, after the download reports it.
    for _ in 0..<500 where model.state == .loading(progress: nil) {
      try await Task.sleep(for: .milliseconds(2))
    }
    #expect(model.state == .loading(progress: 0.25))
    #expect(!model.state.canRetry)

    gate.open()
    #expect(await model.ensure() == .ready(url))
  }

  @Test func aFileTheGatewayNoLongerHasIsGoneForGoodAndOnlyAskedAgainWhenTheReaderRetries() async throws {
    let (files, count) = files { _, _ in throw FileDownloadError.notFound }
    let model = files.model(for: OutboxFixtures.attachment())

    #expect(await model.ensure() == .gone)
    #expect(!model.state.canRetry)

    // Appearing again does not ask again; a deliberate retry does.
    model.load()
    #expect(model.state == .gone)
    #expect(count.value == 1)
    #expect(await model.ensure() == .gone)
    #expect(count.value == 1)

    model.retry()
    await model.ensure()
    #expect(count.value == 2)
  }

  @Test(arguments: [
    FileDownloadError.refused(status: 500), .unreachable, .corrupt, .unauthorized,
  ])
  func anyOtherFailureCanBeTriedAgainAndThenWorks(_ failure: FileDownloadError) async throws {
    let url = try temporaryFile()
    let attempts = Counter()
    let (files, _) = files { _, _ in
      if attempts.bump() == 1 { throw failure }
      return url
    }
    let model = files.model(for: OutboxFixtures.attachment())

    #expect(await model.ensure() == .failed)
    #expect(model.state.canRetry)

    model.retry()
    #expect(await model.ensure() == .ready(url))
  }

  @Test func aFailureThatIsNotOneOfOursIsAFailureToo() async {
    struct Odd: Error {}
    let (files, _) = files { _, _ in throw Odd() }
    #expect(await files.model(for: OutboxFixtures.attachment()).ensure() == .failed)
  }

  @Test func aFileOverItsCapIsNotAskedForAtAll() async {
    let (files, count) = files { _, _ in URL(fileURLWithPath: "/dev/null") }
    let image = files.model(for: OutboxFixtures.attachment(.image, name: "big.png", size: OutboxLimits.imageBytes + 1))
    let video = files.model(
      for: OutboxFixtures.attachment(.video, name: "big.mp4", size: OutboxLimits.fileBytes + 1, id: OutboxFixtures.token(3)))

    #expect(await image.ensure() == .tooLarge)
    #expect(await video.ensure() == .tooLarge)
    #expect(!image.state.canRetry)
    #expect(count.value == 0)
  }

  @Test func theCapTheDownloadReportsIsFinalToo() async {
    let (files, _) = files { _, _ in throw FileDownloadError.tooLarge }
    #expect(await files.model(for: OutboxFixtures.attachment()).ensure() == .tooLarge)
  }

  @Test func cancellingALoadPutsTheModelBackAtIdleAndALaterLoadStartsAgain() async throws {
    let gate = Gate()
    let url = try temporaryFile()
    let attempts = Counter()
    let (files, _) = files { _, _ in
      if attempts.bump() == 1 {
        await gate.wait()
        throw CancellationError()
      }
      return url
    }
    let model = files.model(for: OutboxFixtures.attachment())

    model.load()
    #expect(model.state == .loading(progress: nil))
    model.cancel()
    #expect(model.state == .idle)
    gate.open()

    #expect(await model.ensure() == .ready(url))
  }

  @Test func cancellingEveryLoadStopsThemAll() async {
    let gate = Gate()
    let (files, _) = files { _, _ in
      await gate.wait()
      throw CancellationError()
    }
    let first = files.model(for: OutboxFixtures.attachment())
    let second = files.model(for: OutboxFixtures.attachment(id: OutboxFixtures.token(2)))
    first.load()
    second.load()

    files.cancelAll()

    #expect(first.state == .idle)
    #expect(second.state == .idle)
    gate.open()
  }

  @Test func aFileTheSystemClearedIsFetchedAgain() async throws {
    let first = try temporaryFile()
    let second = try temporaryFile()
    let attempts = Counter()
    let (files, count) = files { _, _ in
      attempts.bump() == 1 ? first : second
    }
    let model = files.model(for: OutboxFixtures.attachment())

    #expect(await model.ensure() == .ready(first))
    try FileManager.default.removeItem(at: first)

    #expect(await model.ensure() == .ready(second))
    #expect(count.value == 2)
  }

  @Test func aPlayerIsHandedALoaderOfItsOwnSchemeUnlessTheFileIsOverTheCap() throws {
    let files = OutboxFiles(
      download: { _, _ in URL(fileURLWithPath: "/dev/null") }, mediaSource: { _, _, _, _ in throw FileDownloadError.unreachable })
    let attachment = OutboxFixtures.attachment(.audio, name: "a b.mp3")

    let loader = try files.mediaLoader(for: attachment)
    #expect(loader.url.scheme == OutboxMediaLoader.scheme, "no address a network stack can dial")
    #expect(loader.url.absoluteString == "hermie-outbox://file/\(attachment.id)/media.mp3", "the type's extension, never the name")
    #expect(loader.maxBytes == OutboxLimits.fileBytes)
    do {
      _ = try files.mediaLoader(for: OutboxFixtures.attachment(.video, name: "a.mp4", size: OutboxLimits.fileBytes + 1))
      Issue.record("a file over the cap was handed to a player")
    } catch {
      #expect((error as? FileDownloadError) == .tooLarge)
    }
  }
}

@MainActor @Suite(.serialized) struct OutboxSessionTests {
  private func session(_ link: ScriptedLink) -> GatewaySession {
    GatewaySession(gatewayID: "g-outbox", link: link)
  }

  @Test func aSessionFetchesByTheRouteWithTheChatsProfileIntoItsOwnFolderUnderTheNameACopyWouldHave() async throws {
    let link = ScriptedLink()
    let bytes = Data("zip".utf8)
    link.onDownload { _, _ in bytes }
    let attachment = OutboxFixtures.attachment(.file, name: "Q3 \u{202E}report.zip", size: 3)
    let files = session(link).outboxFiles(profile: "writer")

    guard case .ready(let url) = await files.model(for: attachment).ensure() else {
      Issue.record("the file did not arrive")
      return
    }
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

    let call = try #require(link.downloads.first)
    #expect(call.path == "/api/files/outbox/\(OutboxFixtures.id)/Q3%20%E2%80%AEreport.zip?profile=writer")
    #expect(call.maxBytes == OutboxLimits.fileBytes)
    #expect(call.expectedSize == 3)
    #expect(call.expectedSHA256 == OutboxFixtures.digest)
    #expect(url.lastPathComponent == "Q3 report.zip", "the saved name is the shown one, without the override")
    #expect(url.path.hasPrefix(AttachmentOpening.directory(gateway: "g-outbox").path))
    #expect(try Data(contentsOf: url) == bytes)
  }

  @Test func aPictureIsCappedAtTwentyFiveMegabytesAndTheRestAtTwoHundred() async throws {
    let link = ScriptedLink()
    link.onDownload { _, _ in Data() }
    let files = session(link).outboxFiles(profile: nil)

    for attachment in [
      OutboxFixtures.attachment(.image, name: "a.png", id: OutboxFixtures.token(1)),
      OutboxFixtures.attachment(.pdf, name: "a.pdf", id: OutboxFixtures.token(2)),
    ] {
      if case .ready(let url) = await files.model(for: attachment).ensure() {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
      }
    }

    #expect(link.downloads.map(\.maxBytes) == [OutboxLimits.imageBytes, OutboxLimits.fileBytes])
  }

  @Test func aFailedFetchLeavesNoFolderBehind() async throws {
    let link = ScriptedLink()
    link.onDownload { download, _ in
      try FileManager.default.createDirectory(
        at: download.destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      throw FileDownloadError.notFound
    }
    let files = session(link).outboxFiles(profile: "writer")
    let model = files.model(for: OutboxFixtures.attachment())

    #expect(await model.ensure() == .gone)
    let folder = try #require(link.downloads.first?.destination.deletingLastPathComponent())
    #expect(!FileManager.default.fileExists(atPath: folder.path))
  }

  @Test func aPlayerReadsItsRangesByTheRouteThroughTheSessionsLink() async throws {
    let link = ScriptedLink()
    link.onRange { _, range in
      (ByteRangeHead(contentType: "audio/mpeg", totalLength: 1000, rangesSupported: true), Data(count: range.length ?? 1))
    }
    let files = session(link).outboxFiles(profile: "writer")
    let loader = try files.mediaLoader(for: OutboxFixtures.attachment(.audio, name: "a.mp3"))
    let asset = loader.makeAsset()

    // Whatever the player makes of four zero bytes, it asked the session's link, by the route, with the cap.
    _ = try? await asset.load(.duration)

    let call = try #require(link.rangeCalls.first)
    #expect(call.path == "/api/files/outbox/\(OutboxFixtures.id)/a.mp3?profile=writer")
    #expect(call.maxBytes == OutboxLimits.fileBytes)
    loader.close()
  }

  // MARK: Kept for the next time

  /// An attachment whose size and SHA-256 are those of `bytes`.
  private func attachment(of bytes: Data, name: String = "notes.txt", id: String = OutboxFixtures.id) -> OutboxAttachment {
    var attachment = OutboxFixtures.attachment(.file, name: name, size: bytes.count, id: id)
    attachment.sha256 = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    return attachment
  }

  @Test func aFileIsKeptPerTokenAndUsedAgainWhileItIsStillWhatTheAttachmentSays() async throws {
    let gateway = "g-outbox-keep-\(UUID().uuidString)"
    defer { AttachmentOpening.discardOpened(gateway: gateway) }
    let link = ScriptedLink()
    let bytes = Data("the notes".utf8)
    link.onDownload { _, _ in bytes }
    let attachment = attachment(of: bytes)

    let first = try await OutboxDownloads.download(attachment, profile: "writer", link: link, gatewayID: gateway) { _ in }
    #expect(first == OutboxDownloads.location(of: attachment, profile: "writer", gateway: gateway))
    #expect(first.deletingLastPathComponent().lastPathComponent == attachment.id)
    #expect(first.path.hasPrefix(OutboxDownloads.directory(gateway: gateway).path))
    #expect(OutboxDownloads.isIntact(first, as: attachment))

    // Opened again (another chat open): no request, the same file.
    let again = try await OutboxDownloads.download(attachment, profile: "writer", link: link, gatewayID: gateway) { _ in }
    #expect(again == first)
    #expect(link.downloads.count == 1)
    #expect(try Data(contentsOf: again) == bytes)
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: first.deletingLastPathComponent().path)
    #expect(leftovers == ["notes.txt"], "no partial file is left beside it")

    // A copy that is no longer the attachment's (changed on disk) is fetched again.
    try Data("tampered".utf8).write(to: first)
    let fetched = try await OutboxDownloads.download(attachment, profile: "writer", link: link, gatewayID: gateway) { _ in }
    #expect(link.downloads.count == 2)
    #expect(try Data(contentsOf: fetched) == bytes)

    // Another profile's chat asks the gateway itself: it answers only the profile the file was shared with.
    _ = try await OutboxDownloads.download(attachment, profile: "reader", link: link, gatewayID: gateway) { _ in }
    #expect(link.downloads.count == 3)
    #expect(OutboxDownloads.profileFolder("writer") != OutboxDownloads.profileFolder("reader"))
    #expect(OutboxDownloads.profileFolder("../x").hasPrefix("p-"), "a handle is never a path")
  }

  @Test func whatIsKeptGoesWhenItIsOldAndTheOldestGoWhenThereIsTooMuch() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-purge-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let now = Date(timeIntervalSince1970: 2_000_000_000)

    func keep(_ token: String, profile: String = "p-a", bytes: Int, daysAgo: Double) throws -> URL {
      let folder = root.appendingPathComponent(profile).appendingPathComponent(token)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let file = folder.appendingPathComponent("f.bin")
      try Data(count: bytes).write(to: file)
      try FileManager.default.setAttributes(
        [.modificationDate: now.addingTimeInterval(-daysAgo * 86_400)], ofItemAtPath: file.path)
      return folder
    }

    let fresh = try keep("fresh", bytes: 100, daysAgo: 1)
    let stale = try keep("stale", bytes: 10, daysAgo: 8)
    let middle = try keep("middle", bytes: 100, daysAgo: 2)
    let oldest = try keep("oldest", profile: "p-b", bytes: 100, daysAgo: 3)

    OutboxDownloads.purge(in: root, olderThan: 7 * 86_400, keepingAtMost: 250, now: now)

    let exists = { (url: URL) in FileManager.default.fileExists(atPath: url.path) }
    #expect(exists(fresh) && exists(middle))
    #expect(!exists(stale), "not used for a week")
    #expect(!exists(oldest), "the least recently used goes once the rest fill the limit")
    #expect(!exists(root.appendingPathComponent("p-b")), "a profile folder left empty goes too")
  }
}
