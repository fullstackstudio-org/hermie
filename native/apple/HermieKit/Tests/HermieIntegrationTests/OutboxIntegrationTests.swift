#if os(macOS)
import CryptoKit
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

private let researcher = "researcher"
private let token = "outbox-token"

@MainActor
private func outboxWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// One request the fake's outbox route answered, as `/__fake/state` reads it back.
private struct OutboxRequest: Equatable {
  var id: String
  var profile: String?
  var method: String
  var range: String?
  var status: Int
}

private func outboxRequests(_ gateway: FakeGateway) async throws -> [OutboxRequest] {
  let state = try await gateway.control("GET", "/__fake/state")

  return (state["outboxRequests"]?.arrayValue ?? []).map { entry in
    OutboxRequest(
      id: entry["id"]?.stringValue ?? "", profile: entry["profile"]?.stringValue,
      method: entry["method"]?.stringValue ?? "", range: entry["range"]?.stringValue,
      status: Int(entry["status"]?.doubleValue ?? 0))
  }
}

/// A fake gateway behind the shared token, for as long as `body` runs.
private func withOutboxGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(FakeGateway.Options(auth: .token, token: token)) { gateway in try await body(gateway) }
}

extension Integration {
  /// The files a bot shares, against the real fake gateway over real sockets: the reply that carries them, the
  /// history that gives them back, the route that serves them (the credential in a header, a profile in the query, byte
  /// ranges), the downloads that check what arrived, and the players that read them as they go.
  @Suite("Files a bot shares") @MainActor
  struct OutboxIntegrationTests {
    /// A session signed in with the shared token (the gateway refuses a request without it), with the
    /// researcher's chat open.
    private static func open(_ gateway: FakeGateway, id: String = "g-outbox") async throws -> GatewaySession {
      var options = GatewaySession.Options()
      options.connection.backoff = { _ in .milliseconds(100) }
      let record = GatewayRecord(id: id, name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
      let session = try GatewaySession(
        record: record, credentials: SessionTokenCredentials(token: token), database: try SQLiteStore(.inMemory), options: options)

      await session.start()
      try await outboxWait("the socket and the roster") {
        session.status.phase == .ready && session.chatList.rows[researcher] != nil
      }
      try await session.open(researcher)
      try await outboxWait("the chat to be live") { await session.store.state(of: researcher)?.hydration == .live }
      return session
    }

    /// Ask the bot to share its files and wait for the reply that carries them.
    private static func shared(_ session: GatewaySession) async throws -> [OutboxAttachment] {
      let composer = ComposerModel(session: session, bot: researcher)
      try await outboxWait("the chat to accept a message") { composer.canSend }
      composer.draft = "please share files"
      await composer.submit()
      try await outboxWait("the reply with the files") {
        await session.store.state(of: researcher)?.orderedItems.compactMap(\.asAssistant).contains { !($0.outbox ?? []).isEmpty } == true
      }
      let state = try #require(await session.store.state(of: researcher))
      return try #require(state.orderedItems.compactMap(\.asAssistant).last { !($0.outbox ?? []).isEmpty }?.outbox)
    }

    @Test("the reply carries the seven files of the scenario, each by its kind, with the note in the text")
    func replyCarriesThem() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)

        #expect(files.map(\.name) == ["sunrise.png", "forest.png", "test card.mp4", "tone.mp3", "Q3 report.pdf", "summary <draft>.html", "archive.zip"])
        #expect(files.map(\.kind) == [.image, .image, .video, .audio, .pdf, .file, .file])
        #expect(files.map(OutboxPresentation.card) == [.picture, .picture, .video, .audio, .document, .file, .file])
        #expect(files.allSatisfy { $0.url.hasPrefix("/api/files/outbox/\($0.id)/") && !$0.url.contains("?") })

