import Foundation

// The schedule builder, as pure functions (`features/cron/schedule.ts`)
// ======================================================================
//
// The gateway does not take a structured schedule: `cron.manage add` and `PUT /api/cron/jobs/{id}`
// both take ONE string, which `cron/jobs.py::parse_schedule` reads. So the builder's whole job is to
// emit a string that parser accepts, and the safest way to know it does is to emit only the forms
// the parser documents:
//
//  - `every 30m` / `every 2h` / `every 1d`: a recurring interval;
//  - `every day at 9am`, `every monday 9am`, `weekdays at 9am`: a weekday/time phrase the parser
//    turns into a 5-field cron expression;
//  - a raw 5-field cron expression;
//  - `in 2h`, or an ISO timestamp: a one-shot.
//
// Nothing here reads the clock. The result describes what was built, never when the job fires: only
// the gateway knows that (it owns the timezone and the DST rules), which is why the editor shows the
// server's `next_run_at` after a save.

public enum CronScheduleMode: String, Sendable, Equatable, CaseIterable {
  case interval
  case daily
  case cron
  case once
}

public enum CronIntervalUnit: String, Sendable, Equatable, CaseIterable {
  case minutes
  case hours
  case days

  var suffix: String {
    switch self {
    case .minutes: "m"
    case .hours: "h"
    case .days: "d"
    }
  }
}

/// One field of a 5-field cron expression, in the order it is written.
public enum CronField: Int, Sendable, Equatable, CaseIterable {
  case minute
  case hour
  case dayOfMonth
  case month
  case dayOfWeek

  /// The bounds `croniter` enforces (7 is Sunday as well as 0).
  var range: ClosedRange<Int> {
    switch self {
    case .minute: 0...59
    case .hour: 0...23
    case .dayOfMonth: 1...31
    case .month: 1...12
    case .dayOfWeek: 0...7
    }
  }
}

/// Why a schedule draft cannot be built.
public enum CronScheduleError: Error, Sendable, Equatable {
  /// The interval is not a whole number of at least 1.
  case interval
  /// The time is not `HH:MM`.
  case time
  /// A cron expression has five fields.
  case cronFieldCount
  case cronField(CronField, value: String)
  /// The one-shot is neither `in <duration>` nor an ISO date or date-time.
  case once
}

/// What the schedule picker edits.
public struct CronScheduleDraft: Sendable, Equatable {
  public var mode: CronScheduleMode
  /// Kept as text: a partially typed number must not snap back to a default.
  public var intervalValue: String
  public var intervalUnit: CronIntervalUnit
  /// `HH:MM`, 24-hour.
  public var time: String
  /// Cron weekday numbering: 0 = Sunday … 6 = Saturday. Empty means every day.
  public var weekdays: [Int]
  public var cronExpression: String
  /// `in 2h`, or an ISO date-time.
  public var onceValue: String

  public init(
    mode: CronScheduleMode = .interval,
    intervalValue: String = "30",
    intervalUnit: CronIntervalUnit = .minutes,
    time: String = "09:00",
    weekdays: [Int] = [],
    cronExpression: String = "0 9 * * 1-5",
    onceValue: String = "in 2h"
  ) {
    self.mode = mode
    self.intervalValue = intervalValue
    self.intervalUnit = intervalUnit
    self.time = time
    self.weekdays = weekdays
    self.cronExpression = cronExpression
    self.onceValue = onceValue
  }

  public static let `default` = CronScheduleDraft()
}

public enum CronSchedule {
  // MARK: Building

  /// The schedule string the gateway parses, or the reason it cannot be built.
  public static func build(_ draft: CronScheduleDraft) -> Result<String, CronScheduleError> {
    switch draft.mode {
    case .interval:
      let text = draft.intervalValue.trimmingCharacters(in: .whitespacesAndNewlines)

      guard let value = Int(text), value >= 1 else {
        return .failure(.interval)
      }

      return .success("every \(value)\(draft.intervalUnit.suffix)")

    case .daily:
      guard let clock = parseClock(draft.time) else {
        return .failure(.time)
      }

      let spec = daySpec(for: draft.weekdays)
      let time = clockPhrase(hour: clock.hour, minute: clock.minute)

      // "every day at 9am" and "every monday 9am" both parse; "weekdays at 9am" is the keyword form,
      // which the parser reads without the "every" prefix.
      return .success(spec.every ? "every \(spec.phrase) at \(time)" : "\(spec.phrase) at \(time)")

    case .cron:
      let expression = draft.cronExpression
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")

      if let error = validateCronExpression(expression) {
        return .failure(error)
      }

      return .success(expression)

    case .once:
      let value = draft.onceValue.trimmingCharacters(in: .whitespacesAndNewlines)

      if value.range(of: #"^in\s+"#, options: [.regularExpression, .caseInsensitive]) != nil {
        let duration = value.replacingOccurrences(
          of: #"^in\s+"#, with: "", options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        guard matches(durationPattern, duration, ignoringCase: true) else {
          return .failure(.once)
        }

        return .success("in \(duration.lowercased())")
      }

      return matches(isoDatePattern, value) ? .success(value) : .failure(.once)
    }
  }

