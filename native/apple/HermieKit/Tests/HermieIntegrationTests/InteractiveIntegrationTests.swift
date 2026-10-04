#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

private let researcher = "researcher"

@MainActor
private func interactiveWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
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
private func withInteractiveGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with the researcher's chat open, and the interactive model its
/// screen would hold.
@MainActor
private struct InteractiveChat {
  let session: GatewaySession
  let model: InteractiveModel

  /// `requests`: the methods this session announces; `nil` for the device's own list.
  static func open(_ gateway: FakeGateway, requests: [String]? = nil) async throws -> InteractiveChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }

    if let requests {
      options.requests = requests
    }

    let record = GatewayRecord(id: "g-interactive", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = InteractiveChat(session: session, model: InteractiveModel(session: session, bot: researcher))

    await session.start()
    try await interactiveWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    // The second `client.capabilities` call goes out after `gateway.ready`: wait until the
    // gateway took the methods, as it hides a request from a connection that did not advertise it.
    try await interactiveWait("the methods to be accepted") {
      let state = try await gateway.control("GET", "/__fake/state")
      return (state["clientCapabilities"]?.arrayValue ?? []).contains { !($0["requests"]?.arrayValue ?? []).isEmpty }
    }
    return chat
  }

  /// Raise a request through the fake and wait until the sheet would show it. The id the gateway
  /// gave it.
  func raise(_ gateway: FakeGateway, _ method: String, _ params: JSONObject = [:]) async throws -> String {
    let raised = try await gateway.control(
      "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": .string(method), "params": .object(params)]))
    let id = try #require(raised["id"]?.stringValue)
    let model = self.model
    try await interactiveWait("the \(method) request") { model.openPrompts.contains { $0.id == id } }
    model.present(id)
    return id
  }

  /// What the fake holds of one request: `{open, answer?, outcome?, error?, reason?, refusals}`.
  static func view(_ gateway: FakeGateway, _ id: String) async throws -> JSONValue {
    try await gateway.control("GET", "/__fake/request/\(id)")
  }
}

extension Integration {
  /// The interactive requests against the real fake gateway, over real sockets.
  @Suite("Interactive requests") @MainActor
  struct InteractiveIntegrationTests {
    private static let fields: JSONValue = [
      ["id": "name", "kind": "text", "label": "Name on the booking", "required": true, "max_length": 20],
      ["id": "guests", "kind": "number", "label": "Guests", "integer": true, "min": 1, "max": 12]
    ]

    @Test("the client advertises the methods, and a raised form reaches the center and the chat's transcript")
    func formReachesTheCenter() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields, "title": "Hotel booking"])

        let state = try await gateway.control("GET", "/__fake/state")
        let last = try #require(state["clientCapabilities"]?.arrayValue?.last)
        #expect(last["server_requests"] == true)
        #expect(last["requests"] == ["input.form", "input.file", "review.draft"])

        let presented = try #require(chat.model.presented)
        #expect(presented.id == id)
        #expect(presented.title == "Hotel booking")
        guard case .form(let params) = presented.body else {
          Issue.record("not a form")
          return
        }
        #expect(params.fields?.map(\.id) == ["name", "guests"])
        #expect(chat.model.secondsLeft.map { $0 > 250 && $0 <= 300 } == true, "from expires_at")

        // The fake saw nobody refuse it.
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["open"] == true)
        #expect(view["outcome"] == nil)

        await chat.session.shutdown()
      }
    }

    @Test("a form answered through the model reaches the gateway, which accepts it")
    func answersAForm() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        #expect(await chat.model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"]?["status"] == "answered")
        #expect(view["answer"]?["values"] == ["name": "Ada Lovelace", "guests": 2])
        #expect(view["refusals"] == [])
        #expect(chat.model.presentedID == nil)
        await chat.session.shutdown()
      }
    }

    @Test("a draft approved with an edit reaches the gateway with its text; one rejected with a comment too")
    func answersADraft() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)

        let first = try await chat.raise(gateway, "review.draft", ["text": "Hi Bram,\n\nSee you Friday.", "editable": true])
        #expect(await chat.model.answer(.approve(text: "Hi Bram,\n\nSee you Saturday.")))
        let approved = try await InteractiveChat.view(gateway, first)
        #expect(approved["outcome"] == "answered")
        #expect(approved["answer"]?["decision"] == "approved")
        #expect(approved["answer"]?["text"] == "Hi Bram,\n\nSee you Saturday.")
        #expect(approved["answer"]?["edited"] == true)

        let second = try await chat.raise(gateway, "review.draft", ["text": "Hello"])
        #expect(await chat.model.answer(.reject(comment: "too short")))
        let rejected = try await InteractiveChat.view(gateway, second)
        #expect(rejected["answer"]?["decision"] == "rejected")
        #expect(rejected["answer"]?["comment"] == "too short")
        await chat.session.shutdown()
      }
    }

    @Test("Skip answers {status: skipped}; the sheet that cannot go on answers 4041 with its reason")
    func skipAndCannotShow() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)

        let skipped = try await chat.raise(gateway, "input.form", ["fields": Self.fields, "optional": true])
        #expect(await chat.model.skip())
        let skippedView = try await InteractiveChat.view(gateway, skipped)
        #expect(skippedView["outcome"] == "answered")
        #expect(skippedView["answer"]?["status"] == "skipped")

        let declined = try await chat.raise(gateway, "input.file")
        #expect(await chat.model.cannotShow(reason: CannotShowReason.permissionDenied))
        let declinedView = try await InteractiveChat.view(gateway, declined)
        #expect(declinedView["outcome"] == "unavailable")
        #expect(declinedView["reason"] == "permission_denied")
        #expect(declinedView["error"]?["code"] == 4041)
        await chat.session.shutdown()
      }
    }

    @Test("a request the gateway stops waiting for closes the sheet's request with a notice, and nothing is sent")
    func expired() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        _ = try await gateway.control("POST", "/__fake/request/\(id)/expire")
        try await interactiveWait("the request to close") { model.presented == nil }
        #expect(model.presentedOutcome == .expired)
        #expect(await model.answer(.form(["name": .text("too late")])) == false)
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "timeout")
        #expect(view["answer"] == nil)
        await chat.session.shutdown()
      }
    }

    @Test("a request still open at shutdown is answered 4041 shutting_down before the socket closes")
    func shutdownAnswers() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])
        await chat.session.shutdown()

        // The fake logs what it read; give its socket a moment to drain.
        let deadline = ContinuousClock.now + .seconds(5)
        var view = try await InteractiveChat.view(gateway, id)
        while view["outcome"] == nil, ContinuousClock.now < deadline {
          try await Task.sleep(for: .milliseconds(20))
          view = try await InteractiveChat.view(gateway, id)
        }
        #expect(view["outcome"] == "unavailable")
        #expect(view["reason"] == "shutting_down")
      }
    }

    @Test("a client that advertises nothing is sent nothing: the gateway has no capable client")
    func nothingAdvertised() async throws {
      try await withInteractiveGateway { gateway in
        var options = GatewaySession.Options()
        options.requests = []
        let record = GatewayRecord(id: "g-none", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        await session.start()
        try await interactiveWait("the socket") { session.status.phase == .ready && session.chatList.rows[researcher] != nil }
        try await session.open(researcher)

        await #expect(throws: FakeGatewayError.self) {
          try await gateway.control(
            "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": "input.form"]))
        }
        #expect(session.interactive.prompts.isEmpty)
        await session.shutdown()
      }
    }
  }
}
#endif
