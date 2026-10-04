import AVFoundation
import Foundation
import HermieCore
import HermieGateway
import HermieTranscript
import Observation
import SwiftUI
import Testing

@testable import HermieUI

/// Shared files in the chat: who may play, how a player reads its failures, the state a card shows per kind, and
/// the pictures a bot shared through the gallery's store. Players run on a one-second silent WAV in a temporary
/// file; nothing is drawn on screen.
@MainActor
enum OutboxUIFixtures {
  static let digest = String(repeating: "a", count: 64)

  static func attachment(
    _ kind: OutboxKind, name: String, size: Int = 1000, token: String = "q"
  ) -> OutboxAttachment {
    let id = String(repeating: token, count: 32)
    return OutboxAttachment(
      id: id, name: name, mime: "application/octet-stream", kind: kind, size: size, sha256: digest, createdAt: 1_791_148_287,
      url: "/api/files/outbox/\(id)/\(OutboxAttachment.encodedName(name))")
  }

  /// A silent mono 8-bit WAV of `seconds` seconds at 8 kHz.
  static func wav(seconds: Int = 1) throws -> URL {
    let rate = 8000
    let samples = rate * seconds
    var data = Data()
    func le32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { data.append(contentsOf: $0) } }
    func le16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { data.append(contentsOf: $0) } }
    data.append(contentsOf: Array("RIFF".utf8))
    le32(36 + samples)
    data.append(contentsOf: Array("WAVEfmt ".utf8))
    le32(16)
    le16(1)
    le16(1)
    le32(rate)
    le32(rate)
    le16(1)
    le16(8)
    data.append(contentsOf: Array("data".utf8))
    le32(samples)
    data.append(Data(repeating: 128, count: samples))

    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-ui-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("tone.wav")
    try data.write(to: url)
    return url
  }

  /// An `OutboxFiles` that hands a player `request` and downloads `file`.
  static func files(
    request: @escaping @Sendable (OutboxAttachment) throws -> MediaRequest = { _ in throw FileDownloadError.unreachable },
    file: URL = URL(fileURLWithPath: "/dev/null")
  ) -> OutboxFiles {
    OutboxFiles(download: { _, _ in file }, mediaSource: request)
  }
}

@MainActor
@Suite struct PlaybackArbiterTests {
  @Test func startingOneStopsTheOneThatPlayed() {
    let arbiter = PlaybackArbiter()
    var paused: [String] = []

    #expect(arbiter.claim("a") { paused.append("a") })
    #expect(arbiter.activeID == "a")
    #expect(arbiter.claim("b") { paused.append("b") })
    #expect(paused == ["a"])
    #expect(arbiter.activeID == "b")
    #expect(arbiter.claim("a") { paused.append("a") })
    #expect(paused == ["a", "b"])
  }

  @Test func claimingAgainByTheOneThatPlaysStopsNobody() {
    let arbiter = PlaybackArbiter()
    var paused = 0
    #expect(arbiter.claim("a") { paused += 1 })
    #expect(arbiter.claim("a") { paused += 1 })
    #expect(paused == 0)
  }

  @Test func nothingStartsWhileBlockedAndTheOneThatPlaysIsLeftAlone() {
    var blocked = false
    let arbiter = PlaybackArbiter { blocked }
    var paused = 0
    #expect(arbiter.claim("a") { paused += 1 })

    blocked = true
    #expect(!arbiter.claim("b") {})
    #expect(arbiter.activeID == "a")
    #expect(paused == 0)

    blocked = false
    #expect(arbiter.claim("b") {})
    #expect(paused == 1)
  }

  @Test func stoppingAllPausesWhoeverPlaysAndGivesTheAudioBack() {
    let arbiter = PlaybackArbiter()
    var events: [String] = []
    arbiter.onBusy = { events.append("busy") }
    arbiter.onIdle = { events.append("idle") }
    _ = arbiter.claim("a") { events.append("pause a") }

    arbiter.stopAll()
    #expect(arbiter.activeID == nil)
    #expect(events == ["busy", "pause a", "idle"])

    arbiter.stopAll()
    #expect(events == ["busy", "pause a", "idle"], "nothing playing, nothing to do")
  }

  @Test func theAudioIsTakenOnceAndGivenBackWhenTheLastOneStops() {
    let arbiter = PlaybackArbiter()
    var events: [String] = []
    arbiter.onBusy = { events.append("busy") }
    arbiter.onIdle = { events.append("idle") }

    _ = arbiter.claim("a") {}
    _ = arbiter.claim("b") {}
    #expect(events == ["busy"], "one after another is not a new take")
    arbiter.release("a")
    #expect(events == ["busy"], "a that was stopped by b has nothing to give back")
    arbiter.release("b")
    #expect(events == ["busy", "idle"])
  }
}

