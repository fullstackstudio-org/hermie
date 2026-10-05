import Foundation
import HermieProtocol
import HermieTranscript

/**
 What the gateway reports about use, as plain values.

 Three of the gateway's calls say something about it, and none says the whole thing:

 - `GET /api/analytics/usage?days=<n>&profile=<bot>` (a REST route of the dashboard, scoped to one
   profile) groups that profile's sessions by the UTC day each STARTED on and sums their tokens and
   cost: the only source of "per bot, per day". It is the answer behind `DailyUsage`.
 - `session.usage` (RPC, one live session) reports that session's tokens and how full its context window
   is, plus the provider account's limits as text lines (`credits_lines`, `account_lines`).
 - `usage.bars` (RPC, no profile) is the Nous account's plan and top-up balance, as display strings and
   fractions. Only a Nous account has one.
 - `insights.get` (RPC, scoped to a profile) counts sessions and messages over a number of days, and
   nothing else.

 Everything here is the gateway's or a provider's text or number: finite and non-negative numbers are
 kept, anything else is zero, and a line of text is drawn as characters, never as Markdown.
 */

/// One day's use by one profile, from the gateway's analytics route.
public struct DailyUsage: Sendable, Equatable, Identifiable {
  /// `yyyy-MM-dd`, in UTC: the day the sessions STARTED on, which is how the gateway groups them.
  public var day: String
  public var inputTokens: Int
  public var outputTokens: Int
  public var cacheReadTokens: Int
  public var reasoningTokens: Int
  /// What the gateway priced the day's sessions at from its price tables.
  public var estimatedCost: Double
  /// What the provider billed, where the provider says (most do not).
  public var actualCost: Double
  public var sessions: Int
  public var apiCalls: Int

  public var id: String { day }

  public init(
    day: String, inputTokens: Int = 0, outputTokens: Int = 0, cacheReadTokens: Int = 0, reasoningTokens: Int = 0,
    estimatedCost: Double = 0, actualCost: Double = 0, sessions: Int = 0, apiCalls: Int = 0
  ) {
    self.day = day
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.cacheReadTokens = cacheReadTokens
    self.reasoningTokens = reasoningTokens
    self.estimatedCost = estimatedCost
    self.actualCost = actualCost
    self.sessions = sessions
    self.apiCalls = apiCalls
  }

  /// Tokens the model read and wrote. A cached read and a reasoning token are parts of these (or of the
  /// bill) and are kept apart, not added.
  public var totalTokens: Int { inputTokens + outputTokens }

  /// What the day cost: the provider's figure where there is one, else the gateway's estimate.
  public var cost: Double { actualCost > 0 ? actualCost : estimatedCost }

  /// The cost is the gateway's estimate, not a billed figure.
  public var isEstimate: Bool { actualCost <= 0 && estimatedCost > 0 }

  /// One row of the route's `daily` list, or nil for a row that names no day.
  public static func parse(row: JSONValue) -> DailyUsage? {
    guard case .object(let object) = row, let day = object["day"]?.stringValue, UsageDays.isDayKey(day) else {
      return nil
    }

    return DailyUsage(
      day: day,
      inputTokens: count(object["input_tokens"]),
      outputTokens: count(object["output_tokens"]),
      cacheReadTokens: count(object["cache_read_tokens"]),
      reasoningTokens: count(object["reasoning_tokens"]),
      estimatedCost: amount(object["estimated_cost"]),
      actualCost: amount(object["actual_cost"]),
      sessions: count(object["sessions"]),
      apiCalls: count(object["api_calls"])
    )
  }

  /// The route's `daily` rows, oldest first. A day listed twice is one day (the rows are added).
  public static func parse(analytics body: JSONValue?) -> [DailyUsage] {
    guard let rows = body?["daily"]?.arrayValue else {
      return []
    }

    var byDay: [String: DailyUsage] = [:]

    for row in rows {
      guard let parsed = parse(row: row) else {
        continue
      }

      if var held = byDay[parsed.day] {
        held.inputTokens += parsed.inputTokens
        held.outputTokens += parsed.outputTokens
        held.cacheReadTokens += parsed.cacheReadTokens
        held.reasoningTokens += parsed.reasoningTokens
        held.estimatedCost += parsed.estimatedCost
        held.actualCost += parsed.actualCost
        held.sessions += parsed.sessions
        held.apiCalls += parsed.apiCalls
        byDay[parsed.day] = held
      } else {
        byDay[parsed.day] = parsed
      }
    }

    return byDay.values.sorted { $0.day < $1.day }
  }

  /// A count: a finite, non-negative number as a whole one; anything else (null, a string, NaN) is zero.
  static func count(_ value: JSONValue?) -> Int {
    guard let number = value?.doubleValue, number.isFinite, number > 0 else {
      return 0
    }

    return number >= Double(Int.max) ? Int.max : Int(number)
  }

  /// An amount of money: finite and non-negative, else zero.
  static func amount(_ value: JSONValue?) -> Double {
    guard let number = value?.doubleValue, number.isFinite, number > 0 else {
      return 0
    }

    return number
  }
}

