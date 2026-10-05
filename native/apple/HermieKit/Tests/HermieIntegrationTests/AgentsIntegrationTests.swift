#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

@MainActor
private func agentsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(20))
  }
}

/// A session on the fake gateway, connected and with its roster read; shut down after the body, however it
/// ends. At file scope, outside the main actor, where `FakeGateway.with` can take it.
private func withAgentsSession(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in
    let session = try await agentsSession(gateway)

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
private func agentsSession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-agents", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await agentsWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows["researcher"] != nil
  }

  return session
}

extension Integration {
  /// The agents overview against the real fake gateway, over real sockets and the real REST cron list: who is
  /// idle, who runs, who waits for the person, which sub-agents run and which crons are next.
  @Suite("Agents overview") @MainActor
  struct AgentsIntegrationTests {
    /// The researcher's chat open, with a prompt sent.
    private func send(_ text: String, on session: GatewaySession, bot: String = "researcher") async throws {
      try await session.open(bot)
      let composer = ComposerModel(session: session, bot: bot)

      try await agentsWait("the chat to accept a message") { composer.canSend }
      composer.draft = text
      await composer.submit()
    }

    @Test("with nothing running every bot is idle, and the crons of the gateway are read with their next run")
    func idleWithCrons() async throws {
      try await withAgentsSession { session in
        let model = session.agents()

        await model.refresh()

        #expect(model.phase == .ready)
        #expect(model.overview.rows.count >= 2, "the roster's bots")
        #expect(model.overview.rows.allSatisfy { $0.state == .idle }, "\(model.overview.rows.map(\.state))")
        #expect(model.overview.isComplete, "session.active_list was read")
        #expect(model.overview.running == 0 && model.overview.waiting == 0)
        #expect(model.overview.subagentCount == 0)

        #expect(model.overview.cronsKnown, "the cron list came over REST")
        #expect(!model.overview.upcoming.isEmpty)
        let soonest = try #require(model.overview.upcoming.first)
        #expect(soonest.nextRunAt > Date(), "a next run is in the future")
        #expect(model.overview.upcoming.map(\.nextRunAt) == model.overview.upcoming.map(\.nextRunAt).sorted())

        let researcher = try #require(model.overview.row(for: "researcher"))
        #expect(researcher.nextCron?.name == "Source scan", "the researcher's own cron, from its profile")
        #expect(researcher.bot.displayName == session.chatList.rows["researcher"]?.bot.displayName)
      }
    }

    @Test("a bot with a turn running is running, the others are not, and it is idle again when the turn is stopped")
    func runningThenIdle() async throws {
      try await withAgentsSession(FakeGateway.Options(streamDelayMs: 120)) { session in
        let model = session.agents()
        await model.refresh()

        try await send("give me the long version", on: session)
        try await agentsWait("the researcher to be listed as running") {
          await model.refreshLive()
          return model.overview.row(for: "researcher")?.state == .running
        }

        let row = try #require(model.overview.row(for: "researcher"))
        #expect(row.startedAt != nil, "the gateway says when the session started")
        #expect(model.overview.row(for: "writer")?.state == .idle)
        #expect(model.overview.running == 1)
        #expect(model.overview.rows.first?.bot.name == "researcher", "what runs is listed before what does not")

        let stopped = try await session.store.interruptSession(
          try #require(await session.store.runningSessions().held.first).runtimeID)
        #expect(stopped)

        try await agentsWait("the researcher to be idle again") {
          await model.refreshLive()
          return model.overview.row(for: "researcher")?.state == .idle
        }
      }
    }

    @Test("a bot parked on an approval is waiting for you, by the gateway's own status")
    func waitingOnAnApproval() async throws {
      try await withAgentsSession(FakeGateway.Options(streamDelayMs: 20)) { session in
        let model = session.agents()
        await model.refresh()

        try await send("please approve this", on: session)
        try await agentsWait("the researcher to be waiting") {
          await model.refreshLive()
          return model.overview.row(for: "researcher")?.state == .waiting
        }

        #expect(model.overview.waiting == 1)
        #expect(model.overview.running == 0)
        #expect(model.overview.rows.first?.bot.name == "researcher", "waiting comes first")
        #expect(model.overview.row(for: "writer")?.state == .idle)
      }
    }

    @Test("the sub-agents of a delegation show under the bot that runs them while they run")
    func subagents() async throws {
      try await withAgentsSession(FakeGateway.Options(streamDelayMs: 20)) { session in
        let model = session.agents()
        await model.refresh()

        try await send("please delegate this", on: session)
        try await agentsWait("sub-agents to be running") {
          await model.refreshLive()
          return model.overview.subagentCount > 0
        }

        let row = try #require(model.overview.row(for: "researcher"))
        #expect(!row.subagents.isEmpty)
        #expect(row.subagents.allSatisfy { !$0.id.isEmpty })
        #expect(row.subagents.contains { $0.goal == "Audit the dependencies" }, "\(row.subagents.map(\.goal))")
        #expect(model.overview.subagents.allSatisfy { $0.bot.name == "researcher" })
        #expect(model.overview.row(for: "writer")?.subagents.isEmpty == true)
      }
    }

    @Test("a cron created on the gateway shows up in the schedule when the gateway says the crons changed")
    func cronBroadcast() async throws {
      try await withAgentsSession { session in
        let model = session.agents()
        await model.refresh()
        let before = model.overview.upcoming.count

        let watching = Task { @MainActor in await model.watchCrons() }
        // Let the watcher subscribe before the change.
        try await Task.sleep(for: .milliseconds(200))

        let crons = try #require(session.cronService)
        let job = CronJobInput(
          name: "Evening summary", prompt: "Summarise the day.", schedule: "every 3h", deliver: "local",
          profile: "writer")
        try await crons.create(job)

        try await agentsWait("the new cron to be in the schedule") {
          model.overview.upcoming.contains { $0.name == "Evening summary" }
        }

        #expect(model.overview.upcoming.count == before + 1)
        #expect(model.overview.row(for: "writer")?.nextCron?.name == "Evening summary")

        watching.cancel()
      }
    }
  }
}
#endif
