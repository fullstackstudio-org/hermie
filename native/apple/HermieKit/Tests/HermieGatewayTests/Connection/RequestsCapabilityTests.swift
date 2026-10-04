import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The `requests` key of the second `client.capabilities` call (`contract/requests/README.md` §1):
/// the decision (`RequestsAdvertisement`) and the calls the connection makes with it, and what it
/// does with an interactive request it was not told to take.
@Suite struct RequestsCapabilityTests {
  static let all = ["input.form", "input.file", "review.draft"]

  /// A first result as a gateway that knows the interactive methods answers it, and, since the
  /// scripted result answers both calls, the second result's echo.
  static func listed(accepts echo: [String]? = nil) -> JSONValue {
    var result: JSONObject = ["server_requests": ["approval", "clarify", "input.form", "input.file", "review.draft"]]

    if let echo {
      result["requests"] = .array(echo.map(JSONValue.string))
    }

    return .object(result)
  }

  @Test("the second call lists the device's methods only when the first result lists an interactive method")
  func decision() {
    let known = ClientCapabilitiesResult(json: ["server_requests": ["approval", "clarify", "input.form"]])
    let old = ClientCapabilitiesResult(json: ["server_requests": ["approval", "clarify", "confirm"]])
    let device = ["input.form", "input.file", "input.form", "review.draft"]

    #expect(RequestsAdvertisement.methods(after: known, device: device) == Self.all, "distinct, in order")
    #expect(RequestsAdvertisement.methods(after: old, device: device).isEmpty, "an older gateway 4000s the key")
    #expect(RequestsAdvertisement.methods(after: known, device: []).isEmpty)
    #expect(RequestsAdvertisement.methods(after: known, device: nil).isEmpty)
    #expect(RequestsAdvertisement.methods(after: ClientCapabilitiesResult(json: [:]), device: device).isEmpty)

    let device32 = (0..<40).map { "device.method\($0)" }
    #expect(RequestsAdvertisement.methods(after: known, device: device32).count == 32, "the contract's bound")
    #expect(RequestsAdvertisement.isInteractive("device.scan") && RequestsAdvertisement.isInteractive("review.draft"))
    #expect(!RequestsAdvertisement.isInteractive("confirm") && !RequestsAdvertisement.isInteractive("approval"))
  }

  @Test("a refresh repeats what the gateway accepted, with the interactive methods")
  func heldAdvertisement() throws {
    let sent = try #require(ConfirmAdvertisement.secondCall(after: ConfirmCapabilityTests.first(), policy: ConfirmCapabilityTests.policy(plain: true)))
    #expect(GatewayConnection.advertisement(sent, accepted: [], requests: []) == nil)

    let onlyRequests = try #require(GatewayConnection.advertisement(sent, accepted: [], requests: ["input.form"]))
    #expect(onlyRequests.jsonValue == ["server_requests": true, "requests": ["input.form"]])

    let both = try #require(GatewayConnection.advertisement(sent, accepted: [.plain], requests: Self.all))
    #expect(both.confirm == [.plain])
    #expect(both.requests == Self.all)
    #expect(both.confirmPasskey == nil)
  }

