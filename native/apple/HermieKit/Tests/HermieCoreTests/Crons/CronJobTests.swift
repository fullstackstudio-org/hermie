import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// A `cron.manage list` row (`_format_job`): `job_id`, the schedule flattened to its display, a preview.
private let socketRow: JSONObject = [
  "job_id": "job-heartbeat",
  "name": "VM heartbeat",
  "schedule": "every 30m",
  "prompt_preview": "Check the VM and summarize disk and memory…",
  "deliver": "local",
  "enabled": true,
  "state": "scheduled",
  "next_run_at": "2026-10-04T14:00:00+02:00",
  "last_run_at": "2026-10-04T13:30:00+02:00",
  "last_status": "ok",
  "repeat": "forever"
]

/// The stored job the HTTP routes answer: `id`, the full prompt, the PARSED schedule under `schedule`
/// and the human string under `schedule_display`, `repeat` as a count.
private let storedRow: JSONObject = [
  "id": "job-digest",
  "name": "Daily digest",
  "prompt": "Summarize the overnight updates.",
  "schedule": ["kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"],
  "schedule_display": "weekdays at 9am",
  "deliver": "bot-chat:researcher",
  "enabled": true,
  "state": "scheduled",
  "repeat": ["times": 3, "completed": 1],
  "profile": "researcher",
  "skills": ["web", 7, "notes"],
  "model": "anthropic/claude-sonnet-5-5"
]

@Suite struct CronJobTests {
  // MARK: Both surfaces, one shape

  @Test func aSocketRowKeysTheJobAsJobIDAndPreviewsThePrompt() {
    let job = CronJob(row: socketRow)

    #expect(job.id == "job-heartbeat")
    #expect(job.schedule == "every 30m")
    #expect(job.prompt == "")
    #expect(job.promptPreview == "Check the VM and summarize disk and memory…")
    #expect(job.displayPrompt == "Check the VM and summarize disk and memory…")
    // A rendered `repeat` cannot be counted back, so it stays unknown rather than being parsed out of
    // its own prose.
    #expect(job.repeatTimes == nil)
    #expect(job.profile == nil)
  }

  @Test func aStoredJobKeysItAsIDAndReadsTheScheduleFromItsDisplay() {
    let job = CronJob(row: storedRow)

    #expect(job.id == "job-digest")
    #expect(job.schedule == "weekdays at 9am")
    #expect(job.prompt == "Summarize the overnight updates.")
    #expect(job.promptPreview == "Summarize the overnight updates.")
    #expect(job.repeatTimes == 3)
    #expect(job.profile == "researcher")
    #expect(job.deliver == "bot-chat:researcher")
    #expect(job.skills == ["web", "notes"], "only the strings of a list are kept")
    #expect(job.model == "anthropic/claude-sonnet-5-5")
  }

  @Test func jobIDWinsWhenBothKeysArePresent() {
    #expect(CronJob(row: ["job_id": "a", "id": "b"]).id == "a")
  }

  @Test func aStoredScheduleThatCarriesNoDisplayReadsFromItsSpec() {
    var row = storedRow
    row["schedule_display"] = nil

    #expect(CronJob(row: row).schedule == "0 9 * * *")

    row["schedule"] = ["kind": "once", "run_at": "2026-10-05T09:00:00+02:00"]
    #expect(CronJob(row: row).schedule == "2026-10-05T09:00:00+02:00")

    row["schedule"] = ["kind": "interval"]
    #expect(CronJob(row: row).schedule == "", "a spec with no readable form is nothing, not noise")

    row["schedule"] = "every 2h"
    #expect(CronJob(row: row).schedule == "every 2h")
  }

  @Test func theProfileIsReadUnderEitherKey() {
    #expect(CronJob(row: ["id": "a", "profile_name": "writer"]).profile == "writer")
    #expect(CronJob(row: ["id": "a", "profile": "researcher", "profile_name": "writer"]).profile == "researcher")
  }

  @Test func aRowThatSaysNothingAboutEnabledIsEnabled() {
    #expect(CronJob(row: ["id": "a"]).enabled)
    #expect(CronJob(row: ["id": "a", "enabled": .null]).enabled)
    #expect(CronJob(row: ["id": "a", "enabled": false]).enabled == false)
  }

  @Test func theDeliveryDefaultsToLocal() {
    #expect(CronJob(row: ["id": "a"]).deliver == "local")
  }

