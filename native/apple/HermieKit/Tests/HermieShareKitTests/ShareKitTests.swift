import Foundation
import HermieShared
import Testing

@testable import HermieShareKit

/// A container in a fresh temporary directory, removed when the test ends.
private final class Scratch {
  let root: URL

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-sharekit-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  deinit {
    try? FileManager.default.removeItem(at: root)
  }

  var outbox: ShareOutbox { ShareOutbox(container: root) }

  func file(_ name: String, _ text: String) throws -> URL {
    let url = root.appendingPathComponent("source").appendingPathComponent(name)

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)

    return url
  }

  func entry(_ id: String) -> URL {
    outbox.directory.appendingPathComponent(id)
  }

  /// The entry as the app reads it.
  func read(_ id: String) throws -> PendingShare? {
    let directory = entry(id)
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    let files = Dictionary(
      uniqueKeysWithValues: names.filter { !$0.hasSuffix(".json") }.map { ($0, directory.appendingPathComponent($0)) })

    return PendingShare.parse(
      id: id, manifest: try Data(contentsOf: directory.appendingPathComponent("manifest.json")),
      claim: try? Data(contentsOf: directory.appendingPathComponent("claim.json")),
      lease: try? Data(contentsOf: directory.appendingPathComponent("lease.json")), files: files)
  }
}

private let gateway = "50696704682b12da"

@Suite("Share outbox writer")
struct ShareOutboxTests {
  @Test("an entry is written as the app reads it, with its gateway, and two files of one name stay two")
  func writes() throws {
    let scratch = try Scratch()
    let pdf = try scratch.file("report.pdf", "%PDF")
    let other = try scratch.file("x/report.pdf", "%PDF-2")
    let id = try #require(
      scratch.outbox.write(
        bot: "researcher", gatewayKey: gateway, note: "look",
        payloads: [
          .file(url: pdf, name: "report.pdf", isImage: false), .file(url: other, name: "report.pdf", isImage: false),
          .url("https://example.org"), .text("hello")
        ]))
    let share = try #require(try scratch.read(id))

    #expect(Identifiers.isSafeShareId(id))
    #expect(share.bot == "researcher")
    #expect(share.gatewayKey == gateway)
    #expect(share.files.count == 2)
    #expect(share.messageText == "look\n\nhttps://example.org\n\nhello")

    guard case let .file(_, _, filename, size, mimeType) = share.files[1] else {
      Issue.record("not a file")
      return
    }

    #expect(filename == "report-2.pdf")
    #expect(size == 6)
    #expect(mimeType == "application/pdf")
  }

  @Test("shared text too long to keep inline becomes a text file, so the manifest stays small and nothing is cut")
  func longText() throws {
    let scratch = try Scratch()
    let long = String(repeating: "abcdefgh", count: 200_000)
    let id = try #require(scratch.outbox.write(bot: "b", gatewayKey: gateway, note: "", payloads: [.text(long), .text("short")]))
    let manifest = try Data(contentsOf: scratch.entry(id).appendingPathComponent("manifest.json"))
    let share = try #require(try scratch.read(id))

    #expect(manifest.count < ShareManifest.inlineTextLimit * 2)
    #expect(share.messageText == "short")

    guard case let .file(_, url, filename, _, mimeType) = try #require(share.files.first) else {
      Issue.record("not a file")
      return
    }

    #expect(filename == "shared-text.txt")
    #expect(mimeType == "text/plain")
    #expect(try String(contentsOf: url, encoding: .utf8) == long)
  }

  @Test("twelve items of the longest inline text still make a manifest the app reads")
  func manifestCeiling() throws {
    let scratch = try Scratch()
    let longest = String(repeating: "é", count: ShareManifest.inlineTextLimit / 2)
    let note = String(repeating: "\u{1}", count: ShareManifest.noteLimit + 10)
    let id = try #require(
      scratch.outbox.write(bot: "b", gatewayKey: gateway, note: note, payloads: Array(repeating: .text(longest), count: 20)))
    let manifest = try Data(contentsOf: scratch.entry(id).appendingPathComponent("manifest.json"))

    #expect(manifest.count <= ShareManifest.maxBytes)
    #expect(try scratch.read(id)?.items.count == ShareManifest.itemLimit)
  }

  @Test("a symbolic link is never staged or copied")
  func links() throws {
    let scratch = try Scratch()
    let secret = try scratch.file("secret.txt", "secret")
    let link = scratch.root.appendingPathComponent("source/link.txt")

    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: secret)

    #expect(ShareOutbox.stage(link, name: "link.txt", isImage: false, in: scratch.root.appendingPathComponent("staging")) == nil)
    #expect(ShareOutbox.stage(secret, name: "../../evil", isImage: false, in: scratch.root.appendingPathComponent("staging")) != nil)

    let id = try #require(
      scratch.outbox.write(bot: "b", gatewayKey: gateway, note: "n", payloads: [.file(url: link, name: "link.txt", isImage: false)]))

    #expect(try scratch.read(id)?.files.isEmpty == true)
    #expect(ShareOutbox.safeFileName("../../evil") == "evil")
  }

  @Test("the lease, the claim and the removal answer for an entry only while it is there")
  func leaseAndClaim() throws {
    let scratch = try Scratch()
    let outbox = scratch.outbox
    let id = try #require(outbox.write(bot: "b", gatewayKey: gateway, note: "n", payloads: []))
    let now = Date(timeIntervalSince1970: 1_770_000_000)

    #expect(outbox.lease(entry: id, now: now))
    #expect(try scratch.read(id)?.lease == ShareLease(at: 1_770_000_000))
    #expect(try scratch.read(id)?.lease?.isFresh(now: now.addingTimeInterval(ShareLease.lifetime - 1)) == true)
    #expect(try scratch.read(id)?.lease?.isFresh(now: now.addingTimeInterval(ShareLease.lifetime)) == false)

    outbox.releaseLease(entry: id)

    #expect(try scratch.read(id)?.lease == nil)
    #expect(outbox.claim(entry: id, bot: "b", now: now))
    #expect(try scratch.read(id)?.claim == ShareClaim(bot: "b", at: 1_770_000_000))

    // The app took it: no lease, no claim, so no send.
    outbox.remove(entry: id)

    #expect(!outbox.exists(entry: id))
    #expect(!outbox.lease(entry: id))
    #expect(!outbox.claim(entry: id, bot: "b"))
    #expect(!outbox.lease(entry: "../\(id)"))
  }

  @Test("the lease outlives the extension's deadline")
  func leaseLifetime() {
    #expect(ShareLease.lifetime > Double(ShareLease.attemptDeadline.components.seconds) + 30)
  }
}

