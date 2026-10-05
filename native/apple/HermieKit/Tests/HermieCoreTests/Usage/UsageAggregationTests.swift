import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

// Tokens and cost per bot and per day: reading the gateway's analytics rows, the UTC days they are
// counted in, and adding them up across bots and across a span.

/// 2026-10-05 12:00 UTC.
let usageNow = Date(timeIntervalSince1970: 1_791_201_600)

func usageDay(
  _ key: String, input: Int = 0, output: Int = 0, cache: Int = 0, estimated: Double = 0, actual: Double = 0,
  sessions: Int = 0, calls: Int = 0
) -> DailyUsage {
  DailyUsage(
    day: key, inputTokens: input, outputTokens: output, cacheReadTokens: cache, estimatedCost: estimated,
    actualCost: actual, sessions: sessions, apiCalls: calls)
}

@Suite struct UsageDaysTests {
  @Test func aDayIsKeyedByItsUTCDateWhateverTheLocalTimeZoneIs() {
    // 23:30 UTC on the 5th is the 6th in Auckland and the 5th everywhere west of it.
    let lateUTC = Date(timeIntervalSince1970: 1_791_201_600 + 11 * 3600 + 1800)

    #expect(UsageDays.key(for: usageNow) == "2026-10-05")
    #expect(UsageDays.key(for: lateUTC) == "2026-10-05")
    #expect(UsageDays.key(for: lateUTC.addingTimeInterval(1800)) == "2026-10-06")
  }

  @Test func theWindowEndsTodayAndCrossesMonthsAndYearsInOrder() {
    #expect(
      UsageDays.window(count: 3, endingAt: usageNow) == ["2026-10-03", "2026-10-04", "2026-10-05"])

    let newYear = Date(timeIntervalSince1970: 1_767_312_000)  // 2026-01-02 00:00 UTC
    #expect(UsageDays.window(count: 4, endingAt: newYear) == ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"])
    #expect(UsageDays.window(count: 0, endingAt: usageNow).isEmpty)
    #expect(UsageDays.window(count: 30, endingAt: usageNow).count == 30)
  }

  @Test func onlyARealDateIsADayKey() {
    #expect(UsageDays.isDayKey("2026-10-05"))
    #expect(UsageDays.isDayKey("2024-02-29"))
    #expect(!UsageDays.isDayKey("2026-02-29"))
    #expect(!UsageDays.isDayKey("2026-13-01"))
    #expect(!UsageDays.isDayKey("2026-10-5"))
    #expect(!UsageDays.isDayKey("26-10-05"))
    #expect(!UsageDays.isDayKey("2026/10/05"))
    #expect(!UsageDays.isDayKey(""))
    #expect(UsageDays.date(forKey: "nope") == nil)
    #expect(UsageDays.date(forKey: "2026-10-05").map(UsageDays.key(for:)) == "2026-10-05")
  }
}

@Suite struct DailyUsageParsingTests {
  private func body(_ rows: [JSONValue]) -> JSONValue {
    .object(["daily": .array(rows), "period_days": 30])
  }

  private func row(_ fields: JSONObject) -> JSONValue {
    .object(fields)
  }

  @Test func aRowOfTheGatewaysAnalyticsIsReadField_by_Field() throws {
    let rows = DailyUsage.parse(
      analytics: body([
        row([
          "day": "2026-10-05", "input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 4000,
          "reasoning_tokens": 50, "estimated_cost": 0.42, "actual_cost": 0, "sessions": 3, "api_calls": 17
        ])
      ]))
    let one = try #require(rows.first)

    #expect(rows.count == 1)
    #expect(one.day == "2026-10-05")
    #expect(one.inputTokens == 1200)
    #expect(one.outputTokens == 300)
    #expect(one.cacheReadTokens == 4000)
    #expect(one.reasoningTokens == 50)
    #expect(one.totalTokens == 1500)
    #expect(one.estimatedCost == 0.42)
    #expect(one.sessions == 3)
    #expect(one.apiCalls == 17)
  }

