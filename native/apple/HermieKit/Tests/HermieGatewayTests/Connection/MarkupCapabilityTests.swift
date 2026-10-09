import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The `markup` key of `client.capabilities` (`MarkupCapabilities.swift`): which Hermie blocks this app draws.
/// Two rules from the gateway: the key goes in the second call, and only after a first result that carried it;
/// and every call replaces the advertisement, so every call after that carries it again.
@Suite struct MarkupCapabilityTests {
  static let all = ["chart", "cards", "alerts"]
  static let echoed = ["alerts", "cards", "chart"]

  /// A first result as a gateway that knows the key answers it; since the scripted result answers every call,
  /// it is the echo of the second one too.
  static func knowing(echo: [String]? = nil) -> JSONValue {
    ["server_requests": ["approval", "clarify"], "markup": .array((echo ?? echoed).map(JSONValue.string))]
  }

  static func calls(_ socket: FakeSocket) -> [JSONValue] {
    socket.sent.filter { $0["method"] == "client.capabilities" }.compactMap { $0["params"] }
  }

  /// The blocks a call lists, as a set: the refresh repeats what the gateway echoed, which is sorted.
  static func names(_ call: JSONValue) -> Set<String> {
    Set(call["markup"]?.arrayValue?.compactMap(\.stringValue) ?? [])
  }

  // MARK: The decision

  @Test("the app draws exactly a chart, cards and alerts")
  func supported() {
    #expect(MarkupAdvertisement.supported == Self.all)
    #expect(GatewayConnection.Options().markup == nil, "a connection announces nothing until it is given a list")
  }

  @Test("the list is sent only when the first result carries the key")
  func decision() {
    let knows = ClientCapabilitiesResult(json: ["server_requests": ["approval"], "markup": []])
    let old = ClientCapabilitiesResult(json: ["server_requests": ["approval", "clarify", "input.form"]])
    let device = ["chart", "cards", "chart", "alerts"]

    #expect(MarkupAdvertisement.names(after: knows, device: device) == Self.all, "distinct, in order")
    #expect(MarkupAdvertisement.names(after: old, device: device).isEmpty, "an older gateway 4000s the key")
    #expect(MarkupAdvertisement.names(after: ClientCapabilitiesResult(json: [:]), device: device).isEmpty)
    #expect(MarkupAdvertisement.names(after: knows, device: []).isEmpty)
    #expect(MarkupAdvertisement.names(after: knows, device: nil).isEmpty)
  }

  @Test("a name the gateway would not read is never sent, and no more than sixteen")
  func shape() {
    let knows = ClientCapabilitiesResult(json: ["markup": []])

    #expect(MarkupAdvertisement.names(after: knows, device: ["Chart", "cards", "a b", "", "9x", "ok-name", "x_y"]) == ["cards", "ok-name"])
    #expect(MarkupAdvertisement.names(after: knows, device: [String(repeating: "a", count: 33)]).isEmpty)
    #expect(MarkupAdvertisement.names(after: knows, device: [String(repeating: "a", count: 32)]).count == 1)

    let many = (0..<30).map { "block-" + String(repeating: "a", count: $0 + 1) }
    #expect(MarkupAdvertisement.names(after: knows, device: many).count <= MarkupAdvertisement.limit)
  }

  // MARK: The calls