@Suite("Share delivery")
struct ShareDeliveryTests {
  private func record(
    _ base: String, mode: String = "session_token", key: String = gateway, expiresAt: Double = 0
  ) -> ShareDeliveryRecord {
    ShareDeliveryRecord.build(
      gatewayId: "g1", gatewayKey: key, baseUrl: base, authMode: mode, headers: ["x-front-door": "door-secret"],
      sessionToken: "session-secret", accessToken: "bearer-secret", expiresAt: expiresAt)!
  }

  private func targets(key: String? = gateway) -> ShareTargets {
    ShareTargets.build(
      bots: [("researcher", "durable-session")], copy: .init(sent: "", queued: "", sending: ""), gatewayKey: key,
      now: Date())
  }

  private func request(_ entry: String, key: String? = gateway) -> ShareDelivery.Request {
    ShareDelivery.Request(entry: entry, bot: "researcher", gatewayKey: key, text: "hello", attachments: [])
  }

  @Test("no credential, an expired one, no session, or gateways that do not all agree: queued without a request")
  func gates() async throws {
    let scratch = try Scratch()
    let outbox = scratch.outbox
    let id = try #require(outbox.write(bot: "researcher", gatewayKey: gateway, note: "n", payloads: []))
    // Nothing listens here: a request would fail, but none may be made.
    let base = "http://127.0.0.1:9"

    let cases: [(ShareCredential?, ShareTargets?, ShareDelivery.Request)] = [
      (nil, targets(), request(id)),
      (ShareCredential(record(base, mode: "native_pkce", expiresAt: 1)), targets(), request(id)),
      (ShareCredential(record(base)), nil, request(id)),
      (ShareCredential(record(base)), targets(key: nil), request(id)),
      (ShareCredential(record(base, key: "")), targets(), request(id)),
      (ShareCredential(record(base)), targets(key: "ffffffffffffffff"), request(id)),
      (ShareCredential(record(base)), targets(), request(id, key: "ffffffffffffffff"))
    ]

    for (credential, targets, request) in cases {
      let outcome = await ShareDelivery.deliver(request, credential: credential, targets: targets, outbox: outbox)

      guard case .queued = outcome else {
        Issue.record("expected queued, got \(outcome)")
        continue
      }
    }

    #expect(try scratch.read(id)?.lease == nil)
    #expect(try scratch.read(id)?.claim == nil)
  }

  @Test("an expired PKCE record is not usable; a session-token record never expires")
  func expiry() {
    #expect(record("https://g.example", mode: "native_pkce", expiresAt: 1).isExpired(now: Date()))
    #expect(!record("https://g.example").isExpired(now: .distantFuture))
    #expect(ShareCredential(record("https://g.example", key: gateway)) != nil)
  }

