import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// `HTTPPushRelayClient` against a loopback server that speaks the relay's protocol, so what goes
/// over the socket (method, path, headers, body) is what is checked.
@Suite("Push relay client")
struct PushRelayClientTests {
  typealias F = PushFixtures

  static let created = """
    {"handle":"\(F.handle(7))","sendSecret":"\(F.secret("send", 7))","manageSecret":"\(F.secret("manage", 7))","relay":"https://elsewhere.example.test"}
    """

  static func client(_ relay: LoopbackRelay, timeoutMs: Int = 5_000) async throws -> HTTPPushRelayClient {
    let origin = try await relay.start()
    return try #require(HTTPPushRelayClient(origin: origin, timeoutMs: timeoutMs))
  }

  static func body(_ request: RelayRequest) throws -> JSONObject {
    guard case .object(let object) = try JSONValue(parsing: request.body) else {
      throw TimedOut(what: "a JSON object body")
    }

    return object
  }

  @Test("register posts the protocol's body and reads the capability")
  func register() async throws {
    let relay = try LoopbackRelay { _ in .json(201, Self.created) }
    defer { relay.stop() }

    let client = try await Self.client(relay)
    let capability = try await client.register(token: F.tokenA, environment: .production, topic: F.topic)

    #expect(capability == PushCapability(handle: F.handle(7), sendSecret: F.secret("send", 7), manageSecret: F.secret("manage", 7)))

    let request = try #require(relay.requests.first)
    #expect(request.method == "POST")
    #expect(request.path == "/v1/registrations")
    #expect(request.headers["content-type"] == "application/json")
    #expect(request.headers["authorization"] == nil)
    #expect(
      try Self.body(request)
        == ["v": 1, "platform": "apns", "token": .string(F.tokenA.hex), "environment": "production", "topic": .string(F.topic)]
    )
  }

  @Test("the response's relay field never changes the origin a registration is made at")
  func responseRelayIgnored() async throws {
    let relay = try LoopbackRelay { _ in .json(201, Self.created) }
    defer { relay.stop() }

    let client = try await Self.client(relay)
    _ = try await client.register(token: F.tokenA, environment: .sandbox, topic: F.topic)

    #expect(client.origin.hasPrefix("http://127.0.0.1:"))
  }

  @Test("update puts the token with the manage secret as a bearer; delete sends no body")
  func updateAndDelete() async throws {
    let relay = try LoopbackRelay { request in
      request.method == "PUT" ? .json(200, #"{"ok":true}"#) : RelayAnswer(status: 204)
    }
    defer { relay.stop() }

    let client = try await Self.client(relay)
    try await client.update(handle: F.handle(3), manageSecret: F.secret("manage", 3), token: F.tokenB, environment: .sandbox)
    try await client.delete(handle: F.handle(3), manageSecret: F.secret("manage", 3))

    let put = relay.requests[0]
    #expect(put.method == "PUT")
    #expect(put.path == "/v1/registrations/\(F.handle(3))")
    #expect(put.headers["authorization"] == "Bearer \(F.secret("manage", 3))")
    #expect(try Self.body(put) == ["v": 1, "token": .string(F.tokenB.hex), "environment": "sandbox"])

    let delete = relay.requests[1]
    #expect(delete.method == "DELETE")
    #expect(delete.path == "/v1/registrations/\(F.handle(3))")
    #expect(delete.headers["authorization"] == "Bearer \(F.secret("manage", 3))")
    #expect(delete.body.isEmpty)
  }

  @Test("statuses become typed errors", arguments: [
    (404, #"{"error":"not_found"}"#, "", PushRelayError.notFound),
    (429, #"{"error":"rate_limited"}"#, "30", .rateLimited(retryAfterSeconds: 30)),
    (429, #"{"error":"rate_limited"}"#, "", .rateLimited(retryAfterSeconds: nil)),
    (403, #"{"error":"topic_not_allowed"}"#, "", .rejected(status: 403, code: "topic_not_allowed")),
    (401, #"{"error":"unauthorized"}"#, "", .rejected(status: 401, code: "unauthorized")),
    (400, #"{"error":"<script>"}"#, "", .rejected(status: 400, code: "unknown")),
    (503, #"{"error":"busy"}"#, "1", .unavailable(status: 503))
  ])
  func statuses(status: Int, body: String, retryAfter: String, expected: PushRelayError) async throws {
    let relay = try LoopbackRelay { _ in
      .json(status, body, headers: retryAfter.isEmpty ? [:] : ["retry-after": retryAfter])
    }
    defer { relay.stop() }

    let client = try await Self.client(relay)

    await #expect(throws: expected) {
      try await client.update(handle: F.handle(1), manageSecret: F.secret("manage", 1), token: F.tokenA, environment: .sandbox)
    }
  }

  @Test("a 401 or 404 means the capability is lost; a 429 does not")
  func capabilityLost() {
    #expect(PushRelayError.notFound.capabilityLost)
    #expect(PushRelayError.rejected(status: 401, code: "unauthorized").capabilityLost)
    #expect(!PushRelayError.rateLimited(retryAfterSeconds: 1).capabilityLost)
    #expect(!PushRelayError.rejected(status: 400, code: "invalid_request").capabilityLost)
  }

  @Test("a redirect is never followed, so the bearer secret goes nowhere else")
  func redirectRefused() async throws {
    let target = try LoopbackRelay { _ in .json(200, #"{"ok":true}"#) }
    defer { target.stop() }
    let elsewhere = try await target.start()

    let relay = try LoopbackRelay { request in
      RelayAnswer(status: 307, headers: ["location": elsewhere + request.path])
    }
    defer { relay.stop() }

    let client = try await Self.client(relay)

    await #expect(throws: PushRelayError.redirectRefused) {
      try await client.update(handle: F.handle(1), manageSecret: F.secret("manage", 1), token: F.tokenA, environment: .sandbox)
    }
    #expect(target.requests.isEmpty)
  }

  @Test("a malformed or incomplete capability is refused", arguments: [
    "not json",
    #"{"handle":"h_short!","sendSecret":"\#(F.secret("send", 1))","manageSecret":"\#(F.secret("manage", 1))"}"#,
    #"{"handle":"\#(F.handle(1))","sendSecret":"short","manageSecret":"\#(F.secret("manage", 1))"}"#,
    #"{"handle":"\#(F.handle(1))","sendSecret":"\#(F.secret("same", 1))","manageSecret":"\#(F.secret("same", 1))"}"#,
    #"{"handle":"\#(F.handle(1))","sendSecret":"\#(F.secret("send", 1))"}"#
  ])
  func malformedCapability(body: String) async throws {
    let relay = try LoopbackRelay { _ in .json(201, body) }
    defer { relay.stop() }

    let client = try await Self.client(relay)

    await #expect(throws: PushRelayError.invalidResponse) {
      _ = try await client.register(token: F.tokenA, environment: .sandbox, topic: F.topic)
    }
  }

  @Test("a stored handle or secret outside the relay's alphabet is never sent")
  func unsafeCapabilityNotSent() async throws {
    let relay = try LoopbackRelay { _ in RelayAnswer(status: 204) }
    defer { relay.stop() }

    let client = try await Self.client(relay)

    await #expect(throws: PushRelayError.notFound) {
      try await client.delete(handle: "h_../../v1/send", manageSecret: F.secret("manage", 1))
    }
    await #expect(throws: PushRelayError.notFound) {
      try await client.delete(handle: F.handle(1), manageSecret: "bad secret with spaces")
    }
    #expect(relay.requests.isEmpty)
  }

  @Test("no answer within the window is a timeout")
  func timeout() async throws {
    let relay = try LoopbackRelay { _ in
      Thread.sleep(forTimeInterval: 2)
      return RelayAnswer(status: 204)
    }
    defer { relay.stop() }

    let client = try await Self.client(relay, timeoutMs: 100)

    await #expect(throws: PushRelayError.timeout) {
      try await client.delete(handle: F.handle(1), manageSecret: F.secret("manage", 1))
    }
  }

  @Test("an unreachable relay is a network error that names nothing")
  func unreachable() async throws {
    let client = try #require(HTTPPushRelayClient(origin: "http://127.0.0.1:9", timeoutMs: 5_000))

    await #expect(throws: PushRelayError.network) {
      try await client.delete(handle: F.handle(1), manageSecret: F.secret("manage", 1))
    }
  }

  @Test("only https origins, or plain http to loopback for tests", arguments: [
    ("https://push.hermie.dev", "https://push.hermie.dev"),
    ("https://push.hermie.dev/", "https://push.hermie.dev"),
    ("HTTPS://Relay.Example.Test:8443", "https://relay.example.test:8443"),
    ("http://127.0.0.1:4000", "http://127.0.0.1:4000"),
    ("http://localhost:4000", "http://localhost:4000"),
    ("http://relay.example.test", nil),
    ("https://push.hermie.dev/v1", nil),
    ("https://user:pass@push.hermie.dev", nil),
    ("https://push.hermie.dev?x=1", nil),
    ("ftp://push.hermie.dev", nil),
    ("", nil)
  ] as [(String, String?)])
  func origins(origin: String, expected: String?) {
    #expect(PushRelay.validatedOrigin(origin) == expected)
    #expect(HTTPPushRelayClient(origin: origin)?.origin == expected)
  }

  @Test("the default origin is the relay's own constant")
  func defaultOrigin() {
    #expect(HTTPPushRelayClient()?.origin == "https://push.hermie.dev")
  }

  @Test("descriptions and errors never carry a token, a full handle or a secret")
  func redaction() {
    let capability = PushCapability(handle: F.handle(4), sendSecret: F.secret("send", 4), manageSecret: F.secret("manage", 4))
    let address = PushRelayAddress(relay: F.relay, handle: F.handle(4), sendSecret: F.secret("send", 4), platform: "ios", updatedAt: 1)
    let secrets = PushRegistrationSecrets(sendSecret: F.secret("send", 4), manageSecret: F.secret("manage", 4))

    let texts = [
      String(describing: capability), String(reflecting: capability), String(describing: address),
      String(reflecting: address), String(describing: secrets), String(reflecting: secrets),
      String(describing: F.tokenA), String(reflecting: F.tokenA), String(describing: F.registration("g1", handle: F.handle(4)))
    ]

    for text in texts {
      #expect(!text.contains(F.handle(4)))
      #expect(!text.contains(F.secret("send", 4)))
      #expect(!text.contains(F.secret("manage", 4)))
      #expect(!text.contains(F.tokenA.hex))
    }

    var dumped = ""
    dump(capability, to: &dumped)
    dump(F.tokenA, to: &dumped)
    #expect(!dumped.contains(F.secret("manage", 4)))
    #expect(!dumped.contains(F.tokenA.hex))
  }

  @Test("tokens: hex from bytes, length and alphabet checked, fingerprint stable")
  func tokens() {
    #expect(APNsDeviceToken(data: Data([0xAB, 0x01] + Array(repeating: 0, count: 30)))?.hex.hasPrefix("ab01") == true)
    #expect(APNsDeviceToken(hex: "AB" + String(repeating: "0", count: 62))?.hex.hasPrefix("ab") == true)
    #expect(APNsDeviceToken(hex: String(repeating: "a", count: 31)) == nil)
    #expect(APNsDeviceToken(hex: String(repeating: "zz", count: 32)) == nil)
    #expect(APNsDeviceToken(data: Data(count: 8)) == nil)
    #expect(F.tokenA.fingerprint == F.tokenA.fingerprint)
    #expect(F.tokenA.fingerprint != F.tokenB.fingerprint)
    #expect(F.tokenA.fingerprint.count == 64)
  }
}