@MainActor
@Suite struct MediaPlaybackErrorTests {
  @Test func aNotFoundIsRecognisedWhereverTheFrameworkPutsIt() {
    let http404 = NSError(domain: "CoreMediaErrorDomain", code: -12938)
    let wrapped = NSError(
      domain: AVFoundationErrorDomain, code: AVError.unknown.rawValue, userInfo: [NSUnderlyingErrorKey: http404])
    let twice = NSError(domain: "x", code: 1, userInfo: [NSUnderlyingErrorKey: wrapped])

    #expect(MediaPlayback.isNotFound(http404))
    #expect(MediaPlayback.isNotFound(wrapped))
    #expect(MediaPlayback.isNotFound(twice))
    #expect(MediaPlayback.isNotFound(URLError(.fileDoesNotExist)))
    #expect(!MediaPlayback.isNotFound(URLError(.notConnectedToInternet)))
    #expect(!MediaPlayback.isNotFound(NSError(domain: "CoreMediaErrorDomain", code: -12939)))
  }

  @Test func eachFailureIsGoneTooLargeOrWorthAnotherTry() {
    #expect(MediaPlayback.phase(after: URLError(.fileDoesNotExist)) == .gone)
    #expect(MediaPlayback.phase(after: FileDownloadError.tooLarge) == .tooLarge)
    #expect(MediaPlayback.phase(after: FileDownloadError.unreachable) == .failed)
    #expect(MediaPlayback.phase(after: URLError(.timedOut)) == .failed)
    #expect(MediaPlayback.phase(after: GatewayError(.network, "no")) == .failed)
  }
}

@MainActor
@Suite(.serialized) struct MediaPlaybackTests {
  private func request(_ url: URL) -> @Sendable (OutboxAttachment) throws -> MediaRequest {
    { _ in MediaRequest(url: url, headers: ["authorization": "Bearer never-sent-to-a-file"]) }
  }

