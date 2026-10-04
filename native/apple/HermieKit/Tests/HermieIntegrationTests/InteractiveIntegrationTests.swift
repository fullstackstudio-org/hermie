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

  /// `requests`: the methods this session announces (the device's own list: a session announces
  /// none unless told to, until the sheets ship).
  static func open(
    _ gateway: FakeGateway,
    requests: [String] = InteractiveCapabilities.deviceMethods()
  ) async throws -> InteractiveChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    options.requests = requests

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
    try await acceptedAdvertisements(gateway, atLeast: 1)
    return chat
  }

  /// Wait until the gateway took the methods from `count` calls (one per socket).
  static func acceptedAdvertisements(_ gateway: FakeGateway, atLeast count: Int) async throws {
    try await interactiveWait("the methods to be accepted") {
      let state = try await gateway.control("GET", "/__fake/state")
      return (state["clientCapabilities"]?.arrayValue ?? []).filter { !($0["requests"]?.arrayValue ?? []).isEmpty }
        .count >= count
    }
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

    @Test("a socket that drops while a form is open: after the reconnect the form is still open, and answerable")
    func formSurvivesAReconnect() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let session = chat.session
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await interactiveWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }
        await session.retryNow()
        try await interactiveWait("the socket to come back") { session.status.phase == .ready }
        try await InteractiveChat.acceptedAdvertisements(gateway, atLeast: 2)
        // Let the recovery's resume and replay (and the read again after the acceptance) land.
        try await Task.sleep(for: .milliseconds(500))

        #expect(model.presented?.id == id, "still open: no list read before the acceptance closed it")
        #expect(model.presentedOutcome == nil)
        #expect(chat.session.interactive.notices.isEmpty)

        #expect(await model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"]?["values"] == ["name": "Ada Lovelace", "guests": 2])
        await session.shutdown()
      }
    }

    @Test("a reconnect whose capability calls fail: the lists it reads leave the form out, and it stays open and answerable")
    func formSurvivesFailedAdvertisement() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let session = chat.session
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        let replays = { () async throws -> Int in
          let state = try await gateway.control("GET", "/__fake/state")
          return (state["methodLog"]?.arrayValue ?? []).filter { $0 == "session.events.since" }.count
        }
        let before = try await replays()

        // The new socket never gets its methods accepted, so the gateway hides the form from the
        // resume's and the replay's `open_requests`: those lists say nothing about it.
        _ = try await gateway.control("POST", "/__fake/deny", body: ["methods": ["client.capabilities"]])
        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await interactiveWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }
        await session.retryNow()
        try await interactiveWait("the socket to come back") { session.status.phase == .ready }
        try await interactiveWait("the replay") { try await replays() > before }
        try await Task.sleep(for: .milliseconds(300))

        #expect(model.presented?.id == id, "still open: no list closed it")
        #expect(model.presentedOutcome == nil)

        // `request.answer` reaches it from any connection.
        #expect(await model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        await session.shutdown()
      }
    }

    @Test("a refused answer (4034) keeps the form open with the gateway's reason; the corrected one is taken")
    func refusedAnswer() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
        #expect(model.refusal == "field:guests:below_min")
        #expect(model.presented?.id == id, "the sheet stays up")
        let refused = try await InteractiveChat.view(gateway, id)
        #expect(refused["open"] == true)
        #expect(refused["refusals"] == ["field:guests:below_min"])

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])))
        #expect(model.refusal == nil)
        let taken = try await InteractiveChat.view(gateway, id)
        #expect(taken["outcome"] == "answered")
        await chat.session.shutdown()
      }
    }

    @Test("the tenth refused answer withdraws the request")
    func refusalCap() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        for attempt in 1...9 {
          #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
          #expect(model.refusal == "field:guests:below_min", "attempt \(attempt)")
        }

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
        try await interactiveWait("the request to close") { model.presented == nil }
        #expect(model.presentedOutcome == .withdrawn)
        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])) == false)
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "too_many_attempts")
        #expect(view["refusals"]?.arrayValue?.count == 10)
        await chat.session.shutdown()
      }
    }

    @Test("by default a session announces no interactive method: the gateway has no capable client")
    func offByDefault() async throws {
      try await withInteractiveGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(id: "g-default", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        await session.start()
        try await interactiveWait("the socket") { session.status.phase == .ready && session.chatList.rows[researcher] != nil }
        try await session.open(researcher)
        try await Task.sleep(for: .milliseconds(200))

        let state = try await gateway.control("GET", "/__fake/state")
        let advertised = (state["clientCapabilities"]?.arrayValue ?? []).contains { !($0["requests"]?.arrayValue ?? []).isEmpty }
        #expect(!advertised)
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