  @Test func theBilledCostWinsAndTheEstimateIsSaidToBeOne() {
    let estimated = usageDay("2026-10-05", estimated: 0.42)
    let billed = usageDay("2026-10-05", estimated: 0.42, actual: 0.5)
    let free = usageDay("2026-10-05")

    #expect(estimated.cost == 0.42 && estimated.isEstimate)
    #expect(billed.cost == 0.5 && !billed.isEstimate)
    #expect(free.cost == 0 && !free.isEstimate)
  }

  @Test func aSumThatIsNullNegativeOrNotANumberIsZero() throws {
    // `SUM()` over no rows is null; a provider can send anything.
    let rows = DailyUsage.parse(
      analytics: body([
        row([
          "day": "2026-10-04", "input_tokens": .null, "output_tokens": -5, "cache_read_tokens": "many",
          "estimated_cost": .null, "actual_cost": -1, "sessions": 1.9, "api_calls": .null
        ])
      ]))
    let one = try #require(rows.first)

    #expect(one.inputTokens == 0)
    #expect(one.outputTokens == 0)
    #expect(one.cacheReadTokens == 0)
    #expect(one.cost == 0)
    #expect(one.sessions == 1)
    #expect(one.apiCalls == 0)
  }

  @Test func aRowWithNoRealDayIsDroppedAndDuplicatesAreOneDayOldestFirst() {
    let rows = DailyUsage.parse(
      analytics: body([
        row(["day": "2026-10-05", "input_tokens": 10]),
        row(["day": "not a day", "input_tokens": 99]),
        row(["input_tokens": 99]),
        row(["day": "2026-10-03", "input_tokens": 1]),
        row(["day": "2026-10-05", "input_tokens": 5, "sessions": 2])
      ]))

    #expect(rows.map(\.day) == ["2026-10-03", "2026-10-05"])
    #expect(rows.last?.inputTokens == 15)
    #expect(rows.last?.sessions == 2)
  }

  @Test func anAnswerThatIsNotAnAnalyticsBodyIsNoDays() {
    #expect(DailyUsage.parse(analytics: nil).isEmpty)
    #expect(DailyUsage.parse(analytics: .array([])).isEmpty)
    #expect(DailyUsage.parse(analytics: .object(["daily": "x"])).isEmpty)
  }

  @Test func insightsCountSessionsAndMessages() {
    let summary = InsightsSummary.parse(.object(["days": 30, "sessions": 12, "messages": 340]))

    #expect(summary == InsightsSummary(days: 30, sessions: 12, messages: 340))
    #expect(InsightsSummary.parse(.object([:])) == nil)
    #expect(InsightsSummary.parse(nil) == nil)
  }
}

@Suite struct UsageAggregationTests {
  private let window = UsageDays.window(count: 7, endingAt: usageNow)

  @Test func aSpanSumsOnlyTheDaysInsideIt() {
    let days = [
      usageDay("2026-09-01", input: 1_000_000, estimated: 99),  // outside
      usageDay("2026-10-03", input: 100, output: 50, estimated: 0.1, sessions: 1, calls: 2),
      usageDay("2026-10-05", input: 200, output: 100, cache: 500, actual: 0.3, sessions: 2, calls: 5)
    ]
    let totals = UsageAggregation.totals(days, in: window)

    #expect(totals.inputTokens == 300)
    #expect(totals.outputTokens == 150)
    #expect(totals.totalTokens == 450)
    #expect(totals.cacheReadTokens == 500)
    #expect(abs(totals.cost - 0.4) < 1e-9)
    #expect(totals.sessions == 3)
    #expect(totals.apiCalls == 7)
    // One of the two days was the gateway's guess.
    #expect(totals.estimated)
  }

  @Test func everyDayOfTheSpanHasARowAndAQuietDayIsZeros() {
    let filled = UsageAggregation.filled([usageDay("2026-10-04", input: 7)], in: window)

    #expect(filled.map(\.day) == window)
    #expect(filled.first { $0.day == "2026-10-04" }?.inputTokens == 7)
    #expect(filled.filter { $0.totalTokens == 0 }.count == 6)
  }