  @Test("with methods to show the connection makes both calls, the second carrying requests")
  func twoCalls() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      await h.connection.start()
      try await h.waitFor(.ready)

      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }
      let calls = socket.sent.filter { $0["method"] == "client.capabilities" }
      #expect(calls.first?["params"] == ["server_requests": true])
      #expect(calls.last?["params"] == ["server_requests": true, "requests": ["input.form", "input.file", "review.draft"]])
    }
  }

  @Test("a gateway that lists no interactive method hears only the first call, and answers a stray one -32601")
  func olderGateway() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = ["server_requests": ["approval", "clarify"]] }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await Task.sleep(for: .milliseconds(50))

      let socket = try #require(h.gateway.lastSocket)
      #expect(socket.sent.filter { $0["method"] == "client.capabilities" }.count == 1)

      let requests = h.connection.serverRequests
      let listening = Task { for await _ in requests {} }
      defer { listening.cancel() }

      await #expect(throws: (any Error).self) {
        try await h.gateway.requestServerSide(method: "input.form", params: ["session_id": "s1"])
      }
      #expect(socket.sent.contains { $0["error"]?["code"] == -32601 })
    }
  }

  @Test("without methods to show nothing is announced, and every interactive request is answered -32601")
  func unadvertisedIsDeclined() async throws {
    try await withHarness { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await Task.sleep(for: .milliseconds(50))

      let socket = try #require(h.gateway.lastSocket)
      #expect(socket.sent.filter { $0["method"] == "client.capabilities" }.count == 1)

      // Listener or not: nobody answers an interactive request on a connection that never said it could.
      let requests = h.connection.serverRequests
      let listening = Task { for await delivery in requests { _ = await delivery.respond(["status": "skipped"]) } }
      defer { listening.cancel() }

      for method in Self.all {
        await #expect {
          try await h.gateway.requestServerSide(method: method, params: ["session_id": "s1"])
        } throws: { error in
          String(describing: error).contains("-32601")
        }
      }
    }
  }

  @Test("a method the gateway did not accept is answered -32601; one it did is delivered and answered")
  func onlyWhatWasAccepted() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: ["input.form"]) }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }
      try await Task.sleep(for: .milliseconds(50))

      let requests = h.connection.serverRequests
      let answering = Task {
        for await delivery in requests where delivery.body.isInteractive {
          _ = await delivery.respond(["status": "skipped"])
        }
      }
      defer { answering.cancel() }

      let form = try await h.gateway.requestServerSide(method: "input.form", params: ["session_id": "s1"])
      #expect(form == ["status": "skipped"])

      for method in ["input.file", "review.draft"] {
        await #expect {
          try await h.gateway.requestServerSide(method: method, params: ["session_id": "s1"])
        } throws: { error in
          String(describing: error).contains("-32601")
        }
      }
    }
  }

  @Test("a request that arrives before the answer to the second call is delivered")
  func deliverableFromTheMomentTheCallIsSent() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      let requests = Recorder(h.connection.serverRequests)
      defer { requests.cancel() }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }

      let asked = Task { try await h.gateway.requestServerSide(method: "review.draft", params: ["session_id": "s1"]) }
      try await eventually("the request") { requests.values.count == 1 }
      let delivery = try #require(requests.values.first)
      #expect(delivery.body.isInteractive)
      #expect(await delivery.respond(["decision": "rejected"]))
      #expect(try await asked.value == ["decision": "rejected"])
    }
  }

  @Test("with a confirm source too, one second call carries both keys")
  func withConfirm() async throws {
    let source = ConfirmCapabilitySource(policy: ConfirmCapabilityPolicy(plain: true))
    var options = HarnessOptions()
    options.confirm = source
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = [
          "server_requests": ["approval", "clarify", "confirm", "input.form", "input.file", "review.draft"],
          "confirm": ["plain"],
          "requests": ["input.form", "input.file", "review.draft"]
        ]
      }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the report") { source.latest != nil }

      let socket = try #require(h.gateway.lastSocket)
      let calls = socket.sent.filter { $0["method"] == "client.capabilities" }
      #expect(calls.count == 2)
      #expect(
        calls.last?["params"]
          == ["server_requests": true, "confirm": ["plain"], "requests": ["input.form", "input.file", "review.draft"]]
      )
      #expect(source.latest?.accepted == [.plain])
      #expect(source.latest?.acceptedRequests == Self.all)
    }
  }

  @Test("a refresh repeats the methods, and a device that can show none any more takes them back")
  func refresh() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }
      try await Task.sleep(for: .milliseconds(50))

      await h.connection.refreshCapabilities()
      try await eventually("the refresh") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 4 }
      let again = socket.sent.filter { $0["method"] == "client.capabilities" }.dropFirst(2)
      #expect(
        again.first?["params"] == ["server_requests": true, "requests": ["input.form", "input.file", "review.draft"]],
        "the first call of a refresh keeps the advertisement")
      #expect(again.last?["params"] == again.first?["params"])
    }
  }

  @Test("once the methods are newly accepted, the open requests of the attached sessions are read again")
  func refetchOpenRequests() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      // The gateway takes none at first: it hid its interactive requests from this socket.
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: []) }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }

      // A chat is attached on this socket.
      _ = try await h.connection.request("session.resume", params: ["session_id": "s1"])
      let asked = { socket.sent.filter { $0["method"] == "session.events.since" }.count }
      let before = asked()

      // Now it takes them: what is open on the attached sessions is read again.
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      await h.connection.refreshCapabilities()
      try await eventually("the open requests read again") { asked() > before }

      let call = try #require(socket.sent.last { $0["method"] == "session.events.since" })
      #expect(call["params"]?["session_id"] == "s1")
    }
  }
  // MARK: Which lists are complete

  @Test("a list read before the gateway accepted the methods says nothing about them; one read after lists them in full")
  func listedOnlyAfterAcceptance() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      // The second call is held: the gateway has not accepted anything from this socket yet.
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all)
        $0.holdFrom["client.capabilities"] = 1
      }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the second call") { h.gateway.heldCount("client.capabilities") == 1 }

      // A reconnect's resume that raced the second call.
      let early = Task { try await h.connection.requestReply("session.resume", params: ["session_id": "s1"]) }
      try await eventually("the early resume") { h.gateway.methodLog.contains("session.resume") }

      h.gateway.releaseHeld("client.capabilities", result: Self.listed(accepts: ["input.form", "review.draft"]))
      #expect(try await early.value.listedRequests.isEmpty, "sent before the methods were accepted")

      try await eventually("a list read after the acceptance") {
        let reply = try? await h.connection.requestReply("session.resume", params: ["session_id": "s1"])
        return reply?.listedRequests == ["input.form", "review.draft"]
      }
    }
  }

  @Test("a second call that gets no answer leaves every list incomplete, and a request then is declined -32601, marked declined")
  func secondCallTimesOut() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all)
        $0.holdFrom["client.capabilities"] = 1
      }
      let requests = Recorder(h.connection.serverRequests)
      defer { requests.cancel() }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the second call") { h.gateway.heldCount("client.capabilities") == 1 }

      // The call times out (the gateway may well have taken the methods).
      await h.clock.advance(by: .seconds(120))
      try await Task.sleep(for: .milliseconds(30))

      let reply = try await h.connection.requestReply("session.resume", params: ["session_id": "s1"])
      #expect(reply.listedRequests.isEmpty)

      await #expect {
        try await h.gateway.requestServerSide(method: "input.form", params: ["session_id": "s1"])
      } throws: { error in
        String(describing: error).contains("-32601")
      }
      try await eventually("the declined delivery") { requests.values.count == 1 }
      let delivery = try #require(requests.values.first)
      #expect(delivery.declined, "already answered: nobody may show it")
      #expect(await delivery.respond(["status": "skipped"]) == false)
    }
  }

  @Test("a delivery the connection hands on to be answered is not marked declined")
  func acceptedIsNotDeclined() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      let requests = Recorder(h.connection.serverRequests)
      defer { requests.cancel() }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }

      let asked = Task { try await h.gateway.requestServerSide(method: "input.form", params: ["session_id": "s1"]) }
      try await eventually("the request") { requests.values.count == 1 }
      let delivery = try #require(requests.values.first)
      #expect(!delivery.declined)
      #expect(await delivery.respond(["status": "skipped"]))
      #expect(try await asked.value == ["status": "skipped"])
    }
  }

  /// Start with every method accepted, and wait until both calls are answered.
  private static func accepted(_ h: Harness) async throws -> FakeSocket {
    h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
    await h.connection.start()
    try await h.waitFor(.ready)
    let socket = try #require(h.gateway.lastSocket)
    try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }
    try await eventually("the acceptance") {
      (try? await h.connection.requestReply("session.resume", params: ["session_id": "s1"]))?.listedRequests
        == Set(Self.all)
    }
    return socket
  }

  @Test("the reads made once the methods are accepted hand their open_requests on, with what they list in full")
  func refetchPublishesItsLists() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      let lists = Recorder(h.connection.openRequestLists)
      defer { lists.cancel() }
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = Self.listed(accepts: [])
        $0.scriptedResults["session.events.since"] = [
          "events": [], "latest_seq": 0, "truncated": false, "count": 0, "epoch": "epoch-1",
          "open_requests": [["id": "srq-1", "method": "input.form", "params": ["session_id": "s1"]]]
        ]
      }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 2 }
      _ = try await h.connection.request("session.resume", params: ["session_id": "s1"])
      #expect(lists.values.isEmpty)

      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.listed(accepts: Self.all) }
      await h.connection.refreshCapabilities()
      try await eventually("the list") { lists.values.count == 1 }
      let list = try #require(lists.values.first)
      #expect(list.sessionID == "s1")
      #expect(list.ids == ["srq-1"])
      #expect(list.listed == Set(Self.all))
    }
  }

  @Test("a refresh whose first call gets no answer empties what was listed in full")
  func refreshFirstCallTimesOut() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      _ = try await Self.accepted(h)

      h.gateway.with { $0.holdFrom["client.capabilities"] = 2 }
      await h.connection.refreshCapabilities()
      try await eventually("the refresh's first call") { h.gateway.heldCount("client.capabilities") == 1 }
      await h.clock.advance(by: .seconds(120))
      try await Task.sleep(for: .milliseconds(30))

      let reply = try await h.connection.requestReply("session.resume", params: ["session_id": "s1"])
      #expect(reply.listedRequests.isEmpty)
    }
  }

  @Test("a refresh that accepts a method again keeps its serial: a read made before the refresh still lists it")
  func refreshKeepsTheSerial() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      let socket = try await Self.accepted(h)

      // A read made after the acceptance, answered only after a refresh.
      let resumes = h.gateway.methodLog.filter { $0 == "session.resume" }.count
      h.gateway.with { $0.holdFrom["session.resume"] = resumes }
      let held = Task { try await h.connection.requestReply("session.resume", params: ["session_id": "s1"]) }
      try await eventually("the held read") { h.gateway.heldCount("session.resume") == 1 }

      await h.connection.refreshCapabilities()
      try await eventually("the refresh") { socket.sent.filter { $0["method"] == "client.capabilities" }.count == 4 }
      try await Task.sleep(for: .milliseconds(30))

      h.gateway.releaseHeld("session.resume", result: ["session_id": "s1"])
      #expect(try await held.value.listedRequests == Set(Self.all))
    }
  }

  @Test("a refresh's second call that no longer carries a method stops listing it from the moment it goes out")
  func refreshWithdrawsAtOnce() async throws {
    var options = HarnessOptions()
    options.requests = Self.all

    try await withHarness(options) { h in
      _ = try await Self.accepted(h)

      // The gateway no longer lists the methods: the refresh's second call takes them back. It is
      // held, so the read below goes out after it and before its answer.
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = ["server_requests": ["approval", "clarify"]]
        $0.holdFrom["client.capabilities"] = 3
      }
      await h.connection.refreshCapabilities()
      try await eventually("the refresh's second call") { h.gateway.heldCount("client.capabilities") == 1 }

      let reply = try await h.connection.requestReply("session.resume", params: ["session_id": "s1"])
      #expect(reply.listedRequests.isEmpty)
      h.gateway.releaseHeld("client.capabilities", result: ["server_requests": ["approval", "clarify"]])
    }
  }
}
