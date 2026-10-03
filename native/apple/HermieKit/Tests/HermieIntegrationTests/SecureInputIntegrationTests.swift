#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

private let researcher = "researcher"

@MainActor
private func secureWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a body on the main actor, where the models live.
private func withSecureGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with the researcher's chat open, and the
/// secure input model its screen would hold.
@MainActor
private struct SecureChat {
  let session: GatewaySession
  let model: SecureInputModel

  static func open(_ gateway: FakeGateway, backoff: Duration = .milliseconds(100)) async throws -> SecureChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in backoff }
    let record = GatewayRecord(id: "g-secure", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = SecureChat(session: session, model: SecureInputModel(session: session, bot: researcher))

    await session.start()
    try await secureWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    return chat
  }

  /// Raise a prompt through the fake and wait until the sheet would show it.
  func raise(_ gateway: FakeGateway, _ method: String, _ params: JSONObject) async throws -> String {
    try await gateway.raiseRequest(method, params: params)
    let model = self.model
    try await secureWait("the \(method) prompt") { model.nextToPresent != nil }
    let id = try #require(model.nextToPresent)
    model.present(id)
    return id
  }

  /// The answers the fake logged, as `(id, result as canonical JSON text)`.
  static func answers(_ gateway: FakeGateway) async throws -> [(id: String, result: String)] {
    let state = try await gateway.control("GET", "/__fake/state")
    return (state["serverRequestAnswers"]?.arrayValue ?? []).compactMap { answer in
      guard let id = answer["id"]?.stringValue, let result = answer["result"] else {
        return nil
      }

      return (id, String(decoding: (try? result.canonicalData()) ?? Data(), as: UTF8.self))
    }
  }
}

extension Integration {
  /// The one-string prompts against the real fake gateway, over real sockets.
  @Suite("Secure input") @MainActor
  struct SecureInputIntegrationTests {
    @Test("a secret is answered with the value, byte for byte, and the client said it answers requests")
    func secretReachesTheGateway() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)
        let value = "sk-test \"quoted\" \\ ünïcode ✓"

        let id = try await chat.raise(gateway, "secret", ["env_var": "EXAMPLE_API_KEY", "prompt": "Paste the key"])
        #expect(chat.model.presented?.kind == .secret(envVar: "EXAMPLE_API_KEY", prompt: "Paste the key"))
        #expect(await chat.model.send(SecretValue(value)))

        let answers = try await SecureChat.answers(gateway)
        let expected = String(decoding: try JSONValue.object(["value": .string(value)]).canonicalData(), as: UTF8.self)
        #expect(answers.first { $0.id == id }?.result == expected)

        // `client.capabilities {server_requests: true}` went out before the first request.
        let state = try await gateway.control("GET", "/__fake/state")
        let log = (state["methodLog"]?.arrayValue ?? []).compactMap(\.stringValue)
        #expect(log.contains("client.capabilities"))
        await chat.session.shutdown()
      }
    }

    @Test("Skip sends ''")
    func skipSendsEmpty() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)

        let id = try await chat.raise(gateway, "secret", ["env_var": "K", "prompt": "p"])
        #expect(await chat.model.skip())
        #expect(try await SecureChat.answers(gateway).first { $0.id == id }?.result == #"{"value":""}"#)
        await chat.session.shutdown()
      }
    }

    @Test("sudo is answered with the password, and skipped with ''")
    func sudo() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)

        let first = try await chat.raise(gateway, "sudo", ["command": "apt-get install example"])
        #expect(chat.model.presented?.kind == .sudo(command: "apt-get install example"))
        #expect(chat.model.secondsLeft.map { $0 > 100 && $0 <= 120 } == true)
        #expect(await chat.model.send(SecretValue("pa55 word")))
        #expect(try await SecureChat.answers(gateway).first { $0.id == first }?.result == #"{"value":"pa55 word"}"#)

        let second = try await chat.raise(gateway, "sudo", ["command": "ls"])
        #expect(await chat.model.skip())
        #expect(try await SecureChat.answers(gateway).first { $0.id == second }?.result == #"{"value":""}"#)
        await chat.session.shutdown()
      }
    }

    @Test("a prompt still open at shutdown is answered '' before the socket closes")
    func shutdownAnswersBeforeClosing() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)

        let id = try await chat.raise(gateway, "secret", ["env_var": "K", "prompt": "p"])
        await chat.session.shutdown()

        // The fake logs what it read; give its socket a moment to drain.
        let deadline = ContinuousClock.now + .seconds(5)
        var answer: String?
        while answer == nil, ContinuousClock.now < deadline {
          answer = try await SecureChat.answers(gateway).first { $0.id == id }?.result
          try await Task.sleep(for: .milliseconds(20))
        }
        #expect(answer == #"{"value":""}"#)
      }
    }

    @Test("a withdrawn prompt closes the sheet's prompt with a notice, and nothing is sent")
    func withdrawn() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)
        let model = chat.model

        let id = try await chat.raise(gateway, "vault.unlock_prompt", ["backend": "example", "display_name": "Example Vault"])
        _ = try await gateway.control("POST", "/__fake/withdraw-requests", body: ["reason": "timeout"])
        try await secureWait("the prompt to close") { model.presented == nil }
        #expect(model.presentedOutcome == .expired)
        #expect(await model.send(SecretValue("too late")) == false)
        #expect(try await SecureChat.answers(gateway).contains { $0.id == id } == false)
        await chat.session.shutdown()
      }
    }

    @Test("a prompt the gateway withdrew while the socket was down closes after the reconnect, and nothing is sent")
    func withdrawnWhileDown() async throws {
      try await withSecureGateway { gateway in
        // A reconnect waits a minute unless asked to dial: the gateway withdraws
        // the request while this client has no socket at all.
        let chat = try await SecureChat.open(gateway, backoff: .seconds(60))
        let model = chat.model
        let session = chat.session

        let id = try await chat.raise(gateway, "sudo", ["command": "ls"])

        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await secureWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }
        let withdrawn = try await gateway.control("POST", "/__fake/withdraw-requests", body: ["reason": "timeout"])
        #expect(withdrawn["withdrawn"] == 1)
        #expect(model.presented?.id == id, "the client heard nothing: the sheet is still up")

        // The resume leaves the now empty list out, as the gateway does, so it is
        // the replay's `open_requests: []` that closes it ("lapsed", not the
        // cancel's "expired").
        await session.retryNow()
        try await secureWait("the prompt to close") { model.presented == nil }
        #expect(model.presentedOutcome == .lapsed)
        #expect(await model.send(SecretValue("too late")) == false)
        #expect(try await SecureChat.answers(gateway).contains { $0.id == id } == false)
        await session.shutdown()
      }
    }

    @Test("a request this app cannot show is refused -32601, never answered '', and noted on the chat")
    func unsupported() async throws {
      try await withSecureGateway { gateway in
        let chat = try await SecureChat.open(gateway)
        let model = chat.model

        try await gateway.raiseRequest("terminal.read", params: [:])
        try await secureWait("the notice") { model.notice != nil }
        #expect(model.notice?.notice == .unsupported(method: "terminal.read"))

        let state = try await gateway.control("GET", "/__fake/state")
        let logged = (state["serverRequestAnswers"]?.arrayValue ?? []).first { $0["method"] == "terminal.read" }
        #expect(logged?["error"]?["code"] == -32601)
        #expect(logged?["error"]?["message"] == "not supported by this client: terminal.read")
        #expect(logged?["result"] == nil)
        await chat.session.shutdown()
      }
    }
  }
}
#endif
