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
    plain: Bool = false
  ) -> ConfirmCapabilityPolicy {
    ConfirmCapabilityPolicy(
      plain: plain,
      passkey: PasskeyAdvertisingPolicy(
        rpID: "confirm.hermie.dev",
        hasCredential: hasCredential,
        pinnedGatewayID: pinned,
        foreignGatewayIDs: foreign
      )
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
