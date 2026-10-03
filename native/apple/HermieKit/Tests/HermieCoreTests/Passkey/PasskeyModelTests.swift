import CryptoKit
import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Testing

@testable import HermieCore

/// `PasskeyModel` over a scripted link, with the soft authenticator: what it answers, what it
/// refuses, and what it makes of the gateway's verdicts.
@MainActor
@Suite struct PasskeyModelTests {
  static let rpID = "confirm.hermie.dev"
  static let address = "https://gw.example.com"
  static let gatewayID: [UInt8] = Array(0..<16)
  static let nonce: [UInt8] = Array(repeating: 7, count: 32)
  static let userID = "self_hosted:7c1f0e2a"

  struct Fixture {
    let link: ScriptedLink
    let model: PasskeyModel
    let phone: SoftPasskeyAuthenticator
    let source: ConfirmCapabilitySource
    let pins: InMemoryPasskeyPins
  }

  static func fixture(
    rpID: String? = rpID,
    plain: Bool = false,
    storedID: String = "gw-1",
    pins: [String: PasskeyPinRecord] = [:],
    store: (any PasskeyPinStore)? = nil,
    authenticator: any PasskeyAuthenticator = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
  ) async -> Fixture {
    let link = ScriptedLink()
    let source = ConfirmCapabilitySource()
    let memory = InMemoryPasskeyPins(pins)
    let model = PasskeyModel(
      storedGatewayID: storedID,
      address: address,
      link: link,
      client: nil,
      authenticator: authenticator,
      configuration: PasskeyConfiguration(rpID: rpID, plain: plain),
      pins: store ?? memory,
      source: source,
      now: { 1_790_000_000 }
    )
    await model.start()
    let phone = authenticator as? SoftPasskeyAuthenticator ?? SoftPasskeyAuthenticator()
    return Fixture(link: link, model: model, phone: phone, source: source, pins: memory)
  }

  /// The params of a `confirm` frame at level `passkey` listing `ids` for the native RP.
  static func params(
    ids: [String],
    v: Int = 1,
    gatewayID: [UInt8] = gatewayID,
    rp: String = rpID,
    expiresAt: Double = 1_790_000_120,
    detail: String? = "  rm -rf /tmp/build\n\tthen: done  "
  ) -> JSONObject {
    var params: JSONObject = [
      "session_id": "sess-1",
      "title": "Delete the build",
      "summary": "Remove the old build directory.",
      "level": "passkey",
      "passkey": [
        "v": .number(Double(v)),
        "nonce": .string(Base64URL.encode(nonce)),
        "gateway_id": .string(Base64URL.encode(gatewayID)),
        "base_url": "https://gw.example.com",
        "expires_at": .number(expiresAt),
        "user": ["id": .string(userID), "name": "Alex Example"],
        "credentials": [["rp_id": .string(rp), "ids": .array(ids.map(JSONValue.string))]]
      ]
    ]
    params["detail"] = detail.map(JSONValue.string)
    return params
  }

  func raise(_ f: Fixture, id: String = "srq-1", _ params: JSONObject? = nil) async throws {
    f.link.raise(id: id, method: "confirm", params: params ?? Self.params(ids: [f.phone.id]))
    try await eventually("the confirmation or its refusal") { @MainActor in
      f.model.confirmation(id) != nil || !f.link.declines.isEmpty
    }
  }

  // MARK: - Answering

  @Test("Confirm signs the challenge of what the sheet shows and answers through request.answer")
  func confirms() async throws {
    let f = await Self.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await raise(f)

    let shown = try #require(f.model.confirmation("srq-1"))
    #expect(shown.phase == .waiting)
    #expect(shown.display.detail == "  rm -rf /tmp/build\n\tthen: done  ", "verbatim, whitespace kept")
    #expect(shown.display.baseURL == "https://gw.example.com")
    #expect(shown.display.host == "gw.example.com")
    #expect(shown.userName == "Alex Example")
    #expect(shown.expiresAt == Date(timeIntervalSince1970: 1_790_000_120))

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.phase == .received, "ok means received, never confirmed")

