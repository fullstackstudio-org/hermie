import Foundation
import Testing

@testable import HermieCore

private func built(_ draft: CronScheduleDraft) -> String? {
  if case .success(let schedule) = CronSchedule.build(draft) { schedule } else { nil }
}

private func failure(_ draft: CronScheduleDraft) -> CronScheduleError? {
  if case .failure(let error) = CronSchedule.build(draft) { error } else { nil }
}

@Suite struct CronScheduleTests {
  // MARK: Interval

  @Test func anIntervalBuildsTheShortForm() {
    var draft = CronScheduleDraft(mode: .interval, intervalValue: "30", intervalUnit: .minutes)

    #expect(built(draft) == "every 30m")
    draft.intervalUnit = .hours
    #expect(built(draft) == "every 30h")
    draft.intervalUnit = .days
    draft.intervalValue = " 2 "
    #expect(built(draft) == "every 2d")
  }

  @Test func anIntervalNeedsAWholeNumberOfAtLeastOne() {
    for bad in ["", "0", "-5", "1.5", "abc", "2h"] {
      #expect(failure(CronScheduleDraft(mode: .interval, intervalValue: bad)) == .interval, "\(bad)")
    }
  }

  // MARK: Daily

  @Test func everyDayUsesTheEveryPrefix() {
    #expect(built(CronScheduleDraft(mode: .daily, time: "09:00")) == "every day at 9am")
    #expect(built(CronScheduleDraft(mode: .daily, time: "14:30", weekdays: [0, 1, 2, 3, 4, 5, 6])) == "every day at 2:30pm")
    #expect(built(CronScheduleDraft(mode: .daily, time: "00:00")) == "every day at 12am")
    #expect(built(CronScheduleDraft(mode: .daily, time: "12:05")) == "every day at 12:05pm")
  }

  @Test func theKeywordFormsHaveNoEveryPrefix() {
    #expect(built(CronScheduleDraft(mode: .daily, time: "09:00", weekdays: [1, 2, 3, 4, 5])) == "weekdays at 9am")
    #expect(built(CronScheduleDraft(mode: .daily, time: "10:00", weekdays: [6, 0])) == "weekends at 10am")
  }

  @Test func otherDaySetsAreNamed() {
    #expect(built(CronScheduleDraft(mode: .daily, time: "08:00", weekdays: [3, 1])) == "every monday, wednesday at 8am")
    #expect(built(CronScheduleDraft(mode: .daily, time: "08:00", weekdays: [1])) == "every monday at 8am")
    #expect(built(CronScheduleDraft(mode: .daily, time: "08:00", weekdays: [1, 1, 9])) == "every monday at 8am")
  }

  @Test func aTimeIsHHMM() {
    for bad in ["", "9", "9am", "24:00", "09:60", "ab:cd", "9:5"] {
      #expect(failure(CronScheduleDraft(mode: .daily, time: bad)) == .time, "\(bad)")
    }

    #expect(CronSchedule.parseClock(" 9:05 ")?.hour == 9)
  }

  // MARK: Cron

  @Test func aCronExpressionIsCollapsedAndPassedThrough() {
    #expect(built(CronScheduleDraft(mode: .cron, cronExpression: "  0   9 * *  1-5 ")) == "0 9 * * 1-5")
    #expect(built(CronScheduleDraft(mode: .cron, cronExpression: "*/15 * * * *")) == "*/15 * * * *")
    #expect(built(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * JAN MON-FRI")) == "0 9 * JAN MON-FRI")
    #expect(built(CronScheduleDraft(mode: .cron, cronExpression: "0 0 * * 7")) == "0 0 * * 7", "7 is Sunday")
  }

