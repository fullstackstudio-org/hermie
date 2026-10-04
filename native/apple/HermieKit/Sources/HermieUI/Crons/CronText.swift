import Foundation
import HermieCore
import HermieTranscript

/// The Crons screens' words, as plain functions so they are tested without a view.
enum CronText {
  // MARK: Schedules

  /// A cron's schedule in words. Only the forms the builder writes, and the forms the gateway spells
  /// them back as, are put in words; anything else is shown exactly as stored.
  static func schedule(
    _ stored: String, calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    switch CronSchedule.describe(stored) {
    case .unknown:
      return Strings.Cron.Detail.unknown
    case .interval(let count, let unit):
      switch unit {
      case .minutes: return NativeStrings.Cron.everyMinutes(count)
      case .hours: return NativeStrings.Cron.everyHours(count)
      case .days: return NativeStrings.Cron.everyDays(count)
      }
    case .onceIn(let delay):
      return NativeStrings.Cron.onceIn(delay)
    case .onceAt(let text, let date):
      let shown = date.map { $0.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)) } ?? text

      return NativeStrings.Cron.onceAt(shown)
    case .daily(let weekdays, let hour, let minute):
      let time = clock(hour: hour, minute: minute, calendar: calendar, locale: locale)
      let days = Set(weekdays.filter { (0...6).contains($0) })

      if days.isEmpty || days.count == 7 {
        return NativeStrings.Cron.dailyAt(time)
      }

      if days == [1, 2, 3, 4, 5] {
        return NativeStrings.Cron.weekdaysAt(time)
      }

      if days == [0, 6] {
        return NativeStrings.Cron.weekendsAt(time)
      }

      let names = Strings.Cron.Schedule.weekdayNames
      let list = days.sorted().compactMap { names.indices.contains($0) ? names[$0] : nil }

      return NativeStrings.Cron.daysAt(ListFormatter.localizedString(byJoining: list), time)
    case .raw(let text):
      return text
    }
  }

  /// `09:00`, or `9:00 AM` where the reader's locale says so.
  static func clock(hour: Int, minute: Int, calendar: Calendar = .current, locale: Locale = .current) -> String {
    var components = DateComponents()
    components.hour = hour
    components.minute = minute
    components.year = 2001
    components.month = 1
    components.day = 1

    guard let date = calendar.date(from: components) else {
      return String(format: "%02d:%02d", hour, minute)
    }

    return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
  }

  /// Why the schedule cannot be built, in words.
  static func error(_ error: CronScheduleError) -> String {
    switch error {
    case .interval: Strings.Cron.Schedule.Errors.interval
    case .time: Strings.Cron.Schedule.Errors.time
    case .cronFieldCount: Strings.Cron.Schedule.Errors.cronFieldCount
    case .cronField(let field, let value):
      Strings.Cron.Schedule.Errors.cronField(field: NativeStrings.Cron.field(field), value: value)
    case .once: Strings.Cron.Schedule.Errors.once
    }
  }

  // MARK: Times

  /// "in 2h", "5 min ago". Absolute times are avoided on a row: the gateway's timezone is not the
  /// phone's, and an absolute time rendered in the phone's zone is wrong in a way nobody notices until a
  /// cron fires an hour off.
  static func relative(_ date: Date, now: Date = .now) -> String {
    let delta = date.timeIntervalSince(now)
    let ahead = delta >= 0
    let magnitude = abs(delta)

    if magnitude < 45 {
      return Strings.Cron.Relative.now
    }

    if magnitude < 3600 {
      let minutes = Int((magnitude / 60).rounded())

      return ahead ? Strings.Cron.Relative.inMinutes(value: minutes) : Strings.Cron.Relative.minutesAgo(value: minutes)
    }

    if magnitude < 86_400 {
      let hours = Int((magnitude / 3600).rounded())

      return ahead ? Strings.Cron.Relative.inHours(value: hours) : Strings.Cron.Relative.hoursAgo(value: hours)
    }

    let days = Int((magnitude / 86_400).rounded())

    return ahead ? Strings.Cron.Relative.inDays(value: days) : Strings.Cron.Relative.daysAgo(value: days)
  }

  /// The row's WHEN column: a micro label over a value.
  static func when(_ when: CronRowWhen, now: Date = .now) -> (label: String, value: String) {
    switch when {
    case .next(let date): (Strings.Cron.List.nextLabel, relative(date, now: now))
    case .last(let date): (Strings.Cron.List.lastLabel, relative(date, now: now))
    case .neverRun: (Strings.Cron.List.lastLabel, Strings.Cron.Detail.unknown)
    case .overdue: (Strings.Cron.List.nextLabel, Strings.Cron.List.overdue)
    case .notScheduled: (Strings.Cron.List.nextLabel, Strings.Cron.List.noNextRun)
    }
  }

  // MARK: Status

  static func status(_ status: CronStatus) -> String {
    switch status {
    case .ok: Strings.Cron.Status.ok
    case .failed: Strings.Cron.Status.failed
    case .paused: Strings.Cron.Status.paused
    case .pending: Strings.Cron.Status.pending
    }
  }

  /// What a run came to, in words: the gateway's own `end_reason` made readable where this build has no
  /// word for it.
  static func outcome(_ run: CronRun) -> String {
    switch run.outcome {
    case .running: Strings.Cron.Status.running
    case .ok: Strings.Cron.Status.ok
    case .failed: Strings.Cron.Status.failed
    case .other: humanised(run.status) ?? Strings.Cron.Status.ok
    }
  }

  /// A raw gateway status as a label, or nil when there is nothing to say. A status this app knows gets
  /// the word the design board uses (`ok` and `success` are one label rather than two); one it does not
  /// know is still made readable (`rate_limited` shown as "Rate limited") rather than printed raw.
  static func humanised(_ raw: String?) -> String? {
    let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    if trimmed.isEmpty {
      return nil
    }

    switch trimmed.lowercased() {
    case "ok", "success", "succeeded", "complete", "completed", "done", "cron_complete": return Strings.Cron.Status.ok
    case "error", "failed", "failure", "fail", "cron_incomplete_no_output": return Strings.Cron.Status.failed
    case "paused": return Strings.Cron.Status.paused
    case "pending", "queued", "waiting": return Strings.Cron.Status.pending
    case "running": return Strings.Cron.Status.running
    default: break
    }

    let words = trimmed.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)

    return words.prefix(1).localizedUppercase + words.dropFirst()
  }

  /// A run's heading: when it started, as a relative phrase, or its id where it has no stamp.
  static func runWhen(_ run: CronRun, now: Date = .now) -> String {
    run.when.map { relative($0, now: now) } ?? run.id
  }

  // MARK: Delivery

  /// Where a cron delivers, by the gateway's own name for the target where it listed one.
  static func delivery(_ deliver: String, targets: [CronDeliveryTarget]) -> String {
    targets.first { $0.id == deliver }?.name ?? (deliver.isEmpty ? Strings.Cron.Detail.unknown : deliver)
  }
}

