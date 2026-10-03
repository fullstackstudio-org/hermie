import Foundation
import Testing

@testable import HermieProtocol

/// The wire objects of `contract/confirm-passkey/README.md` §8, read through the typed views
/// from `vectors.json` → `wire_examples`, and the shapes this client builds compared with them.
@Suite struct ConfirmPasskeyWireTests {
  static func example(_ key: String) throws -> JSONValue {
    let vectors = try loadContract("confirm-passkey/vectors.json")
    return try #require(vectors["wire_examples"]?[key], "wire_examples.\(key)")
  }

  @Test("a confirm frame at level passkey reads into its typed request")
  func confirmFrame() throws {
    let frame = try #require(ServerRequest(jsonValue: try Self.example("confirm_request_frame")))

    guard case .confirm(let params) = frame.body else {
      Issue.record("not read as confirm: \(frame.body.method)")
      return
    }

    #expect(frame.id == "srq-3f9a0c41d2e8")
    #expect(params.level == .passkey)
    #expect(params.sessionID == "sess-7Q2xK")
    #expect(params.title == "Pay invoice")
    #expect(params.detail == "IBAN NL00 TEST 0123 4567 89\nReference 2026-114")

    let passkey = try #require(params.passkey)
    #expect(passkey.v == 1)
    #expect(passkey.gatewayID == "2kvwXlBOqzLxDCPyRKi-lQ")
    #expect(passkey.baseURL == "https://gw.example.com")
    #expect(passkey.expiresAt == 1_790_000_120)
    #expect(passkey.user?.id == "self_hosted:7c1f0e2a")
    #expect(passkey.credentials?.map(\.rpID) == ["confirm.hermie.dev", "gw.example.com"])
    #expect(passkey.credentials?.first?.ids == ["A8IUBl84vRTMaBj6dOc0nTQa9s8D9cYvLoqdAfgcaRo"])

    // Lossless: the frame goes back out exactly as it came.
    #expect(try canonical(frame) == canonical(try Self.example("confirm_request_frame")))
    #expect(!frame.body.isSecureInput)
  }

  @Test("the decline is exactly {decision: declined, method: tap}")
  func decline() throws {
    #expect(try canonical(ConfirmResult.declined) == canonical(try Self.example("result_declined")))
    #expect(ConfirmResult.declined.json.keys.sorted() == ["decision", "method"])
  }

