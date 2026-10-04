import Foundation
import Synchronization
import Testing

@testable import HermieGateway

/// `HTTPClient.readRange`: a byte range of a gateway file for a media player, held to the rules of `downloadFile`
/// (a redirect is refused, a 401 refreshes once, the whole file is capped) and handing over no more than was asked.
@Suite(.serialized) struct HTTPClientRangeTests {
  static let base = "http://gateway.test"
  static let route = "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/clip.mp4?profile=writer"

  /// What one read handed over.
  final class Received: Sendable {
    private let state = Mutex<(heads: [ByteRangeHead], data: Data)>(([], Data()))
    var heads: [ByteRangeHead] { state.withLock { $0.heads } }
    var data: Data { state.withLock { $0.data } }
    func head(_ head: ByteRangeHead) { state.withLock { $0.heads.append(head) } }
    func append(_ data: Data) { state.withLock { $0.data.append(data) } }
  }

  static func body(_ count: Int) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 7) })
  }

  /// A gateway that answers ranges of `file` as the outbox route does.
  static func ranged(_ file: Data) -> StubServer {
    StubServer { request in
      guard let range = request.header("range"), range.hasPrefix("bytes=") else {
        return .respond(status: 200, body: file, headers: ["content-type": "video/mp4"])
      }
      let bounds = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
      let first = Int(bounds[0]) ?? 0
      let last = bounds.count > 1 && !bounds[1].isEmpty ? min(Int(bounds[1])!, file.count - 1) : file.count - 1
      return .respond(
        status: 206, body: file.subdata(in: first..<(last + 1)),
        headers: ["content-type": "video/mp4; codecs=avc1", "content-range": "bytes \(first)-\(last)/\(file.count)"])
    }
  }

  @Test("a range is asked for with the credential and handed over with what the gateway said about the file")
  func aRange() async throws {
    let file = Self.body(10_000)
    let server = Self.ranged(file)
    let http = try HTTPClient(
      baseURL: Self.base, credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      extraHeaders: ["x-front-door": "door"], transport: server.transport())
    let received = Received()

    try await http.readRange(
      Self.route, offset: 100, length: 50, maxBytes: 1_000_000, onHead: received.head, onData: received.append)

    #expect(received.heads == [ByteRangeHead(contentType: "video/mp4", totalLength: 10_000, rangesSupported: true)])
    #expect(received.data == file.subdata(in: 100..<150))

    let request = try #require(server.requests.first)
    #expect(request.header("range") == "bytes=100-149")
    #expect(request.header("authorization") == "Bearer at-1")
    #expect(request.header("x-front-door") == "door")
    #expect(request.path == "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/clip.mp4")
    #expect(request.handlesCookies == false)
  }

  @Test("a read to the end asks an open range and takes the rest of the file")
  func toTheEnd() async throws {
    let file = Self.body(3000)
    let server = Self.ranged(file)
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let received = Received()

    try await http.readRange(
      Self.route, offset: 2500, length: nil, maxBytes: 1_000_000, onHead: received.head, onData: received.append)

    #expect(server.requests.first?.header("range") == "bytes=2500-")
    #expect(received.data == file.subdata(in: 2500..<3000))
  }

  @Test("a gateway that sends the whole file has the bytes before the range skipped and no more than asked handed over")
  func wholeFile() async throws {
    let file = Self.body(4000)
    let server = StubServer { _ in
      .respond(status: 200, body: file, headers: ["content-type": "audio/mpeg", "content-length": "4000"])
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let received = Received()

    try await http.readRange(
      Self.route, offset: 1000, length: 10, maxBytes: 1_000_000, onHead: received.head, onData: received.append)

    #expect(received.heads.first?.rangesSupported == false)
    #expect(received.heads.first?.totalLength == 4000)
    #expect(received.data == file.subdata(in: 1000..<1010))
  }

  @Test("a range answered with more bytes than asked hands over only what was asked")
  func moreThanAsked() async throws {
    let file = Self.body(1000)
    let server = StubServer { _ in
      .respond(status: 206, body: file, headers: ["content-range": "bytes 0-999/1000"])
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let received = Received()

    try await http.readRange(Self.route, offset: 0, length: 2, maxBytes: 1_000_000, onHead: received.head, onData: received.append)

    #expect(received.data == file.prefix(2))
  }

  @Test("a file whose whole length is over the cap is refused before a byte is handed over, a range of it too")
  func overTheCap() async throws {
    let server = StubServer { _ in
      .respond(status: 206, body: Data([1, 2]), headers: ["content-range": "bytes 0-1/5000"])
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let received = Received()

    do {
      try await http.readRange(Self.route, offset: 0, length: 2, maxBytes: 4999, onHead: received.head, onData: received.append)
      Issue.record("a range of a file over the cap was handed over")
    } catch {
      #expect((error as? FileDownloadError) == .tooLarge)
    }
    #expect(received.heads.isEmpty && received.data.isEmpty)

    do {
      try await http.readRange(Self.route, offset: 5000, length: 2, maxBytes: 4999, onHead: { _ in }, onData: { _ in })
      Issue.record("a range past the cap was asked for")
    } catch {
      #expect((error as? FileDownloadError) == .tooLarge)
    }
  }

  @Test("a 404 is not found, another refusal its status, and a range that does not start where asked is refused")
  func refusals() async throws {
    for (reply, expected) in [
      (StubReply.text("", status: 404), FileDownloadError.notFound),
      (.text("", status: 416), .refused(status: 416)),
      (.respond(status: 206, body: Data([1]), headers: ["content-range": "bytes 5-5/10"]), .refused(status: 206)),
      (.respond(status: 206, body: Data([1]), headers: [:]), .refused(status: 206)),
    ] {
      let server = StubServer { _ in reply }
      let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
      let received = Received()

      do {
        try await http.readRange(Self.route, offset: 0, length: 1, maxBytes: 1000, onHead: received.head, onData: received.append)
        Issue.record("\(expected) was handed over")
      } catch {
        #expect((error as? FileDownloadError) == expected)
      }
      #expect(received.heads.isEmpty)
    }
  }

  @Test("a 401 asks the provider once and reads again with the fresh token")
  func unauthorized() async throws {
    let file = Self.body(100)
    let credentials = HTTPClientBehaviourTests.RotatingCredentials(verdict: .retry)
    let server = StubServer { request in
      request.header("authorization") == "Bearer at-2"
        ? .respond(status: 206, body: file.prefix(10), headers: ["content-range": "bytes 0-9/100"]) : .text("", status: 401)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: credentials, transport: server.transport())
    let received = Received()

    try await http.readRange(Self.route, offset: 0, length: 10, maxBytes: 1000, onHead: received.head, onData: received.append)

    #expect(received.heads.count == 1, "the refused answer is never taken for the file")
    #expect(received.data == file.prefix(10))
    #expect(server.requests.map { $0.header("authorization") } == ["Bearer at-1", "Bearer at-2"])
  }

  @Test("a redirect to another listener is refused, and nothing reaches it")
  func redirect() async throws {
    let elsewhere = try LoopbackHTTPServer { _ in RealListenerRedirectTests.reply(status: "200 OK", body: "stolen") }
    let elsewherePort = try await elsewhere.start()
    let gateway = try LoopbackHTTPServer { _ in
      RealListenerRedirectTests.reply(status: "302 Found", headers: ["Location: http://localhost:\(elsewherePort)/x"])
    }
    let gatewayPort = try await gateway.start()
    defer {
      gateway.stop()
      elsewhere.stop()
    }
    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(gatewayPort)",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]), transport: HTTPTransport())
    let received = Received()

    do {
      try await http.readRange(Self.route, offset: 0, length: 2, maxBytes: 1000, onHead: received.head, onData: received.append)
      Issue.record("a redirect was followed")
    } catch {
      #expect((error as? FileDownloadError) == .refused(status: 302))
    }
    #expect(elsewhere.requests.isEmpty)
    #expect(received.heads.isEmpty && received.data.isEmpty)
    #expect(gateway.requests.first?.contains("Bearer at-1") == true)
  }

  @Test("cancelling the task ends the read")
  func cancelled() async throws {
    let server = StubServer { _ in .hang }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    let task = Task {
      try await http.readRange(Self.route, offset: 0, length: 1, maxBytes: 1000, onHead: { _ in }, onData: { _ in })
    }
    await waitUntil { !server.requests.isEmpty }
    task.cancel()

    do {
      try await task.value
      Issue.record("a cancelled read finished")
    } catch {
      #expect(error is CancellationError)
    }
  }

  @Test func aContentRangeIsReadStrictly() {
    #expect(RangeSink.contentRange("bytes 0-1/10").map { $0 == (0, 1, 10) } == true)
    #expect(RangeSink.contentRange("bytes 5-9/*").map { $0 == (5, 9, nil) } == true)
    #expect(RangeSink.contentRange("bytes 5-4/10") == nil)
    #expect(RangeSink.contentRange("bytes 0-10/10") == nil)
    #expect(RangeSink.contentRange("items 0-1/10") == nil)
    #expect(RangeSink.contentRange("bytes 0-x/10") == nil)
    #expect(RangeSink.contentRange(nil) == nil)
    #expect(RangeSink.mediaType("Audio/MPEG; charset=binary") == "audio/mpeg")
    #expect(RangeSink.mediaType(" ") == nil)
  }
}