  @Test func aCronExpressionHasFiveFields() {
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * *")) == .cronFieldCount)
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * * * *")) == .cronFieldCount)
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "")) == .cronFieldCount)
  }

  @Test func everyNumberIsInsideItsFieldsRange() {
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "60 9 * * *")) == .cronField(.minute, value: "60"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 24 * * *")) == .cronField(.hour, value: "24"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 0 * *")) == .cronField(.dayOfMonth, value: "0"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * 13 *")) == .cronField(.month, value: "13"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * * 8")) == .cronField(.dayOfWeek, value: "8"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0-99 9 * * *")) == .cronField(.minute, value: "0-99"))
  }

  @Test func aFieldOutsideTheAlphabetIsRefused() {
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * * ?")) == .cronField(.dayOfWeek, value: "?"))
    #expect(failure(CronScheduleDraft(mode: .cron, cronExpression: "0 9 * # *")) == .cronField(.month, value: "#"))
  }

  // MARK: Once

  @Test func aOneShotIsADelayOrAnISODate() {
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "in 2h")) == "in 2h")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "  IN  30 Minutes ")) == "in 30 minutes")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "in hour")) == "in hour", "a bare unit defaults to 1")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "2026-09-20T09:00")) == "2026-09-20T09:00")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "2026-09-20 09:00:30")) == "2026-09-20 09:00:30")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "2026-09-20T09:00:00+02:00")) == "2026-09-20T09:00:00+02:00")
    #expect(built(CronScheduleDraft(mode: .once, onceValue: "2026-09-20")) == "2026-09-20")
  }

  @Test func aOneShotThatIsNeitherIsRefused() {
    for bad in ["", "in", "in soon", "in 2 fortnights", "tomorrow", "20-09-2026", "2026-09-20T9:00"] {
      #expect(failure(CronScheduleDraft(mode: .once, onceValue: bad)) == .once, "\(bad)")
    }
  }

  // MARK: Reading a stored schedule back

  @Test func anExistingIntervalOpensInIntervalMode() {
    let draft = CronSchedule.draft(from: "every 45m")

    #expect(draft.mode == .interval)
    #expect(draft.intervalValue == "45")
    #expect(draft.intervalUnit == .minutes)
    #expect(CronSchedule.draft(from: "every 2 hours").intervalUnit == .hours)
    #expect(CronSchedule.draft(from: "every 3d").intervalUnit == .days)
  }

  @Test func theGatewaysMinutesAreSaidInTheBiggerUnitWhenTheyDivide() {
    let hours = CronSchedule.draft(from: "every 120m")
    let days = CronSchedule.draft(from: "every 1440m")

    #expect(hours.intervalValue == "2" && hours.intervalUnit == .hours)
    #expect(days.intervalValue == "1" && days.intervalUnit == .days)
    #expect(CronSchedule.draft(from: "every 90m").intervalValue == "90")
    // Rebuilt, the same schedule.
    #expect(built(hours) == "every 2h")
  }

  @Test func anExistingDayAndTimeOpensInDailyMode() {
    let weekdays = CronSchedule.draft(from: "weekdays at 9am")

    #expect(weekdays.mode == .daily)
    #expect(weekdays.time == "09:00")
    #expect(weekdays.weekdays == [1, 2, 3, 4, 5])

    let monday = CronSchedule.draft(from: "every monday 9:30pm")
    #expect(monday.weekdays == [1])
    #expect(monday.time == "21:30")

    let several = CronSchedule.draft(from: "every monday, wed and fri at 14:00")
    #expect(several.weekdays == [1, 3, 5])
    #expect(several.time == "14:00")

    #expect(CronSchedule.draft(from: "every day at noon").time == "12:00")
    #expect(CronSchedule.draft(from: "every day at midnight").time == "00:00")
    #expect(CronSchedule.draft(from: "every day at 9am").weekdays == [])
  }

  @Test func theBuilderRoundTripsWhatItWrote() {
    let drafts = [
      CronScheduleDraft(mode: .interval, intervalValue: "15", intervalUnit: .minutes),
      CronScheduleDraft(mode: .daily, time: "07:45", weekdays: [1, 2, 3, 4, 5]),
      CronScheduleDraft(mode: .daily, time: "23:00", weekdays: [0, 6]),
      CronScheduleDraft(mode: .daily, time: "09:00", weekdays: [2, 4]),
      CronScheduleDraft(mode: .cron, cronExpression: "*/5 * * * *"),
      CronScheduleDraft(mode: .once, onceValue: "in 2h")
    ]

    for draft in drafts {
      let schedule = built(draft)
      #expect(schedule != nil)
      #expect(built(CronSchedule.draft(from: schedule)) == schedule, "\(schedule ?? "")")
    }
  }

  @Test func aOneShotTheGatewaySpelledOutOpensInOnceMode() {
    #expect(CronSchedule.draft(from: "in 2h").mode == .once)
    #expect(CronSchedule.draft(from: "once in 2h").onceValue == "in 2h")
    #expect(CronSchedule.draft(from: "once at 2026-02-03 14:00").onceValue == "2026-02-03 14:00")
    #expect(CronSchedule.draft(from: "2026-09-20T09:00:00+02:00").mode == .once)
  }

  @Test func aScheduleTheBuilderCannotExpressKeepsItsRawStringInCronMode() {
    let six = CronSchedule.draft(from: "0 0 9 * * 1")
    #expect(six.mode == .cron)
    #expect(six.cronExpression == "0 0 9 * * 1", "rewriting it would silently change when it fires")
    #expect(failure(six) == .cronFieldCount)

    #expect(CronSchedule.draft(from: "0 9 * * 1-5").mode == .cron)
    #expect(CronSchedule.draft(from: nil) == .default)
    #expect(CronSchedule.draft(from: "  ") == .default)
  }

  // MARK: Words

  @Test func anIntervalIsSaidInTheUnitItFitsBest() {
    #expect(CronSchedule.describe("every 30m") == .interval(count: 30, unit: .minutes))
    #expect(CronSchedule.describe("every 120m") == .interval(count: 2, unit: .hours))
    #expect(CronSchedule.describe("every 1440m") == .interval(count: 1, unit: .days))
    #expect(CronSchedule.describe("Every 2 hours") == .interval(count: 2, unit: .hours))
    #expect(CronSchedule.describe("every 1m") == .interval(count: 1, unit: .minutes))
  }

  @Test func aOneShotIsSaidWithItsDurationOrItsDate() {
    #expect(CronSchedule.describe("in 2h") == .onceIn("2h"))
    #expect(CronSchedule.describe("once in 30m") == .onceIn("30m"))

    guard case .onceAt(let text, let date) = CronSchedule.describe("once at 2026-02-03 14:00") else {
      Issue.record("not a one-shot at a date")
      return
    }

    #expect(text == "2026-02-03 14:00")
    #expect(date != nil)
    #expect(CronSchedule.describe("2026-09-20T09:00:00+02:00") == .onceAt("2026-09-20T09:00:00+02:00", CronDate.parse("2026-09-20T09:00:00+02:00")))
  }

  @Test func aDayAndATimeIsSaidAsOne() {
    #expect(CronSchedule.describe("weekdays at 9am") == .daily(weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0))
    #expect(CronSchedule.describe("every day at 9:30pm") == .daily(weekdays: [], hour: 21, minute: 30))
    #expect(CronSchedule.describe("every monday 9am") == .daily(weekdays: [1], hour: 9, minute: 0))
  }

  @Test func theSimplestCronExpressionsAreSaidAsADayAndATimeToo() {
    #expect(CronSchedule.describe("0 9 * * *") == .daily(weekdays: [], hour: 9, minute: 0))
    #expect(CronSchedule.describe("30 14 * * 1-5") == .daily(weekdays: [1, 2, 3, 4, 5], hour: 14, minute: 30))
    #expect(CronSchedule.describe("0 8 * * 0,6") == .daily(weekdays: [0, 6], hour: 8, minute: 0))
    #expect(CronSchedule.describe("0 8 * * 7") == .daily(weekdays: [0], hour: 8, minute: 0))
    #expect(CronSchedule.describe("0 8 * * 1,3,5") == .daily(weekdays: [1, 3, 5], hour: 8, minute: 0))
  }

  @Test func anythingElseIsShownExactlyAsStored() {
    for raw in ["*/15 * * * *", "0 9 1 * *", "0 9 * 6 *", "0 9 * * MON-FRI", "0 9,17 * * *", "every full moon"] {
      #expect(CronSchedule.describe(raw) == .raw(raw), "\(raw)")
    }

    #expect(CronSchedule.describe("") == .unknown)
    #expect(CronSchedule.describe("  ") == .unknown)
  }
}