  /// Validate one 5-field cron expression the way the gateway's parser would accept it, minus the
  /// parts only `croniter` can judge: the field count, the alphabet, and that every number in a field
  /// is inside that field's range. A name like `MON` or a step like `*/15` passes through, because
  /// the parser allows both and refusing them here would invent a stricter contract than the server's.
  public static func validateCronExpression(_ expression: String) -> CronScheduleError? {
    let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)

    guard fields.count == CronField.allCases.count else {
      return .cronFieldCount
    }

    for (field, value) in zip(CronField.allCases, fields) {
      guard matches(#"^[A-Za-z0-9*\-,/]+$"#, value) else {
        return .cronField(field, value: value)
      }

      let numbers = value.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }

      if numbers.contains(where: { !field.range.contains($0) }) {
        return .cronField(field, value: value)
      }
    }

    return nil
  }

  // MARK: Clock and days

  /// `(9, 0)` → `9am`, `(8, 30)` → `8:30am`, `(0, 0)` → `12am`.
  public static func clockPhrase(hour: Int, minute: Int) -> String {
    let hour12 = hour % 12 == 0 ? 12 : hour % 12
    let suffix = hour < 12 ? "am" : "pm"

    return minute == 0 ? "\(hour12)\(suffix)" : "\(hour12):\(String(format: "%02d", minute))\(suffix)"
  }

  /// `09:00` → `(9, 0)`; anything else → nil.
  public static func parseClock(_ text: String) -> (hour: Int, minute: Int)? {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard matches(#"^\d{1,2}:\d{2}$"#, value) else {
      return nil
    }

    let parts = value.split(separator: ":").compactMap { Int($0) }

    guard parts.count == 2, parts[0] <= 23, parts[1] <= 59 else {
      return nil
    }

    return (parts[0], parts[1])
  }

  static let weekdayWords = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

  /// The day part of a weekday/time phrase. No day or all seven is "every day"; Monday to Friday is the
  /// parser's own `weekdays`; Saturday and Sunday `weekends`; anything else the names, comma-separated.
  static func daySpec(for weekdays: [Int]) -> (phrase: String, every: Bool) {
    let days = Set(weekdays).filter { (0...6).contains($0) }.sorted()

    if days.isEmpty || days.count == 7 {
      return ("day", true)
    }

    if days == [1, 2, 3, 4, 5] {
      return ("weekdays", false)
    }

    if days == [0, 6] {
      return ("weekends", false)
    }

    return (days.map { weekdayWords[$0] }.joined(separator: ", "), true)
  }

  // MARK: Reading a stored schedule back

  /// Read a stored schedule string back into a draft, so opening the editor on an existing cron lands
  /// on the mode that wrote it.
  ///
  /// A schedule the builder cannot express (a six-field expression, a phrase with named months) comes
  /// back as Cron with the raw string in the field, because showing it verbatim is honest and
  /// rewriting it would silently change when the cron fires. What the gateway ADDS on its side is
  /// undone: `every 120m` is how it spells `every 2h`, and `once at …` / `once in …` are how it spells
  /// a one-shot.
  public static func draft(from schedule: String?) -> CronScheduleDraft {
    let raw = (schedule ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    if raw.isEmpty {
      return .default
    }

    if let (value, unit) = interval(in: raw) {
      var draft = CronScheduleDraft.default
      let (shown, shownUnit) = tidy(value, unit)
      draft.mode = .interval
      draft.intervalValue = String(shown)
      draft.intervalUnit = shownUnit

      return draft
    }

    var once = raw

    if let range = raw.range(of: #"^once\s+(at|in)\s+"#, options: [.regularExpression, .caseInsensitive]) {
      let kind = raw[range].lowercased().contains(" in ") ? "in " : ""
      once = kind + raw[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    if once.range(of: #"^in\s+.+"#, options: [.regularExpression, .caseInsensitive]) != nil
      || matches(isoDatePattern, once)
    {
      var draft = CronScheduleDraft.default
      draft.mode = .once
      draft.onceValue = once

      return draft
    }

    if let phrase = parseDayTimePhrase(raw) {
      var draft = CronScheduleDraft.default
      draft.mode = .daily
      draft.time = phrase.time
      draft.weekdays = phrase.weekdays

      return draft
    }

    var draft = CronScheduleDraft.default
    draft.mode = .cron
    draft.cronExpression = raw

    return draft
  }

  /// `every 30m`, `every 2 hours`: the interval's number and unit.
  static func interval(in raw: String) -> (Int, CronIntervalUnit)? {
    guard
      let match = captures(
        #"^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$"#, in: raw,
        options: .caseInsensitive),
      match.count == 2, let value = Int(match[0])
    else {
      return nil
    }

    switch match[1].lowercased().first {
    case "h": return (value, .hours)
    case "d": return (value, .days)
    default: return (value, .minutes)
    }
  }

  /// The inverse of the daily/weekly branch: `every monday 9am`, `weekdays at 9am`, `every day at
  /// 14:30`, `every monday, wednesday at noon`. The time comes back as `HH:MM`.
  static func parseDayTimePhrase(_ raw: String) -> (weekdays: [Int], time: String)? {
    var tokens = raw.lowercased()
      .replacingOccurrences(of: ",", with: " ")
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)

    if tokens.first == "every" {
      tokens.removeFirst()
    }

    guard tokens.count >= 2 else {
      return nil
    }

    let keywords: [String: [Int]] = [
      "day": [], "daily": [], "everyday": [],
      "weekday": [1, 2, 3, 4, 5], "weekdays": [1, 2, 3, 4, 5],
      "weekend": [0, 6], "weekends": [0, 6]
    ]
    var weekdays: [Int]
    var index = 0

    if let keyword = keywords[tokens[0]] {
      weekdays = keyword
      index = 1
    } else {
      weekdays = []

      while index < tokens.count {
        let token = tokens[index]

        if token == "and" {
          index += 1
          continue
        }

        guard let day = weekdayWords.firstIndex(where: { $0 == token || $0.prefix(3) == token }) else {
          break
        }

        if !weekdays.contains(day) {
          weekdays.append(day)
        }

        index += 1
      }

      if weekdays.isEmpty {
        return nil
      }
    }

    let rest = tokens[index...].filter { $0 != "at" }

    guard !rest.isEmpty, let clock = parseClockPhrase(rest.joined()) else {
      return nil
    }

    return (weekdays, String(format: "%02d:%02d", clock.hour, clock.minute))
  }

  /// `9am` / `9:30am` / `14:00` / `noon` → 24-hour parts, mirroring `_parse_clock_time`.
  static func parseClockPhrase(_ text: String) -> (hour: Int, minute: Int)? {
    let value = text.lowercased().filter { !$0.isWhitespace }

    if value == "noon" || value == "midday" {
      return (12, 0)
    }

    if value == "midnight" {
      return (0, 0)
    }

    guard let match = captures(#"^(\d{1,2})(?::(\d{2}))?(am|pm)?$"#, in: value, options: []),
      var hour = Int(match[0])
    else {
      return nil
    }

    let minute = Int(match[1]) ?? 0

    if !match[2].isEmpty {
      guard (1...12).contains(hour) else {
        return nil
      }

      hour = (hour % 12) + (match[2] == "pm" ? 12 : 0)
    }

    return hour > 23 || minute > 59 ? nil : (hour, minute)
  }

  // MARK: Patterns

  static let isoDatePattern =
    #"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$"#
  static let durationPattern = #"^\d*\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$"#

  static func matches(_ pattern: String, _ text: String, ignoringCase: Bool = false) -> Bool {
    var options = String.CompareOptions.regularExpression

    if ignoringCase {
      options.insert(.caseInsensitive)
    }

    return text.range(of: pattern, options: options) != nil
  }

  /// The capture groups of the first match, `""` for one that did not take part; nil for no match.
  static func captures(_ pattern: String, in text: String, options: NSRegularExpression.Options) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
      let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    else {
      return nil
    }

    return (1..<match.numberOfRanges).map { index in
      Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
    }
  }
}