  @Test func theGatewayPerDayAddsEveryBotAndRanksThemHeaviestFirst() {
    let bots = [
      BotUsage(bot: "researcher", days: [usageDay("2026-10-05", input: 1000, estimated: 0.20), usageDay("2026-10-04", input: 10)]),
      BotUsage(bot: "writer", days: [usageDay("2026-10-05", input: 500, estimated: 0.90)]),
      BotUsage(bot: "idle", days: [])
    ]
    let days = UsageAggregation.perDay(bots, in: window)
    let today = days.last

    #expect(days.map(\.day) == window)
    #expect(today?.totals.totalTokens == 1500)
    #expect(abs((today?.totals.cost ?? 0) - 1.10) < 1e-9)
    // Cost decides the order, then tokens: the writer cost more though it said less.
    #expect(today?.bots.map(\.bot) == ["writer", "researcher"])
    #expect(days.first { $0.day == "2026-10-04" }?.bots.map(\.bot) == ["researcher"])
    #expect(days.first { $0.day == "2026-10-01" }?.totals.isEmpty == true)
  }

  @Test func eachBotsShareOfASpanLeavesOutTheOnesThatDidNothing() {
    let bots = [
      BotUsage(bot: "b", days: [usageDay("2026-10-05", input: 10, estimated: 1)]),
      BotUsage(bot: "a", days: [usageDay("2026-10-05", input: 10, estimated: 1)]),
      BotUsage(bot: "quiet", days: [usageDay("2026-08-01", input: 10_000)]),
      BotUsage(bot: "big", days: [usageDay("2026-10-02", input: 1, estimated: 5)])
    ]
    let shares = UsageAggregation.perBot(bots, in: window)

    // The same cost and tokens: the name is the last word, so the order is the same on every run.
    #expect(shares.map(\.bot) == ["big", "a", "b"])
    #expect(UsageAggregation.total(bots, in: window).cost == 7)
  }

  @Test func todayIsTheGatewaysUTCDay() {
    let bots = [BotUsage(bot: "a", days: [usageDay("2026-10-04", input: 100), usageDay("2026-10-05", input: 7)])]
    let today = UsageAggregation.total(bots, in: UsageDays.window(count: 1, endingAt: usageNow))

    #expect(today.totalTokens == 7)
  }

  @Test func thePerDayRowsAreTheSameWhateverOrderTheBotsArriveIn() {
    let bots = [
      BotUsage(bot: "a", days: [usageDay("2026-10-05", input: 5, estimated: 1)]),
      BotUsage(bot: "b", days: [usageDay("2026-10-05", input: 5, estimated: 1)]),
      BotUsage(bot: "c", days: [usageDay("2026-10-05", input: 9, estimated: 1)])
    ]

    #expect(
      UsageAggregation.perDay(bots, in: window) == UsageAggregation.perDay(bots.reversed(), in: window))
  }
}

@Suite struct ProviderUsageParsingTests {
  @Test func theNousBalanceIsReadAsTheGatewayWordedIt() throws {
    let bars = try #require(
      NousUsageBars.parse(
        .object([
          "ok": true, "available": true, "status": "healthy", "plan_name": "Pro", "renews_display": "Oct 24, 2026",
          "subscription_remaining_display": "$12.00", "topup_remaining_display": "$3.00",
          "total_spendable_display": "$15.00", "has_topup": true,
          "plan_bar": [
            "kind": "plan", "remaining_display": "$12.00", "total_display": "$20.00", "spent_display": "$8.00",
            "pct_used": 40, "fill_fraction": 0.6
          ],
          "topup_bar": [
            "kind": "topup", "remaining_display": "$3.00", "total_display": "$3.00", "spent_display": "$0.00",
            "pct_used": .null, "fill_fraction": 1
          ]
        ])))