  @Test func repeatIsACountOrANumericString() {
    #expect(CronJob.repeatTimes(.number(2)) == 2)
    #expect(CronJob.repeatTimes(.string(" 4 ")) == 4)
    #expect(CronJob.repeatTimes(["times": .null, "completed": 3]) == nil, "times: null is forever")
    #expect(CronJob.repeatTimes(.string("2/3")) == nil)
    #expect(CronJob.repeatTimes(nil) == nil)
  }

  // MARK: Dates

  @Test func nextAndLastRunAreReadAsPythonWritesThem() throws {
    let job = CronJob(row: socketRow)

    #expect(job.nextRunAt == Date(timeIntervalSince1970: 1_791_115_200))  // 2026-10-04T12:00:00Z
    #expect(job.lastRunAt == Date(timeIntervalSince1970: 1_791_113_400))

    let micro = try #require(CronDate.parse("2026-10-04T12:00:00.123456+00:00"))
    #expect(micro == Date(timeIntervalSince1970: 1_791_115_200))
    #expect(CronDate.parse("2026-10-04T12:00:00Z") == micro)
    #expect(CronDate.parse("2026-10-04 14:00:00+02:00") == micro)
    #expect(CronDate.parse("2026-10-04T14:00+0200") == micro)
    #expect(CronDate.parse("not a date") == nil)
    #expect(CronDate.parse("2026-13-40T00:00:00Z") == nil)
  }

  @Test func aTimeWithNoZoneIsReadInThisDevicesZone() throws {
    let naive = try #require(CronDate.parse("2026-10-04T09:30:00"))
    var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: naive)

    #expect(components.hour == 9 && components.minute == 30)
    components = Calendar.current.dateComponents([.year, .month, .day], from: try #require(CronDate.parse("2026-10-04")))
    #expect(components.day == 4)
  }

  @Test func epochSecondsAndMillisecondsBothRead() {
    #expect(CronDate.fromEpoch(1_791_115_200) == Date(timeIntervalSince1970: 1_791_115_200))
    #expect(CronDate.fromEpoch(1_791_115_200_000) == Date(timeIntervalSince1970: 1_791_115_200))
  }

  // MARK: Status

  @Test func theDotSaysPausedBeforeFailed() {
    var job = CronJob(id: "a", enabled: false, lastError: "boom")
    #expect(job.status == .paused)

    job = CronJob(id: "a", state: "paused")
    #expect(job.status == .paused)
  }

  @Test func theDotReadsTheLastOutcome() {
    #expect(CronJob(id: "a", lastStatus: "ok").status == .ok)
    #expect(CronJob(id: "a", lastStatus: "Success").status == .ok)
    #expect(CronJob(id: "a", lastStatus: "error").status == .failed)
    #expect(CronJob(id: "a", lastError: "RuntimeError: nope").status == .failed)
    #expect(CronJob(id: "a").status == .pending)
    #expect(CronJob(id: "a", lastStatus: "whatever").status == .pending)
  }

