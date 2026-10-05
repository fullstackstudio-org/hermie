import AVFoundation
import Foundation
import HermieGateway
import HermieTranscript
import Network
import Synchronization
import Testing

@testable import HermieCore

/// `OutboxMediaLoader`: AVFoundation reads a shared sound or video only through the loader, a byte range at a time,
/// and the loader reads only through the gateway's own client, so the credential never goes where a redirect points.
@Suite(.serialized) struct OutboxMediaLoaderTests {
  /// A silent mono 8-bit WAV of `seconds` seconds at 8 kHz.
  static func wav(seconds: Int = 1) -> Data {
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
    return data
  }

  static func attachment(size: Int, name: String = "tone.wav") -> OutboxAttachment {
    OutboxFixtures.attachment(.audio, name: name, size: size)
  }

  /// The ranges a reader was asked for.
  final class Asked: Sendable {
    private let ranges = Mutex<[MediaRange]>([])
    var all: [MediaRange] { ranges.withLock { $0 } }
    func add(_ range: MediaRange) { ranges.withLock { $0.append(range) } }
  }

  /// A reader that serves `file` by range, as the outbox route does, and notes what it was asked.
  static func reader(_ file: Data, asked: Asked, total: Int? = nil) -> MediaRangeReader {
    { range, onHead, onData in
      asked.add(range)
      let end = range.length.map { min(file.count, range.offset + $0) } ?? file.count
      onHead(ByteRangeHead(contentType: "audio/wav", totalLength: total ?? file.count, rangesSupported: true))
      onData(file.subdata(in: range.offset..<end))
    }
  }

  @Test("AVFoundation reads a sound through the loader by byte ranges, never the whole file in one")
  func rangesThroughTheLoader() async throws {
    let file = Self.wav(seconds: 1)
    let asked = Asked()
    let loader = OutboxMediaLoader(attachment: Self.attachment(size: file.count), maxBytes: 1_000_000, read: Self.reader(file, asked: asked))
    let asset = loader.makeAsset()

    let (duration, playable) = try await asset.load(.duration, .isPlayable)

    #expect(playable)
    #expect(duration.seconds > 0.9 && duration.seconds < 1.1)
    #expect(!asked.all.isEmpty)
    #expect(asked.all.first == MediaRange(offset: 0, length: 2), "what the file is, from its first bytes")
    #expect(loader.failure == nil)
    loader.close()
  }

  @Test("a file whose whole length is over the cap is never handed to the player, whatever the reader allows")
  func overTheCap() async throws {
    let file = Self.wav(seconds: 1)
    let asked = Asked()
    let loader = OutboxMediaLoader(
      attachment: Self.attachment(size: file.count), maxBytes: file.count - 1, read: Self.reader(file, asked: asked))
    let asset = loader.makeAsset()

    await #expect(throws: (any Error).self) { _ = try await asset.load(.duration, .isPlayable) }
    #expect(loader.failure == .tooLarge)
  }

  @Test("a 404 fails the load as the system's own file-does-not-exist, and the loader remembers it")
  func notFound() async throws {
    let loader = OutboxMediaLoader(attachment: Self.attachment(size: 100), maxBytes: 1000) { _, _, _ in
      throw FileDownloadError.notFound
    }
    let asset = loader.makeAsset()

    await #expect(throws: (any Error).self) { _ = try await asset.load(.duration, .isPlayable) }
    #expect(loader.failure == .notFound)
    let error = OutboxMediaLoader.loadError(FileDownloadError.notFound)
    #expect(error.domain == NSURLErrorDomain && error.code == NSURLErrorFileDoesNotExist)
  }

  @Test("closing the loader cancels the range on its way")
  func closing() async throws {
    let started = Mutex(false)
    let cancelled = Mutex(false)
    let loader = OutboxMediaLoader(attachment: Self.attachment(size: 100), maxBytes: 1000) { _, _, _ in
      started.withLock { $0 = true }
      do {
        try await Task.sleep(for: .seconds(30))
      } catch {
        cancelled.withLock { $0 = true }
        throw error
      }
    }
    let asset = loader.makeAsset()
    let load = Task { try? await asset.load(.duration) }

    for _ in 0..<500 where !started.withLock({ $0 }) { try await Task.sleep(for: .milliseconds(10)) }
    loader.close()
    asset.cancelLoading()
    for _ in 0..<500 where !cancelled.withLock({ $0 }) { try await Task.sleep(for: .milliseconds(10)) }

    #expect(cancelled.withLock { $0 })
    load.cancel()
  }

