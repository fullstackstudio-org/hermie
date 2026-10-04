import Foundation
import HermieProtocol

// The cron model: one shape for a cron job, whichever surface it arrived on
// ========================================================================
//
// The gateway has two surfaces for the same job and they do not agree
// (`features/cron/model.ts` in the Expo app, which this ports):
//
//  - `cron.manage {action: "list"}` answers `_format_job` rows, which key the job as `job_id`, carry
//    a `prompt_preview` and flatten the schedule to its human `schedule_display` string;
//  - the HTTP routes answer the STORED job: keyed `id`, the full `prompt`, and the PARSED schedule
//    (an object) under `schedule` with the human string under `schedule_display`.
//
// Reading both here is what lets the list and the detail read the same fields. `repeat` is a count
// in the stored job (`{times, completed}`, `times: null` meaning forever) and a rendered word
// ("forever", "2/3") in a list row; only the count is modelled, because a rendered string cannot be
// counted back.

/// What a cron's dot says.
public enum CronStatus: String, Sendable, Equatable, CaseIterable {
  case ok
  case failed
  case paused
  case pending
}

/// One cron job, normalised from either surface.
public struct CronJob: Sendable, Equatable, Hashable, Identifiable {
  public var id: String
  public var name: String
  /// The schedule as the gateway says it (`schedule_display`): `every 30m`, `0 9 * * 1-5`,
  /// `weekdays at 9am`, `once at 2026-10-04 09:00`. `CronScheduleDescription` puts it in words.
  public var schedule: String
  /// The full prompt; present only on a detail read.
  public var prompt: String
  public var promptPreview: String
  /// Where the result goes: `local`, `bot-chat`, `bot-chat:<bot>`, or a messaging platform.
  public var deliver: String
  public var enabled: Bool
  public var state: String
  public var nextRunAt: Date?
  public var lastRunAt: Date?
  public var lastStatus: String?
  public var lastError: String?
  public var pausedAt: String?
  public var pausedReason: String?
  /// How many times in total; `nil` is "until removed".
  public var repeatTimes: Int?
  public var skills: [String]
  public var model: String?
  /// Which profile's cron store the job lives in. The HTTP list tags every row with it; every
  /// mutation and detail read has to hand it back, because `cron.manage` binds the profile's home
  /// to it and would otherwise look for the job in the launch profile's store.
  public var profile: String?

  public init(
    id: String,
    name: String = "",
    schedule: String = "",
    prompt: String = "",
    promptPreview: String = "",
    deliver: String = "local",
    enabled: Bool = true,
    state: String = "",
    nextRunAt: Date? = nil,
    lastRunAt: Date? = nil,
    lastStatus: String? = nil,
    lastError: String? = nil,
    pausedAt: String? = nil,
    pausedReason: String? = nil,
    repeatTimes: Int? = nil,
    skills: [String] = [],
    model: String? = nil,
    profile: String? = nil
  ) {
    self.id = id
    self.name = name
    self.schedule = schedule
    self.prompt = prompt
    self.promptPreview = promptPreview
    self.deliver = deliver
    self.enabled = enabled
    self.state = state
    self.nextRunAt = nextRunAt
    self.lastRunAt = lastRunAt
    self.lastStatus = lastStatus
    self.lastError = lastError
    self.pausedAt = pausedAt
    self.pausedReason = pausedReason
    self.repeatTimes = repeatTimes
    self.skills = skills
    self.model = model
    self.profile = profile
  }

