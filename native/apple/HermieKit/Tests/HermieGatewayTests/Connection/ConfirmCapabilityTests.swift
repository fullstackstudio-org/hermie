import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The two-step `client.capabilities` of contract §8: the decision (`ConfirmAdvertisement`) and
/// the calls the connection makes with it.
@Suite struct ConfirmCapabilityTests {
  static let gatewayID = "2kvwXlBOqzLxDCPyRKi-lQ"

  static func first(enabled: Bool = true, reason: String = "", native: [String] = ["confirm.hermie.dev"]) -> ClientCapabilitiesResult {
    ClientCapabilitiesResult(json: [
      "server_requests": ["approval", "clarify", "confirm"],
      "confirm": [],
      "confirm_passkey": [
        "v": 1, "enabled": .bool(enabled), "reason": .string(reason), "gateway_id": .string(gatewayID),
        "rp": ["native": .array(native.map(JSONValue.string)), "web": ["gw.example.com"]]
      ]
    ])
  }

  static func policy(
    hasCredential: Bool = true,
    pinned: String? = nil,
    foreign: Set<String> = [],
    plain: Bool = false,
    fields: Bool = false
  ) -> ConfirmCapabilityPolicy {
    ConfirmCapabilityPolicy(
      plain: plain,
      passkey: PasskeyAdvertisingPolicy(
        rpID: "confirm.hermie.dev",
        hasCredential: hasCredential,
        pinnedGatewayID: pinned,
        foreignGatewayIDs: foreign
      ),
      fields: fields
    )
  }

