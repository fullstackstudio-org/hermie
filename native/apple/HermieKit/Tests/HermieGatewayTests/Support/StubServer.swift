import Foundation
import Synchronization

@testable import HermieGateway

/// One request as the stub saw it, with the routing header taken back out.
struct StubRequest: Sendable {
  var method: String
  var url: String
  /// Header names lowercased.
  var headers: [String: String]
  var body: Data
  var cachePolicy: URLRequest.CachePolicy
  var handlesCookies: Bool

  var path: String { URL(string: url)?.path() ?? "" }
  var scheme: String { URL(string: url)?.scheme ?? "" }
  var host: String { URL(string: url)?.host() ?? "" }
  var bodyText: String { String(decoding: body, as: UTF8.self) }

  func header(_ name: String) -> String? { headers[name.lowercased()] }
}

/// What the stub does with one request.
enum StubReply: Sendable {
  case respond(status: Int, body: Data, headers: [String: String])
  /// Fail the way `URLSession` does when nothing answers, with this error.
  case fail(any Error & Sendable)
  /// A 3xx pointing at `location`.
  case redirect(status: Int, location: String)
  /// Never answer; only a cancellation ends it.
  case hang

  static func json(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> StubReply {
    .respond(status: status, body: Data(text.utf8), headers: headers)
  }

  static func text(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> StubReply {
    .respond(status: status, body: Data(text.utf8), headers: headers)
  }

  static func status(_ status: Int) -> StubReply {
    .respond(status: status, body: Data(), headers: [:])
  }

  /// An error carrying `message` as its description, like a platform failure.
  static func failing(_ message: String) -> StubReply {
    .fail(NSError(domain: "StubURLProtocol", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
  }

  static func urlError(_ code: URLError.Code) -> StubReply {
    .fail(URLError(code))
  }
}

/// A fake server behind a stubbed `URLProtocol`: every request a session it
/// made sends is answered by `handler` and recorded.
///
/// Tests run in parallel, so each server routes by an id the session adds as a
/// header, never by a global handler.
final class StubServer: Sendable {
  typealias Handler = @Sendable (StubRequest) -> StubReply

  static let routingHeader = "X-Stub-Server"

  let id = UUID().uuidString
  private let state: Mutex<(handler: Handler, requests: [StubRequest])>

  init(_ handler: @escaping Handler) {
    state = Mutex((handler, []))
    StubRegistry.register(self)
  }

  /// Answer by path; anything unrouted is a 404.
  convenience init(routes: [String: StubReply]) {
    self.init { request in routes[request.path] ?? .text("not found", status: 404) }
  }

  /// Every request seen so far, oldest first.
  var requests: [StubRequest] { state.withLock { $0.requests } }

  func setHandler(_ handler: @escaping Handler) {
    state.withLock { $0.handler = handler }
  }

  fileprivate func answer(_ request: StubRequest) -> StubReply {
    state.withLock { state in
      state.requests.append(request)
      return state.handler
    }(request)
  }

  /// A session whose requests reach this server and nothing else.
  func session() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    configuration.httpAdditionalHeaders = [Self.routingHeader: id]
    return HTTPTransport.makeSession(configuration: configuration)
  }

  /// A transport over `session()` with the given clock.
  func transport(clock: any Clock<Duration> = ContinuousClock()) -> HTTPTransport {
    HTTPTransport(session: session(), clock: clock)
  }
}

/// Every server a test made, by id. Kept for the life of the test process: a
/// handful of small objects, and no weak box to argue about.
private enum StubRegistry {
  private static let servers = Mutex<[String: StubServer]>([:])

  static func register(_ server: StubServer) {
    servers.withLock { $0[server.id] = server }
  }

  static func server(_ id: String) -> StubServer? {
    servers.withLock { $0[id] }
  }
}

final class StubURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }

    guard let id = request.value(forHTTPHeaderField: StubServer.routingHeader), let server = StubRegistry.server(id)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }

    var headers: [String: String] = [:]

    for (name, value) in request.allHTTPHeaderFields ?? [:] where name.caseInsensitiveCompare(StubServer.routingHeader) != .orderedSame {
      headers[name.lowercased()] = value
    }

    let seen = StubRequest(
      method: request.httpMethod ?? "GET",
      url: url.absoluteString,
      headers: headers,
      body: request.httpBody ?? Self.read(request.httpBodyStream),
      cachePolicy: request.cachePolicy,
      handlesCookies: request.httpShouldHandleCookies
    )

    switch server.answer(seen) {
    case .respond(let status, let body, let replyHeaders):
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: replyHeaders)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    case .fail(let error):
      client?.urlProtocol(self, didFailWithError: error)
    case .redirect(let status, let location):
      let target = URL(string: location, relativeTo: url)!.absoluteURL
      let response = HTTPURLResponse(
        url: url,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["Location": target.absoluteString]
      )!
      var next = request
      next.url = target
      client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
      // When the delegate refuses the redirect, the 3xx itself is the answer.
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data())
      client?.urlProtocolDidFinishLoading(self)
    case .hang:
      break
    }
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream?) -> Data {
    guard let stream else {
      return Data()
    }

    stream.open()
    defer { stream.close() }

    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)

    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)

      guard count > 0 else {
        break
      }

      data.append(buffer, count: count)
    }

    return data
  }
}