    let call = try #require(f.link.calls("request.answer").first)
    #expect(call.params["id"]?.stringValue == "srq-1")
    let result = try #require(call.params["result"].flatMap(ConfirmResult.init(jsonValue:)))
    #expect(result.json.keys.sorted() == ["decision", "method", "passkey"], "never verified")
    #expect(result.decision == .confirmed)
    #expect(result.method == .passkey)

    let passkey = try #require(result.passkey)
    #expect(passkey.v == 1)
    #expect(passkey.rpID == Self.rpID)
    #expect(passkey.baseURL == "https://gw.example.com")
    #expect(passkey.credentialID == f.phone.id)
    #expect(passkey.userHandle == Base64URL.encode(Array(repeating: 9, count: 32)))

    // The challenge in clientDataJSON is the contract's, over the text the sheet showed.
    let expected = PasskeyChallenge.challenge(
      shown.display,
      PasskeyChallengeBinding(
        purpose: .confirm,
        gatewayID: Self.gatewayID,
        userID: Self.userID,
        sessionID: "sess-1",
        requestID: "srq-1",
        nonce: Self.nonce
      )
    )
    let clientData = try #require(passkey.clientDataJSON.flatMap(Base64URL.decode))
    let clientJSON = try JSONValue(parsing: Data(clientData))
    #expect(clientJSON["challenge"]?.stringValue == Base64URL.encode(expected))
    #expect(clientJSON["type"]?.stringValue == "webauthn.get")

    let authData = try #require(passkey.authenticatorData.flatMap(Base64URL.decode))
    let signature = try P256.Signing.ECDSASignature(derRepresentation: try #require(passkey.signature.flatMap(Base64URL.decode)))
    #expect(f.phone.privateKey.publicKey.isValidSignature(signature, for: authData + Array(SHA256.hash(data: clientData))))
    #expect(Array(authData.prefix(32)) == Array(SHA256.hash(data: Array(Self.rpID.utf8))))
    #expect(authData[32] & 0x05 == 0x05, "UP and UV")
  }

  @Test("Decline sends exactly {decision: declined, method: tap} and no ceremony runs")
  func declines() async throws {
    let f = await Self.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await raise(f)

    await f.model.decline("srq-1")

    let call = try #require(f.link.calls("request.answer").first)
    #expect(call.params == ["id": "srq-1", "result": ["decision": "declined", "method": "tap"]])
    #expect(f.model.confirmation("srq-1")?.phase == .declined)
    #expect(f.phone.ceremonies == 0)
  }

