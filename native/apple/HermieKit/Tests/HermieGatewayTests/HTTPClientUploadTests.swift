import Foundation
import Synchronization
import Testing

@testable import HermieGateway

/// `POST /api/files/upload-stream`: the file's one road to the gateway, held to the rules every
/// authenticated call is (a redirect is refused, a 401 refreshes once) and to what the app tells
/// the reader about a refusal.
@Suite(.serialized) struct HTTPClientUploadTests {
  static let base = "http://gateway.test"
  static let target = "/work/space/uploads/hermie/2026-10-03/abc12345-notes.txt"

  /// A file with a body worth finding in the request.
  private func file(_ text: String = "the bytes of the file") throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("upload-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("notes.txt")
    try Data(text.utf8).write(to: url)
    return url
  }

  private func upload(_ http: HTTPClient, _ url: URL, onProgress: (@Sendable (Double) -> Void)? = nil) async throws -> String {
    try await http.uploadFile(from: url, name: "notes.txt", mimeType: "text/plain", to: Self.target, onProgress: onProgress)
  }

  @Test("the file goes as the three form fields upload_managed_file_stream declares, and the resolved path comes back")
  func fields() async throws {
    let server = StubServer { _ in
      .json("{\"ok\":true,\"path\":\"/real/home/work/space/notes.txt\"}", headers: ["content-type": "application/json"])
    }
    let http = try HTTPClient(
      baseURL: Self.base, credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      transport: server.transport())

    let stored = try await upload(http, try file())

    #expect(stored == "/real/home/work/space/notes.txt", "the path the gateway resolved wins over the one asked for")
    let request = try #require(server.requests.first)
    #expect(request.method == "POST")
    #expect(request.path == "/api/files/upload-stream")
    #expect(request.header("authorization") == "Bearer at-1")
    #expect(request.header("content-type")?.hasPrefix("multipart/form-data; boundary=") == true)
    #expect(request.bodyText.contains("name=\"path\"\r\n\r\n\(Self.target)"))
    #expect(request.bodyText.contains("name=\"overwrite\"\r\n\r\ntrue"))
    #expect(request.bodyText.contains("name=\"file\"; filename=\"notes.txt\""))
    #expect(request.bodyText.contains("the bytes of the file"))
  }

  @Test("a refusal's own words ride on the error, and a 413 says so by its status")
  func refusals() async throws {
    let server = StubServer { request in
      request.bodyText.contains("huge") ? .json("{\"detail\":\"File is too large\"}", status: 413) : .json("{\"detail\":\"Path must be absolute\"}", status: 400)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    let large = await gatewayError { try await upload(http, try file("huge")) }
    #expect(large?.status == 413)
    #expect(large?.kind == .protocol)
    #expect(large?.hint == "File is too large")

    let relative = await gatewayError { try await upload(http, try file()) }
    #expect(relative?.status == 400)
    #expect(relative?.hint == "Path must be absolute")
  }

  @Test("a 5xx is a server error and says nothing of the body")
  func serverError() async throws {
    let server = StubServer { _ in .text("<html>bad gateway</html>", status: 502) }
    let http = try HTTPClient(baseURL: Self.base, credentials: AnonymousCredentials(), transport: server.transport())

    let error = await gatewayError { try await upload(http, try file()) }

    #expect(error?.kind == .server)
    #expect(error?.status == 502)
  }

  @Test("a 401 asks the provider once and sends the file again, whole, with the fresh token")
  func unauthorizedRetriesOnce() async throws {
    let credentials = HTTPClientBehaviourTests.RotatingCredentials(verdict: .retry)
    let server = StubServer { request in
      request.header("authorization") == "Bearer at-2" ? .json("{\"ok\":true}") : .text("", status: 401)
    }
    let http = try HTTPClient(baseURL: Self.base, credentials: credentials, transport: server.transport())

    let stored = try await upload(http, try file())

    #expect(stored == Self.target, "no path in the answer: the one asked for stands")
    #expect(await credentials.rejected == ["at-1"])
    #expect(server.requests.map { $0.header("authorization") } == ["Bearer at-1", "Bearer at-2"])
    #expect(server.requests.allSatisfy { $0.bodyText.contains("the bytes of the file") }, "the retry carries the file too")
  }

  @Test("a second 401 is an auth error, and the file is not sent a third time")
  func secondUnauthorized() async throws {
    let server = StubServer { _ in .text("", status: 401) }
    let http = try HTTPClient(
      baseURL: Self.base, credentials: HTTPClientBehaviourTests.RotatingCredentials(verdict: .retry), transport: server.transport())

    let error = await gatewayError { try await upload(http, try file()) }

    #expect(error?.kind == .auth)
    #expect(error?.status == 401)
    #expect(server.requests.count == 2)
  }

  @Test("a 401 the provider cannot answer is a sign-in-again error, and nothing is retried")
  func reauth() async throws {
    let server = StubServer { _ in .text("", status: 401) }
    let http = try HTTPClient(
      baseURL: Self.base, credentials: HTTPClientBehaviourTests.RotatingCredentials(verdict: .reauth), transport: server.transport())

    let error = await gatewayError { try await upload(http, try file()) }

    #expect(error?.kind == .auth)
    #expect(server.requests.count == 1)
  }

  @Test("a redirect is refused: the credential and the file stay with the gateway")
  func redirectIsRefused() async throws {
    let elsewhere = try LoopbackHTTPServer { _ in RealListenerRedirectTests.reply(status: "200 OK", body: "{\"stolen\":true}") }
    let elsewherePort = try await elsewhere.start()
    let gateway = try LoopbackHTTPServer { _ in
      RealListenerRedirectTests.reply(
        status: "307 Temporary Redirect", headers: ["Location: http://localhost:\(elsewherePort)/api/files/upload-stream"])
    }
    let gatewayPort = try await gateway.start()
    defer {
      gateway.stop()
      elsewhere.stop()
    }

    let http = try HTTPClient(
      baseURL: "http://127.0.0.1:\(gatewayPort)",
      credentials: AnonymousCredentials(headers: ["authorization": "Bearer at-1"]),
      transport: HTTPTransport())

    let error = await gatewayError { try await upload(http, try file()) }

    #expect(error?.kind == .redirect)
    #expect(error?.redirectedOrigin == "http://localhost:\(elsewherePort)")
    #expect(gateway.requests.count == 1, "asked once")
    #expect(elsewhere.requests.isEmpty, "nothing, not the bearer and not the file, went where it pointed")
  }
}
