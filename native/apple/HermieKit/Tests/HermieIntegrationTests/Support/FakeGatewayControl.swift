#if os(macOS)
import Foundation
import HermieProtocol

/// The fake's control surface (`/__fake/*`): not part of the gateway contract,
/// and never reached through the client under test. These go out over a plain
/// `URLSession` of their own, so a bug in `HTTPTransport` cannot hide behind
/// the very calls that set a test up.
extension FakeGateway {
  /// A turn somebody else ran, for `POST /__fake/inject`.
  struct Injection: Sendable {
    var profile = "researcher"
    var user = "Message from 🤖 Writer (@writer): the draft is ready."
    var assistant = "Noted — I will fold that in."
    /// Streamed to connected sockets frame by frame; `false` lands it at once.
    var stream = false
    /// The HERM-83 author stamp (`display_metadata.author`).
    var author: (id: String, name: String?)?
    /// A stored or runtime session id; `nil` is the profile's Bot Chat.
    var sessionID: String?
    /// `error` with `error` set stages a failed turn.
    var status: String?
    var error: String?

    var json: JSONValue {
      var body: JSONObject = [
        "profile": .string(profile),
        "user": .string(user),
        "assistant": .string(assistant),
        "stream": .bool(stream)
      ]
      if let author {
        var stamp: JSONObject = ["id": .string(author.id)]
        if let name = author.name { stamp["name"] = .string(name) }
        body["author"] = .object(stamp)
      }
      if let sessionID { body["session_id"] = .string(sessionID) }
      if let status { body["status"] = .string(status) }
      if let error { body["error"] = .string(error) }
      return .object(body)
    }
  }

  struct Injected: Sendable, Equatable {
    /// The runtime id, as the socket names the session.
    var sessionID: String
    /// The stored id, as REST history names it.
    var storedSessionID: String
  }

  /// `POST /__fake/inject`.
  @discardableResult
  func inject(_ injection: Injection = Injection()) async throws -> Injected {
    let body = try await control("POST", "/__fake/inject", body: injection.json)

    return Injected(
      sessionID: body["session_id"]?.stringValue ?? "",
      storedSessionID: body["stored_session_id"]?.stringValue ?? ""
    )
  }

  struct RaisedRequest: Sendable, Equatable {
    var method: String
    var sessionID: String
  }

  /// `POST /__fake/request`: raise a server→client request (`clarify`,
  /// `approval`, …) on the profile's Bot Chat. Answers once raised, not once answered.
  @discardableResult
  func raiseRequest(_ method: String, profile: String = "researcher", params: JSONObject = [:]) async throws
    -> RaisedRequest
  {
    let body = try await control(
      "POST",
      "/__fake/request",
      body: .object(["profile": .string(profile), "method": .string(method), "params": .object(params)])
    )

    return RaisedRequest(method: body["raised"]?.stringValue ?? "", sessionID: body["session_id"]?.stringValue ?? "")
  }

  /// `POST /__fake/usage`: stage what the usage calls answer: a profile's days (`days`), the Nous balance
  /// (`bars`), the provider account lines `session.usage` carries (`accountLines`), the providers
  /// `account.usage` answers with (`account`), a gateway with no `account.usage` (`accountUnsupported`), a
  /// gateway with none of it (`unsupported`), or `clear` to take it all back.
  @discardableResult
  func stageUsage(_ fields: JSONObject) async throws -> JSONValue {
    try await control("POST", "/__fake/usage", body: .object(fields))
  }

  /// `GET /__fake/usage`: what `account.usage` was asked, oldest first: `{profile: String?, refresh: Bool}` each.
  func accountUsageCalls() async throws -> [(profile: String?, refresh: Bool)] {
    let body = try await control("GET", "/__fake/usage")

    return (body["accountCalls"]?.arrayValue ?? []).map { call in
      (call["profile"]?.stringValue, call["refresh"] == .bool(true))
    }
  }

  /// `POST /__fake/stop-all`: stage what `session.interrupt_all` answers beyond the sessions it stops
  /// (`notAllowed`, `failed`), a gateway without the method (`unsupported`), or `clear`.
  @discardableResult
  func stageStopAll(_ fields: JSONObject) async throws -> JSONValue {
    try await control("POST", "/__fake/stop-all", body: .object(fields))
  }

  /// `GET /__fake/push`: the push section as the gateway holds it.
  func pushSection() async throws -> JSONValue {
    try await control("GET", "/__fake/push")
  }

  /// `POST /__fake/push` `registrations`: replace who is registered for push.
  func setPushRegistrations(_ registrations: JSONObject, seen: JSONObject = [:]) async throws {
    try await control(
      "POST",
      "/__fake/push",
      body: .object(["action": .string("registrations"), "registrations": .object(registrations), "seen": .object(seen)])
    )
  }

  /// `POST /__fake/push` with one of the events ADR-0017 names (`cron`, `dm`, `approval`).
  @discardableResult
  func pushEvent(_ action: String, _ fields: JSONObject = [:]) async throws -> JSONValue {
    var body = fields
    body["action"] = .string(action)
    return try await control("POST", "/__fake/push", body: .object(body))
  }

  /// One control call. Anything but a 2xx is an error that names the path and the body.
  @discardableResult
  func control(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> JSONValue {
    let (status, text) = try await FakeGateway.plainRequest(method, baseURL + path, body: body)

    guard (200...299).contains(status) else {
      throw FakeGatewayError.control(path: path, status: status, body: text)
    }

    return try JSONValue(parsing: text)
  }

  /// A request outside the client under test: no redirects followed, no
  /// cookies, no cache. Answers the status and the body as text.
  static func plainRequest(
    _ method: String,
    _ url: String,
    headers: [String: String] = [:],
    body: JSONValue? = nil
  ) async throws -> (status: Int, text: String) {
    let (status, text, _) = try await plainResponse(method, url, headers: headers, body: body)
    return (status, text)
  }

  /// `plainRequest`, with the response headers (lowercased names).
  static func plainResponse(
    _ method: String,
    _ url: String,
    headers: [String: String] = [:],
    body: JSONValue? = nil
  ) async throws -> (status: Int, text: String, headers: [String: String]) {
    guard let target = URL(string: url) else {
      throw URLError(.badURL)
    }

    var request = URLRequest(url: target)
    request.httpMethod = method
    request.timeoutInterval = 30

    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }

    if let body {
      request.httpBody = try body.canonicalData()
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }

    let (data, response) = try await controlSession.data(for: request, delegate: NoRedirects.shared)
    let http = response as? HTTPURLResponse
    var fields: [String: String] = [:]

    for (name, value) in http?.allHeaderFields ?? [:] {
      if let name = name as? String, let value = value as? String {
        fields[name.lowercased()] = value
      }
    }

    return (http?.statusCode ?? 0, String(decoding: data, as: UTF8.self), fields)
  }

  private static let controlSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    return URLSession(configuration: configuration)
  }()
}

/// Answer a redirect as the response itself: the test reads `location`.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  static let shared = NoRedirects()

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
#endif