/// The Activity screen's words.
enum ActivityText {
  /// `researcher → writer`, `researcher ↩︎ writer` or `researcher spawned 3 agents`.
  static func heading(_ entry: ActivityEntry, label: (String) -> String) -> String {
    switch entry.kind {
    case .delegation:
      Strings.App.Activity.spawned(bot: label(entry.fromHandle), count: entry.agentCount ?? 0)
    case .dmReply:
      Strings.App.Activity.reply(from: label(entry.fromHandle), to: label(entry.toHandle ?? ""))
    case .dmOut, .dmIn:
      Strings.App.Activity.to(from: label(entry.fromHandle), to: label(entry.toHandle ?? ""))
    }
  }

  /// The delivery or delegation state, in words; nil where the row has none.
  static func status(_ entry: ActivityEntry) -> String? {
    guard let raw = entry.status, !raw.isEmpty else {
      return nil
    }

    if entry.kind == .delegation, let word = Strings.App.Activity.GroupStatus[raw] {
      return word
    }

    switch raw {
    case "Replied": return NativeStrings.ActivityStatus.replied
    case "Sending": return NativeStrings.ActivityStatus.sending
    case "Queued": return NativeStrings.ActivityStatus.queued
    case "Sent": return NativeStrings.ActivityStatus.sent
    case "Ambiguous target": return NativeStrings.ActivityStatus.ambiguous
    default: return CronText.humanised(raw)
    }
  }

  /// `Today`, `Yesterday`, `Tue, Sep 9`: the heading over a day's rows.
  static func dayTitle(_ start: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current)
    -> String
  {
    if calendar.isDate(start, inSameDayAs: now) {
      return Strings.App.Activity.today
    }

    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(start, inSameDayAs: yesterday) {
      return Strings.App.Activity.yesterday
    }

    return start.formatted(
      Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(locale))
  }

  /// A row's clock time.
  static func clock(_ seconds: Double, locale: Locale = .current) -> String {
    Date(timeIntervalSince1970: seconds).formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
  }
}
