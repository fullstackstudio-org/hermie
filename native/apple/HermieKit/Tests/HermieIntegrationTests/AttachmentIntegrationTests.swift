#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let researcher = "researcher"

@MainActor
private func attachmentWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a body on the main actor, where the models live.
private func withAttachGateway(
  _ options: FakeGateway.Options,
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

/// A 1x1 PNG, the smallest picture the fake gateway takes as an image.
private let tinyPNG = Data(
  base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")!

@MainActor
private struct AttachChat {
  let session: GatewaySession
  let composer: ComposerModel

  static func open(_ gateway: FakeGateway) async throws -> AttachChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(
      id: "g-attach", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = AttachChat(session: session, composer: ComposerModel(session: session, bot: researcher))

    await session.start()
    try await attachmentWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    try await attachmentWait("the chat to accept a message") { chat.composer.canSend }
    return chat
  }

  /// Stage bytes as a file the composer's tray takes, through the same staging the pickers use.
  func stage(_ bytes: Data, name: String, type: String?) throws -> PickedFile {
    try AttachmentStaging.stage(data: bytes, name: name, mimeType: type)
  }

  /// The methods the gateway was called with, in order.
  static func methods(_ gateway: FakeGateway) async throws -> [String] {
    let state = try await gateway.control("GET", "/__fake/state")
    return (state["methodLog"]?.arrayValue ?? []).compactMap { entry in
      entry.stringValue ?? entry["method"]?.stringValue
    }
  }
}

extension Integration {
  /// Attachments against the real fake gateway, over real sockets and a real upload: what the "+"
  /// stages is what the gateway receives, and the agent can read it.
  @Suite("Attachments") @MainActor
  struct AttachmentIntegrationTests {
    @Test("a file is uploaded into the session's folder and the agent reads it by the reference in the prompt")
    func fileEndToEnd() async throws {
      try await withAttachGateway(FakeGateway.Options(streamDelayMs: 1)) { gateway in
        let chat = try await AttachChat.open(gateway)
        let composer = chat.composer

        composer.tray.add([try chat.stage(Data("a,b,c".utf8), name: "report.csv", type: "text/csv")])
        try await attachmentWait("the upload to finish") { !composer.tray.isEmpty && !composer.tray.blocked }
        #expect(composer.tray.items.first?.kind == .file)

        composer.draft = "Summarise this please."
        #expect(composer.canSubmit)
        await composer.submit()
        #expect(composer.lastEvent?.event == .sent)
        #expect(composer.tray.isEmpty)

        try await attachmentWait("the message in the transcript") {
          composer.chat.items.compactMap(\.item.asUser).contains { $0.text == "Summarise this please." }
        }
        let user = try #require(composer.chat.items.compactMap(\.item.asUser).first { $0.text == "Summarise this please." })
        let reference = try #require(user.attachments?.first)
        #expect(reference.hasPrefix("@file:/root/projects/researcher/uploads/hermie/"))
        #expect(reference.hasSuffix("-report.csv"))

        // The fake's reply names the file back with its size: it read the bytes the app uploaded.
        try await attachmentWait("the agent to read the file") {
          composer.chat.items.compactMap(\.item.asAssistant).contains {
            $0.text.contains("report.csv") && $0.text.contains("5 bytes")
          }
        }
        await chat.session.shutdown()
      }
    }

    @Test("an image goes over the socket before the prompt and the gateway takes it as an image")
    func imageEndToEnd() async throws {
      try await withAttachGateway(FakeGateway.Options(streamDelayMs: 1)) { gateway in
        let chat = try await AttachChat.open(gateway)
        let composer = chat.composer

        composer.tray.add([try chat.stage(tinyPNG, name: "photo.png", type: "image/png")])
        try await attachmentWait("the image to be read") { !composer.tray.isEmpty && !composer.tray.blocked }
        #expect(composer.tray.items.first?.kind == .image)

        composer.draft = "What is this?"
        await composer.submit()
        #expect(composer.notice == nil, "the gateway took the image: \(String(describing: composer.notice))")

        let methods = try await AttachChat.methods(gateway)
        let attach = try #require(methods.firstIndex(of: "image.attach_bytes"))
        let submit = try #require(methods.lastIndex(of: "prompt.submit"))
        #expect(attach < submit, "the image goes first: the gateway queues it onto the next turn")

        try await attachmentWait("the message in the transcript") {
          composer.chat.items.compactMap(\.item.asUser).contains { $0.text == "What is this?" }
        }
        let user = try #require(composer.chat.items.compactMap(\.item.asUser).first { $0.text == "What is this?" })
        #expect(user.text == "What is this?")
        #expect(user.attachments?.first?.contains("photo.png") == true)
        await chat.session.shutdown()
      }
    }

    @Test("a real upload reports its progress and answers the path the gateway resolved")
    func uploadProgress() async throws {
      try await withAttachGateway(FakeGateway.Options()) { gateway in
        let http = try HTTPClient(baseURL: gateway.baseURL, credentials: SessionTokenCredentials(token: ""))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("big.bin")
        try Data(repeating: 0x2A, count: 3 * 1024 * 1024).write(to: file)

        let seen = Mutex<[Double]>([])
        let stored = try await http.uploadFile(
          from: file, name: "big.bin", mimeType: "application/octet-stream",
          to: "/work/space/uploads/hermie/2026-10-03/abc12345-big.bin"
        ) { fraction in seen.withLock { $0.append(fraction) } }

        #expect(stored == "/work/space/uploads/hermie/2026-10-03/abc12345-big.bin")
        let fractions = seen.withLock { $0 }
        #expect(!fractions.isEmpty)
        #expect(fractions == fractions.sorted(), "progress only moves forward")
        #expect(zip(fractions, fractions.dropFirst()).allSatisfy { $1 - $0 >= 0.01 || $1 == 1 }, "a callback per percent, not per write")
        #expect(fractions.last == 1)
      }
    }

    @Test("a refused upload says why, and a relative path is the gateway's 400")
    func refusedUpload() async throws {
      try await withAttachGateway(FakeGateway.Options()) { gateway in
        let http = try HTTPClient(baseURL: gateway.baseURL, credentials: SessionTokenCredentials(token: ""))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("a.txt")
        try Data("hi".utf8).write(to: file)

        do {
          _ = try await http.uploadFile(
            from: file, name: "a.txt", mimeType: "text/plain", to: "uploads/hermie/a.txt")
          Issue.record("a relative path should be refused")
        } catch let error as GatewayError {
          #expect(error.status == 400)
          #expect(error.hint == "Path must be absolute")
          #expect(AttachmentProblem.of(error) == .refused(detail: "Path must be absolute"))
        }
      }
    }
  }
}
#endif