  @Test func theTypeIsASoundOrAVideoByWhatIsServedTheAttachmentOrTheName() {
    let wav = OutboxFixtures.attachment(.audio, name: "tone.wav")
    #expect(OutboxMediaLoader.contentType(served: "audio/mpeg", attachment: wav) == "public.mp3")
    #expect(OutboxMediaLoader.contentType(served: "text/html", attachment: wav) == "com.microsoft.waveform-audio")
    #expect(OutboxMediaLoader.contentType(served: nil, attachment: OutboxFixtures.attachment(.video, name: "a.mp4")) == "public.mpeg-4")
    #expect(OutboxMediaLoader.contentType(served: nil, attachment: OutboxFixtures.attachment(.audio, name: "a")) == "public.mpeg-4-audio")
  }

  @Test("a playlist is never declared, and the player's address never carries the bot's name or its extension")
  func aPlaylistNameOrTypeNeverMakesAStream() {
    let video = OutboxFixtures.attachment(.video, name: "clip.m3u8")
    #expect(OutboxMediaLoader.contentType(served: "application/vnd.apple.mpegurl", attachment: video) == "public.mpeg-4")
    #expect(OutboxMediaLoader.contentType(served: "audio/mpegurl", attachment: OutboxFixtures.attachment(.audio, name: "a.m3u")) == "public.mpeg-4-audio")

    let url = OutboxMediaLoader(attachment: video, maxBytes: 1000) { _, _, _ in }.url
    #expect(url.pathExtension == "mp4")
    #expect(!url.absoluteString.contains("m3u"))
    #expect(!url.absoluteString.contains("clip"))
    #expect(url.scheme == OutboxMediaLoader.scheme)
  }

  // MARK: Through the gateway's own client, on real sockets

  @Test("a gateway that redirects the player elsewhere: nothing reaches the other origin, the credential least, and the load fails")
  func redirect() async throws {
    let elsewhere = try BinaryLoopbackServer { _ in BinaryLoopbackServer.reply(status: "200 OK", body: Self.wav()) }
    let elsewherePort = try await elsewhere.start()
    let gateway = try BinaryLoopbackServer { _ in
      BinaryLoopbackServer.reply(status: "302 Found", headers: ["Location: http://localhost:\(elsewherePort)/stolen"])
    }
    let gatewayPort = try await gateway.start()
    defer {
      gateway.stop()
      elsewhere.stop()
    }

    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(gatewayPort)", credentials: BearerOnly(token: "at-secret"), transport: HTTPTransport())
    let attachment = Self.attachment(size: Self.wav().count)
    let path = OutboxRoute.path(for: attachment, profile: "writer")
    let loader = OutboxMediaLoader(attachment: attachment, maxBytes: OutboxLimits.fileBytes) { range, onHead, onData in
      try await http.readRange(path, offset: range.offset, length: range.length, maxBytes: OutboxLimits.fileBytes, onHead: onHead, onData: onData)
    }
    let asset = loader.makeAsset()

    await #expect(throws: (any Error).self) { _ = try await asset.load(.duration, .isPlayable) }

    #expect(elsewhere.requests.isEmpty, "the redirect was never followed")
    #expect(elsewhere.requests.allSatisfy { !$0.contains("at-secret") })
    #expect(!gateway.requests.isEmpty)
    #expect(gateway.requests.allSatisfy { $0.contains("Authorization: Bearer at-secret") && $0.contains("Range: bytes=") })
    #expect(loader.failure == .refused(status: 302))
  }