/// A sum of days.
public struct UsageTotals: Sendable, Equatable {
  public var inputTokens = 0
  public var outputTokens = 0
  public var cacheReadTokens = 0
  public var reasoningTokens = 0
  public var cost = 0.0
  public var sessions = 0
  public var apiCalls = 0
  /// Some of the cost is the gateway's estimate rather than a billed figure.
  public var estimated = false

  public init() {}

  public var totalTokens: Int { inputTokens + outputTokens }

  public var isEmpty: Bool {
    totalTokens == 0 && cost == 0 && sessions == 0 && apiCalls == 0
  }

  public mutating func add(_ day: DailyUsage) {
    inputTokens += day.inputTokens
    outputTokens += day.outputTokens
    cacheReadTokens += day.cacheReadTokens
    reasoningTokens += day.reasoningTokens
    cost += day.cost
    sessions += day.sessions
    apiCalls += day.apiCalls
    estimated = estimated || day.isEstimate
  }

  public mutating func add(_ other: UsageTotals) {
    inputTokens += other.inputTokens
    outputTokens += other.outputTokens
    cacheReadTokens += other.cacheReadTokens
    reasoningTokens += other.reasoningTokens
    cost += other.cost
    sessions += other.sessions
    apiCalls += other.apiCalls
    estimated = estimated || other.estimated
  }
}

/// One bot's days.
public struct BotUsage: Sendable, Equatable, Identifiable {
  /// The profile name.
  public var bot: String
  public var days: [DailyUsage]

  public var id: String { bot }

  public init(bot: String, days: [DailyUsage]) {
    self.bot = bot
    self.days = days
  }
}

/// The calendar the gateway counts days in: UTC, as `yyyy-MM-dd`. A person's own midnight is not
/// knowable from a daily sum, so every surface says its days are the gateway's.
public enum UsageDays {
  private static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
    return calendar
  }

  /// `yyyy-MM-dd` for the UTC day `date` is in.
  public static func key(for date: Date) -> String {
    let parts = utc.dateComponents([.year, .month, .day], from: date)

    return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
  }

  /// The UTC day's midnight, for a day key; nil for a string that is not one.
  public static func date(forKey key: String) -> Date? {
    guard isDayKey(key) else {
      return nil
    }

    let parts = key.split(separator: "-").compactMap { Int($0) }

    guard parts.count == 3 else {
      return nil
    }

    return utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
  }

  /// `^\d{4}-\d{2}-\d{2}$` and a real date.
  public static func isDayKey(_ text: String) -> Bool {
    let scalars = Array(text.unicodeScalars)

    guard scalars.count == 10, scalars[4] == "-", scalars[7] == "-" else {
      return false
    }

    for (index, scalar) in scalars.enumerated() where index != 4 && index != 7 {
      guard ("0"..."9").contains(scalar) else {
        return false
      }
    }

    let parts = text.split(separator: "-").compactMap { Int($0) }

    guard parts.count == 3, (1...12).contains(parts[1]) else {
      return false
    }

    let month = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
    let days = month.flatMap { utc.range(of: .day, in: .month, for: $0)?.count } ?? 31

    return (1...days).contains(parts[2])
  }

  /// The `count` UTC days ending with the one `now` is in, oldest first.
  public static func window(count: Int, endingAt now: Date) -> [String] {
    guard count > 0 else {
      return []
    }

    return (0..<count).reversed().compactMap { back in
      utc.date(byAdding: .day, value: -back, to: now).map(key(for:))
    }
  }
}

/// `insights.get`: how many sessions and messages a profile had over a number of days.
public struct InsightsSummary: Sendable, Equatable {
  public var days: Int
  public var sessions: Int
  public var messages: Int

  public init(days: Int, sessions: Int, messages: Int) {
    self.days = days
    self.sessions = sessions
    self.messages = messages
  }

  public static func parse(_ result: JSONValue?) -> InsightsSummary? {
    guard case .object(let object)? = result, object["sessions"] != nil || object["messages"] != nil else {
      return nil
    }

    return InsightsSummary(
      days: DailyUsage.count(object["days"]), sessions: DailyUsage.count(object["sessions"]),
      messages: DailyUsage.count(object["messages"]))
  }
}

/// One bar of a provider account: spent of total, and what is left, as the gateway worded them.
public struct ProviderUsageBar: Sendable, Equatable {
  /// `plan` (a monthly allowance, drawn as the share used) or `topup` (a balance with no ceiling).
  public var kind: String
  public var remaining: String
  public var total: String
  public var spent: String
  /// Whole per cent used; nil for a bar with no ceiling.
  public var percentUsed: Int?
  /// How much of the bar is left, 0 to 1.
  public var fillFraction: Double

  public init(kind: String, remaining: String, total: String, spent: String, percentUsed: Int?, fillFraction: Double) {
    self.kind = kind
    self.remaining = remaining
    self.total = total
    self.spent = spent
    self.percentUsed = percentUsed
    self.fillFraction = fillFraction
  }

