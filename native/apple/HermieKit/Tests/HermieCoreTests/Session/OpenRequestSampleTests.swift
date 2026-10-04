import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Observation
import Synchronization
import Testing

@testable import HermieCore

/// What the session reports as open, from the four places that hold a request: the transcript's
/// approvals, questions and cards, the secure prompts, the interactive requests and the passkey
/// confirmations. `RequestAlerts` is built from it.
@Suite("Open requests as the session reports them", .timeLimit(.minutes(1))) @MainActor
struct OpenRequestSampleTests {
  private func opened() async throws -> InteractiveHarness {
    let h = InteractiveHarness()
    h.link.respond(to: RPC.ApprovalReceived.name, with: ["acknowledged": true])
    h.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": [["request_id": "appr-1"]]])
    try await h.open()
    return h
  }

  private func listed(_ session: GatewaySession) async -> [OpenRequest] {
    await session.openRequests(from: session.openRequestSample()).requests
  }

  @Test("an approval, a form and a secret are each listed once under their chat, and go when they end")
  func listsAndDrops() async throws {
    let h = try await opened()
    let session = h.session
    // A chat screen is up for this chat; the others below are not (`unobservedChat`).
    let requests = RequestsModel(chat: session.chat(Fixture.profile))

    #expect(await listed(session).isEmpty)
    #expect(session.openRequestSample().ready)

    h.link.raise(
      id: "srq-appr", method: "approval",
      params: [
        "session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "rm -rf ./build",
        "description": "Delete the build folder", "choices": ["once", "deny"]
      ])
    try await h.harness.frame()
    try await eventually("the approval to be listed") { await session.openAsks[Fixture.profile]?.count == 1 }

    try await h.raiseOpen("srq-f")
    try await h.harness.frame()

    h.link.raise(
      id: "srq-s", method: "secret",
      params: ["session_id": .string(Fixture.runtime), "env_var": "API_KEY", "prompt": "Paste the key"])
    try await eventually("the secret to open") { await session.secureInput.isOpen("srq-s") }

    let all = await listed(session)
    #expect(Set(all.map(\.requestId)) == ["appr-1", "srq-f", "srq-s"], "the approval is named by its queue id")
    #expect(all.count == 3, "a form's card and its prompt are one request")
    #expect(all.allSatisfy { $0.chat == Fixture.profile && $0.gatewayId == session.gatewayID })
    #expect(all.allSatisfy { $0.chatName == session.chatName(Fixture.profile) })

    let approval = try #require(all.first { $0.requestId == "appr-1" })
    #expect(approval.method == "approval")
    #expect(approval.text == "Delete the build folder", "its description, never its command")

    let secret = try #require(all.first { $0.requestId == "srq-s" })
    #expect(secret.method == "secret")
    #expect(secret.sessionId == Fixture.runtime)
    #expect(secret.text == "", "a secure prompt carries nothing to show")
    #expect(!String(describing: all).contains("API_KEY"))

    // Over on the gateway's side: cancelled, expired.
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "srq-f", "method": "input.form", "reason": "timeout"])
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "srq-s", "method": "secret", "reason": "interrupted"])
    try await h.harness.frame()
    try await eventually("the form and the secret to end") { await listed(session).map(\.requestId) == ["appr-1"] }

    // Answered here.
    try await eventually("the chat to show it") { await requests.openRequests.count == 1 }
    await requests.answerApproval("srq-appr", choice: "once")
    try await h.harness.frame()
    try await eventually("the approval to end") { await listed(session).isEmpty }
  }

  @Test("a chat that no screen observes is listed too")
  func unobservedChat() async throws {
    let h = try await opened()
    let session = h.session

    // No `chat(_:)` was ever asked for: only the chat list's summaries know about it.
    h.link.raise(
      id: "srq-appr", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "ls", "choices": ["once", "deny"]])
    try await h.harness.frame()
    try await eventually("the approval to be listed") { await listed(session).count == 1 }

    #expect(session.openAsks[Fixture.profile]?.first?.requestId == "appr-1")
  }

  @Test("openAsks moves only when what is open does")
  func asksMoveOnlyOnChange() async throws {
    let session = SessionHarness().session

    func summary(_ asks: [OpenAsk]) -> FrameBatch {
      var batch = FrameBatch()
      batch.summaries = [
        "scout": ChatSummary(
          key: "scout", preview: nil, unread: 0, needsInput: !asks.isEmpty, busy: false, hydration: .cold,
          attached: true, lastMessageAt: 0, asks: asks)
      ]
      return batch
    }

    func moved(_ batch: FrameBatch) -> Bool {
      let fired = Mutex(false)
      withObservationTracking { _ = session.openAsks } onChange: { fired.withLock { $0 = true } }
      session.applyAsks(batch)
      return fired.withLock { $0 }
    }

    let ask = OpenAsk(method: "approval", requestId: "appr-1")

    #expect(!moved(summary([])), "a chat with nothing open changes nothing")
    #expect(moved(summary([ask])))
    #expect(!moved(summary([ask])), "the same list again (a token of a reply) moves nothing")
    #expect(session.openAsks == ["scout": [ask]])
    #expect(moved(summary([])))
    #expect(session.openAsks.isEmpty)

    _ = moved(summary([ask]))
    var removal = FrameBatch()
    removal.removed = ["scout"]
    #expect(moved(removal), "a chat the store let go takes its requests with it")
    #expect(session.openAsks.isEmpty)
  }

  @Test("a passkey confirmation is placed in the chat that holds its session; one no chat holds yet is counted, not listed")
  func confirmations() async throws {
    let h = try await opened()
    let session = h.session
    let f = await PasskeyModelTests.fixture()

    var bound = PasskeyModelTests.params(ids: [f.phone.id])
    bound["session_id"] = .string(Fixture.runtime)
    try await PasskeyModelTests().raise(f, id: "srq-c1", bound)
    try await PasskeyModelTests().raise(f, id: "srq-c2")

    #expect(f.model.confirmations.count == 2)

    let sample = OpenRequestSample(requests: [], confirmations: f.model.confirmations, ready: true)
    let (requests, unresolved) = await session.openRequests(from: sample)

    #expect(unresolved == 1, "sess-1 is held by no chat")
    #expect(requests.count == 1)

    let confirm = try #require(requests.first)
    #expect(confirm.requestId == "srq-c1")
    #expect(confirm.method == "confirm")
    #expect(confirm.level == .passkey)
    #expect(confirm.chat == Fixture.profile)
    #expect(confirm.sessionId == Fixture.runtime)
    #expect(confirm.text == "", "the sheet's text and detail never leave the app")
  }
}
