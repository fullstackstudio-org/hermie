#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"
private let token = "attached-images-token"

/// A 1x1 PNG, the smallest picture the fake gateway serves.
private let tinyPNG = Data(
  base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")!

@MainActor
private func attachedWait(_ what: String, _ condition: @MainActor () async -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A fake gateway (signed in by a shared token) whose researcher has a home on this machine, with a picture in
/// its `images/` folder, for as long as `body` runs.
private func withAttachedGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  let home = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-attached-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: home.appendingPathComponent("images"), withIntermediateDirectories: true)
  try tinyPNG.write(to: home.appendingPathComponent("images/upload_20261004_160406_1.png"))
  defer { try? FileManager.default.removeItem(at: home) }

  let options = FakeGateway.Options(auth: .token, token: token, extraArguments: ["--profile-home", "\(researcher)=\(home.path)"])

  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

/// One request the fake's attached-image route answered, as `/__fake/state` reads it back.
private struct ImageRequest: Equatable {
  var name: String
  var profile: String?
  var status: Int
}

private func imageRequests(_ gateway: FakeGateway) async throws -> [ImageRequest] {
  let state = try await gateway.control("GET", "/__fake/state")

  return (state["attachedImageRequests"]?.arrayValue ?? []).map { entry in
    ImageRequest(
      name: entry["name"]?.stringValue ?? "", profile: entry["profile"]?.stringValue,
      status: Int(entry["status"]?.doubleValue ?? 0))
  }
}

extension Integration {
  /// An image attached to a chat, fetched through the gateway's own route against the real fake gateway: the
  /// history names it by its path, the session asks `GET /api/files/images/<name>?profile=` with its own
  /// header credentials, and a path outside the chat's profile's `images/` folder is never asked of it.
  @Suite("Attached chat images") @MainActor
  struct AttachedImageIntegrationTests {
    /// The session of one test, signed in with the shared token, with the researcher's chat open.
    private static func open(_ gateway: FakeGateway) async throws -> GatewaySession {
      var options = GatewaySession.Options()
      options.connection.backoff = { _ in .milliseconds(100) }
      let record = GatewayRecord(id: "g-attached", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
      let session = try GatewaySession(
        record: record, credentials: SessionTokenCredentials(token: token), database: try SQLiteStore(.inMemory), options: options)

      await session.start()
      try await attachedWait("the socket and the roster") {
        session.status.phase == .ready && session.chatList.rows[researcher] != nil
      }
      try await session.open(researcher)
      try await attachedWait("the chat to be live") { await session.store.state(of: researcher)?.hydration == .live }
      return session
    }

    /// The references the history gave the turn that begins with `words`.
    private static func references(of words: String, in session: GatewaySession) async throws -> [String] {
      try await attachedWait("the turn \"\(words)\"") {
        await session.store.state(of: researcher)?.orderedItems.compactMap(\.asUser).contains { $0.text.hasPrefix(words) } == true
      }
      let state = try #require(await session.store.state(of: researcher))
      return try #require(state.orderedItems.compactMap(\.asUser).first { $0.text.hasPrefix(words) }).attachments ?? []
    }

    @Test("a picture in the chat's own profile folder comes through the image route, with the token in a header and not in the address")
    func fetchedByTheRoute() async throws {
      try await withAttachedGateway { gateway in
        let own = "/root/.hermes/profiles/researcher/images/upload_20261004_160406_1.png"
        try await gateway.inject(FakeGateway.Injection(user: "what is this?\n@image:\(own)", assistant: "A single pixel."))
        let session = try await Self.open(gateway)

        let references = try await Self.references(of: "what is this?", in: session)
        #expect(references == ["@image:\(own)"])

        let result = await session.prepareAttachment(try #require(references.first), profile: researcher)
        guard case .preview(let url) = result else {
          Issue.record("expected a preview, got \(result)")
          return
        }

        #expect(url.lastPathComponent == "upload_20261004_160406_1.png")
        #expect(try Data(contentsOf: url) == tinyPNG, "the bytes the gateway holds")
        #expect(
          try await imageRequests(gateway) == [ImageRequest(name: "upload_20261004_160406_1.png", profile: researcher, status: 200)],
          "asked as the chat's profile, once; the token in the header got it past the gate")

        AttachmentOpening.discardOpened(gateway: session.gatewayID)
        await session.shutdown()
      }
    }

    @Test("a path outside the chat's profile folder keeps the existing routes, and the gateway's refusal is the notice")
    func elsewhereAndMissing() async throws {
      try await withAttachedGateway { gateway in
        let missing = "/root/.hermes/profiles/researcher/images/upload_gone.png"
        let elsewhere = [
          "/root/.hermes/images/upload_20261004_160406_1.png",
          "/root/.hermes/profiles/writer/images/upload_20261004_160406_1.png",
          "/root/.hermes/profiles/researcher/images/sub/upload_20261004_160406_1.png"
        ]
        try await gateway.inject(
          FakeGateway.Injection(user: "gone\n@image:\(missing)", assistant: "Hm."))
        let session = try await Self.open(gateway)

        // 404: the route said so, and the files routes (this gateway has neither) too.
        #expect(await session.prepareAttachment("@image:\(missing)", profile: researcher) == .failed(name: "upload_gone.png"))
        #expect(try await imageRequests(gateway) == [ImageRequest(name: "upload_gone.png", profile: researcher, status: 404)])

        // Another profile's folder, the default's, a nested one: never asked of the image route at all.
        for path in elsewhere {
          #expect(await session.prepareAttachment("@image:\(path)", profile: researcher) == .failed(name: "upload_20261004_160406_1.png"))
        }
        #expect(try await imageRequests(gateway).count == 1, "nothing but the first request reached the image route")

        await session.shutdown()
      }
    }

    @Test("the [image] line of an unnamed image is a placeholder chip: nothing to open, nothing asked of the gateway")
    func placeholder() async throws {
      try await withAttachedGateway { gateway in
        try await gateway.inject(FakeGateway.Injection(user: "and this one?\n[image]", assistant: "I cannot see it."))
        let session = try await Self.open(gateway)

        let references = try await Self.references(of: "and this one?", in: session)
        #expect(references == ["@image:Image"])
        #expect(references.allSatisfy(isImagePlaceholder))

        let state = try #require(await session.store.state(of: researcher))
        let turn = try #require(state.orderedItems.compactMap(\.asUser).first { $0.text.hasPrefix("and this one?") })
        #expect(turn.text == "and this one?", "the line is not left in the words")
        #expect(try await imageRequests(gateway).isEmpty)

        await session.shutdown()
      }
    }
  }
}
#endif