  @Test("a 4034 refusal keeps it open with its reason; the fifth ends it as too_many_attempts")
  func refusals() async throws {
    let f = await Self.fixture()
    try await raise(f)

    let first = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")
    f.link.fail(call, GatewayRPCError(.rejected, "answer refused", code: 4034, data: ["reason": "challenge_mismatch"]))
    await first.value
    #expect(f.model.confirmation("srq-1")?.phase == .refused(reason: "challenge_mismatch"))
    #expect(f.model.confirmation("srq-1")?.isOpen == true)

    let second = Task { await f.model.confirm("srq-1") }
    let again = try await f.link.pendingCall("request.answer")
    f.link.fail(again, GatewayRPCError(.rejected, "answer refused", code: 4034, data: ["reason": "too_many_attempts"]))
    await second.value
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.tooManyAttempts))
  }

  @Test("a 4033 means this connection may not answer it")
  func notAllowed() async throws {
    let f = await Self.fixture()
    try await raise(f)

    let task = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")
    f.link.fail(call, GatewayRPCError(.rejected, "not allowed", code: 4033))
    await task.value
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.notAllowed))
  }

  @Test("an answer that never arrived can be sent again")
  func notSent() async throws {
    let f = await Self.fixture()
    try await raise(f)

    let task = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")
    f.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await task.value

    guard case .notSent? = f.model.confirmation("srq-1")?.phase else {
      Issue.record("expected notSent, got \(String(describing: f.model.confirmation("srq-1")?.phase))")
      return
    }

    f.link.respond(to: "request.answer", with: ["status": "ok"])
    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .received)
  }

  // MARK: - What the gateway says afterwards

  @Test("verification_failed overrides a received answer; resolved after ours keeps it")
  func verificationFailed() async throws {
    let f = await Self.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await raise(f)
    await f.model.confirm("srq-1")

    f.link.emit("request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": "resolved"])
    f.link.emit("request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": "verification_failed"])

    try await eventually("verification_failed") { @MainActor in
      f.model.confirmation("srq-1")?.phase == .ended(.verificationFailed)
    }
  }

  @Test("the cancel reasons are the outcome of a confirmation nobody here answered")
  func cancelReasons() async throws {
    let f = await Self.fixture()
    let cases: [(String, PasskeyConfirmEnd)] = [
      ("resolved", .answeredElsewhere), ("timeout", .timedOut), ("too_many_attempts", .tooManyAttempts),
      ("session_closed", .withdrawn(reason: "session_closed"))
    ]

    for (index, (reason, end)) in cases.enumerated() {
      let id = "srq-\(index + 10)"
      try await raise(f, id: id)
      f.link.emit("request.cancel", session: "sess-1", payload: ["id": .string(id), "method": "confirm", "reason": .string(reason)])
      try await eventually(reason) { @MainActor in f.model.confirmation(id)?.phase == .ended(end) }
    }

    #expect(f.model.confirmations.allSatisfy { !$0.isOpen })
  }

  @Test("dismissing the system sheet sends nothing and keeps the sheet")
  func dismissedCeremony() async throws {
    let link = ScriptedLink()
    let model = PasskeyModel(
      storedGatewayID: "gw-1",
      address: Self.address,
      link: link,
      client: nil,
      authenticator: FailingAuthenticator(error: .cancelled),
      configuration: PasskeyConfiguration(rpID: Self.rpID),
      pins: InMemoryPasskeyPins(),
      source: nil,
      now: { 1_790_000_000 }
    )
    await model.start()
    link.raise(id: "srq-1", method: "confirm", params: Self.params(ids: ["AQID"]))
    try await eventually("the confirmation") { @MainActor in model.confirmation("srq-1") != nil }

    await model.confirm("srq-1")

    #expect(model.confirmation("srq-1")?.phase == .waiting)
    #expect(link.calls("request.answer").isEmpty)
    #expect(link.declines.isEmpty)
  }

  @Test("an authenticator that cannot run this RP's ceremony answers 4040 with its reason")
  func unavailableCeremony() async throws {
    let f = await Self.fixture(authenticator: SoftPasskeyAuthenticator(rpID: "other.example"))
    try await raise(f, Self.params(ids: [SoftPasskeyAuthenticator(rpID: "other.example").id]))

    // An authenticator for another RP answers `unavailable` for this one: a 4040, not a silent stall.
    await f.model.confirm("srq-1")
    #expect(f.link.calls("request.answer").isEmpty)
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.unavailable(reason: "rp_not_supported")))
    #expect(f.link.declines.first?.code == 4040)
    #expect(f.link.declineData("srq-1") == ["reason": "rp_not_supported"])
  }

  @Test("a credential the device does not hold is a 4040 no_credential")
  func noCredentialOnDevice() async throws {
    let f = await Self.fixture()
    try await raise(f, Self.params(ids: [Base64URL.encode(Array(repeating: 1, count: 32))]))

    await f.model.confirm("srq-1")
    #expect(f.link.calls("request.answer").isEmpty)
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.unavailable(reason: "no_credential")))
    #expect(f.link.declineData("srq-1") == ["reason": "no_credential"])
  }

  // MARK: - Frames refused on arrival

  @Test("a frame without a credential for this build's RP is refused with a notice")
  func noCredentialForApp() async throws {
    let f = await Self.fixture()
    try await raise(f, Self.params(ids: ["abc"], rp: "gw.example.com"))

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declines.first?.code == 4040)
    #expect(f.link.declineData("srq-1") == ["reason": "no_credential"])
    #expect(f.model.notices.map(\.kind) == [.noCredentialForApp])
  }

  @Test("an unknown v is refused with a notice")
  func unknownVersion() async throws {
    let f = await Self.fixture()
    try await raise(f, Self.params(ids: [f.phone.id], v: 2))

    #expect(f.link.declineData("srq-1") == ["reason": "unsupported_version"])
    #expect(f.model.notices.map(\.kind) == [.unsupportedVersion])
  }

  @Test("a gateway_id other than the pinned one is refused with a notice")
  func gatewayIDMismatch() async throws {
    let pinned = PasskeyPinRecord(gatewayID: Base64URL.encode(Array(repeating: 0xAA, count: 16)), seenAt: 1)
    let f = await Self.fixture(pins: ["gw-1": pinned])
    try await raise(f)

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declineData("srq-1") == ["reason": "gateway_id_mismatch"])
    #expect(f.model.notices.map(\.kind) == [.gatewayIDMismatch])
  }

  @Test("a gateway_id pinned for another stored gateway is refused with a notice")
  func gatewayIDConflict() async throws {
    let other = PasskeyPinRecord(gatewayID: Base64URL.encode(Self.gatewayID), seenAt: 1)
    let f = await Self.fixture(pins: ["gw-other": other])
    try await raise(f)

    #expect(f.link.declineData("srq-1") == ["reason": "gateway_id_conflict"])
    #expect(f.model.notices.map(\.kind) == [.gatewayIDConflict])
  }

  @Test("a build without an RP refuses every passkey frame and advertises no passkey")
  func noRP() async throws {
    let f = await Self.fixture(rpID: nil)
    try await raise(f)

    #expect(f.link.declineData("srq-1") == ["reason": "rp_not_configured"])
    #expect(f.source.policy.passkey == nil)
  }

  @Test("a plain confirm is declined -32601 while the app has no plain sheet")
  func plainDeclined() async throws {
    let f = await Self.fixture()
    var params = Self.params(ids: [f.phone.id])
    params["level"] = "plain"
    params["passkey"] = nil
    try await raise(f, params)

    #expect(f.link.declines.first?.code == JSONRPCError.methodNotFound)
    #expect(f.model.confirmation("srq-1") == nil)
  }

  // MARK: - Advertising

  @Test("the policy advertises passkey only once a credential for this RP is known")
  func policy() async throws {
    let f = await Self.fixture()
    #expect(f.source.policy.passkey?.hasCredential == false)
    #expect(f.source.policy.passkey?.rpID == Self.rpID)

    let known = PasskeyPinRecord(
      gatewayID: Base64URL.encode(Self.gatewayID),
      knownCredentialIDs: ["a"],
      appCredentialIDs: ["a"],
      seenAt: 1
    )
    let g = await Self.fixture(pins: ["gw-1": known, "gw-2": PasskeyPinRecord(gatewayID: "other", seenAt: 1)])
    #expect(g.source.policy.passkey?.hasCredential == true)
    #expect(g.source.policy.passkey?.pinnedGatewayID == Base64URL.encode(Self.gatewayID))
    #expect(g.source.policy.passkey?.foreignGatewayIDs == ["other"])
  }

  @Test("passkey.changed for a credential this device did not add leaves a notice")
  func changedElsewhere() async throws {
    let f = await Self.fixture()
    f.link.emit(
      "passkey.changed",
      session: "",
      payload: ["change": "added", "credential": ["id": "zzz", "name": "Laptop — gw.example.com", "rp_id": "gw.example.com"]]
    )

    try await eventually("the notice") { @MainActor in !f.model.notices.isEmpty }
    #expect(f.model.notices.map(\.kind) == [.credentialAdded(name: "Laptop — gw.example.com")])
  }

  @Test("a new passkey's name carries the path prefix of a gateway served under one")
  func credentialNameWithPath() throws {
    let configuration = PasskeyConfiguration(rpID: Self.rpID, displayName: "Phone")
    let baseURL = try GatewayAddress.passkeyBaseURL(of: "https://gw.example.com/hermes/")
    #expect(configuration.credentialName(host: ConfirmDisplay.subject("", baseURL: baseURL).host) == "Phone — gw.example.com/hermes")
  }
}

/// An authenticator whose every ceremony fails with `error`.
struct FailingAuthenticator: PasskeyAuthenticator {
  let error: PasskeyCeremonyError

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    throw error
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    throw error
  }

  func cancel() async {}
}
