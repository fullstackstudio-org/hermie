import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// How a confirmation ends on this device: withdrawn during the ceremony, expired, and `plain`
/// without a sheet.
@MainActor
@Suite struct PasskeyConfirmLifecycleTests {
  typealias T = PasskeyModelTests

  @Test("a request withdrawn while the system sheet is up sends nothing, even if the ceremony returns first")
  func withdrawnDuringCeremony() async throws {
    let blocking = BlockingAuthenticator()
    let f = await T.fixture(authenticator: blocking)
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await PasskeyModelTests().raise(f, T.params(ids: ["AQID"]))

    let confirming = Task { await f.model.confirm("srq-1") }
    try await eventually("the ceremony") { blocking.asserting }

    f.link.emit("request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": "timeout"])
    try await eventually("the cancel") { blocking.cancelling }

    // The ceremony finishes while `cancel()` is still running.
    blocking.finishAssertion()
    await confirming.value
    blocking.finishCancel()

    #expect(f.link.calls("request.answer").isEmpty, "no answer for a withdrawn request")
    try await eventually("timed out") { @MainActor in f.model.confirmation("srq-1")?.phase == .ended(.timedOut) }
  }

  @Test("a request past expires_at ends locally as timed out and runs no ceremony")
  func expired() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id], expiresAt: 1_789_999_000))

    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
    #expect(f.phone.ceremonies == 0)
    #expect(f.link.calls("request.answer").isEmpty)
  }

  @Test("with plain advertised but no plain sheet, a plain confirm is still answered")
  func plainWithoutSheet() async throws {
    let f = await T.fixture(plain: true)
    var params = T.params(ids: [f.phone.id])
    params["level"] = "plain"
    params["passkey"] = nil
    try await PasskeyModelTests().raise(f, params)

    #expect(f.link.declines.map(\.id) == ["srq-1"])
    #expect(f.model.confirmation("srq-1") == nil)
  }
}

/// An authenticator whose assertion and cancel each wait until the test lets them finish.
final class BlockingAuthenticator: PasskeyAuthenticator {
  private struct State {
    var asserting = false
    var cancelling = false
    var assertion: CheckedContinuation<Void, Never>?
    var cancel: CheckedContinuation<Void, Never>?
  }

  private let state = Mutex(State())

  var asserting: Bool { state.withLock { $0.asserting } }
  var cancelling: Bool { state.withLock { $0.cancelling } }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    throw .unavailable(reason: "not_in_this_test")
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    await withCheckedContinuation { continuation in
      state.withLock {
        $0.asserting = true
        $0.assertion = continuation
      }
    }

    return PasskeyAssertionResponse(
      credentialID: request.allowCredentialIDs[0],
      authenticatorData: Array(repeating: 1, count: 37),
      clientDataJSON: Array("{}".utf8),
      signature: [0x30, 0x00],
      userHandle: nil
    )
  }

  func cancel() async {
    await withCheckedContinuation { continuation in
      state.withLock {
        $0.cancelling = true
        $0.cancel = continuation
      }
    }
  }

  func finishAssertion() {
    state.withLock { $0.assertion }?.resume()
  }

  func finishCancel() {
    state.withLock { $0.cancel }?.resume()
  }
}
