import Foundation
import HermieGateway
import Synchronization
import Testing

@testable import HermieCore

/// Uploads a test holds open until it says so, by file name.
final class HeldUploads: Sendable {
  private struct State {
    var waiting: [String: CheckedContinuation<Result<OutgoingAttachment, any Error>, Never>] = [:]
    var started: [String] = []
    var cancelled: [String] = []
    var progress: [String: (@Sendable (Double) -> Void)] = [:]
  }

  private let state = Mutex(State())

  var started: [String] { state.withLock { $0.started } }
  var cancelled: [String] { state.withLock { $0.cancelled } }

  func upload(_ file: PickedFile, _ onProgress: @escaping @Sendable (Double) -> Void) async throws
    -> OutgoingAttachment
  {
    state.withLock {
      $0.started.append(file.name)
      $0.progress[file.name] = onProgress
    }

    let result: Result<OutgoingAttachment, any Error> = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        state.withLock { $0.waiting[file.name] = continuation }
      }
    } onCancel: {
      state.withLock { state in
        state.cancelled.append(file.name)
        state.waiting.removeValue(forKey: file.name)?.resume(returning: .failure(CancellationError()))
      }
    }

    return try result.get()
  }

  func report(_ name: String, _ fraction: Double) {
    let handler = state.withLock { $0.progress[name] }
    handler?(fraction)
  }

  func finish(_ name: String, path: String? = nil) {
    state.withLock { $0.waiting.removeValue(forKey: name) }?.resume(
      returning: .success(.file(filename: name, path: path ?? "/work/space/uploads/hermie/d/t-\(name)")))
  }

  func fail(_ name: String, _ error: any Error) {
    state.withLock { $0.waiting.removeValue(forKey: name) }?.resume(returning: .failure(error))
  }

  func isWaiting(_ name: String) -> Bool { state.withLock { $0.waiting[name] != nil } }
}

private struct TrayHarness {
  let tray: AttachmentTray
  let held: HeldUploads
  let folder: URL