  @Test("a gateway that answers ranges is read by the player through the client, a range at a time, with the credential")
  func realRanges() async throws {
    let file = Self.wav(seconds: 2)
    let gateway = try BinaryLoopbackServer { head in BinaryLoopbackServer.ranged(file, head: head) }
    let port = try await gateway.start()
    defer { gateway.stop() }

    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(port)", credentials: BearerOnly(token: "at-secret"), transport: HTTPTransport())
    let attachment = Self.attachment(size: file.count)
    let path = OutboxRoute.path(for: attachment, profile: "writer")
    let loader = OutboxMediaLoader(attachment: attachment, maxBytes: OutboxLimits.fileBytes) { range, onHead, onData in
      try await http.readRange(path, offset: range.offset, length: range.length, maxBytes: OutboxLimits.fileBytes, onHead: onHead, onData: onData)
    }
    let asset = loader.makeAsset()

    let (duration, playable) = try await asset.load(.duration, .isPlayable)

    #expect(playable)
    #expect(duration.seconds > 1.9 && duration.seconds < 2.1)
    #expect(gateway.requests.allSatisfy { $0.contains("Authorization: Bearer at-secret") })
    #expect(gateway.requests.allSatisfy { $0.contains("Range: bytes=") })
    #expect(gateway.requests.first?.contains("GET /api/files/outbox/\(attachment.id)/tone.wav?profile=writer ") == true)
    loader.close()
  }
}

/// Only a bearer token, as a signed-in session sends it.
private struct BearerOnly: CredentialProvider {
  var token: String
  var mode: GatewayAuthMode { .sessionToken }
  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] { ["authorization": "Bearer \(token)"] }
  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan { DialPlan(url: wsURL) }
  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict { .reauth }
  func signOut() async throws {}
}

/// A one-response-per-connection HTTP/1.1 server on 127.0.0.1 whose answers may be bytes (a range of a sound file).
final class BinaryLoopbackServer: Sendable {
  typealias Responder = @Sendable (_ requestHead: String) -> Data

  private final class Log: Sendable {
    let heads = Mutex<[String]>([])
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "BinaryLoopbackServer")
  private let log = Log()

  /// Every request head received (request line and headers).
  var requests: [String] { log.heads.withLock { $0 } }

  init(_ respond: @escaping Responder) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    let log = log
    let queue = queue

    listener.newConnectionHandler = { connection in
      connection.start(queue: queue)
      Self.receive(connection, buffer: Data(), log: log, respond: respond)
    }
  }

  static func reply(status: String, headers: [String] = [], body: Data = Data()) -> Data {
    let head = (["HTTP/1.1 \(status)", "Content-Length: \(body.count)", "Connection: close"] + headers)
      .joined(separator: "\r\n") + "\r\n\r\n"
    return Data(head.utf8) + body
  }

  /// The outbox route's answer to a request head: the range it asks for, or the whole file.
  static func ranged(_ file: Data, head: String) -> Data {
    let line = head.split(separator: "\r\n").first { $0.lowercased().hasPrefix("range: bytes=") }
    guard let line else { return reply(status: "200 OK", headers: ["Content-Type: audio/wav"], body: file) }
    let bounds = line.dropFirst("range: bytes=".count).split(separator: "-", omittingEmptySubsequences: false)
    let first = Int(bounds[0]) ?? 0
    let last = bounds.count > 1 && !bounds[1].isEmpty ? min(Int(bounds[1]) ?? 0, file.count - 1) : file.count - 1
    guard first < file.count, first <= last else { return reply(status: "416 Range Not Satisfiable") }
    return reply(
      status: "206 Partial Content",
      headers: ["Content-Type: audio/wav", "Accept-Ranges: bytes", "Content-Range: bytes \(first)-\(last)/\(file.count)"],
      body: file.subdata(in: first..<(last + 1)))
  }

  func start() async throws -> UInt16 {
    let listener = listener
    let queue = queue

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let once = Mutex(false)

      listener.stateUpdateHandler = { update in
        let claim = {
          once.withLock { done in
            defer { done = true }
            return !done
          }
        }
        switch update {
        case .ready:
          if claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
        case .failed(let error):
          if claim() { continuation.resume(throwing: error) }
        default:
          break
        }
      }

      listener.start(queue: queue)
    }
  }

  func stop() {
    listener.cancel()
  }

  private static func receive(_ connection: NWConnection, buffer: Data, log: Log, respond: @escaping Responder) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      var buffer = buffer
      if let data { buffer.append(data) }

      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        log.heads.withLock { $0.append(head) }
        connection.send(content: respond(head), completion: .contentProcessed { _ in connection.cancel() })
        return
      }

      if isComplete || error != nil {
        connection.cancel()
        return
      }

      receive(connection, buffer: buffer, log: log, respond: respond)
    }
  }
}