  @Test("the second call carries markup, and the first does not")
  func twoCalls() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.knowing() }
      await h.connection.start()
      try await h.waitFor(.ready)

      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { Self.calls(socket).count == 2 }
      let calls = Self.calls(socket)

      #expect(calls.first == ["server_requests": true], "before the gateway has said it knows the key")
      #expect(calls.last == ["server_requests": true, "markup": ["chart", "cards", "alerts"]])
      try await eventually("the echo") { await h.connection.acceptedMarkup == Self.echoed }
    }
  }

  @Test("a gateway that does not know the key hears only the first call")
  func olderGateway() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = ["server_requests": ["approval", "clarify"]] }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await Task.sleep(for: .milliseconds(50))

      let socket = try #require(h.gateway.lastSocket)
      #expect(Self.calls(socket).count == 1)
      #expect(Self.calls(socket).first?["markup"] == nil)
      #expect(await h.connection.acceptedMarkup.isEmpty)
    }
  }

  @Test("a connection given no list makes the one call it always made")
  func nothingToAnnounce() async throws {
    try await withHarness { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.knowing() }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await Task.sleep(for: .milliseconds(50))

      let socket = try #require(h.gateway.lastSocket)
      #expect(Self.calls(socket) == [["server_requests": true]])
    }
  }

  @Test("a gateway that knows the key and accepts none is still told, and records none")
  func acceptsNone() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.knowing(echo: []) }
      await h.connection.start()
      try await h.waitFor(.ready)

      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { Self.calls(socket).count == 2 }
      try await Task.sleep(for: .milliseconds(30))
      #expect(await h.connection.acceptedMarkup.isEmpty)
    }
  }

  @Test("every call after the gateway has shown it knows the key carries markup, a refresh's first call too")
  func everyLaterCallCarriesIt() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.knowing() }
      await h.connection.start()
      try await h.waitFor(.ready)
      let socket = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { Self.calls(socket).count == 2 }
      try await eventually("the echo") { await h.connection.acceptedMarkup == Self.echoed }

      // A refresh (a setting changed, a passkey enrolled, a request type toggled) announces twice more.
      await h.connection.refreshCapabilities()
      try await eventually("the refresh") { Self.calls(socket).count == 4 }
      try await Task.sleep(for: .milliseconds(30))

      let refresh = Self.calls(socket).dropFirst(2)
      for call in refresh {
        #expect(Self.names(call) == Set(Self.all), "a call without markup would clear it at the gateway: \(call)")
      }

      // And once more, to be sure it is not only the first refresh.
      await h.connection.refreshCapabilities()
      try await eventually("the second refresh") { Self.calls(socket).count == 6 }
      for call in Self.calls(socket).dropFirst(4) {
        #expect(Self.names(call) == Set(Self.all))
      }

      // Only the opening call of the socket is bare.
      let bare = Self.calls(socket).filter { $0["markup"] == nil }
      #expect(bare.count == 1 && Self.calls(socket).first?["markup"] == nil)
    }
  }

  @Test("a new socket announces again: bare first call, then markup")
  func aReconnectAdvertisesAgain() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with { $0.scriptedResults["client.capabilities"] = Self.knowing() }
      await h.connection.start()
      try await h.waitFor(.ready)
      let first = try #require(h.gateway.lastSocket)
      try await eventually("both calls") { Self.calls(first).count == 2 }

      h.gateway.dropSockets()
      try await h.advanceUntil("the connection to come back") {
        let phase = await h.connection.phase
        return h.gateway.connections == 2 && phase == .ready
      }

      let second = try #require(h.gateway.lastSocket)
      #expect(second !== first)
      try await eventually("both calls on the new socket") { Self.calls(second).count == 2 }
      #expect(Self.calls(second).first == ["server_requests": true])
      #expect(Self.calls(second).last == ["server_requests": true, "markup": ["chart", "cards", "alerts"]])
    }
  }

  @Test("with a confirm source and interactive methods too, one second call carries all three keys")
  func withTheOtherKeys() async throws {
    let source = ConfirmCapabilitySource(policy: ConfirmCapabilityPolicy(plain: true))
    var options = HarnessOptions()
    options.confirm = source
    options.requests = RequestsCapabilityTests.all
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = [
          "server_requests": ["approval", "clarify", "confirm", "input.form", "input.file", "review.draft"],
          "confirm": ["plain"],
          "requests": ["input.form", "input.file", "review.draft"],
          "markup": ["alerts", "cards", "chart"]
        ]
      }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the report") { source.latest != nil }

      let socket = try #require(h.gateway.lastSocket)
      let calls = Self.calls(socket)
      #expect(calls.count == 2)
      #expect(
        calls.last
          == [
            "server_requests": true, "confirm": ["plain"], "requests": ["input.form", "input.file", "review.draft"],
            "markup": ["chart", "cards", "alerts"]
          ])

      // A refresh repeats all three in both of its calls.
      await h.connection.refreshCapabilities()
      try await eventually("the refresh") { Self.calls(socket).count == 4 }
      for call in Self.calls(socket).dropFirst(2) {
        #expect(call["confirm"] == ["plain"] && call["requests"] != nil && call["markup"] != nil, "\(call)")
      }
    }
  }

  @Test("a second call that gets no answer records nothing, and the next refresh still announces")
  func unansweredSecondCall() async throws {
    var options = HarnessOptions()
    options.markup = Self.all

    try await withHarness(options) { h in
      h.gateway.with {
        $0.scriptedResults["client.capabilities"] = Self.knowing()
        $0.holdFrom["client.capabilities"] = 1
      }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the second call") { h.gateway.heldCount("client.capabilities") == 1 }
      #expect(await h.connection.acceptedMarkup.isEmpty, "nothing is accepted until the gateway says so")

      h.gateway.releaseHeld("client.capabilities", result: Self.knowing())
      try await eventually("the echo") { await h.connection.acceptedMarkup == Self.echoed }
    }
  }

  // MARK: The held advertisement

  @Test("what the gateway accepted is what a refresh repeats")
  func heldAdvertisement() throws {
    let sent = ClientCapabilitiesParams(serverRequests: true)

    #expect(GatewayConnection.advertisement(sent, accepted: [], markup: []) == nil)

    let held = try #require(GatewayConnection.advertisement(sent, accepted: [], markup: ["cards", "chart"]))
    #expect(held.jsonValue == ["server_requests": true, "markup": ["cards", "chart"]])
  }
}