  @Test("a passkey answer carries the assertion and never verified")
  func passkeyAnswer() throws {
    let assertion = PasskeyAssertion(
      rpID: "confirm.hermie.dev",
      baseURL: "https://gw.example.com",
      credentialID: "A8IU",
      authenticatorData: "K-iE",
      clientDataJSON: "eyJ0",
      signature: "MEQC",
      userHandle: nil
    )
    let result = ConfirmResult.confirmed(assertion)

    #expect(result.json.keys.sorted() == ["decision", "method", "passkey"])
    #expect(result.decision == .confirmed)
    #expect(result.method == .passkey)
    #expect(result.verified == nil)
    #expect(
      result.passkey?.json.keys.sorted()
        == ["authenticator_data", "base_url", "client_data_json", "credential_id", "rp_id", "signature", "v"]
    )
    #expect(result.passkey?.v == 1)
    #expect("\(assertion)" == "PasskeyAssertion(<redacted>)")
  }

  @Test("the first capabilities result reads its confirm_passkey block")
  func firstResult() throws {
    let result = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result")))
    let passkey = try #require(result.confirmPasskey)

    #expect(result.serverRequests == ["approval", "clarify", "confirm"])
    #expect(result.confirm == [])
    #expect(passkey.v == 1)
    #expect(passkey.enabled == true)
    #expect(passkey.reason == "")
    #expect(passkey.gatewayID == "2kvwXlBOqzLxDCPyRKi-lQ")
    #expect(passkey.rp?.ids(for: .native) == ["confirm.hermie.dev"])
    #expect(passkey.rp?.ids(for: .web) == ["gw.example.com", "other.example.com"])

    let privateOnly = try #require(
      ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result_private_only"))
    )
    #expect(privateOnly.confirmPasskey?.enabled == false)
    #expect(privateOnly.confirmPasskey?.reason == "private_origin")

    let without = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_first_result_without_passkey")))
    #expect(without.confirmPasskey == nil)
  }

  @Test("the second-call params this client builds are the contract's")
  func secondCallParams() throws {
    var withPasskey = ClientCapabilitiesParams(serverRequests: true)
    withPasskey.confirm = [.plain, .passkey]
    withPasskey.confirmPasskey = ConfirmPasskeyAdvertisement(kind: .native, rpID: "confirm.hermie.dev")
    #expect(try canonical(withPasskey) == canonical(try Self.example("capabilities_second_call_params_with_passkey")))

    var plainOnly = ClientCapabilitiesParams(serverRequests: true)
    plainOnly.confirm = [.plain]
    #expect(try canonical(plainOnly) == canonical(try Self.example("capabilities_second_call_params_plain_only")))

    let second = try #require(ClientCapabilitiesResult(jsonValue: try Self.example("capabilities_second_result")))
    #expect(second.confirm == [.passkey, .plain])
  }

  @Test("the 4040 and 4034 errors read their reason")
  func errors() throws {
    let cannotRun = try #require(JSONRPCResponse(jsonValue: try Self.example("error_cannot_run_ceremony")))
    #expect(cannotRun.error?.code == 4040)
    #expect(cannotRun.error?.data?["reason"]?.stringValue == "no_credential")

    let built = ServerRequest(id: "srq-3f9a0c41d2e8", method: "confirm", params: [:])
      .fail(code: 4040, message: "passkey ceremony unavailable", data: ["reason": "no_credential"])
    #expect(try canonical(try #require(built)) == canonical(cannotRun))

    let refused = try #require(JSONRPCResponse(jsonValue: try Self.example("request_answer_refused")))
    #expect(refused.error?.code == 4034)
    #expect(refused.error?.data?["reason"]?.stringValue == "challenge_mismatch")
  }

  @Test("request.cancel reasons, the passkey ones included, stay open")
  func cancelReasons() {
    #expect(RequestCancelReason(rawValue: "verification_failed") == .verificationFailed)
    #expect(RequestCancelReason(rawValue: "too_many_attempts") == .tooManyAttempts)
    #expect(RequestCancelReason(rawValue: "resolved") == .resolved)
    #expect(RequestCancelReason(rawValue: "session_closed") == .sessionClosed)
    #expect(RequestCancelReason(rawValue: "cancelled:other") == .unknown("cancelled:other"))

    let payload = RequestCancelPayload(json: ["id": "srq-1", "method": "confirm", "reason": "verification_failed"])
    #expect(payload.cancelReason == .verificationFailed)
  }

  @Test("passkey.changed reads its credential")
  func passkeyChanged() {
    let payload = PasskeyChangedPayload(json: [
      "change": "added", "credential": ["id": "abc", "name": "Hermie — gw.example.com", "rp_id": "confirm.hermie.dev"],
      "at": 1_790_000_000
    ])
    #expect(PasskeyChangedPayload.eventType == "passkey.changed")
    #expect(payload.change == .added)
    #expect(payload.credential?.id == "abc")
    #expect(payload.credential?.rpID == "confirm.hermie.dev")
  }

  @Test("the enrolment body and an invite never show their code")
  func redaction() {
    let finish = PasskeyRegisterFinishParams(
      registrationID: "r1",
      baseURL: "https://gw.example.com",
      code: "M67B1PK0QJBTJWRQSSB2",
      credential: PasskeyNewCredential(id: "x", clientDataJSON: "y", attestationObject: "z", transports: ["internal"])
    )
    #expect(!"\(finish)".contains("M67B1"))
    #expect(!String(reflecting: finish).contains("M67B1"))
    #expect(finish.code == "M67B1PK0QJBTJWRQSSB2")

    let invite = PasskeyInviteResult(json: ["code": "M67B1-PK0QJ-BTJWR-QSSB2", "expires_at": 1])
    #expect(!"\(invite)".contains("M67B1"))
  }
}