  static func parse(_ value: JSONValue?) -> ProviderUsageBar? {
    guard case .object(let object)? = value else {
      return nil
    }

    let fraction = object["fill_fraction"]?.doubleValue ?? 0

    return ProviderUsageBar(
      kind: object["kind"]?.stringValue ?? "",
      remaining: UsageText.line(object["remaining_display"]?.stringValue),
      total: UsageText.line(object["total_display"]?.stringValue),
      spent: UsageText.line(object["spent_display"]?.stringValue),
      percentUsed: object["pct_used"]?.doubleValue.flatMap { $0.isFinite ? Int($0.rounded()) : nil },
      fillFraction: fraction.isFinite ? min(1, max(0, fraction)) : 0
    )
  }
}

/// `usage.bars`: the Nous account's plan and top-up balance. The only structured account usage the
/// gateway has; Anthropic's subscription windows and Codex's are text lines in `session.usage`.
public struct NousUsageBars: Sendable, Equatable {
  public var status: String
  public var planName: String
  public var renews: String
  public var subscriptionRemaining: String
  public var topupRemaining: String
  public var totalSpendable: String
  public var planBar: ProviderUsageBar?
  public var topupBar: ProviderUsageBar?

  public init(
    status: String = "", planName: String = "", renews: String = "", subscriptionRemaining: String = "",
    topupRemaining: String = "", totalSpendable: String = "", planBar: ProviderUsageBar? = nil,
    topupBar: ProviderUsageBar? = nil
  ) {
    self.status = status
    self.planName = planName
    self.renews = renews
    self.subscriptionRemaining = subscriptionRemaining
    self.topupRemaining = topupRemaining
    self.totalSpendable = totalSpendable
    self.planBar = planBar
    self.topupBar = topupBar
  }

  /// The bars, or nil where the gateway says there are none (`available` false: not signed in to Nous,
  /// or the portal unreachable) or sent nothing usable.
  public static func parse(_ result: JSONValue?) -> NousUsageBars? {
    guard case .object(let object)? = result, object["available"] == .bool(true) else {
      return nil
    }

    let bars = NousUsageBars(
      status: UsageText.line(object["status"]?.stringValue),
      planName: UsageText.line(object["plan_name"]?.stringValue),
      renews: UsageText.line(object["renews_display"]?.stringValue ?? object["renews_at"]?.stringValue),
      subscriptionRemaining: UsageText.line(object["subscription_remaining_display"]?.stringValue),
      topupRemaining: UsageText.line(object["topup_remaining_display"]?.stringValue),
      totalSpendable: UsageText.line(object["total_spendable_display"]?.stringValue),
      planBar: ProviderUsageBar.parse(object["plan_bar"]),
      topupBar: ProviderUsageBar.parse(object["topup_bar"])
    )

    return bars.planBar == nil && bars.topupBar == nil && bars.totalSpendable.isEmpty ? nil : bars
  }
}

/// What `session.usage` says about one live session.
public struct SessionUsage: Sendable, Equatable {
  public var model: String
  public var inputTokens: Int
  public var outputTokens: Int
  public var calls: Int
  /// How full the context window is; nil where the gateway did not say how big the window is.
  public var context: ContextUsage?
  /// The provider account's limits, rendered by the gateway as text, one line each: Anthropic's
  /// subscription windows, Codex's quota, a Nous credit line. Plain text.
  public var accountLines: [String]

  public init(
    model: String = "", inputTokens: Int = 0, outputTokens: Int = 0, calls: Int = 0, context: ContextUsage? = nil,
    accountLines: [String] = []
  ) {
    self.model = model
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.calls = calls
    self.context = context
    self.accountLines = accountLines
  }

  public var totalTokens: Int { inputTokens + outputTokens }

  /// The most account lines kept, and the longest one: what a provider sends is bounded before it is drawn.
  static let lineLimit = 12

  public static func parse(_ result: JSONValue?) -> SessionUsage? {
    guard case .object(let object)? = result, !object.isEmpty else {
      return nil
    }

    // The two kinds of line the gateway sends are one list to the reader: the account's, then the credits.
    let lines = (object["account_lines"]?.arrayValue ?? []) + (object["credits_lines"]?.arrayValue ?? [])

    return SessionUsage(
      model: UsageText.line(object["model"]?.stringValue),
      inputTokens: DailyUsage.count(object["input"]),
      outputTokens: DailyUsage.count(object["output"]),
      calls: DailyUsage.count(object["calls"]),
      context: contextUsageOf(Usage(json: object)),
      accountLines: lines.compactMap { UsageText.line($0.stringValue) }.filter { !$0.isEmpty }.prefix(lineLimit).map { $0 }
    )
  }
}

/// Text the gateway or a provider sent, made safe to draw as characters.
enum UsageText {
  static let limit = 200

  /// One line: control, format and separator characters become spaces, the ends are trimmed, and it is
  /// cut at `limit`.
  static func line(_ text: String?) -> String {
    guard let text else {
      return ""
    }

    var cleaned = String.UnicodeScalarView()

    for scalar in text.unicodeScalars.prefix(limit * 2) {
      switch scalar.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator:
        cleaned.append(" ")
      default:
        cleaned.append(scalar)
      }
    }

    return String(String(cleaned).trimmingCharacters(in: .whitespaces).prefix(limit))
  }
}
