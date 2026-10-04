#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func cronsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, connected and with its roster read, as the app holds one. No chat is
/// open: the crons and the timeline are read without one.
@MainActor
private func connectedSession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-crons", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await cronsWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows["researcher"] != nil
  }

  return session
}

/// `FakeGateway.with`, with a connected session and a body on the main actor, where the models live; the
/// session is shut down after it, however it ends.
private func withConnectedSession(
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await connectedSession(gateway)

    do {
      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension Integration {
  /// The Crons screens' model against the real fake gateway, over a real socket and real HTTP: the list of
  /// every profile, pause and resume, a cron created in a profile, edited, run now with its transcript
  /// read, and deleted; and the model following the gateway's own broadcasts.
  @Suite("Crons") @MainActor
  struct CronsIntegrationTests {
    private func withModel(
      _ body: @escaping @MainActor @Sendable (GatewaySession, CronsModel) async throws -> Void
    ) async throws {
      try await withConnectedSession { session in
        let model = try #require(session.crons())
        await model.load()

        try await body(session, model)
      }
    }

    @Test("the list is every profile's crons, each tagged with its own, and the scheduler is running")
    func listsEveryProfile() async throws {
      try await withModel { _, model in
        #expect(model.phase == .ready)
        #expect(model.gatewayRunning == true)
        #expect(model.jobs.map(\.id).sorted() == ["job-cleanup", "job-digest", "job-heartbeat", "job-inbox-scan"])
        #expect(model.job(id: "job-inbox-scan")?.profile == "researcher")
        #expect(model.job(id: "job-heartbeat")?.profile == "default")
        #expect(model.showsProfiles)
        #expect(model.paused.map(\.id) == ["job-cleanup"])
        #expect(model.targets.map(\.id) == ["local", "bot-chat:researcher"])
      }
    }

    @Test("a row says what the list needs: its schedule in words' source, its next run and its last result")
    func rowsCarryTheirFacts() async throws {
      try await withModel { _, model in
        let heartbeat = try #require(model.job(id: "job-heartbeat"))

        #expect(!heartbeat.schedule.isEmpty)
        #expect(heartbeat.nextRunAt != nil)
        #expect(heartbeat.status == .ok)
        #expect(model.job(id: "job-digest")?.lastErrorSummary.contains("no model configured") == true)
        #expect(model.job(id: "job-digest")?.status == .failed)
      }
    }

    @Test("the detail reads the full prompt and the run history, newest first")
    func detailAndRuns() async throws {
      try await withModel { _, model in
        let heartbeat = try #require(model.job(id: "job-heartbeat"))

        await model.loadDetail(of: heartbeat)
        await model.loadRuns(of: heartbeat)

        #expect(model.job(id: "job-heartbeat")?.prompt.contains("summarize disk and memory") == true)

        guard case .loaded(let runs)? = model.runs["job-heartbeat"] else {
          Issue.record("the history did not load: \(String(describing: model.runs["job-heartbeat"]))")
          return
        }

        #expect(runs.count == 2)
        #expect((runs[0].startedAt ?? 0) > (runs[1].startedAt ?? 0))
        #expect(runs[0].id.hasPrefix("cron_job-heartbeat_"))
      }
    }

    @Test("a run opens as a read-only transcript")
    func runTranscript() async throws {
      try await withModel { session, model in
        let heartbeat = try #require(model.job(id: "job-heartbeat"))
        await model.loadRuns(of: heartbeat)
        guard case .loaded(let runs)? = model.runs["job-heartbeat"], let run = runs.first else {
          Issue.record("no runs")
          return
        }

        let viewer = try #require(session.cronRun(job: heartbeat, run: run))
        await viewer.load()

        #expect(viewer.phase == .ready)
        #expect(!viewer.items.isEmpty)
      }
    }

    @Test("pausing and resuming are the gateway's, scoped to the cron's profile, and the list follows")
    func pauseAndResume() async throws {
      try await withModel { _, model in
        let inbox = try #require(model.job(id: "job-inbox-scan"))

        #expect(await model.pause(inbox))
        #expect(model.job(id: "job-inbox-scan")?.status == .paused)
        #expect(model.job(id: "job-inbox-scan")?.nextRunAt == nil, "a paused cron has no next run")

        let paused = try #require(model.job(id: "job-inbox-scan"))
        #expect(await model.resume(paused))
        #expect(model.job(id: "job-inbox-scan")?.status != .paused)
        #expect(model.job(id: "job-inbox-scan")?.nextRunAt != nil)
      }
    }

    @Test("a cron is created in the profile the editor chose, and not in the launch profile")
    func createInAProfile() async throws {
      try await withModel { _, model in
        var draft = CronEditorDraft()
        draft.name = "Nightly sweep"
        draft.prompt = "Sweep the logs."
        draft.profile = "writer"
        draft.schedule = CronScheduleDraft(mode: .interval, intervalValue: "6", intervalUnit: .hours)

        #expect(await model.save(draft))

        let created = try #require(model.jobs.first { $0.name == "Nightly sweep" })
        #expect(created.profile == "writer")
        #expect(created.nextRunAt != nil, "the next run is the gateway's")
        #expect(model.saveError == nil)
      }
    }

    @Test("an edit is a merge: the schedule changes, the prompt stays, and the next run is recomputed")
    func editMerges() async throws {
      try await withModel { _, model in
        let heartbeat = try #require(model.job(id: "job-heartbeat"))
        let before = heartbeat.nextRunAt
        await model.loadDetail(of: heartbeat)

        var draft = CronEditorDraft(editing: try #require(model.job(id: "job-heartbeat")))
        draft.name = "Renamed heartbeat"
        draft.schedule = CronScheduleDraft(mode: .interval, intervalValue: "15", intervalUnit: .minutes)

        #expect(await model.save(draft))

        let after = try #require(model.job(id: "job-heartbeat"))
        #expect(after.name == "Renamed heartbeat")
        #expect(after.schedule == "every 15m")
        #expect(after.prompt.contains("summarize disk and memory"))
        #expect(after.nextRunAt != before)
      }
    }

    @Test("run now adds a run with a transcript, and leaves the schedule alone")
    func runNow() async throws {
      try await withModel { _, model in
        let cleanup = try #require(model.job(id: "job-cleanup"))
        await model.loadRuns(of: cleanup)
        #expect(model.runs["job-cleanup"] == .loaded([]))

        #expect(await model.runNow(cleanup))

        guard case .loaded(let runs)? = model.runs["job-cleanup"] else {
          Issue.record("the history did not load")
          return
        }

        #expect(runs.count == 1)
        #expect(model.job(id: "job-cleanup")?.lastStatus == "ok")
        #expect(model.job(id: "job-cleanup")?.schedule == cleanup.schedule)
      }
    }

    @Test("a deleted cron is gone from the list and from the gateway")
    func deleteIsGone() async throws {
      try await withModel { _, model in
        let digest = try #require(model.job(id: "job-digest"))
        #expect(await model.remove(digest))
        #expect(model.job(id: "job-digest") == nil)

        await model.load()
        #expect(model.job(id: "job-digest") == nil, "read again from the gateway")
      }
    }

    @Test("a refusal the gateway makes is said in its own words and changes nothing")
    func refusalIsReported() async throws {
      try await withModel { _, model in
        let ghost = CronJob(id: "job-nope", profile: "default")

        #expect(await model.pause(ghost) == false)
        #expect(model.failure != nil)
        #expect(model.jobs.count == 4)
      }
    }

    @Test("the model follows the gateway's cron.changed broadcasts")
    func followsBroadcasts() async throws {
      try await withModel { session, model in
        let watching = Task { await model.watch() }
        defer { watching.cancel() }

        // Another client changes the list: this model was not asked, and must hear about it.
        let other = try #require(session.cronService)
        try await other.runNow(CronJob(id: "job-cleanup", profile: "default"))
        try await other.create(CronJobInput(name: "From elsewhere", prompt: "p", schedule: "every 1h"))

        try await cronsWait("the list to include the new cron") {
          model.jobs.contains { $0.name == "From elsewhere" }
        }
      }
    }
  }
}
#endif