  @MainActor init() throws {
    let held = HeldUploads()
    self.held = held
    let ids = Mutex(0)
    tray = AttachmentTray(
      AttachmentTray.Dependencies(
        upload: { file, progress in try await held.upload(file, progress) },
        newID: { ids.withLock { value in value += 1; return "chip-\(value)" } }
      ))
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("tray-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  func file(_ name: String, type: String? = nil, bytes: Int = 4, size: Int? = nil) throws -> PickedFile {
    let url = folder.appendingPathComponent(name)
    try Data(repeating: 0x41, count: bytes).write(to: url)
    return PickedFile(name: name, mimeType: type, size: size ?? bytes, url: url)
  }

  func until(_ what: String, _ condition: @escaping @MainActor @Sendable (AttachmentTray) -> Bool) async throws {
    let tray = self.tray
    try await eventually(what) { await MainActor.run { condition(tray) } }
  }

  func settled(_ status: AttachmentStatus, id: String? = nil) async throws {
    let tray = self.tray
    try await eventually("the chip to be \(status)") {
      await MainActor.run {
        tray.items.filter { id == nil || $0.id == id }.allSatisfy { $0.status == status } && !tray.items.isEmpty
      }
    }
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct AttachmentTrayTests {
  @Test func anImageIsReadAndEncodedAndIsReadyToTake() async throws {
    let harness = try TrayHarness()
    let image = try harness.file("photo.png", type: "image/png", bytes: 3)

    harness.tray.add([image])
    #expect(harness.tray.items.first?.kind == .image)
    #expect(harness.tray.blocked, "still being read")
    try await harness.settled(.ready)
    #expect(!harness.tray.blocked)
    #expect(harness.tray.items.first?.previewURL == image.url, "a small image shows as its own thumbnail")

    let taken = try #require(harness.tray.take())
    #expect(taken.attachments == [.image(filename: "photo.png", base64: Data(repeating: 0x41, count: 3).base64EncodedString())])
    #expect(harness.held.started.isEmpty, "an image is read, never uploaded")
  }

  @Test func aFileIsUploadedAtOnceAndHoldsTheSendUntilItIsDone() async throws {
    let harness = try TrayHarness()

    harness.tray.add([try harness.file("report.pdf", type: "application/pdf")])
    #expect(harness.tray.items.first?.kind == .file)
    try await eventually("the upload to start") { harness.held.isWaiting("report.pdf") }
    #expect(harness.tray.blocked)
    #expect(harness.tray.take() == nil, "nothing leaves while an upload runs")
    #expect(!harness.tray.isEmpty, "and the chip stays")

    harness.held.report("report.pdf", 0.4)
    try await harness.until("the progress") { $0.items.first?.progress == 0.4 }

    harness.held.finish("report.pdf", path: "/work/space/uploads/hermie/d/t-report.pdf")
    try await harness.settled(.ready)
    #expect(harness.tray.items.first?.progress == nil)

    let taken = try #require(harness.tray.take())
    #expect(taken.attachments == [.file(filename: "report.pdf", path: "/work/space/uploads/hermie/d/t-report.pdf")])
  }

  @Test func whatIsSentIsTakenOutInOneStepSoASecondSendFindsNothing() async throws {
    let harness = try TrayHarness()
    harness.tray.add([try harness.file("a.png", type: "image/png")])
    try await harness.settled(.ready)

    let first = harness.tray.take()
    let second = harness.tray.take()

    #expect(first?.attachments.count == 1)
    #expect(second == nil, "a second press on Send takes nothing: no second identical turn")
    #expect(harness.tray.isEmpty)
  }

  @Test func aFailedSendPutsExactlyWhatItTookBackAheadOfNewerOnesAndNeverTwice() async throws {
    let harness = try TrayHarness()
    harness.tray.add([try harness.file("a.png", type: "image/png"), try harness.file("b.png", type: "image/png")])
    try await harness.settled(.ready)

    let taken = try #require(harness.tray.take())
    harness.tray.add([try harness.file("c.png", type: "image/png")])
    try await harness.settled(.ready, id: "chip-3")

    harness.tray.restore(taken)
    #expect(harness.tray.items.map(\.name) == ["a.png", "b.png", "c.png"])

    harness.tray.restore(taken)
    #expect(harness.tray.items.map(\.name) == ["a.png", "b.png", "c.png"], "restoring twice does not double them")
  }

  @Test func aSentChipsLocalCopyIsLetGoOnlyWhenTheSendIsDone() async throws {
    let harness = try TrayHarness()
    let staged = try AttachmentStaging.stage(data: Data("hello".utf8), name: "pasted.png", mimeType: "image/png")
    harness.tray.add([staged])
    try await harness.settled(.ready)

    let taken = try #require(harness.tray.take())
    #expect(FileManager.default.fileExists(atPath: staged.url.path), "kept: a failed send may put it back")
    harness.tray.release(taken)
    #expect(!FileManager.default.fileExists(atPath: staged.url.path))
  }

  @Test func theLaunchSweepRemovesOnlyCopiesOlderThanADay() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("purge-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let old = root.appendingPathComponent("old", isDirectory: true)
    let fresh = root.appendingPathComponent("fresh", isDirectory: true)
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
    let now = Date()
    try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-3 * 86_400)], ofItemAtPath: old.path)

    AttachmentStaging.purge(in: root, now: now)

    #expect(!FileManager.default.fileExists(atPath: old.path), "a copy from days ago is gone")
    #expect(FileManager.default.fileExists(atPath: fresh.path), "one a live composer may hold stays")
  }

  @Test func aFailedUploadHoldsTheSendAndCanBeRetriedOrRemoved() async throws {
    let harness = try TrayHarness()
    harness.tray.add([try harness.file("a.pdf")])
    try await eventually("the upload to start") { harness.held.isWaiting("a.pdf") }

    harness.held.fail("a.pdf", GatewayError(.network, "Could not reach the gateway."))
    try await harness.settled(.failed)
    #expect(harness.tray.blocked)
    #expect(harness.tray.take() == nil)
    #expect(harness.tray.items.first?.problem == .failed(message: "Could not reach the gateway."))

    harness.tray.retry("chip-1")
    #expect(harness.tray.items.first?.status == .working)
    try await eventually("the second attempt") { harness.held.started == ["a.pdf", "a.pdf"] && harness.held.isWaiting("a.pdf") }
    harness.held.finish("a.pdf")
    try await harness.settled(.ready)
    #expect(harness.tray.take() != nil)

    harness.tray.add([try harness.file("b.pdf")])
    try await eventually("b") { harness.held.isWaiting("b.pdf") }
    harness.held.fail("b.pdf", GatewayError(.network, "down"))
    try await harness.settled(.failed)
    harness.tray.remove(harness.tray.items[0].id)
    #expect(!harness.tray.blocked, "removing the failed chip frees the send")
    #expect(harness.tray.isEmpty)
  }