  @Test("passkey is advertised only when enabled, the RP is listed and a credential is known (P9)")
  func verdicts() {
    let enabled = Self.first()
    #expect(ConfirmAdvertisement.verdict(enabled.confirmPasskey, policy: Self.policy().passkey) == .advertised)
    #expect(ConfirmAdvertisement.verdict(nil, policy: Self.policy().passkey) == .notOffered)
    #expect(
      ConfirmAdvertisement.verdict(Self.first(enabled: false, reason: "disabled").confirmPasskey, policy: Self.policy().passkey)
        == .unavailable(reason: "disabled")
    )
    #expect(ConfirmAdvertisement.verdict(Self.first(native: []).confirmPasskey, policy: Self.policy().passkey) == .rpNotAccepted)
    #expect(ConfirmAdvertisement.verdict(enabled.confirmPasskey, policy: nil) == .rpNotAccepted)
    #expect(ConfirmAdvertisement.verdict(enabled.confirmPasskey, policy: Self.policy(hasCredential: false).passkey) == .notEnrolled)
    #expect(
      ConfirmAdvertisement.verdict(enabled.confirmPasskey, policy: Self.policy(pinned: "AAAAAAAAAAAAAAAAAAAAAA").passkey)
        == .gatewayIDMismatch(presented: Self.gatewayID)
    )
    #expect(
      ConfirmAdvertisement.verdict(enabled.confirmPasskey, policy: Self.policy(foreign: [Self.gatewayID]).passkey)
        == .gatewayIDConflict(presented: Self.gatewayID)
    )

    var otherVersion = Self.first().confirmPasskey
    otherVersion?.v = 2
    #expect(ConfirmAdvertisement.verdict(otherVersion, policy: Self.policy().passkey) == .notOffered)
  }

  @Test("the second call: passkey with its RP, plain alone, or none")
  func secondCall() throws {
    let both = try #require(ConfirmAdvertisement.secondCall(after: Self.first(), policy: Self.policy(plain: true)))
    #expect(both.confirm == [.plain, .passkey])
    #expect(both.confirmPasskey?.kind == .native)
    #expect(both.confirmPasskey?.rpID == "confirm.hermie.dev")
    #expect(both.confirmPasskey?.v == 1)
    #expect(both.serverRequests == true)

    let passkeyOnly = try #require(ConfirmAdvertisement.secondCall(after: Self.first(), policy: Self.policy()))
    #expect(passkeyOnly.confirm == [.passkey])

    // Not enrolled: `plain` alone when the app shows it, and never the passkey block.
    let plain = try #require(
      ConfirmAdvertisement.secondCall(after: Self.first(), policy: Self.policy(hasCredential: false, plain: true))
    )
    #expect(plain.confirm == [.plain])
    #expect(plain.confirmPasskey == nil)

    #expect(ConfirmAdvertisement.secondCall(after: Self.first(), policy: Self.policy(hasCredential: false)) == nil)

    // A gateway without `confirm` at all gets no second call, plain or not.
    let old = ClientCapabilitiesResult(json: ["server_requests": ["approval", "clarify"]])
    #expect(ConfirmAdvertisement.secondCall(after: old, policy: Self.policy(plain: true)) == nil)

    // A gateway that knows `confirm` but not the passkey block never hears of it (4000 otherwise).
    let plainGateway = ClientCapabilitiesResult(json: ["server_requests": ["approval", "clarify", "confirm"], "confirm": []])
    #expect(ConfirmAdvertisement.secondCall(after: plainGateway, policy: Self.policy(plain: true))?.confirmPasskey == nil)
  }

  @Test("with a source the connection makes both calls and reports what was accepted")
  func twoCalls() async throws {
    let source = ConfirmCapabilitySource(policy: Self.policy())
    var options = HarnessOptions()
    options.confirm = source

    try await withHarness(options) { h in
      var first = Self.first().json
      first["confirm"] = ["passkey"]
      h.gateway.with { $0.scriptedResults["client.capabilities"] = .object(first) }
      await h.connection.start()
      try await h.waitFor(.ready)

      try await eventually("the report") { source.latest != nil }

      let socket = try #require(h.gateway.lastSocket)
      let calls = socket.sent.filter { $0["method"] == "client.capabilities" }
      #expect(calls.count == 2)
      #expect(calls.first?["params"] == ["server_requests": true])
      #expect(
        calls.last?["params"]
          == [
            "server_requests": true, "confirm": ["passkey"],
            "confirm_passkey": ["v": 1, "kind": "native", "rp_id": "confirm.hermie.dev"]
          ]
      )
      #expect(source.latest?.verdict == .advertised)
      #expect(source.latest?.passkeyAccepted == true)

      // Something changed (the passkey was revoked): the announcement runs again on the same socket.
      // Its first call keeps what this socket advertised, so a request raised between the two calls
      // still finds this client; the second call then withdraws `passkey`.
      source.setPolicy(Self.policy(hasCredential: false))
      await h.connection.refreshCapabilities()
      try await eventually("the second report") { source.latest?.verdict == .notEnrolled }
      let again = socket.sent.filter { $0["method"] == "client.capabilities" }.dropFirst(2)
      #expect(again.count == 2)
      #expect(again.first?["params"] == calls.last?["params"], "the first call of a refresh keeps the advertisement")
      #expect(again.last?["params"] == ["server_requests": true], "and the second withdraws it")
    }
  }

  @Test("a refresh repeats only the levels the gateway accepted, and the passkey block only with passkey")
  func heldAdvertisement() throws {
    let sent = try #require(ConfirmAdvertisement.secondCall(after: Self.first(), policy: Self.policy(plain: true)))
    #expect(GatewayConnection.advertisement(sent, accepted: []) == nil)

    let plainOnly = try #require(GatewayConnection.advertisement(sent, accepted: [.plain]))
    #expect(plainOnly.confirm == [.plain])
    #expect(plainOnly.confirmPasskey == nil)

    let both = try #require(GatewayConnection.advertisement(sent, accepted: [.plain, .passkey]))
    #expect(both.jsonValue == sent.jsonValue)
  }

  // MARK: Structured fields (version 2)

  static func example(_ key: String) throws -> JSONValue {
    try #require(PasskeyContractTests.vectors["wire_examples"]?[key], "wire_examples.\(key)")
  }

  @Test("a client that shows fields answers the v2 first result with confirm_fields and passkey v 2: the contract's second call")
  func secondCallV2() throws {
    let first = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result_v2")))
    let sent = try #require(ConfirmAdvertisement.secondCall(after: first, policy: Self.policy(plain: true, fields: true)))
    #expect(sent.jsonValue == (try Self.example("capabilities_second_call_params_v2")))
    #expect(sent.confirmFields == true)
    #expect(sent.confirmPasskey?.v == 2)

    // The passkey alone, and plain alone: the key rides on whichever level goes.
    let passkeyOnly = try #require(ConfirmAdvertisement.secondCall(after: first, policy: Self.policy(fields: true)))
    #expect(passkeyOnly.confirm == [.passkey] && passkeyOnly.confirmFields == true && passkeyOnly.confirmPasskey?.v == 2)

    let plainOnly = try #require(
      ConfirmAdvertisement.secondCall(after: first, policy: Self.policy(hasCredential: false, plain: true, fields: true))
    )
    #expect(plainOnly.confirm == [.plain] && plainOnly.confirmFields == true && plainOnly.confirmPasskey == nil)
  }

  @Test("without fields, or without the gateway's key, nothing about fields or version 2 is sent")
  func secondCallWithoutFields() throws {
    let first = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result_v2")))

    // This client does not show fields: version 1 and no key, whatever the gateway offers.
    let version1 = try #require(ConfirmAdvertisement.secondCall(after: first, policy: Self.policy(plain: true)))
    #expect(version1.confirmFields == nil && version1.confirmPasskey?.v == 1)
    #expect(version1.json["confirm_fields"] == nil)

    // A gateway that does not know the key refuses it with 4000 (and the whole call): never sent.
    let older = Self.first()
    #expect(older.confirmFields == nil)
    let sent = try #require(ConfirmAdvertisement.secondCall(after: older, policy: Self.policy(plain: true, fields: true)))
    #expect(sent.confirmFields == nil && sent.confirmPasskey?.v == 1)
    #expect(sent.json["confirm_fields"] == nil)

    // The key without `versions` (a gateway with fields but not version 2): fields yes, passkey v 1.
    var keyOnly = Self.first().json
    keyOnly["confirm_fields"] = false
    let keyOnlyResult = try #require(ClientCapabilitiesResult(jsonValue: .object(keyOnly)))
    let partial = try #require(ConfirmAdvertisement.secondCall(after: keyOnlyResult, policy: Self.policy(fields: true)))
    #expect(partial.confirmFields == true && partial.confirmPasskey?.v == 1)

    // A `versions` list without 2 keeps version 1.
    var one = try #require(first.confirmPasskey)
    one.versions = [1]
    var onlyOne = first
    onlyOne.confirmPasskey = one
    #expect(ConfirmAdvertisement.secondCall(after: onlyOne, policy: Self.policy(fields: true))?.confirmPasskey?.v == 1)
  }

  @Test("a refresh repeats confirm_fields with the levels, and only with a level accepted")
  func heldFields() throws {
    let first = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result_v2")))
    let sent = try #require(ConfirmAdvertisement.secondCall(after: first, policy: Self.policy(plain: true, fields: true)))

    let held = try #require(GatewayConnection.advertisement(sent, accepted: [.plain, .passkey], fields: true))
    #expect(held.jsonValue == sent.jsonValue)

    // The gateway did not take it: it is not repeated.
    #expect(try #require(GatewayConnection.advertisement(sent, accepted: [.plain, .passkey])).confirmFields == nil)
    // With no level there is nothing for it to ride on.
    #expect(GatewayConnection.advertisement(sent, accepted: [], fields: true) == nil)
    #expect(try #require(GatewayConnection.advertisement(sent, accepted: [], requests: ["input.form"], fields: true)).confirmFields == nil)
  }

  @Test("with a source the connection sends confirm_fields and passkey v 2, and reports the gateway took them")
  func twoCallsV2() async throws {
    let source = ConfirmCapabilitySource(policy: Self.policy(fields: true))
    var options = HarnessOptions()
    options.confirm = source

    try await withHarness(options) { h in
      var first = try #require(try Self.example("capabilities_first_result_v2").objectValue)
      // The one scripted result serves both calls: the second answer accepts what the client sent.
      first["confirm"] = ["passkey"]
      first["confirm_fields"] = true
      h.gateway.with { $0.scriptedResults["client.capabilities"] = .object(first) }
      await h.connection.start()
      try await h.waitFor(.ready)

      try await eventually("the report") { source.latest?.fieldsAccepted == true }

      let socket = try #require(h.gateway.lastSocket)
      let calls = socket.sent.filter { $0["method"] == "client.capabilities" }
      #expect(calls.count == 2)
      #expect(calls.first?["params"] == ["server_requests": true])
      #expect(
        calls.last?["params"]
          == [
            "server_requests": true, "confirm": ["passkey"], "confirm_fields": true,
            "confirm_passkey": ["v": 2, "kind": "native", "rp_id": "confirm.hermie.dev"]
          ]
      )
      #expect(source.latest?.passkeyAccepted == true)

      // A refresh keeps both in its first call, so a request with fields raised between the two calls
      // still finds this client.
      source.setPolicy(Self.policy(fields: true))
      await h.connection.refreshCapabilities()
      try await eventually("the refresh") { socket.sent.filter { $0["method"] == "client.capabilities" }.count >= 4 }
      let again = socket.sent.filter { $0["method"] == "client.capabilities" }.dropFirst(2)
      #expect(again.first?["params"] == calls.last?["params"], "the first call of a refresh keeps confirm_fields and v 2")
    }
  }

  @Test("once passkey is newly accepted on a socket, the open requests of the attached sessions are read again")
  func refetchOpenRequests() async throws {
    let source = ConfirmCapabilitySource(policy: Self.policy(hasCredential: false))
    var options = HarnessOptions()
    options.confirm = source

    try await withHarness(options) { h in
      var first = Self.first().json
      first["confirm"] = ["passkey"]
      h.gateway.with { $0.scriptedResults["client.capabilities"] = .object(first) }
      await h.connection.start()
      try await h.waitFor(.ready)
      try await eventually("the first report") { source.latest?.verdict == .notEnrolled }

      // A chat is attached on this socket; the gateway hid its gated request from it so far.
      _ = try await h.connection.request("session.resume", params: ["session_id": "s1"])
      let socket = try #require(h.gateway.lastSocket)
      let asked = { socket.sent.filter { $0["method"] == "session.events.since" }.count }
      let before = asked()

      // A passkey was enrolled: `passkey` is accepted now, so the gated requests are visible.
      source.setPolicy(Self.policy())
      await h.connection.refreshCapabilities()
      try await eventually("passkey accepted") { source.latest?.passkeyAccepted == true }
      try await eventually("the open requests read again") { asked() > before }

      let call = try #require(socket.sent.last { $0["method"] == "session.events.since" })
      #expect(call["params"]?["session_id"] == "s1")
    }
  }

  @Test("without a source a confirm frame is answered -32601 and only one call goes out")
  func withoutSource() async throws {
    try await withHarness { h in
      await h.connection.start()
      try await h.waitFor(.ready)

      let requests = h.connection.serverRequests
      let listening = Task { for await _ in requests {} }
      defer { listening.cancel() }

      await #expect(throws: (any Error).self) {
        try await h.gateway.requestServerSide(method: "confirm", params: ["session_id": "s1", "level": "passkey"])
      }

      let socket = try #require(h.gateway.lastSocket)
      #expect(socket.sent.filter { $0["method"] == "client.capabilities" }.count == 1)
    }
  }
}
