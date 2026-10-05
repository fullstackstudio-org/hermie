#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"
private let writer = "writer"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func stopWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
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
private func withStopGateway(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with `bot`'s chat open and its composer.
@MainActor
private struct Client {
  let session: GatewaySession
  let composer: ComposerModel

  static func open(_ gateway: FakeGateway, id: String, bot: String) async throws -> Client {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(id: id, name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let client = Client(session: session, composer: ComposerModel(session: session, bot: bot))

    await session.start()
    try await stopWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[bot] != nil
    }
    try await session.open(bot)
    try await stopWait("the chat to accept a message") { client.composer.canSend }
    return client
  }

  /// Send the long prompt and wait until the reply is streaming.
  func startLongTurn() async throws {
    composer.draft = "give me the long version"
    await composer.submit()
    try await stopWait("the reply to stream") { composer.running }
  }
}

extension Integration {
  /// The emergency stop against the real fake gateway, over real sockets: the app's own running chat
  /// and another client's turn on the same gateway are both interrupted, and the summary says so.
  @Suite("Emergency stop") @MainActor
  struct EmergencyStopIntegrationTests {
    @Test("every running turn is stopped: the app's own chat through its Stop, another client's session by its id")
    func stopsEverythingThatRuns() async throws {
      try await withStopGateway(FakeGateway.Options(streamDelayMs: 60)) { gateway in
        let app = try await Client.open(gateway, id: "g-app", bot: researcher)
        let other = try await Client.open(gateway, id: "g-other", bot: writer)

        try await app.startLongTurn()
        try await other.startLongTurn()

        let stopGateway = SessionStopGateway(session: app.session, name: "fake")
        let model = EmergencyStopModel(gateways: { [stopGateway] })

        await model.begin()

        guard case .confirming(let plan) = model.phase else {
          Issue.record("expected a question, got \(model.phase)")
          return
        }

        #expect(plan.total == 2, "both turns: \(plan.entries.flatMap(\.turns))")

        let turns = plan.entries.flatMap(\.turns)
        let own = try #require(turns.first { $0.chatKey == researcher })
        let foreign = try #require(turns.first { $0.chatKey == nil })
        #expect(foreign.botName == app.session.chatName(writer), "named by the bot the gateway lists it under")
        #expect(own.id != foreign.id)

        await model.confirm()

        guard case .finished(let summary) = model.phase else {
          Issue.record("expected a summary, got \(model.phase)")
          return
        }

        #expect(summary.stopped == 2)
        #expect(summary.failed == 0)
        #expect(summary.records.allSatisfy { $0.outcome == .stopped })

        try await stopWait("the app's own turn to end") { !app.composer.turnActive }
        try await stopWait("the other client's turn to end") { !other.composer.turnActive }
        #expect(await app.session.store.runningSessions().held.isEmpty)
        #expect(await app.session.store.runningSessions().other.isEmpty, "nothing runs on the gateway any more")

        // Asking again finds nothing.
        await model.begin()
        guard case .finished(let idle) = model.phase else {
          Issue.record("expected an idle summary, got \(model.phase)")
          return
        }
        #expect(idle.wasIdle)

        await app.session.shutdown()
        await other.session.shutdown()
      }
    }

    @Test("an approval the gateway raises is in the Needs you list with its bot, and leaves when it is answered")
    func inboxFollowsTheGateway() async throws {
      try await withStopGateway { gateway in
        let app = try await Client.open(gateway, id: "g-app", bot: researcher)
        let session = app.session
        let requests = RequestsModel(session: session, bot: researcher)
        let inbox = NeedsYouInbox()

        @MainActor func refresh() async {
          let sample = session.openRequestSample()
          let (open, _) = await session.openRequests(from: sample)
          inbox.update(
            gatewayId: session.gatewayID, gatewayName: "fake", gatewayKey: "", requests: open,
            connections: sample.connections, chatName: { session.chatName($0) }, authoritative: sample.ready)
        }

        try await gateway.raiseRequest(
          "approval",
          params: ["request_id": "appr-inbox", "command": "rm -rf ./build", "description": "Delete the build folder", "choices": ["once", "deny"]]
        )
        try await stopWait("the approval to be listed") {
          await refresh()
          return inbox.count == 1
        }

        let item = try #require(inbox.items.first)
        #expect(item.kind == .approval)
        #expect(item.requestId == "appr-inbox")
        #expect(item.bot == researcher)
        #expect(item.title(copy: .english) == "Needs your approval: Delete the build folder", "its description, never its command")
        #expect(!item.title(copy: .english).contains("rm -rf"))

        let card = try #require(requests.openRequests.first { $0.asApproval?.approvalID == "appr-inbox" }?.asApproval)
        await requests.answerApproval(card.requestID, choice: "once")
        try await stopWait("the approval to leave the list") {
          await refresh()
          return inbox.isEmpty
        }

        await session.shutdown()
      }
    }

    @Test("with nothing running the stop says so and sends no interrupt")
    func nothingToStop() async throws {
      try await withStopGateway { gateway in
        let app = try await Client.open(gateway, id: "g-app", bot: researcher)
        let model = EmergencyStopModel(gateways: { [SessionStopGateway(session: app.session, name: "fake")] })

        await model.begin()

        guard case .finished(let summary) = model.phase else {
          Issue.record("expected an idle summary, got \(model.phase)")
          return
        }

        #expect(summary.wasIdle)
        await app.session.shutdown()
      }
    }
  }
}
#endif