  @Test func aLateAnswerForARemovedOrRetriedChipIsDropped() async throws {
    let harness = try TrayHarness()
    harness.tray.add([try harness.file("a.pdf")])
    try await eventually("the upload to start") { harness.held.isWaiting("a.pdf") }

    harness.tray.remove("chip-1")
    #expect(harness.held.cancelled == ["a.pdf"], "removing a working chip cancels its upload")
    try await Task.sleep(for: .milliseconds(20))
    #expect(harness.tray.items.isEmpty)
    #expect(!harness.tray.blocked)
  }

  @Test func aFileOverTheCapIsRefusedBeforeAnyByteMovesAndIsNotRetried() async throws {
    let harness = try TrayHarness()
    let big = try harness.file("big.bin", size: AttachmentRules.maxFileBytes + 1)

    harness.tray.add([big])
    #expect(harness.tray.items.first?.status == .failed)
    #expect(harness.tray.items.first?.problem == .tooLarge(limitBytes: AttachmentRules.maxFileBytes))
    #expect(harness.held.started.isEmpty)

    harness.tray.retry("chip-1")
    #expect(harness.tray.items.first?.status == .failed, "it would be refused the same way")
    #expect(harness.held.started.isEmpty)
  }

  @Test func anImageOverTheImageCapIsRefusedEvenThoughAFileOfThatSizeWouldNotBe() async throws {
    let harness = try TrayHarness()
    let big = try harness.file("big.png", type: "image/png", size: AttachmentRules.maxImageBytes + 1)
    let ok = try harness.file("exact.png", type: "image/png", size: AttachmentRules.maxImageBytes)

    harness.tray.add([big, ok])
    #expect(harness.tray.items[0].problem == .tooLarge(limitBytes: AttachmentRules.maxImageBytes))
    try await harness.until("the image at the cap to be read") { $0.items[1].status == .ready }
  }

  @Test func aLargeImageIsNotDrawnAsItsOwnThumbnail() async throws {
    let harness = try TrayHarness()
    let large = try harness.file("large.png", type: "image/png", bytes: 8, size: AttachmentRules.maxPreviewBytes + 1)

    harness.tray.add([large])
    try await harness.settled(.ready)
    #expect(harness.tray.items.first?.previewURL == nil)
  }

  @Test func anUnreadableImageSaysSoOnItsChip() async throws {
    let harness = try TrayHarness()
    let gone = PickedFile(
      name: "gone.png", mimeType: "image/png", size: 10,
      url: harness.folder.appendingPathComponent("not-there.png"))

    harness.tray.add([gone])
    try await harness.settled(.failed)
    guard case .unreadable? = harness.tray.items.first?.problem else {
      Issue.record("expected unreadable, got \(String(describing: harness.tray.items.first?.problem))")
      return
    }
  }

  @Test func clearingStopsEveryUploadAndEmptiesTheTray() async throws {
    let harness = try TrayHarness()
    harness.tray.add([try harness.file("a.pdf"), try harness.file("b.pdf")])
    try await eventually("both uploads to start") { harness.held.isWaiting("a.pdf") && harness.held.isWaiting("b.pdf") }

    harness.tray.clear()
    #expect(harness.tray.items.isEmpty)
    #expect(Set(harness.held.cancelled) == ["a.pdf", "b.pdf"])
  }

  @Test(arguments: [
    (GatewayError(.protocol, "too big", status: 413), AttachmentProblem.tooLarge(limitBytes: AttachmentRules.maxFileBytes)),
    (GatewayError(.protocol, "failed", status: 403, hint: "Path is outside the root"), .refused(detail: "Path is outside the root")),
    (GatewayError(.protocol, "failed with 400", status: 400), .refused(detail: "failed with 400")),
    (GatewayError(.server, "HTTP 502", status: 502), .failed(message: "HTTP 502")),
    (GatewayError(.network, "offline"), .failed(message: "offline"))
  ])
  func aFailedUploadComesToTheProblemThatNamesIt(error: GatewayError, expected: AttachmentProblem) {
    #expect(AttachmentProblem.of(error) == expected)
  }

  @Test func noWorkspaceIsItsOwnProblem() {
    #expect(AttachmentProblem.of(AttachmentUploadError.noWorkspace) == .noWorkspace)
  }
}