  /// Normalise either surface's row. `job_id` wins when both keys are present.
  public init(row: JSONObject) {
    let text = { (key: String) -> String in row[key]?.stringValue ?? "" }
    let nonEmpty = { (key: String) -> String? in
      row[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }
    let prompt = text("prompt")
    let enabled = row["enabled"]

    self.init(
      id: text("job_id").isEmpty ? text("id") : text("job_id"),
      name: text("name"),
      schedule: Self.scheduleDisplay(row),
      prompt: prompt,
      promptPreview: text("prompt_preview").isEmpty ? prompt : text("prompt_preview"),
      deliver: text("deliver").isEmpty ? "local" : text("deliver"),
      // A row that says nothing about `enabled` is an enabled row: the scheduler treats a missing
      // flag as on, and showing it as paused would be a lie that survives until the next detail read.
      enabled: enabled == nil || enabled == .null ? true : enabled != .bool(false),
      state: text("state"),
      nextRunAt: nonEmpty("next_run_at").flatMap(CronDate.parse),
      lastRunAt: nonEmpty("last_run_at").flatMap(CronDate.parse),
      lastStatus: nonEmpty("last_status"),
      lastError: nonEmpty("last_error") ?? Self.fireError(row["last_fire_error"]) ?? nonEmpty("last_delivery_error"),
      pausedAt: nonEmpty("paused_at"),
      pausedReason: nonEmpty("paused_reason"),
      repeatTimes: Self.repeatTimes(row["repeat"]),
      skills: (row["skills"]?.arrayValue ?? []).compactMap(\.stringValue),
      model: nonEmpty("model"),
      // `profile_name` is the same value under the key the profiles routes use.
      profile: nonEmpty("profile") ?? nonEmpty("profile_name")
    )
  }

  /// The schedule as a line, from either surface (`cron/jobs.py::_schedule_display_for_job`): the
  /// stored spec is an object whose readable form is one of a known set of keys, and a spec that
  /// carries none of them is better shown as nothing than as noise.
  static func scheduleDisplay(_ row: JSONObject) -> String {
    let display = (row["schedule_display"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    if !display.isEmpty {
      return display
    }

    switch row["schedule"] {
    case .string(let text)?:
      return text
    case .object(let spec)?:
      for key in ["display", "value", "expr", "run_at"] {
        let text = (spec[key]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if !text.isEmpty {
          return text
        }
      }

      return ""
    default:
      return ""
    }
  }

  /// `{times, completed}` from the stored job, or a plain count (a number, or a numeric string).
  static func repeatTimes(_ value: JSONValue?) -> Int? {
    let counted = value?.objectValue.map { $0["times"] } ?? value

    switch counted {
    case .number(let number)?:
      return number.isFinite ? Int(exactly: number.rounded(.towardZero)) : nil
    case .string(let text)?:
      return Int(text.trimmingCharacters(in: .whitespacesAndNewlines))
    default:
      return nil
    }
  }

  /// A missed fire, which the gateway records as an OBJECT: `{at, detail}`, the scheduler stamping
  /// when it could not start the job. The detail is the sentence worth showing.
  static func fireError(_ value: JSONValue?) -> String? {
    switch value {
    case .object(let record)?:
      record["detail"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    case .string(let text)?:
      text.isEmpty ? nil : text
    default:
      nil
    }
  }

  /// The dot next to a cron.
  ///
  /// Paused beats failed on purpose: a paused cron is not going to retry, so the first thing to say
  /// about it is that it is off, not that its last attempt went badly. The error itself is still on
  /// the row underneath.
  public var status: CronStatus {
    if !enabled || state == "paused" {
      return .paused
    }

    let lastStatus = (lastStatus ?? "").lowercased()

    if lastError != nil || Self.failedStatuses.contains(lastStatus) {
      return .failed
    }

    if Self.okStatuses.contains(lastStatus) {
      return .ok
    }

    return .pending
  }

  static let failedStatuses: Set<String> = ["error", "failed", "failure", "fail"]
  static let okStatuses: Set<String> = ["ok", "success", "succeeded", "completed", "done"]

  /// The first plain sentence of the last error: the scheduler stores raw exception text
  /// (`RuntimeError: Cron job 'x' has no model configured (job.model=None, …)`). Empty without one.
  public var lastErrorSummary: String {
    CronError.summary(lastError)
  }

  /// The prompt a person reads: the full one when it was read, the preview before that.
  public var displayPrompt: String {
    prompt.isEmpty ? promptPreview : prompt
  }

  /// The bot whose chat this cron delivers into, from `bot-chat:<name>`; `nil` for any other target.
  public var deliveredBot: String? {
    CronDelivery.bot(in: deliver)
  }
}

/// What a row says about WHEN a cron runs, given what it actually is.
///
/// Three cases, in order, because they answer three different questions (`cronRowWhen`):
///
///  - **Paused.** A paused cron is not going anywhere, so "next" is not a question the row answers
///    for it, even where the gateway still carries a stale `next_run_at` from before it was paused.
///    What is left to say is what it last did, or nothing at all if it never ran.
///  - **Overdue.** An active cron whose `next_run_at` slipped into the past is not lying about the
///    future, the scheduler is simply behind: one word rather than a signed relative time.
///  - **Otherwise** the next run if it has one, the last run if it does not, and "not scheduled".
public enum CronRowWhen: Sendable, Equatable {
  case next(Date)
  case last(Date)
  /// Paused and never run.
  case neverRun
  case overdue
  case notScheduled
}

extension CronJob {
  public func rowWhen(now: Date = .now) -> CronRowWhen {
    if status == .paused {
      return lastRunAt.map(CronRowWhen.last) ?? .neverRun
    }

    if let nextRunAt, nextRunAt < now {
      return .overdue
    }

    if let nextRunAt {
      return .next(nextRunAt)
    }

    if let lastRunAt {
      return .last(lastRunAt)
    }

    return .notScheduled
  }
}

/// Where a cron delivers (`deliver`).
public enum CronDelivery {
  /// The bot of `bot-chat:<name>`; `nil` for `local`, a bare `bot-chat` and every platform.
  public static func bot(in deliver: String) -> String? {
    let prefix = "bot-chat:"

    guard deliver.hasPrefix(prefix) else {
      return nil
    }

    let name = String(deliver.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)

    return name.isEmpty ? nil : name
  }
}

/// One run of a cron: an ordinary session row (`cron_{job_id}_{timestamp}`), in `list_sessions_rich`
/// shape.
///
/// A session row has NO `status` column: the outcome is `end_reason`, which the portability layer
/// copies out of the sessions table. A run the scheduler finished says `cron_complete`; one that
/// ended without a final assistant message says `cron_incomplete_no_output`.
public struct CronRun: Sendable, Equatable, Hashable, Identifiable {
  /// What a run came to.
  public enum Outcome: Sendable, Equatable {
    /// No end recorded and none seen yet.
    case running
    case ok
    case failed
    /// An `end_reason` this build has no word for; the caller says it as the gateway did.
    case other
  }

  public var id: String
  /// Unix seconds.
  public var startedAt: Double?
  public var endedAt: Double?
  public var lastActive: Double?
  public var status: String?
  public var messageCount: Int
  public var preview: String
  public var title: String

  public init(
    id: String,
    startedAt: Double? = nil,
    endedAt: Double? = nil,
    lastActive: Double? = nil,
    status: String? = nil,
    messageCount: Int = 0,
    preview: String = "",
    title: String = ""
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.lastActive = lastActive
    self.status = status
    self.messageCount = messageCount
    self.preview = preview
    self.title = title
  }

  public init(row: JSONObject) {
    let number = { (key: String) -> Double? in
      switch row[key] {
      case .number(let value)? where value.isFinite: value
      case .string(let text)?: Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
      default: nil
      }
    }
    let nonEmpty = { (key: String) -> String? in row[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }

    self.init(
      id: row["id"]?.stringValue ?? "",
      startedAt: number("started_at"),
      endedAt: number("ended_at"),
      lastActive: number("last_active"),
      status: nonEmpty("status") ?? nonEmpty("end_reason"),
      messageCount: number("message_count").flatMap { Int(exactly: $0.rounded(.towardZero)) } ?? 0,
      preview: row["preview"]?.stringValue ?? "",
      title: row["title"]?.stringValue ?? ""
    )
  }

  public var outcome: Outcome {
    let status = (status ?? "").lowercased()

    if status.isEmpty {
      return endedAt == nil ? .running : .ok
    }

    if Self.failedWords.contains(where: { status.contains($0) }) {
      return .failed
    }

    if Self.okWords.contains(status) {
      return .ok
    }

    return .other
  }

  static let okWords: Set<String> = [
    "ok", "success", "succeeded", "complete", "completed", "cron_complete", "done", "idle"
  ]
  /// Substrings of a failed end: `cron_incomplete_no_output`, `error`, `failed`, `interrupted`.
  static let failedWords = ["incomplete", "error", "fail", "interrupt", "no_output", "timeout", "timed_out"]

  /// When the run started, else when it was last active.
  public var when: Date? {
    (startedAt ?? lastActive).map(CronDate.fromEpoch)
  }

  /// A person-readable heading: the session's title where it has one.
  public var displayTitle: String {
    title.isEmpty ? id : title
  }
}

/// One place a cron can deliver to (`GET /api/cron/delivery-targets`).
public struct CronDeliveryTarget: Sendable, Equatable, Hashable, Identifiable {
  public var id: String
  public var name: String
  /// False for a platform that has no home channel configured: it can be chosen but will not deliver.
  public var homeTargetSet: Bool

  public init(id: String, name: String, homeTargetSet: Bool = true) {
    self.id = id
    self.name = name
    self.homeTargetSet = homeTargetSet
  }

  public init(row: JSONObject) {
    let id = (row["id"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? row["name"]?.stringValue ?? ""
    let name = row["name"]?.stringValue ?? ""

    self.init(id: id, name: name.isEmpty ? id : name, homeTargetSet: row["home_target_set"] != .bool(false))
  }

  /// A gateway that cannot list its targets still delivers locally, and an editor with one option
  /// beats an editor that refuses to open.
  public static let local = CronDeliveryTarget(id: "local", name: "Local (save only)")
}

// MARK: - Errors

/// The text of a cron's last error, shortened to its first plain sentence.
public enum CronError {
  static let summaryLimit = 200

  /// Port of the desktop's `lastErrorSummary`, so both clients say the same thing. The wrappers nest
  /// (a marker, then an emoji, then the exception class): peeled until the text is stable.
  public static func summary(_ lastError: String?) -> String {
    var text = (lastError ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var previous = ""

    while previous != text {
      previous = text
      text = strip(markerPattern, from: text)
      text = stripEmoji(from: text)
      text = strip(prefixPattern, from: text)
    }

    let end = firstSentenceEnd(in: text)
    let sentence = (end.map { String(text[..<$0]) } ?? text).trimmingCharacters(in: .whitespacesAndNewlines)

    guard sentence.count > summaryLimit else {
      return sentence
    }

    let cut = String(sentence.prefix(summaryLimit - 1)).trimmingCharacters(in: .whitespacesAndNewlines)

    return cut + "…"
  }

  private static let markerPattern = #"^\[[a-z_]+(?::[a-z_]+)?\]\s*"#
  private static let prefixPattern = #"^(?:[A-Za-z_][\w.]*(?:Error|Exception)|Exception):\s*"#
  private static let emoji = ["⚠️", "⚠", "🛑", "❌", "🚫"]

  private static func strip(_ pattern: String, from text: String) -> String {
    guard let range = text.range(of: pattern, options: .regularExpression) else {
      return text
    }

    return String(text[range.upperBound...]).replacingOccurrences(
      of: #"^\s+"#, with: "", options: .regularExpression)
  }

  private static func stripEmoji(from text: String) -> String {
    for mark in emoji where text.hasPrefix(mark) {
      return String(text.dropFirst(mark.count)).replacingOccurrences(
        of: #"^\s+"#, with: "", options: .regularExpression)
    }

    return text
  }

  /// The index just past the first sentence's full stop (`/\. |\n/`), or `nil` for one sentence.
  private static func firstSentenceEnd(in text: String) -> String.Index? {
    var best: String.Index?

    if let stop = text.range(of: ". ") {
      best = text.index(after: stop.lowerBound)
    }

    if let newline = text.firstIndex(of: "\n"), best == nil || newline < best! {
      best = newline
    }

    return best
  }
}

// MARK: - Dates

/// How the gateway's timestamps are read.
public enum CronDate {
  /// An ISO 8601 date or date-time as Python writes it (`2026-10-04T09:00:00.123456+02:00`, with a
  /// space for the `T`, with no zone). A time with no zone is read in this device's zone, as the
  /// Expo app's `Date.parse` read it.
  public static func parse(_ text: String) -> Date? {
    let pattern = #"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$"#
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))
    else {
      return nil
    }

    let group = { (index: Int) -> String? in
      Range(match.range(at: index), in: value).map { String(value[$0]) }
    }
    var components = DateComponents()
    components.year = group(1).flatMap { Int($0) }
    components.month = group(2).flatMap { Int($0) }
    components.day = group(3).flatMap { Int($0) }
    components.hour = group(4).flatMap { Int($0) } ?? 0
    components.minute = group(5).flatMap { Int($0) } ?? 0
    components.second = group(6).flatMap { Int($0) } ?? 0

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone(of: group(7)) ?? .current

    guard let date = calendar.date(from: components),
      calendar.dateComponents([.year, .month, .day], from: date).day == components.day
    else {
      return nil
    }

    return date
  }

  private static func zone(of text: String?) -> TimeZone? {
    guard let text else {
      return nil
    }

    if text == "Z" {
      return TimeZone(secondsFromGMT: 0)
    }

    let digits = text.dropFirst().replacingOccurrences(of: ":", with: "")
    let hours = Int(digits.prefix(2)) ?? 0
    let minutes = digits.count > 2 ? Int(digits.dropFirst(2)) ?? 0 : 0
    let seconds = (hours * 60 + minutes) * 60

    return TimeZone(secondsFromGMT: text.hasPrefix("-") ? -seconds : seconds)
  }

  /// Epoch seconds, or milliseconds when the number is too large to be seconds.
  public static func fromEpoch(_ value: Double) -> Date {
    Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value)
  }
}
