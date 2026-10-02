#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// Wait for a condition the runtime reaches on its own; a cap only turns a
/// hang into a failure.
@MainActor
private func composerWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
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
private func withComposerGateway(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with the researcher's chat open, and the
/// composer and requests models a chat screen would hold.
@MainActor
private struct OpenChat {
  let session: GatewaySession
  let composer: ComposerModel
  let requests: RequestsModel

  static func open(_ gateway: FakeGateway) async throws -> OpenChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(
      id: "g-composer", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = OpenChat(
      session: session,
      composer: ComposerModel(session: session, bot: researcher),
      requests: RequestsModel(session: session, bot: researcher)
    )

    await session.start()
    try await composerWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    try await composerWait("the chat to accept a message") { chat.composer.canSend }
    return chat
  }

  /// Answers to server requests, as the fake logged them (`result` as JSON text).
  static func answers(_ gateway: FakeGateway) async throws -> [String] {
    let state = try await gateway.control("GET", "/__fake/state")
    return (state["serverRequestAnswers"]?.arrayValue ?? []).compactMap { answer in
      answer["result"].map { String(decoding: (try? $0.canonicalData()) ?? Data(), as: UTF8.self) }
    }
  }
}

extension Integration {
  /// The composer and the request answering against the real fake gateway, over
  /// real sockets: `ComposerModel` and `RequestsModel` on a `GatewaySession`.
  @Suite("Composer and requests") @MainActor
  struct ComposerIntegrationTests {
    @Test("a message is sent, its reply streams, and Stop ends it with the partial reply kept")
    func sendStreamStop() async throws {
      try await withComposerGateway(FakeGateway.Options(streamDelayMs: 60)) { gateway in
        let chat = try await OpenChat.open(gateway)
        let composer = chat.composer
        let before = composer.chat.items.count

        composer.draft = "give me the long version"
        await composer.submit()
        #expect(composer.lastEvent?.event == .sent)
        #expect(composer.draft.isEmpty)

        // One snapshot: the streaming reply's id and what it said so far.
        try await composerWait("the reply to stream") {
          (composer.chat.items.last?.item.asAssistant?.text.count ?? 0) > 40 && composer.running
        }
        let streaming = try #require(composer.chat.items.last?.item.asAssistant)

        await composer.stop()
        #expect(composer.lastEvent?.event == .stopped)
        #expect(composer.notice == nil)
        // The interrupted completion is the last frame of the turn: the gateway
        // sends nothing of the reply after it (`interrupt.test.ts` in the fake).
        try await composerWait("the turn to end") { !composer.turnActive }

        // The same item, with at least the words seen before Stop.
        let kept = try #require(
          composer.chat.items.lazy.compactMap(\.item.asAssistant).first { $0.id == streaming.id },
          "the reply that was streaming is still there")
        #expect(kept.text.hasPrefix(streaming.text), "the partial reply is kept: \(kept.text.count) of \(streaming.text.count)")
        #expect(!kept.streaming)
        // Nothing of the stopped reply arrives as a reply of its own afterwards.
        let last = try #require(composer.chat.items.last { $0.item.asAssistant != nil }?.item.asAssistant)
        #expect(last.status == .interrupted, "the turn ends on the stopped reply, not on a later one (\(last.id))")
        #expect(composer.chat.items.count > before)
        await chat.session.shutdown()
      }
    }

    @Test("an approval raised through the fake is allowed, and another denied")
    func approveAndDeny() async throws {
      try await withComposerGateway { gateway in
        let chat = try await OpenChat.open(gateway)
        let requests = chat.requests

        for (queueID, choice) in [("appr-int-allow", "once"), ("appr-int-deny", "deny")] {
          try await gateway.raiseRequest(
            "approval",
            params: ["request_id": .string(queueID), "command": "rm -rf ./build", "choices": ["once", "deny"]]
          )
          try await composerWait("the \(queueID) card") {
            requests.openRequests.contains { $0.asApproval?.approvalID == queueID }
          }
          let card = try #require(requests.openRequests.first { $0.asApproval?.approvalID == queueID }?.asApproval)

          await requests.answerApproval(card.requestID, choice: choice)
          #expect(requests.phase(of: card.requestID) == nil)
          #expect(requests.notice == nil, "re-validated: approval.pending lists it")
          try await composerWait("the card to close") { requests.openRequests.isEmpty }
          #expect(try await OpenChat.answers(gateway).last == "{\"choice\":\"\(choice)\"}")
        }

        #expect(try await OpenChat.answers(gateway).count == 2)
        await chat.session.shutdown()
      }
    }

    @Test("an approval answered elsewhere is closed with a notice, and nothing is sent")
    func approvalAnsweredElsewhere() async throws {
      try await withComposerGateway { gateway in
        let chat = try await OpenChat.open(gateway)
        let requests = chat.requests

        try await gateway.raiseRequest(
          "approval", params: ["request_id": "appr-elsewhere", "command": "ls", "choices": ["once", "deny"]])
        try await composerWait("the card") { !requests.openRequests.isEmpty }
        let card = try #require(requests.openRequests.first?.asApproval)

        // Another client answers it through the queue: approval.pending stops listing it.
        let runtimeID = try #require(await chat.session.store.state(of: researcher)?.runtimeSessionID)
        _ = try await chat.session.link.requestReply(
          RPC.ApprovalRespond.name,
          params: ["session_id": .string(runtimeID), "choice": "deny", "request_id": "appr-elsewhere"]
        )

        await requests.answerApproval(card.requestID, choice: "once")
        #expect(requests.notice?.notice == .noLongerPending)
        try await composerWait("the card to close") { requests.openRequests.isEmpty }
        #expect(try await OpenChat.answers(gateway).isEmpty, "nothing answered on the request's reply")
        await chat.session.shutdown()
      }
    }

    @Test("a clarify is answered with an option, and another in free text")
    func clarify() async throws {
      try await withComposerGateway { gateway in
        let chat = try await OpenChat.open(gateway)
        let requests = chat.requests

        for (question, answer) in [("Which branch?", "main"), ("What should it be called?", "Spring cleaning")] {
          let params: JSONObject =
            answer == "main" ? ["question": .string(question), "choices": ["main", "next"]] : ["question": .string(question)]
          try await gateway.raiseRequest("clarify", params: params)
          try await composerWait("the clarify card") { !requests.openRequests.isEmpty }
          let card = try #require(requests.openRequests.first?.asClarify)
          let qid = try #require(card.questions.first?.qid)

          await requests.answerClarify(card.requestID, answers: [qid: answer])
          try await composerWait("the card to close") { requests.openRequests.isEmpty }
          #expect(try await OpenChat.answers(gateway).last == "{\"answer\":\"\(answer)\"}")
        }
        await chat.session.shutdown()
      }
    }
  }
}
#endif