  @Test func aPlayerReadsTheLengthAndIsReady() async throws {
    let url = try OutboxUIFixtures.wav(seconds: 1)
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let playback = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))

    #expect(playback.phase == .idle)
    await playback.prepare()

    #expect(playback.phase == .ready)
    #expect(try #require(playback.duration) > 0.9 && playback.duration! < 1.1)
    #expect(playback.player != nil)
    #expect(!playback.isPlaying)
  }

  @Test func theCenterKeepsOnePlayerPerTokenAndOnePreparationAtATime() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let attachment = OutboxUIFixtures.attachment(.audio, name: "tone.wav")

    #expect(center.playback(for: attachment) === center.playback(for: attachment))
    let playback = center.playback(for: attachment)
    async let first: Void = playback.prepare()
    async let second: Void = playback.prepare()
    _ = await (first, second)
    #expect(playback.phase == .ready)
  }

  @Test func playingAndPausingFollowTheArbiterAndNothingStartsWhileBlocked() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    var call = true
    let center = MediaPlaybackCenter(
      files: OutboxUIFixtures.files(request: request(url)), arbiter: PlaybackArbiter { call })
    let playback = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))

    // A voice call has the audio: the sound does not start.
    await playback.play()
    #expect(!playback.isPlaying)
    #expect(center.arbiter.activeID == nil)

    call = false
    await playback.play()
    #expect(playback.isPlaying)
    #expect(center.arbiter.activeID == playback.id)

    playback.pause()
    #expect(!playback.isPlaying)
    #expect(center.arbiter.activeID == nil)
  }

  @Test func startingASecondSoundPausesTheFirst() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let first = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "one.wav", token: "a"))
    let second = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "two.wav", token: "b"))

    await first.play()
    #expect(first.isPlaying)
    await second.play()

    #expect(second.isPlaying)
    #expect(!first.isPlaying, "only one plays at a time")
    #expect(center.arbiter.activeID == second.id)
    center.stopAll()
  }

  @Test func closingTheChatStopsEverythingAndLetsThePlayersGo() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let audio = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav", token: "a"))
    let video = center.playback(for: OutboxUIFixtures.attachment(.video, name: "clip.wav", token: "b"))
    await audio.prepare()
    await video.play()
    center.present(video: video)
    #expect(center.video === video)

    center.stopAll()

    #expect(!video.isPlaying)
    #expect(center.video == nil)
    #expect(audio.player == nil && video.player == nil)
    #expect(audio.phase == .idle && video.phase == .idle)
    #expect(center.arbiter.activeID == nil)

    // It plays again from a new player.
    await audio.play()
    #expect(audio.isPlaying)
    center.stopAll()
  }

  @Test func dismissingTheFullScreenVideoPausesIt() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let video = center.playback(for: OutboxUIFixtures.attachment(.video, name: "clip.wav"))
    center.present(video: video)
    await video.play()
    #expect(video.isPlaying)

    center.dismissVideo()

    #expect(!video.isPlaying)
    #expect(center.video == nil)
  }

  @Test func aSeekIsHeldInsideTheFile() async throws {
    let url = try OutboxUIFixtures.wav(seconds: 2)
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(url)))
    let playback = center.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))
    await playback.prepare()

    playback.seek(to: 1)
    #expect(playback.position == 1)
    playback.seek(to: 99)
    #expect(try #require(playback.duration) >= playback.position && playback.position <= 2.1)
    playback.seek(to: -3)
    #expect(playback.position == 0)
    playback.seek(to: .nan)
    #expect(playback.position == 0)
  }

  @Test func aFileThatIsNotThereIsGoneAndOneThatCannotBePlayedFails() async throws {
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-missing-\(UUID().uuidString).wav")
    let gone = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(missing)))
      .playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))
    await gone.prepare()
    #expect(gone.phase == .gone || gone.phase == .failed)
    #expect(gone.player == nil)

    let garbage = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-garbage-\(UUID().uuidString).wav")
    try Data("not audio at all".utf8).write(to: garbage)
    defer { try? FileManager.default.removeItem(at: garbage) }
    let broken = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: request(garbage)))
      .playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))
    await broken.prepare()
    #expect(broken.phase == .failed)

    await broken.play()
    #expect(!broken.isPlaying)
  }

  @Test func aFileOverTheCapIsNeverHandedToAPlayer() async {
    let center = MediaPlaybackCenter(files: OutboxUIFixtures.files(request: { _ in Issue.record("asked"); throw FileDownloadError.unreachable }))
    let playback = center.playback(
      for: OutboxUIFixtures.attachment(.video, name: "huge.mp4", size: OutboxLimits.fileBytes + 1))
    await playback.prepare()
    #expect(playback.phase == .tooLarge)
  }

  @Test func aFailedPlayerCanBeTriedAgain() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let attempts = Attempts()
    let files = OutboxUIFixtures.files(request: { _ in
      if attempts.next() == 1 { throw FileDownloadError.unreachable }
      return MediaRequest(url: url, headers: [:])
    })
    let playback = MediaPlaybackCenter(files: files).playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))

    await playback.prepare()
    #expect(playback.phase == .failed)
    playback.retry()
    for _ in 0..<500 where playback.phase != .ready { try await Task.sleep(for: .milliseconds(10)) }
    #expect(playback.phase == .ready)
  }
}

private final class Attempts: @unchecked Sendable {
  private var count = 0
  private let lock = NSLock()
  @discardableResult func next() -> Int {
    lock.lock()
    defer { lock.unlock() }
    count += 1
    return count
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}

// MARK: - What a card says

@MainActor
@Suite struct OutboxStatusTests {
  @Test func eachFileStateHasItsLine() {
    let size = 48_213
    let sized = OutboxPresentation.sizeText(size)

    #expect(OutboxStatus.line(.idle, size: size) == sized)
    #expect(OutboxStatus.line(.ready(URL(fileURLWithPath: "/tmp/x")), size: size) == sized)
    #expect(OutboxStatus.line(.loading(progress: nil), size: size) == NativeStrings.Outbox.downloading)
    #expect(OutboxStatus.line(.loading(progress: 0.4), size: size) == NativeStrings.Outbox.downloading(percent: 40))
    #expect(OutboxStatus.line(.gone, size: size) == NativeStrings.Outbox.gone)
    #expect(OutboxStatus.line(.failed, size: size) == NativeStrings.Outbox.failed)
    #expect(OutboxStatus.line(.tooLarge, size: size).hasPrefix(NativeStrings.Outbox.tooLarge))
    #expect(OutboxStatus.line(.ready(URL(fileURLWithPath: "/tmp/x")), size: size, saveFailed: true) == NativeStrings.Outbox.saveFailed)
  }