  @Test("an entry the app has taken is not sent")
  func taken() async throws {
    let scratch = try Scratch()
    let outcome = await ShareDelivery.deliver(
      request("0123456789abcdef"), credential: ShareCredential(record("http://127.0.0.1:9")), targets: targets(),
      outbox: scratch.outbox)

    #expect(outcome == .takenByApp)
  }

  /// A front door that answers with a redirect to another origin, and that other origin.
  private func frontDoor() async throws -> (door: LoopbackHTTPServer, elsewhere: LoopbackHTTPServer, base: String) {
    let elsewhere = try LoopbackHTTPServer { _ in "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}" }
    let elsewherePort = try await elsewhere.start()
    let door = try LoopbackHTTPServer { _ in
      "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:\(elsewherePort)/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    }
    let port = try await door.start()

    return (door, elsewhere, "http://127.0.0.1:\(port)")
  }

  @Test("a redirect on the ticket is refused: one request, and no credential reaches the other origin")
  func ticketRedirect() async throws {
    let (door, elsewhere, base) = try await frontDoor()

    defer {
      door.stop()
      elsewhere.stop()
    }

    let scratch = try Scratch()
    let id = try #require(scratch.outbox.write(bot: "researcher", gatewayKey: gateway, note: "n", payloads: []))
    let outcome = await ShareDelivery.deliver(
      request(id), credential: ShareCredential(record(base, mode: "native_pkce", expiresAt: 4_000_000_000)),
      targets: targets(), outbox: scratch.outbox, deadline: .seconds(10))

    guard case .queued = outcome else {
      Issue.record("expected queued, got \(outcome)")
      return
    }

    #expect(door.requests.count == 1)
    #expect(door.requests.first?.hasPrefix("POST /api/auth/ws-ticket") == true)
    #expect(elsewhere.requests.isEmpty)
    // The entry is left exactly as it was, for the app.
    #expect(try scratch.read(id)?.lease == nil)
    #expect(try scratch.read(id)?.claim == nil)
  }

  @Test("a redirect on the socket's upgrade is refused: no credential reaches the other origin")
  func socketRedirect() async throws {
    let (door, elsewhere, base) = try await frontDoor()

    defer {
      door.stop()
      elsewhere.stop()
    }

    let scratch = try Scratch()
    let id = try #require(scratch.outbox.write(bot: "researcher", gatewayKey: gateway, note: "n", payloads: []))
    let outcome = await ShareDelivery.deliver(
      request(id), credential: ShareCredential(record(base)), targets: targets(), outbox: scratch.outbox,
      deadline: .seconds(10))

    guard case .queued = outcome else {
      Issue.record("expected queued, got \(outcome)")
      return
    }

    #expect(door.requests.count == 1)
    #expect(door.requests.first?.hasPrefix("GET /api/ws?token=") == true)
    #expect(elsewhere.requests.isEmpty)
    #expect(try scratch.read(id)?.claim == nil)
  }

  @Test("a gateway that never answers runs into the deadline, and the entry is the app's again")
  func deadline() async throws {
    // Accepts the upgrade request and never answers it.
    let silent = try LoopbackHTTPServer { _ in
      Thread.sleep(forTimeInterval: 5)
      return ""
    }
    let port = try await silent.start()

    defer { silent.stop() }

    let scratch = try Scratch()
    let id = try #require(scratch.outbox.write(bot: "researcher", gatewayKey: gateway, note: "n", payloads: []))
    let started = ContinuousClock.now
    let outcome = await ShareDelivery.deliver(
      request(id), credential: ShareCredential(record("http://127.0.0.1:\(port)")), targets: targets(),
      outbox: scratch.outbox, deadline: .milliseconds(500))

    #expect(outcome == .queued(reason: "the attempt ran out of time"))
    #expect(ContinuousClock.now - started < .seconds(4))
    #expect(try scratch.read(id)?.lease == nil)
    #expect(try scratch.read(id)?.claim == nil)
  }

  @Test("the upload path and the file reference are the app's")
  func paths() {
    let path = ShareDelivery.uploadPath(cwd: "/home/a/", name: "my report.pdf", now: Date(timeIntervalSince1970: 0))

    #expect(path.hasPrefix("/home/a/uploads/hermie/1970-01-01/"))
    #expect(path.hasSuffix("-my-report.pdf"))
    #expect(ShareDelivery.fileReference("/a b") == "@file:`/a b`")
    #expect(ShareDelivery.fileReference("/ab") == "@file:/ab")
  }
}
