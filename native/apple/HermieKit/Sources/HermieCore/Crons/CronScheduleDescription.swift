import Foundation

/// A schedule, understood well enough to be said in words.
///
/// Only the forms the builder writes, and the forms the gateway spells them back as
/// (`cron/jobs.py::_schedule_display_for_job`), are understood; anything else is `raw` and shown
/// exactly as stored. A cron expression nobody can read is still better than a friendly sentence that
/// describes a different schedule. The words themselves (and their languages) are the view's.
public enum CronScheduleDescription: Sendable, Equatable {
  /// No schedule at all.
  case unknown
  /// `every 30m`; the gateway always spells an interval in minutes, so a count that divides into hours
  /// or days is said in those (`every 120m` is every 2 hours).
  case interval(count: Int, unit: CronIntervalUnit)
  /// `in 2h` / `once in 2h`: the duration as written.
  case onceIn(String)
  /// An ISO date-time, or `once at …`: as written, and as a date where it reads as one.
  case onceAt(String, Date?)
  /// A day set and a time of day; no weekdays is every day. From `weekdays at 9am`,
  /// `every monday 9am` and the plain five-field cron expressions that say the same thing.
  case daily(weekdays: [Int], hour: Int, minute: Int)
  case raw(String)
}

extension CronSchedule {
  public static func describe(_ schedule: String) -> CronScheduleDescription {
    let raw = schedule.trimmingCharacters(in: .whitespacesAndNewlines)

    if raw.isEmpty {
      return .unknown
    }

    if let (value, unit) = interval(in: raw) {
      let (count, shown) = tidy(value, unit)

      return .interval(count: count, unit: shown)
    }

    if let once = captures(#"^(?:once\s+)?in\s+(.+)$"#, in: raw, options: .caseInsensitive) {
      return .onceIn(once[0].trimmingCharacters(in: .whitespacesAndNewlines))
    }

    if let once = captures(#"^once\s+at\s+(.+)$"#, in: raw, options: .caseInsensitive) {
      let text = once[0].trimmingCharacters(in: .whitespacesAndNewlines)

      return .onceAt(text, CronDate.parse(text))
    }

    if matches(isoDatePattern, raw) {
      return .onceAt(raw, CronDate.parse(raw))
    }

    if let phrase = parseDayTimePhrase(raw), let clock = parseClock(phrase.time) {
      return .daily(weekdays: phrase.weekdays, hour: clock.hour, minute: clock.minute)
    }

    if let simple = simpleCron(raw) {
      return .daily(weekdays: simple.weekdays, hour: simple.hour, minute: simple.minute)
    }

    return .raw(raw)
  }

  /// `(120, minutes)` → `(2, hours)`, `(1440, minutes)` → `(1, days)`.
  static func tidy(_ value: Int, _ unit: CronIntervalUnit) -> (Int, CronIntervalUnit) {
    guard unit == .minutes else {
      return (value, unit)
    }

    if value >= 1440, value % 1440 == 0 {
      return (value / 1440, .days)
    }

    if value >= 60, value % 60 == 0 {
      return (value / 60, .hours)
    }

    return (value, unit)
  }

  /// `M H * * D` with a plain minute and hour, every day of the month and every month, and a weekday
  /// field of numbers, lists and ranges (`*`, `1-5`, `0,6`, `1,3,5`); nil for anything fancier.
  static func simpleCron(_ expression: String) -> (weekdays: [Int], hour: Int, minute: Int)? {
    let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)

    guard fields.count == 5, fields[2] == "*", fields[3] == "*",
      let minute = Int(fields[0]), (0...59).contains(minute),
      let hour = Int(fields[1]), (0...23).contains(hour)
    else {
      return nil
    }

    if fields[4] == "*" {
      return ([], hour, minute)
    }

    var days = Set<Int>()

    for part in fields[4].split(separator: ",") {
      let ends = part.split(separator: "-").map { Int($0) }

      switch ends.count {
      case 1:
        guard let day = ends[0], (0...7).contains(day) else { return nil }
        days.insert(day % 7)
      case 2:
        guard let first = ends[0], let last = ends[1], (0...7).contains(first), (0...7).contains(last),
          first <= last
        else { return nil }
        days.formUnion((first...last).map { $0 % 7 })
      default:
        return nil
      }
    }

    return (days.sorted(), hour, minute)
  }
}