  @Test func eachPlayerPhaseHasItsLine() {
    #expect(OutboxStatus.line(MediaPlayback.Phase.gone, size: 10) == NativeStrings.Outbox.gone)
    #expect(OutboxStatus.line(MediaPlayback.Phase.failed, size: 10) == NativeStrings.Outbox.failed)
    #expect(OutboxStatus.line(MediaPlayback.Phase.ready, size: 1000) == OutboxPresentation.sizeText(1000))
  }

  @Test func theNoLongerAvailableLineIsTheWordsTheGatewayHasNoFile() {
    // The three languages have their own words, and "gone" is not the same words as "failed".
    #expect(NativeStrings.Outbox.gone != NativeStrings.Outbox.failed)
    #expect(!NativeStrings.Outbox.retry.isEmpty && !NativeStrings.Outbox.save.isEmpty && !NativeStrings.Outbox.play.isEmpty)
  }
}

// MARK: - The pictures a bot shared, through the gallery's store

@MainActor
@Suite(.serialized) struct OutboxPictureStoreTests {
  /// A store over files whose download writes `body` (a real PNG) or throws `failure`.
  private func store(
    attempts: Attempts, png: URL?, failure: FileDownloadError?
  ) -> (MessageImageStore, OutboxFiles) {
    let files = OutboxFiles(
      download: { _, _ in
        _ = attempts.next()
        if let failure { throw failure }
        return png!
      },
      mediaSource: { _ in throw FileDownloadError.unreachable })
    return (MessageImageStore { _ in nil }, files)
  }

  @Test func aSharedPictureIsAReferenceOfItsOwnNamedAsTheCardShowsIt() {
    let attachment = OutboxUIFixtures.attachment(.image, name: "photo\u{202E}.png")
    let picture = MessageImageStore.image(for: attachment)

    #expect(picture.reference == "outbox:\(attachment.id)")
    #expect(picture.name == "photo.png")
    #expect(MessageImageStore.isOutbox(picture.reference))
    #expect(!MessageImageStore.isOutbox("/api/files/a.png"))
    #expect(!MessageImageStore.isOutbox("@image:outbox:x"))
  }

  @Test func aSharedPictureIsFetchedThroughItsModelAndDecoded() async throws {
    let png = try MessageImageStoreTests.makeImage(width: 300, height: 100)
    defer { try? FileManager.default.removeItem(at: png) }
    let attempts = Attempts()
    let (store, files) = store(attempts: attempts, png: png, failure: nil)
    let attachment = OutboxUIFixtures.attachment(.image, name: "photo.png")
    store.register(outbox: [attachment], files: files)
    let reference = MessageImageStore.reference(for: attachment)

    let data = try #require(await store.image(reference, maxPixel: 100))
    #expect(max(data.image.width, data.image.height) == 100)
    #expect(await store.file(reference) == png)
    #expect(attempts.value == 1, "one fetch, whoever asks")
    #expect(!store.isGone(reference))
  }

  @Test func aPictureTheGatewayNoLongerHasIsGoneAndIsNotAskedForAgain() async {
    let attempts = Attempts()
    let (store, files) = store(attempts: attempts, png: nil, failure: .notFound)
    let attachment = OutboxUIFixtures.attachment(.image, name: "photo.png")
    store.register(outbox: [attachment], files: files)
    let reference = MessageImageStore.reference(for: attachment)

    #expect(await store.image(reference, maxPixel: 100) == nil)
    #expect(store.isGone(reference))

    store.retry(reference)
    #expect(await store.image(reference, maxPixel: 100) == nil)
    #expect(attempts.value == 1, "a retry does not ask the gateway for what it said is gone")
  }

  @Test func anyOtherFailureIsNotGoneAndARetryAsksAgain() async throws {
    let png = try MessageImageStoreTests.makeImage(width: 40, height: 40)
    defer { try? FileManager.default.removeItem(at: png) }
    let attempts = Attempts()
    let files = OutboxFiles(
      download: { _, _ in
        if attempts.next() == 1 { throw FileDownloadError.unreachable }
        return png
      },
      mediaSource: { _ in throw FileDownloadError.unreachable })
    let store = MessageImageStore { _ in nil }
    let attachment = OutboxUIFixtures.attachment(.image, name: "photo.png")
    store.register(outbox: [attachment], files: files)
    let reference = MessageImageStore.reference(for: attachment)

    #expect(await store.image(reference, maxPixel: 64) == nil)
    #expect(!store.isGone(reference), "a failure is a retry, not a loss")

    store.retry(reference)
    #expect(await store.image(reference, maxPixel: 64) != nil)
  }

