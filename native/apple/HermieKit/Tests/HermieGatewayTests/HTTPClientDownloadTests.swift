import CryptoKit
import Foundation
import Synchronization
import Testing

@testable import HermieGateway

/// `HTTPClient.downloadFile`: a file of the gateway on disk, as it arrives, held to the rules every
/// authenticated call is (a redirect is refused, a 401 refreshes once) and to the caps and checks a shared
/// file needs (`contract/outbox/`).
@Suite(.serialized) struct HTTPClientDownloadTests {
  static let base = "http://gateway.test"
  static let route = "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/clip.mp4?profile=writer"

  static func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  /// A fresh place for one downloaded file.
  static func destination() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("download-tests-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent("clip.mp4")
  }

  static func body(_ count: Int) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 7) })
  }

  @Test("the bytes land in the file, with their size and SHA-256, and the request is the route with the credential")
  func arrives() async throws {
    let bytes = Self.body(50_000)
    let server = StubServer { _ in .respond(status: 200, body: bytes, headers: ["content-length": "50000"]) }
    let http = try HTTPClient(
      baseURL: Self.base, credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      extraHeaders: ["x-front-door": "door"], transport: server.transport())
    let destination = Self.destination()

    let result = try await http.downloadFile(
      Self.route, to: destination, maxBytes: 1_000_000, expectedSize: 50_000, expectedSHA256: Self.sha(bytes))

    #expect(result.url == destination)
    #expect(result.bytes == 50_000)
    #expect(result.sha256 == Self.sha(bytes))
    #expect(try Data(contentsOf: destination) == bytes)

    let request = try #require(server.requests.first)
    #expect(request.method == "GET")
    #expect(request.path == "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/clip.mp4")
    #expect(request.url.hasSuffix("?profile=writer"))
    #expect(request.header("authorization") == "Bearer at-1")
    #expect(request.header("x-front-door") == "door")
    #expect(request.handlesCookies == false, "no cookie goes with a download: the native credential is the header")
  }

  @Test("progress runs from nothing to the whole, upwards, and is called with the total known")
  func progress() async throws {
    let bytes = Self.body(10_000)
    let server = StubServer { _ in .respond(status: 200, body: bytes, headers: ["content-length": "10000"]) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let seen = Mutex<[Double]>([])

    _ = try await http.downloadFile(Self.route, to: Self.destination(), maxBytes: 1_000_000) { fraction in
      seen.withLock { $0.append(fraction) }
    }

    let fractions = seen.withLock { $0 }
    #expect(fractions.last == 1)
    #expect(fractions == fractions.sorted())
    #expect(fractions.allSatisfy { $0 > 0 && $0 <= 1 })
  }

  @Test("a 404 is not found, a 500 is a refusal with its status, and neither leaves a file")
  func refusals() async throws {
    for (status, expected) in [(404, FileDownloadError.notFound), (500, .refused(status: 500)), (403, .refused(status: 403))] {
      let server = StubServer { _ in .json("{\"detail\":\"no\"}", status: status) }
      let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
      let destination = Self.destination()

      await #expect(throws: FileDownloadError.self) {
        _ = try await http.downloadFile(Self.route, to: destination, maxBytes: 1_000_000)
      }
      do {
        _ = try await http.downloadFile(Self.route, to: destination, maxBytes: 1_000_000)
      } catch {
        #expect((error as? FileDownloadError) == expected, "status \(status)")
      }
      #expect(!FileManager.default.fileExists(atPath: destination.path))
    }
  }

  @Test("a file announced larger than the cap is refused before a byte is kept")
  func announcedOverTheCap() async throws {
    let server = StubServer { _ in .respond(status: 200, body: Self.body(5000), headers: ["content-length": "5000"]) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let destination = Self.destination()

    do {
      _ = try await http.downloadFile(Self.route, to: destination, maxBytes: 4999)
      Issue.record("a file over the cap was taken")
    } catch {
      #expect((error as? FileDownloadError) == .tooLarge)
    }
    #expect(!FileManager.default.fileExists(atPath: destination.path))
  }

  @Test("a body that runs past the cap is cut off as it arrives, whatever it announced, and removed")
  func streamedOverTheCap() async throws {
    // No Content-Length and the connection closing at the end: only the bytes can say how long it is.
    let body = String(repeating: "a", count: 200_000)
    let server = try LoopbackHTTPServer { _ in
      "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + body
    }
    let port = try await server.start()
    defer { server.stop() }
    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(port)", credentials: AnonymousCredentials(), transport: HTTPTransport())
    let destination = Self.destination()

    do {
      _ = try await http.downloadFile(Self.route, to: destination, maxBytes: 100_000)
      Issue.record("a body over the cap was taken")
    } catch {
      #expect((error as? FileDownloadError) == .tooLarge)
    }
    #expect(!FileManager.default.fileExists(atPath: destination.path))
  }

  @Test("a body that is not the size or the SHA-256 it was said to be is removed and called corrupt")
  func corrupt() async throws {
    let bytes = Self.body(2000)
    let server = StubServer { _ in .respond(status: 200, body: bytes, headers: ["content-length": "2000"]) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    for (size, digest) in [(1999, Self.sha(bytes)), (2000, String(repeating: "0", count: 64))] {
      let destination = Self.destination()
      do {
        _ = try await http.downloadFile(
          Self.route, to: destination, maxBytes: 1_000_000, expectedSize: size, expectedSHA256: digest)
        Issue.record("a file that is not what was announced was kept")
      } catch {
        #expect((error as? FileDownloadError) == .corrupt)
      }
      #expect(!FileManager.default.fileExists(atPath: destination.path))
    }
  }

  @Test("a digest in capitals is the same digest")
  func digestCase() async throws {
    let bytes = Self.body(100)
    let server = StubServer { _ in .respond(status: 200, body: bytes, headers: [:]) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let result = try await http.downloadFile(
      Self.route, to: Self.destination(), maxBytes: 1_000, expectedSHA256: Self.sha(bytes).uppercased())
    #expect(result.sha256 == Self.sha(bytes))
  }

  @Test("a 401 asks the provider once and fetches again with the fresh token; a second is not retried")
  func unauthorized() async throws {
    let bytes = Self.body(100)
    let credentials = HTTPClientBehaviourTests.RotatingCredentials(verdict: .retry)
    let server = StubServer { request in
      request.header("authorization") == "Bearer at-2"
        ? .respond(status: 200, body: bytes, headers: [:]) : .text("", status: 401)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: credentials, transport: server.transport())

    let result = try await http.downloadFile(Self.route, to: Self.destination(), maxBytes: 1_000)

    #expect(result.bytes == 100)
    #expect(await credentials.rejected == ["at-1"])
    #expect(server.requests.map { $0.header("authorization") } == ["Bearer at-1", "Bearer at-2"])

    let always = StubServer { _ in .text("", status: 401) }
    let stubborn = try HTTPClient(
      baseURL: Self.base, credentials: HTTPClientBehaviourTests.RotatingCredentials(verdict: .retry),
      transport: always.transport())
    do {
      _ = try await stubborn.downloadFile(Self.route, to: Self.destination(), maxBytes: 1_000)
      Issue.record("a refused credential was taken for a file")
    } catch {
      #expect((error as? FileDownloadError) == .unauthorized)
    }
    #expect(always.requests.count == 2)
  }

  @Test("a 401 the provider cannot answer is not retried")
  func reauth() async throws {
    let server = StubServer { _ in .text("", status: 401) }
    let http = try HTTPClient(
      baseURL: Self.base, credentials: HTTPClientBehaviourTests.RotatingCredentials(verdict: .reauth),
      transport: server.transport())

    do {
      _ = try await http.downloadFile(Self.route, to: Self.destination(), maxBytes: 1_000)
      Issue.record("a refused credential was taken for a file")
    } catch {
      #expect((error as? FileDownloadError) == .unauthorized)
    }
    #expect(server.requests.count == 1)
  }

  @Test("a redirect is refused: the credential stays with the gateway")
  func redirect() async throws {
    let elsewhere = try LoopbackHTTPServer { _ in RealListenerRedirectTests.reply(status: "200 OK", body: "stolen") }
    let elsewherePort = try await elsewhere.start()
    let gateway = try LoopbackHTTPServer { _ in
      RealListenerRedirectTests.reply(
        status: "307 Temporary Redirect", headers: ["Location: http://localhost:\(elsewherePort)/x"])
    }
    let gatewayPort = try await gateway.start()
    defer {
      gateway.stop()
      elsewhere.stop()
    }
    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(gatewayPort)",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]), transport: HTTPTransport())
    let destination = Self.destination()

    do {
      _ = try await http.downloadFile(Self.route, to: destination, maxBytes: 1_000)
      Issue.record("a redirect was followed")
    } catch {
      #expect((error as? FileDownloadError) == .refused(status: 307))
    }
    #expect(elsewhere.requests.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: destination.path))
  }

  @Test("a gateway that cannot be reached is unreachable")
  func unreachable() async throws {
    let server = StubServer { _ in .urlError(.cannotConnectToHost) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    do {
      _ = try await http.downloadFile(Self.route, to: Self.destination(), maxBytes: 1_000)
      Issue.record("a download came from nowhere")
    } catch {
      #expect((error as? FileDownloadError) == .unreachable)
    }
  }

  @Test("cancelling the task ends the request and leaves no file")
  func cancelled() async throws {
    let server = StubServer { _ in .hang }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())
    let destination = Self.destination()

    let task = Task { try await http.downloadFile(Self.route, to: destination, maxBytes: 1_000) }
    await waitUntil { !server.requests.isEmpty }
    task.cancel()

    do {
      _ = try await task.value
      Issue.record("a download that was cancelled finished")
    } catch {
      #expect(error is CancellationError)
    }
    #expect(!FileManager.default.fileExists(atPath: destination.path))
  }
}
