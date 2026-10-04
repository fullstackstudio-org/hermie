#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

@MainActor
private func activityWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, connected and with its roster read; shut down after the body, however it
/// ends. At file scope, outside the main actor, where `FakeGateway.with` can take it.
private func withActivitySession(
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await activitySession(gateway)

    do {
      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

@MainActor
private func activitySession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-activity", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await activityWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows["researcher"] != nil
  }

  return session
}

extension Integration {
  /// The Activity timeline against the real fake gateway: the researcher's Bot Chat holds a
  /// `message_agent` hand-off to the writer and the teammate's answer, and the timeline shows it without
  /// the chat ever having been opened.
  @Suite("Activity") @MainActor
  struct ActivityIntegrationTests {
    private func withSession(
      _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
    ) async throws {
      try await withActivitySession(body)
    }

    @Test("a bot's hand-off to another shows on the timeline from its chat's tail, with no chat opened")
    func showsTheHandOffFromTheTail() async throws {
      try await withSession { session in
        let model = session.activity()

        await model.refresh()

        #expect(model.phase == .ready)
        let entry = try #require(model.entries.first { $0.botName == "researcher" && $0.toHandle == "writer" })
        #expect(entry.fromHandle == "researcher")
        #expect(entry.text.contains("draft the announcement"))
        #expect(entry.kind == .dmOut || entry.kind == .dmReply)
        #expect(model.days.flatMap(\.entries).contains { $0.id == entry.id })
        #expect(model.displayName(forHandle: "researcher") == session.chatList.rows["researcher"]?.bot.displayName)
        #expect(model.knows(bot: entry.botName), "a tap can open its chat")
      }
    }

    @Test("the counters are read from the gateway")
    func counters() async throws {
      try await withSession { session in
        let model = session.activity()

        await model.refresh()

        #expect(model.counters.botsWorking == 0)
        #expect(model.counters.activeSubagents == 0)
        #expect(model.counters.inFlightDeliveries == 0)
      }
    }

    @Test("a chat that is live is the timeline's truth, and reading again does not lose its rows")
    func aLiveChatIsKept() async throws {
      try await withSession { session in
        let model = session.activity()
        await model.refresh()
        let tailed = model.entries.count

        try await session.open("researcher")
        await model.refresh()

        #expect(model.entries.count >= 1)
        #expect(model.entries.contains { $0.botName == "researcher" && $0.toHandle == "writer" })
        #expect(tailed >= 1)
      }
    }
  }
}
#endif