    #expect(bars.planName == "Pro")
    #expect(bars.renews == "Oct 24, 2026")
    #expect(bars.totalSpendable == "$15.00")
    #expect(bars.planBar?.percentUsed == 40)
    #expect(bars.planBar?.fillFraction == 0.6)
    #expect(bars.topupBar?.percentUsed == nil)
    #expect(bars.topupBar?.remaining == "$3.00")
  }

  @Test func noBalanceIsNoBars() {
    #expect(NousUsageBars.parse(.object(["ok": true, "available": false])) == nil)
    #expect(NousUsageBars.parse(.object(["ok": true, "available": true])) == nil)
    #expect(NousUsageBars.parse(nil) == nil)
  }

  @Test func aFractionThatIsNotOneIsClamped() {
    let bar = ProviderUsageBar.parse(.object(["kind": "plan", "fill_fraction": 7]))

    #expect(bar?.fillFraction == 1)
    #expect(ProviderUsageBar.parse(.object(["fill_fraction": -3]))?.fillFraction == 0)
  }

  @Test func aSessionsUsageCarriesTheAccountLinesTheGatewayRendered() throws {
    let usage = try #require(
      SessionUsage.parse(
        .object([
          "model": "claude-sonnet", "input": 1000, "output": 200, "calls": 4, "total": 1200,
          "context_used": 50_000, "context_max": 200_000,
          "account_lines": [
            "📈 Account limits", "Provider: anthropic (Max)", "Current session: 82% remaining (18% used) • resets in 2h 10m"
          ],
          "credits_lines": ["Nous credits: $4.20"]
        ])))

    #expect(usage.totalTokens == 1200)
    #expect(usage.calls == 4)
    #expect(usage.context?.fraction == 0.25)
    #expect(usage.accountLines.count == 4)
    #expect(usage.accountLines.contains("Current session: 82% remaining (18% used) • resets in 2h 10m"))
  }

  @Test func accountLinesAreBoundedAndCleanedBeforeTheyAreDrawn() throws {
    let many = (0..<40).map { JSONValue.string("line \($0)") }
    let usage = try #require(
      SessionUsage.parse(
        .object([
          "account_lines": .array(many + [.string("a\nb\u{202E}c"), .string(String(repeating: "x", count: 5000)), .string("   ")])
        ])))

    #expect(usage.accountLines.count == SessionUsage.lineLimit)

    let noisy = try #require(
      SessionUsage.parse(
        .object(["account_lines": ["a\nb\u{202E}c", .string(String(repeating: "x", count: 5000)), "   "]])))

    #expect(noisy.accountLines.first == "a b c")
    #expect(noisy.accountLines.allSatisfy { $0.count <= UsageText.limit })
    // A line with nothing in it is not a line.
    #expect(noisy.accountLines.count == 2)
  }

  @Test func aSessionWithNothingToSayIsNothing() {
    #expect(SessionUsage.parse(.object([:])) == nil)
    #expect(SessionUsage.parse(nil) == nil)
  }
}

@Suite struct UsageFormatTests {
  private let en = Locale(identifier: "en_US")

  @Test func tokensAreWrittenCompactly() {
    #expect(UsageFormat.tokens(0, locale: en) == "0")
    #expect(UsageFormat.tokens(950, locale: en) == "950")
    #expect(UsageFormat.tokens(12_345, locale: en) == "12.3K")
    #expect(UsageFormat.tokens(1_250_000, locale: en) == "1.25M")
  }

  @Test func aCostIsInDollarsWithCentsUnderAThousand() {
    #expect(UsageFormat.cost(0.5, locale: en) == "$0.50")
    #expect(UsageFormat.cost(12.36, locale: en) == "$12.36")
    #expect(UsageFormat.cost(1234.6, locale: en) == "$1,235")
    #expect(UsageFormat.cost(-3, locale: en) == "$0.00")
    #expect(UsageFormat.cost(.nan, locale: en) == "$0.00")
  }

  @Test func aDayIsADateInUTCWhateverTheDevicesZoneIs() {
    #expect(UsageFormat.day("2026-10-05", locale: en) == "Oct 5")
    #expect(UsageFormat.day("garbage", locale: en) == "garbage")
  }

  @Test func aFractionIsWholePerCent() {
    #expect(UsageFormat.percent(0.456, locale: en) == "46%")
    #expect(UsageFormat.percent(7, locale: en) == "100%")
    #expect(UsageFormat.percent(.nan, locale: en) == "0%")
  }
}
