import Foundation

/// One bot's share of a span.
public struct BotUsageTotal: Sendable, Equatable, Identifiable {
  public var bot: String
  public var totals: UsageTotals

  public var id: String { bot }

  public init(bot: String, totals: UsageTotals) {
    self.bot = bot
    self.totals = totals
  }
}

/// One day across every bot, and what each bot used in it.
public struct DayUsage: Sendable, Equatable, Identifiable {
  public var day: String
  public var totals: UsageTotals
  /// Bots that used anything that day, the heaviest first.
  public var bots: [BotUsageTotal]

  public var id: String { day }

  public init(day: String, totals: UsageTotals = UsageTotals(), bots: [BotUsageTotal] = []) {
    self.day = day
    self.totals = totals
    self.bots = bots
  }
}

/**
 Tokens and cost per bot and per day, from the days each bot's profile reported
 (`DailyUsage`, UTC). Pure functions: the models and the alert read through these, so the rules are
 tested without a gateway.

 A span is a list of day keys (`UsageDays.window`), which is how "the last seven days" is the same
 seven days for every bot, and a day on which a bot did nothing is a day with zeros rather than a gap.
 */
public enum UsageAggregation {
  /// The sum of the days that fall in `window`; a day outside it is not counted.
  public static func totals(_ days: [DailyUsage], in window: [String]) -> UsageTotals {
    let inside = Set(window)
    var totals = UsageTotals()

    for day in days where inside.contains(day.day) {
      totals.add(day)
    }

    return totals
  }

  /// One row for every day of `window`, oldest first, zeros for a day with no row: what a chart draws.
  public static func filled(_ days: [DailyUsage], in window: [String]) -> [DailyUsage] {
    var byDay: [String: DailyUsage] = [:]

    for day in days {
      byDay[day.day] = day
    }

    return window.map { byDay[$0] ?? DailyUsage(day: $0) }
  }

  /// Every day of `window` across every bot, oldest first.
  public static func perDay(_ bots: [BotUsage], in window: [String]) -> [DayUsage] {
    let inside = Set(window)
    var byDay: [String: [String: UsageTotals]] = [:]

    for bot in bots {
      for day in bot.days where inside.contains(day.day) {
        byDay[day.day, default: [:]][bot.bot, default: UsageTotals()].add(day)
      }
    }

    return window.map { key in
      let perBot = byDay[key] ?? [:]
      var total = UsageTotals()

      for value in perBot.values {
        total.add(value)
      }

      let ranked = perBot.map { BotUsageTotal(bot: $0.key, totals: $0.value) }.filter { !$0.totals.isEmpty }

      return DayUsage(day: key, totals: total, bots: heaviestFirst(ranked))
    }
  }

  /// Every bot's share of `window`, the heaviest first, bots that used nothing left out.
  public static func perBot(_ bots: [BotUsage], in window: [String]) -> [BotUsageTotal] {
    heaviestFirst(
      bots.map { BotUsageTotal(bot: $0.bot, totals: totals($0.days, in: window)) }.filter { !$0.totals.isEmpty })
  }

  /// All the bots together over `window`.
  public static func total(_ bots: [BotUsage], in window: [String]) -> UsageTotals {
    var total = UsageTotals()

    for bot in bots {
      total.add(totals(bot.days, in: window))
    }

    return total
  }

  /// Cost first, then tokens, then the name: an order that never depends on how the bots arrived.
  static func heaviestFirst(_ totals: [BotUsageTotal]) -> [BotUsageTotal] {
    totals.sorted { lhs, rhs in
      if lhs.totals.cost != rhs.totals.cost {
        return lhs.totals.cost > rhs.totals.cost
      }

      if lhs.totals.totalTokens != rhs.totals.totalTokens {
        return lhs.totals.totalTokens > rhs.totals.totalTokens
      }

      return lhs.bot < rhs.bot
    }
  }
}