  @Test func aPictureNobodyRegisteredIsNotFetched() async {
    let store = MessageImageStore { _ in nil }
    #expect(await store.image("outbox:\(String(repeating: "z", count: 32))", maxPixel: 64) == nil)
  }
}

// MARK: - The chat's media

@MainActor
@Suite struct OutboxMediaTests {
  @Test func closingTheChatStopsPlayersLoadsAndWhatIsUp() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let media = OutboxMedia(
      files: OutboxUIFixtures.files(request: { _ in MediaRequest(url: url, headers: [:]) }))
    let audio = media.playback.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))
    let pdf = media.files.model(for: OutboxUIFixtures.attachment(.pdf, name: "a.pdf", token: "p"))
    await audio.play()
    media.present(pdf: pdf)
    media.shared = OutboxMedia.SharedFile(url: url)

    media.stop()

    #expect(!audio.isPlaying)
    #expect(media.pdf == nil)
    #expect(media.shared == nil)
    #expect(media.playback.arbiter.activeID == nil)
  }

  @Test func aVoiceCallBlocksPlaybackUntilItIsOver() async throws {
    let url = try OutboxUIFixtures.wav()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let media = OutboxMedia(
      files: OutboxUIFixtures.files(request: { _ in MediaRequest(url: url, headers: [:]) }))
    var call = true
    media.blockPlayback { call }
    let audio = media.playback.playback(for: OutboxUIFixtures.attachment(.audio, name: "tone.wav"))

    await audio.play()
    #expect(!audio.isPlaying)

    call = false
    await audio.play()
    #expect(audio.isPlaying)
    media.stop()
  }

  #if os(macOS)
    @Test func aSavedNameIsWhatTheCardShowsWithoutWhatAFileSystemRefuses() {
      // The save panel opens with `OutboxText.savedName` (the panel itself is never opened by a test).
      #expect(OutboxText.savedName("a\u{202E}b:c.zip") == "ab_c.zip")
    }
  #endif
}

// MARK: - Drawn, without a window

@MainActor
@Suite struct SharedFilesRenderingTests {
  private func render<Content: View>(_ content: Content, size: DynamicTypeSize = .large) throws -> CGImage {
    let renderer = ImageRenderer(content: content.frame(width: 390).dynamicTypeSize(size))
    renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
    return try #require(renderer.cgImage)
  }

  @Test(arguments: [DynamicTypeSize.large, .accessibility5])
  func everyKindDrawsAsAChipWhereThereIsNoChat(size: DynamicTypeSize) throws {
    let image = try render(SharedFilesView(attachments: GallerySample.sharedFiles, media: nil, images: nil), size: size)
    #expect(image.height > 0)
  }

  @Test(arguments: [DynamicTypeSize.large, .accessibility5])
  func everyKindDrawsAsItsCardInAChat(size: DynamicTypeSize) throws {
    let media = OutboxMedia(files: OutboxUIFixtures.files())
    let store = MessageImageStore { _ in nil }
    let image = try render(
      SharedFilesView(attachments: GallerySample.sharedFiles, media: media, images: store), size: size)
    #expect(image.height > 0)
  }

  @Test func theStatesOfAFileChipDrawEachOne() async throws {
    let attachment = OutboxUIFixtures.attachment(.file, name: "backup.zip")
    let gone = OutboxFiles(download: { _, _ in throw FileDownloadError.notFound }, mediaSource: { _ in throw FileDownloadError.unreachable })
    let failing = OutboxFiles(download: { _, _ in throw FileDownloadError.unreachable }, mediaSource: { _ in throw FileDownloadError.unreachable })
    let large = OutboxUIFixtures.attachment(.file, name: "huge.bin", size: OutboxLimits.fileBytes + 1)

    for (files, attachment) in [(gone, attachment), (failing, attachment), (failing, large)] {
      _ = await files.model(for: attachment).ensure()
      let media = OutboxMedia(files: files)
      #expect(try render(OutboxFileChip(attachment: attachment, media: media)).height > 0)
    }
  }

  @Test func aReplyOfNothingButFilesDrawsItsCards() throws {
    let item = AssistantItem(
      base: ItemBase(id: "a:1", seq: 1, origin: .live, version: 1), text: "", streaming: false, interim: false,
      outbox: GallerySample.sharedFiles)
    let row = TranscriptRow(VisibleItem(item: .assistant(item), presentation: .full))

    #expect(try render(TranscriptItemView(row: row)).height > 0)
  }
}