        let state = try #require(await session.store.state(of: researcher))
        let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last { !($0.outbox ?? []).isEmpty })
        #expect(reply.text.contains("(1 file could not be shared.)"), "the note stays as the gateway wrote it")
        await session.shutdown()
      }
    }

    @Test("a new session reads them back from the history, the same ones")
    func historyGivesThemBack() async throws {
      try await withOutboxGateway { gateway in
        let first = try await Self.open(gateway, id: "g-outbox-1")
        let files = try await Self.shared(first)
        await first.shutdown()

        // Another session, with nothing cached: the history is the only place the files can come from.
        let second = try await Self.open(gateway, id: "g-outbox-2")
        try await outboxWait("the files in the history") {
          await second.store.state(of: researcher)?.orderedItems.compactMap(\.asAssistant).contains { !($0.outbox ?? []).isEmpty } == true
        }
        let state = try #require(await second.store.state(of: researcher))
        let again = try #require(state.orderedItems.compactMap(\.asAssistant).last { !($0.outbox ?? []).isEmpty }?.outbox)

        #expect(again == files)
        await second.shutdown()
      }
    }

    @Test("every file downloads whole, checked against its size and SHA-256, into a folder of this gateway, as the chat's profile")
    func downloads() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)
        let outbox = session.outboxFiles(profile: researcher)

        for attachment in files {
          let model = outbox.model(for: attachment)
          guard case .ready(let url) = await model.ensure() else {
            Issue.record("\(attachment.name) did not arrive: \(model.state)")
            continue
          }
          let data = try Data(contentsOf: url)

          #expect(data.count == attachment.size, "\(attachment.name)")
          #expect(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == attachment.sha256, "\(attachment.name)")
          #expect(url.lastPathComponent == OutboxText.savedName(attachment.name))
          #expect(url.path.hasPrefix(AttachmentOpening.directory(gateway: session.gatewayID).path))
        }

        // A name the file system refuses is saved under what the card shows, never as the bot wrote it.
        let html = try #require(files.first { $0.mime == "text/html" })
        #expect(OutboxText.savedName(html.name) == "summary _draft_.html")

        let requests = try await outboxRequests(gateway)
        #expect(requests.count == files.count)
        #expect(requests.allSatisfy { $0.profile == researcher && $0.status == 200 && $0.method == "GET" })

        AttachmentOpening.discardOpened(gateway: session.gatewayID)
        await session.shutdown()
      }
    }

    @Test("a player's request carries the credential in a header and is answered a byte range; without it the gate refuses")
    func rangesThroughTheSessionsCredentials() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)
        let clip = try #require(files.first { $0.kind == .video })
        let path = OutboxRoute.path(for: clip, profile: researcher)

        let request = try await session.link.mediaRequest(path)
        #expect(!request.url.absoluteString.contains(token), "the credential is never in the address")
        #expect(request.url.query == "profile=\(researcher)")

        var headers = request.headers
        headers["range"] = "bytes=0-9"
        let part = try await FakeGateway.plainResponse("GET", request.url.absoluteString, headers: headers)
        #expect(part.status == 206)
        #expect(part.headers["content-range"] == "bytes 0-9/\(clip.size)")
        #expect(part.headers["accept-ranges"] == "bytes")
        #expect(part.headers["x-content-type-options"] == "nosniff")

        let tail = try await FakeGateway.plainResponse("GET", request.url.absoluteString, headers: headers.merging(["range": "bytes=-34"]) { _, new in new })
        #expect(tail.status == 206)
        #expect(tail.headers["content-range"] == "bytes \(clip.size - 34)-\(clip.size - 1)/\(clip.size)")

        let past = try await FakeGateway.plainResponse("GET", request.url.absoluteString, headers: headers.merging(["range": "bytes=\(clip.size)-"]) { _, new in new })
        #expect(past.status == 416)

        let anonymous = try await FakeGateway.plainResponse("GET", request.url.absoluteString)
        #expect(anonymous.status == 401, "a request without the credential does not get the file")
        await session.shutdown()
      }
    }

    @Test("a file asked for as another profile is not found, and the card says it is gone, with nothing to retry")
    func anotherProfileIsGone() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)
        let image = try #require(files.first { $0.kind == .image })

        let model = session.outboxFiles(profile: "writer").model(for: image)
        #expect(await model.ensure() == .gone)
        #expect(!model.state.canRetry)

        let own = session.outboxFiles(profile: researcher).model(for: image)
        guard case .ready = await own.ensure() else {
          Issue.record("the researcher's own picture did not arrive")
          return
        }
        AttachmentOpening.discardOpened(gateway: session.gatewayID)
        await session.shutdown()
      }
    }

    @Test("the system's player reads a sound and a video from the gateway with the credential in its headers, by byte ranges")
    func playersReadThem() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)
        let tone = try #require(files.first { $0.kind == .audio })
        let clip = try #require(files.first { $0.kind == .video })
        let center = MediaPlaybackCenter(files: session.outboxFiles(profile: researcher))

        let audio = center.playback(for: tone)
        await audio.prepare()
        #expect(audio.phase == .ready, "the gate accepted the player's own requests: \(audio.phase)")
        let length = try #require(audio.duration)
        #expect(length > 1.5 && length < 2.5, "the fake's tone is two seconds, read as \(length)")

        let video = center.playback(for: clip)
        await video.loadPoster()
        #expect(video.phase == .ready)
        #expect(video.poster != nil, "the first frame of the clip")

        // The player asked for ranges, not the whole file, and every request it made was answered.
        let requests = try await outboxRequests(gateway)
        #expect(requests.contains { $0.id == tone.id && $0.range != nil })
        #expect(requests.filter { $0.id == tone.id || $0.id == clip.id }.allSatisfy { $0.status == 200 || $0.status == 206 })
        #expect(requests.allSatisfy { $0.profile == researcher })

        center.stopAll()
        await session.shutdown()
      }
    }

    @Test("a player that is told the file is not there says gone, not failed")
    func aPlayerSeesA404AsGone() async throws {
      try await withOutboxGateway { gateway in
        let session = try await Self.open(gateway)
        let files = try await Self.shared(session)
        let tone = try #require(files.first { $0.kind == .audio })
        // The same file asked for as a profile that never shared it: the gateway's 404.
        let center = MediaPlaybackCenter(files: session.outboxFiles(profile: "writer"))

        let audio = center.playback(for: tone)
        await audio.prepare()

        #expect(audio.phase == .gone, "the system's own error for a 404 is read as gone: \(audio.phase)")
        #expect(audio.player == nil)
        await session.shutdown()
      }
    }
  }
}
#endif
