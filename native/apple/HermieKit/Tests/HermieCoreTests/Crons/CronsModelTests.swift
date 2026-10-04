import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

private let heartbeat = CronJob(id: "job-heartbeat", name: "VM heartbeat", schedule: "every 30m", profile: "default")
private let digest = CronJob(id: "job-digest", name: "Daily digest", schedule: "weekdays at 9am", profile: "default")
private let cleanup = CronJob(
  id: "job-cleanup", name: "Cleanup", schedule: "every 1d", enabled: false, state: "paused", profile: "default")
private let inbox = CronJob(id: "job-inbox", name: "Inbox scan", schedule: "every 1h", profile: "researcher")

@MainActor
private func loaded(_ jobs: [CronJob] = [heartbeat, digest, cleanup]) async -> (CronsModel, StubCrons) {
  let backend = StubCrons()
  backend.set(jobs)
  let model = CronsModel(backend: backend, debounce: .milliseconds(20))
  await model.load()

  return (model, backend)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct CronsModelTests {
  // MARK: Reading

  @Test func startsLoadingAndThenHoldsTheJobsAndTheSchedulerFlag() async {
    let backend = StubCrons()
    backend.set([heartbeat, digest], running: false)
    let model = CronsModel(backend: backend)

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.jobs == [heartbeat, digest])
    #expect(model.gatewayRunning == false)
  }

  @Test func theListSplitsIntoActiveAndPausedInTheGatewaysOrder() async {
    let (model, _) = await loaded()

    #expect(model.active == [heartbeat, digest])
    #expect(model.paused == [cleanup])
  }

  @Test func anEmptyListIsReadyNotFailed() async {
    let (model, _) = await loaded([])

    #expect(model.phase == .ready)
    #expect(model.jobs.isEmpty)
  }

  @Test func theDeliveryTargetsAreReadOnce() async {
    let backend = StubCrons()
    backend.state.withLock {
      $0.targets = [.local, CronDeliveryTarget(id: "bot-chat:researcher", name: "Bot Chat (researcher)")]
    }
    let model = CronsModel(backend: backend)

    await model.load()
    await model.load()

    #expect(model.targets.map(\.id) == ["local", "bot-chat:researcher"])
    #expect(backend.calls.filter { $0 == "targets" }.count == 1)
  }

  @Test func theProfileIsShownOnlyWhereItTellsTwoRowsApart() async {
    let (single, _) = await loaded([heartbeat, digest])
    let (several, _) = await loaded([heartbeat, inbox])

    #expect(!single.showsProfiles)
    #expect(several.showsProfiles)
  }

  @Test func aFailedFirstReadSaysWhy() async {
    let backend = StubCrons()
    backend.fail("list", GatewayError(.server, "HTTP 502", status: 502))
    let model = CronsModel(backend: backend)

    await model.load()

    #expect(model.phase == .failed("HTTP 502"))
  }

  @Test func aFailedRefreshKeepsTheListOnScreenAndSaysSo() async {
    let (model, backend) = await loaded()
    backend.fail("list", GatewayRPCError(.timeout, "request timed out"))

    await model.load()

    #expect(model.phase == .ready)
    #expect(model.jobs == [heartbeat, digest, cleanup])
    #expect(model.failure == "request timed out")
  }

  @Test func aReadThatANewerOneOvertookIsDropped() async throws {
    let backend = StubCrons()
    backend.set([heartbeat])
    backend.hold("list")
    let model = CronsModel(backend: backend)

    let first = Task { await model.load() }
    try await eventually("the first read to be in the air") { backend.isHolding }

    // The gateway moves on and a newer read lands first.
    backend.set([heartbeat, digest])
    await model.load()
    #expect(model.jobs == [heartbeat, digest])

    backend.release()
    await first.value

    #expect(model.jobs == [heartbeat, digest], "the older answer must not overwrite the newer one")
  }

  @Test func lookingAJobUpByID() async {
    let (model, _) = await loaded()

    #expect(model.job(id: "job-digest") == digest)
    #expect(model.job(id: "job-nope") == nil)
  }

  // MARK: Detail and runs

  @Test func theDetailReplacesTheRowSoEveryScreenReadsOneValue() async {
    let (model, backend) = await loaded()
    var full = heartbeat
    full.prompt = "The whole prompt."
    backend.state.withLock { $0.details["job-heartbeat"] = full }

    await model.loadDetail(of: heartbeat)

    #expect(model.job(id: "job-heartbeat")?.prompt == "The whole prompt.")
    #expect(model.jobs.count == 3)
  }

  @Test func aDetailThatFailsLeavesTheRowAlone() async {
    let (model, backend) = await loaded()
    backend.fail("detail", GatewayError(.server, "gone", status: 404))

    await model.loadDetail(of: heartbeat)

    #expect(model.job(id: "job-heartbeat") == heartbeat)
  }

  @Test func theRunHistoryIsLoadedPerJob() async {
    let (model, backend) = await loaded()
    let runs = [CronRun(id: "cron_job-heartbeat_2", startedAt: 2), CronRun(id: "cron_job-heartbeat_1", startedAt: 1)]
    backend.state.withLock { $0.runs["job-heartbeat"] = runs }

    #expect(model.runs["job-heartbeat"] == nil)
    await model.loadRuns(of: heartbeat)

    #expect(model.runs["job-heartbeat"] == .loaded(runs))
    #expect(model.runs["job-digest"] == nil)
  }

  @Test func aFailedHistoryReadSaysWhyAndAnEarlierOneStaysOnScreen() async {
    let (model, backend) = await loaded()
    backend.fail("runs", GatewayError(.server, "HTTP 500", status: 500))

    await model.loadRuns(of: heartbeat)
    #expect(model.runs["job-heartbeat"] == .failed("HTTP 500"))

    backend.heal("runs")
    backend.state.withLock { $0.runs["job-heartbeat"] = [CronRun(id: "r1")] }
    await model.loadRuns(of: heartbeat)
    #expect(model.runs["job-heartbeat"] == .loaded([CronRun(id: "r1")]))

    backend.fail("runs", GatewayError(.server, "HTTP 500", status: 500))
    await model.loadRuns(of: heartbeat)
    #expect(model.runs["job-heartbeat"] == .loaded([CronRun(id: "r1")]))
    #expect(model.failure == "HTTP 500")
  }

  // MARK: Actions

  @Test func pausingAsksTheGatewayAndReadsTheListAgain() async {
    let (model, backend) = await loaded()
    backend.set([heartbeat, digest, cleanup].map { $0.id == "job-heartbeat" ? pausedCopy($0) : $0 })

    let done = await model.pause(heartbeat)

    #expect(done)
    #expect(backend.calls.contains("pause job-heartbeat"))
    #expect(model.paused.map(\.id) == ["job-heartbeat", "job-cleanup"], "the list is the gateway's answer, not a guess")
    #expect(model.busy.isEmpty)
  }

  @Test func resumingAndRunningNowAskTheGateway() async {
    let (model, backend) = await loaded()

    #expect(await model.resume(cleanup))
    #expect(await model.runNow(heartbeat))

    #expect(backend.calls.contains("resume job-cleanup"))
    #expect(backend.calls.contains("runNow job-heartbeat"))
    #expect(backend.calls.contains("runs job-heartbeat"), "the new run shows in the history")
  }

  @Test func aRefusedActionReportsTheGatewaysWordsAndChangesNothing() async {
    let (model, backend) = await loaded()
    backend.fail("pause", GatewayRPCError(.rejected, "Job not found"))

    let done = await model.pause(heartbeat)

    #expect(!done)
    #expect(model.failure == "Job not found")
    #expect(model.busy.isEmpty)
    #expect(model.jobs == [heartbeat, digest, cleanup])
    #expect(backend.calls.filter { $0 == "list" }.count == 1, "no second read after a refusal")
  }

  @Test func theNextActionClearsWhatTheLastOneSaid() async {
    let (model, backend) = await loaded()
    backend.fail("pause", GatewayRPCError(.rejected, "Job not found"))
    _ = await model.pause(heartbeat)
    backend.heal("pause")

    #expect(await model.pause(heartbeat))
    #expect(model.failure == nil)
  }

  @Test func aRowIsBusyWhileItsActionRuns() async throws {
    let (model, backend) = await loaded()
    backend.hold("runNow")

    let running = Task { await model.runNow(heartbeat) }
    try await eventually("the action to be in the air") { backend.isHolding }

    #expect(model.busy == ["job-heartbeat"])
    #expect(await model.pause(heartbeat) == false, "one action at a time on a cron")
    #expect(!backend.calls.contains("pause job-heartbeat"))
    #expect(await model.pause(digest), "another cron is not held up")

    backend.release()
    #expect(await running.value)
    #expect(model.busy.isEmpty)
  }

  @Test func deletingDropsTheRowAndItsHistory() async {
    let (model, backend) = await loaded()
    await model.loadRuns(of: digest)
    backend.set([heartbeat, cleanup])

    #expect(await model.remove(digest))

    #expect(backend.calls.contains("remove job-digest"))
    #expect(model.job(id: "job-digest") == nil)
    #expect(model.runs["job-digest"] == nil)
  }

  @Test func aRefusedDeleteKeepsTheRow() async {
    let (model, backend) = await loaded()
    backend.fail("remove", GatewayError(.server, "Unknown job", status: 404))

    #expect(await model.remove(digest) == false)

    #expect(model.job(id: "job-digest") == digest)
    #expect(model.failure == "Unknown job")
  }

  // MARK: Saving

  private func draft(_ name: String = "Nightly sweep", editing job: CronJob? = nil) -> CronEditorDraft {
    var draft = job.map { CronEditorDraft(editing: $0) } ?? CronEditorDraft()
    draft.name = name
    draft.prompt = draft.prompt.isEmpty ? "Sweep the logs." : draft.prompt

    return draft
  }

  @Test func aNewCronIsCreatedAndTheListReadAgain() async {
    let (model, backend) = await loaded()

    #expect(await model.save(draft()))

    #expect(backend.calls.contains("create Nightly sweep"))
    #expect(backend.calls.filter { $0 == "list" }.count == 2)
    #expect(model.saveError == nil)
    #expect(!model.saving)
  }

  @Test func anEditedCronIsUpdatedAndTheRowTakesTheAnswer() async {
    let (model, backend) = await loaded()
    var answer = digest
    answer.name = "Renamed"
    answer.nextRunAt = Date(timeIntervalSince1970: 1_791_115_200)
    backend.state.withLock { $0.updated = answer }
    backend.set([heartbeat, answer, cleanup])

    #expect(await model.save(draft("Renamed", editing: digest)))

    #expect(backend.calls.contains("update job-digest Renamed"))
    #expect(model.job(id: "job-digest")?.name == "Renamed")
  }

  @Test func aDraftThatIsNotReadyIsNotSent() async {
    let (model, backend) = await loaded()
    var bad = CronEditorDraft()
    bad.name = "No instructions"

    #expect(await model.save(bad) == false)

    #expect(backend.calls.filter { $0.hasPrefix("create") }.isEmpty)
  }

  @Test func aRefusedSaveSaysWhyAndKeepsTheEditorsWords() async {
    let (model, backend) = await loaded()
    backend.fail("create", GatewayRPCError(.rejected, "Invalid schedule 'every 0m'"))

    #expect(await model.save(draft()) == false)

    #expect(model.saveError == "Invalid schedule 'every 0m'")
    #expect(!model.saving)

    model.beginEditing()
    #expect(model.saveError == nil)
  }

  // MARK: Following the gateway

  @Test func aBroadcastReadsTheListAgainOnceForABurst() async throws {
    let (model, backend) = await loaded()
    let watching = Task { await model.watch() }
    try await eventually("the model to follow the broadcasts") { backend.watchers == 1 }
    backend.set([heartbeat])

    for _ in 0..<5 {
      backend.broadcastChange()
    }

    try await eventually("the list to be read again") { backend.calls.filter { $0 == "list" }.count == 2 }
    try await Task.sleep(for: .milliseconds(120))

    #expect(backend.calls.filter { $0 == "list" }.count == 2, "five broadcasts in a burst are one read")
    #expect(model.jobs == [heartbeat])

    watching.cancel()
    await watching.value
  }

  private func pausedCopy(_ job: CronJob) -> CronJob {
    var copy = job
    copy.enabled = false
    copy.state = "paused"

    return copy
  }
}