  @Test func aMissedFireIsTheErrorToShow() {
    let job = CronJob(row: ["id": "a", "last_fire_error": ["at": "2026-10-04", "detail": "Could not start the job."]])

    #expect(job.lastError == "Could not start the job.")
    #expect(job.status == .failed)
    #expect(CronJob(row: ["id": "a", "last_delivery_error": "no home channel"]).lastError == "no home channel")
    #expect(
      CronJob(row: ["id": "a", "last_error": "first", "last_delivery_error": "second"]).lastError == "first")
  }

  // MARK: What a row says about when

  private let now = Date(timeIntervalSince1970: 1_791_100_000)

  @Test func anActiveCronSaysItsNextRun() {
    let next = now.addingTimeInterval(3600)

    #expect(CronJob(id: "a", nextRunAt: next).rowWhen(now: now) == .next(next))
  }

  @Test func anOverdueCronSaysOverdueInsteadOfASignedTime() {
    #expect(CronJob(id: "a", nextRunAt: now.addingTimeInterval(-50_000)).rowWhen(now: now) == .overdue)
  }

  @Test func aPausedCronNeverSaysNextEvenWithAStaleNextRun() {
    let last = now.addingTimeInterval(-7200)
    let paused = CronJob(id: "a", enabled: false, nextRunAt: now.addingTimeInterval(-50_000), lastRunAt: last)

    #expect(paused.rowWhen(now: now) == .last(last))
    #expect(CronJob(id: "a", enabled: false).rowWhen(now: now) == .neverRun)
  }

  @Test func withNoNextRunItFallsBackToTheLastRunAndThenToNotScheduled() {
    let last = now.addingTimeInterval(-60)

    #expect(CronJob(id: "a", lastRunAt: last).rowWhen(now: now) == .last(last))
    #expect(CronJob(id: "a").rowWhen(now: now) == .notScheduled)
  }

  // MARK: The last error

  @Test func theSummaryIsTheFirstPlainSentence() {
    let raw = "RuntimeError: Cron job 'x' has no model configured (job.model=None, provider=None). Set one."

    #expect(CronError.summary(raw) == "Cron job 'x' has no model configured (job.model=None, provider=None).")
  }

  @Test func theSummaryPeelsNestedWrappers() {
    #expect(CronError.summary("[cron:failed] ⚠️ ValueError: bad schedule") == "bad schedule")
    #expect(CronError.summary("🛑 stopped") == "stopped")
    #expect(CronError.summary("Exception: plain") == "plain")
    #expect(CronError.summary("first line\nsecond line") == "first line")
    #expect(CronError.summary(nil) == "")
    #expect(CronError.summary("   ") == "")
  }

  @Test func aLongSentenceIsCutAtTwoHundred() {
    let summary = CronError.summary(String(repeating: "a", count: 300))

    #expect(summary.count == 200)
    #expect(summary.hasSuffix("…"))
  }

  // MARK: Delivery

  @Test func theBotOfADeliveryTarget() {
    #expect(CronDelivery.bot(in: "bot-chat:researcher") == "researcher")
    #expect(CronDelivery.bot(in: "bot-chat") == nil)
    #expect(CronDelivery.bot(in: "bot-chat:") == nil)
    #expect(CronDelivery.bot(in: "local") == nil)
    #expect(CronDelivery.bot(in: "telegram") == nil)
    #expect(CronJob(row: storedRow).deliveredBot == "researcher")
  }

  @Test func aDeliveryTargetReadsItsNameOrFallsBackToItsID() {
    let target = CronDeliveryTarget(row: ["id": "bot-chat:researcher", "name": "Bot Chat (researcher)"])

    #expect(target == CronDeliveryTarget(id: "bot-chat:researcher", name: "Bot Chat (researcher)"))
    #expect(CronDeliveryTarget(row: ["id": "telegram", "home_target_set": false]).homeTargetSet == false)
    #expect(CronDeliveryTarget(row: ["id": "telegram"]).name == "telegram")
    #expect(CronDeliveryTarget(row: ["name": "Slack"]).id == "Slack")
  }

  // MARK: Runs

  @Test func aRunReadsASessionRow() {
    let run = CronRun(row: [
      "id": "cron_job-heartbeat_1790000000",
      "started_at": 1_790_000_000,
      "ended_at": 1_790_000_030.5,
      "end_reason": "cron_complete",
      "message_count": 3,
      "preview": "Check the VM",
      "title": "VM heartbeat"
    ])

    #expect(run.id == "cron_job-heartbeat_1790000000")
    #expect(run.status == "cron_complete", "a session row has no status column: the outcome is end_reason")
    #expect(run.messageCount == 3)
    #expect(run.when == Date(timeIntervalSince1970: 1_790_000_000))
    #expect(run.displayTitle == "VM heartbeat")
    #expect(CronRun(row: ["id": "x"]).displayTitle == "x")
  }

  @Test func aRunsOutcomeIsReadFromHowItEnded() {
    func outcome(_ reason: String?, ended: Double? = 1) -> CronRun.Outcome {
      CronRun(id: "r", endedAt: ended, status: reason).outcome
    }

    #expect(outcome("cron_complete") == .ok)
    #expect(outcome("ok") == .ok)
    #expect(outcome("completed") == .ok)
    #expect(outcome("cron_incomplete_no_output") == .failed, "ended without a final assistant message")
    #expect(outcome("interrupted") == .failed)
    #expect(outcome("error") == .failed)
    #expect(outcome("user_exit") == .other)
    #expect(outcome(nil) == .ok, "no reason but ended: nothing says it went badly")
    #expect(outcome(nil, ended: nil) == .running)
  }

  @Test func aRunTakesTheStatusColumnWhereTheGatewayHasOne() {
    #expect(CronRun(row: ["id": "r", "status": "ok", "end_reason": "interrupted"]).status == "ok")
  }
}
