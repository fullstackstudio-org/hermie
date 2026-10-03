import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A confirmation's end against an answer in flight and an answer whose delivery is not known:
/// what the person is told must be true.
@MainActor
@Suite struct PasskeyConfirmDeliveryTests {
  typealias T = PasskeyModelTests

  nonisolated static let start: Double = 1_790_000_000

  /// A clock the test moves.
  final class Clock: Sendable {
    private let value = Mutex(PasskeyConfirmDeliveryTests.start)
    var now: Double { value.withLock { $0 } }
    func advance(_ seconds: Double) { value.withLock { $0 += seconds } }
  }

  /// A fixture whose frame expires `after` seconds from `clock`'s start, and the confirmation id.
  static func open(
    after: Double = 60,
    authenticator: any PasskeyAuthenticator = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
  ) async throws -> (T.Fixture, Clock) {
    let clock = Clock()
    let f = await T.fixture(authenticator: authenticator, now: { clock.now })
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id], expiresAt: start + after))
    return (f, clock)
  }

  /// Confirm, with the answer sent but not yet replied to.
  static func confirmInFlight(_ f: T.Fixture) async throws -> (Task<Void, Never>, ScriptedLink.Call) {
    let task = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")
    return (task, call)
  }

  /// Confirm, with the call failing without a reply: the assertion may have been delivered.
  static func confirmLosingTheReply(_ f: T.Fixture) async throws {
    let (task, call) = try await confirmInFlight(f)
    f.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await task.value
  }

  // MARK: - An answer in flight is not ended by the countdown

  @Test("the countdown reaching zero while an answer is in flight leaves it, and a late ok is received")
  func expiryDoesNotEndAnAnswerInFlight() async throws {
    let (f, clock) = try await Self.open()
    let (task, call) = try await Self.confirmInFlight(f)
    #expect(f.model.confirmation("srq-1")?.phase == .sending)

    clock.advance(61)
    await f.model.expireIfDue("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .sending, "the reply may still say received")

    f.link.answer(call, ["status": "ok"])
    await task.value
    #expect(f.model.confirmation("srq-1")?.phase == .received)
  }

  @Test("an answer in flight whose reply is lost after the deadline ends as unknown, not as timed out")
  func lostReplyAfterTheDeadline() async throws {
    let (f, clock) = try await Self.open()
    let (task, call) = try await Self.confirmInFlight(f)

    clock.advance(61)
    f.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await task.value

    #expect(f.model.confirmation("srq-1")?.answerMayHaveArrived == true)
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.outcomeUnknown))
  }

  @Test("a refused answer that comes back after the deadline ends the confirmation as timed out")
  func refusedAfterTheDeadline() async throws {
    let (f, clock) = try await Self.open()
    let (task, call) = try await Self.confirmInFlight(f)

    clock.advance(61)
    f.link.fail(call, GatewayRPCError(.rejected, "invalid", code: 4034, data: ["reason": "signature_invalid"]))
    await task.value

    #expect(f.model.confirmation("srq-1")?.answerMayHaveArrived == false)
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut), "the gateway said no: nothing was confirmed")
  }

  // MARK: - The system sheet goes with the deadline

  @Test("the countdown reaching zero during the ceremony ends it first, then cancels the system sheet")
  func expiryDuringTheCeremony() async throws {
    let blocking = BlockingAuthenticator()
    let (f, clock) = try await Self.open(authenticator: blocking)
    f.link.respond(to: "request.answer", with: ["status": "ok"])

    let confirming = Task { await f.model.confirm("srq-1") }
    try await eventually("the ceremony") { blocking.asserting }

    clock.advance(61)
    let expiring = Task { await f.model.expireIfDue("srq-1") }
    try await eventually("the cancel") { blocking.cancelling }
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut), "the phase moved before cancel() ran")

    // The ceremony returns while cancel() is still running: it finds the request over.
    blocking.finishAssertion()
    await confirming.value
    blocking.finishCancel()
    await expiring.value

    #expect(f.link.calls("request.answer").isEmpty, "nothing is sent for an expired request")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
  }

  // MARK: - Delivery that is not known

  @Test("a lost reply to an assertion is remembered and the retry sentence no longer claims anything")
  func lostReplyIsRemembered() async throws {
    let (f, _) = try await Self.open()
    #expect(f.model.confirmation("srq-1")?.answerMayHaveArrived == false)

    try await Self.confirmLosingTheReply(f)

    let after = try #require(f.model.confirmation("srq-1"))
    #expect(after.answerMayHaveArrived)
    guard case .notSent = after.phase else {
      Issue.record("expected notSent, got \(after.phase)")
      return
    }
  }

  @Test("a lost reply to a decline does not make delivery uncertain for an assertion")
  func lostDeclineIsNotAnAssertion() async throws {
    let (f, clock) = try await Self.open()
    let task = Task { await f.model.decline("srq-1") }
    let call = try await f.link.pendingCall("request.answer")
    f.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await task.value
    #expect(f.model.confirmation("srq-1")?.answerMayHaveArrived == false)

    clock.advance(61)
    await f.model.expireIfDue("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
  }

  @Test("after a lost reply the countdown ends it as unknown, never as timed out")
  func lostReplyThenExpiry() async throws {
    let (f, clock) = try await Self.open()
    try await Self.confirmLosingTheReply(f)

    clock.advance(61)
    await f.model.expireIfDue("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.outcomeUnknown))
  }

  @Test("after a lost reply a Decline the gateway no longer knows ends as unknown")
  func lostReplyThenDeclineNotOpen() async throws {
    let (f, _) = try await Self.open()
    try await Self.confirmLosingTheReply(f)

    f.link.respond(to: "request.answer", with: ["status": "expired"])
    await f.model.decline("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.outcomeUnknown))
  }

  @Test("after a lost reply a Decline the gateway took is declined: the request was still open")
  func lostReplyThenDeclineOK() async throws {
    let (f, _) = try await Self.open()
    try await Self.confirmLosingTheReply(f)

    f.link.respond(to: "request.answer", with: ["status": "ok"])
    await f.model.decline("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .declined)
  }

  @Test("after a lost reply a retry the gateway no longer knows ends as unknown; one it took is received")
  func lostReplyThenRetry() async throws {
    let (f, _) = try await Self.open()
    try await Self.confirmLosingTheReply(f)

    f.link.respond(to: "request.answer", with: ["status": "expired"])
    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.outcomeUnknown))

    let (g, _) = try await Self.open()
    try await Self.confirmLosingTheReply(g)
    g.link.respond(to: "request.answer", with: ["status": "ok"])
    await g.model.confirm("srq-1")
    #expect(g.model.confirmation("srq-1")?.phase == .received)
  }

  @Test("after a lost reply the gateway's own words keep their meaning, and the others become unknown")
  func lostReplyThenTheGatewayCancels() async throws {
    let cases: [(String, PasskeyConfirmPhase)] = [
      ("resolved", .ended(.outcomeUnknown)), ("timeout", .ended(.outcomeUnknown)),
      ("session_closed", .ended(.outcomeUnknown)), ("verification_failed", .ended(.verificationFailed)),
      ("too_many_attempts", .ended(.tooManyAttempts))
    ]

    for (reason, expected) in cases {
      let (f, _) = try await Self.open()
      try await Self.confirmLosingTheReply(f)

      f.link.emit(
        "request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": .string(reason)])
      try await eventually(reason) { @MainActor in f.model.confirmation("srq-1")?.phase == expected }
    }
  }

  @Test("without a lost reply the same endings keep their usual words")
  func usualWords() async throws {
    let (f, clock) = try await Self.open()
    clock.advance(61)
    await f.model.expireIfDue("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
  }

  // MARK: - The deadline

  @Test("a frame without expires_at is not answered and says so")
  func missingExpiry() async throws {
    let f = await T.fixture()
    var params = T.params(ids: [f.phone.id])
    var passkey = try #require(params["passkey"]?.objectValue)
    passkey["expires_at"] = nil
    params["passkey"] = .object(passkey)
    try await PasskeyModelTests().raise(f, params)

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.model.notices.contains { $0.kind == .malformedRequest })
  }

  @Test("the local deadline is at most 120 seconds after arrival, whatever expires_at says")
  func deadlineIsCapped() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id], expiresAt: Self.start + 86_400))

    let shown = try #require(f.model.confirmation("srq-1"))
    #expect(shown.expiresAt == Date(timeIntervalSince1970: Self.start + 120))
  }

  @Test("a frame that is over on arrival shows a notice and no sheet")
  func expiredOnArrival() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id], expiresAt: Self.start - 5))

    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
    #expect(f.model.notices.contains { $0.kind == .expiredOnArrival })
  }

  @Test("the name of a passkey in a notice is one bounded line, whatever the gateway sent")
  func noticeNamesAreBounded() async throws {
    let f = await T.fixture()
    let hostile = "Work\u{202E}laptop\n" + String(repeating: "x", count: 500)
    f.model.notify(.credentialAdded(name: hostile))

    guard case .credentialAdded(let shown)? = f.model.notices.first?.kind else {
      Issue.record("expected a notice")
      return
    }

    #expect(!shown.contains("\u{202E}"))
    #expect(!shown.contains("\n"))
    #expect(shown.count <= SecurePrompt.nameLimit + 1)
    #expect(shown.hasPrefix("Work"))
  }
}
