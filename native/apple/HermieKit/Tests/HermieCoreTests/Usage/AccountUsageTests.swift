import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

// `account.usage`: the wire decode into plain values, the service's call, the model behind a screen (its
// fallback, its refresh and the gateway's 15 second floor) and how both usage models carry it.

private func provider(
  _ id: String, title: String = "Claude account limits", plan: JSONValue = "Max", available: Bool = true,
  reason: JSONValue = .null, windows: [JSONValue] = [], details: [JSONValue] = [], credits: JSONValue = .null
) -> JSONValue {
  .object([
    "provider": .string(id), "source": "oauth_usage_api", "title": .string(title), "plan": plan,
    "available": .bool(available), "unavailable_reason": reason, "fetched_at": "2026-10-05T12:00:00Z",
    "windows": .array(windows), "details": .array(details), "credits": credits
  ])
}

private func window(
  _ id: String, label: String, used: JSONValue = .null, resetAt: JSONValue = .null, detail: JSONValue = .null
) -> JSONValue {
  .object(["id": .string(id), "label": .string(label), "used_percent": used, "reset_at": resetAt, "detail": detail])
}

private func answer(_ providers: [JSONValue], profile: String = "researcher") -> JSONValue {
  .object(["ok": true, "profile": .string(profile), "providers": .array(providers)])
}

@Suite struct AccountUsageDecodeTests {
  @Test func aProviderIsReadFieldByField() throws {
    let usage = try #require(
      AccountUsage.parse(
        answer([
          provider(
            "anthropic",
            windows: [
              window("current_session", label: "Current session", used: 18, resetAt: "2026-10-05T14:10:00Z"),
              window("current_week", label: "Current week", used: 36.5, resetAt: "2026-10-08T16:00:00Z", detail: "Opus")
            ],
            details: ["Extra usage is off."],
            credits: .object(["currency": "USD", "remaining": 4.2, "total": 10]))
        ])))

    #expect(usage.profile == "researcher")

    let claude = try #require(usage.providers.first)
    #expect(claude.provider == "anthropic")
    #expect(claude.title == "Claude account limits")
    #expect(claude.plan == "Max")
    #expect(claude.available)
    #expect(claude.unavailableReason == nil)
    #expect(claude.source == "oauth_usage_api")
    #expect(claude.fetchedAt == Date(timeIntervalSince1970: 1_791_201_600))
    #expect(claude.details == ["Extra usage is off."])
    #expect(claude.credits == AccountCredits(currency: "USD", remaining: 4.2, total: 10))
    #expect(abs((claude.credits?.fraction ?? 0) - 0.42) < 1e-9)

    #expect(claude.windows.map(\.id) == ["current_session", "current_week"])
    #expect(claude.windows[0].label == "Current session")
    #expect(claude.windows[0].usedPercent == 18)
    #expect(claude.windows[0].fraction == 0.18)
    #expect(claude.windows[0].resetAt == Date(timeIntervalSince1970: 1_791_201_600 + 2 * 3600 + 10 * 60))
    #expect(claude.windows[0].detail == nil)
    #expect(claude.windows[1].usedPercent == 36.5)
    #expect(claude.windows[1].detail == "Opus")
  }

  @Test func aProviderWithNothingToShowKeepsItsReason() throws {
    let usage = try #require(
      AccountUsage.parse(
        answer([
          provider(
            "openrouter", title: "OpenRouter credits", plan: .null, available: false,
            reason: "Not signed in to this provider in this profile.")
        ])))

    let router = try #require(usage.providers.first)
    #expect(!router.available)
    #expect(router.unavailableReason == "Not signed in to this provider in this profile.")
    #expect(router.plan == nil)
    #expect(router.windows.isEmpty)
    #expect(router.credits == nil)
  }

  @Test func aSharePastTheEndsIsClampedAndOneThatIsNoNumberIsNone() throws {
    let usage = try #require(
      AccountUsage.parse(
        answer([
          provider(
            "anthropic",
            windows: [
              window("a", label: "Over", used: 140),
              window("b", label: "Under", used: -5),
              window("c", label: "Text", used: "lots"),
              window("d", label: "None", used: .null)
            ])
        ])))

    let windows = try #require(usage.providers.first?.windows)
    #expect(windows.map(\.usedPercent) == [100, 0, nil, nil])
    #expect(windows.map(\.fraction) == [1, 0, nil, nil])
  }

  @Test func aTimeIsIsoWithOrWithoutFractionalSecondsAndAnythingElseIsNone() {
    let base = Date(timeIntervalSince1970: 1_791_201_600)

    #expect(AccountUsage.date("2026-10-05T12:00:00Z") == base)
    #expect(AccountUsage.date("2026-10-05T12:00:00.250Z") == base.addingTimeInterval(0.25))
    #expect(AccountUsage.date("2026-10-05T14:00:00+02:00") == base)
    #expect(AccountUsage.date("soon") == nil)
    #expect(AccountUsage.date("") == nil)
    #expect(AccountUsage.date(nil) == nil)
  }

  @Test func creditsNeedAnAmountAndACurrency() {
    #expect(AccountCredits.parse(.object(["currency": "EUR", "remaining": 3, "total": .null])) != nil)
    #expect(AccountCredits.parse(.object(["currency": "EUR", "remaining": 3, "total": .null]))?.fraction == nil)
    #expect(AccountCredits.parse(.object(["currency": "", "remaining": 3])) == nil)
    #expect(AccountCredits.parse(.object(["currency": "USD"])) == nil)
    #expect(AccountCredits.parse(.null) == nil)
    // A negative balance is nothing left, and a share never passes the whole.
    #expect(AccountCredits.parse(.object(["currency": "USD", "remaining": -2, "total": 10]))?.remaining == 0)
    #expect(AccountCredits(currency: "USD", remaining: 30, total: 10).fraction == 1)
    #expect(AccountCredits(currency: "USD", remaining: 3, total: 0).fraction == nil)
  }

  @Test func textIsOneBoundedLineAndWhatIsNotUsableIsDropped() throws {
    let long = String(repeating: "x", count: 5000)
    let usage = try #require(
      AccountUsage.parse(
        answer([
          provider(
            "anthropic", title: "Claude\naccount\u{202E}limits",
            windows: [window("w", label: long)] + (0..<20).map { window("w\($0)", label: "L\($0)") },
            details: (0..<20).map { .string("line \($0)") } + [.string("   "), .number(5)]),
          .string("nonsense"), .object(["source": "no provider and no title"])
        ])))

    #expect(usage.providers.count == 1)

    let claude = try #require(usage.providers.first)
    #expect(claude.title == "Claude account limits")
    #expect(claude.windows.count == ProviderAccountUsage.itemLimit)
    #expect(claude.windows[0].label.count == UsageText.limit)
    #expect(claude.details.count == ProviderAccountUsage.itemLimit)
    #expect(claude.details.first == "line 0")
  }

  @Test func aProviderListedTwiceIsOneAndTheFirstStands() throws {
    let usage = try #require(
      AccountUsage.parse(answer([provider("anthropic", plan: "Max"), provider("anthropic", plan: "Pro")])))

    #expect(usage.providers.map(\.plan) == ["Max"])
  }

  @Test func aProfileWithNoAccountIsAnAnswerAndAnythingUnreadableIsNot() {
    #expect(AccountUsage.parse(answer([]))?.providers.isEmpty == true)
    #expect(AccountUsage.parse(.object(["ok": false, "providers": .array([])])) == nil)
    #expect(AccountUsage.parse(.object(["ok": true])) == nil)
    #expect(AccountUsage.parse(.object(["providers": "many"])) == nil)
    #expect(AccountUsage.parse(.string("no")) == nil)
    #expect(AccountUsage.parse(nil) == nil)
  }

  @Test func aProviderThatSaysNothingIsUnavailable() throws {
    let usage = try #require(
      AccountUsage.parse(answer([.object(["provider": "codex", "title": "Codex account limits"])])))

    #expect(usage.providers.first?.available == false)
  }
}

@Suite struct AccountUsageFormatTests {
  private let now = Date(timeIntervalSince1970: 1_791_201_600)
  private let english = Locale(identifier: "en_US")

  @Test func aCountdownIsTheTwoLargestUnits() {
    #expect(UsageFormat.timeUntil(now.addingTimeInterval(2 * 3600 + 10 * 60), from: now, locale: english) == "2h 10m")
    #expect(UsageFormat.timeUntil(now.addingTimeInterval(3 * 86_400 + 4 * 3600), from: now, locale: english) == "3d 4h")
    #expect(UsageFormat.timeUntil(now.addingTimeInterval(45 * 60), from: now, locale: english) == "45m")
    #expect(UsageFormat.timeUntil(now.addingTimeInterval(20), from: now, locale: english) == "1m")
  }

  @Test func aTimeThatHasPassedIsNoCountdown() {
    #expect(UsageFormat.timeUntil(now, from: now) == nil)
    #expect(UsageFormat.timeUntil(now.addingTimeInterval(-60), from: now) == nil)
  }

  @Test func moneyIsInItsCurrencyAndAnOddCurrencyIsWrittenAfter() {
    #expect(UsageFormat.money(4.2, currency: "USD", locale: english) == "$4.20")
    #expect(UsageFormat.money(4.2, currency: "usd", locale: english) == "$4.20")
    #expect(UsageFormat.money(12, currency: "credits", locale: english) == "12 credits")
    #expect(UsageFormat.money(-3, currency: "USD", locale: english) == "$0.00")
  }
}

@Suite struct AccountUsageServiceTests {
  @Test func theCallCarriesTheProfileAndOnlyAskesForARefreshWhenToldTo() async throws {
    let link = ScriptedLink()
    link.respond(to: "account.usage", with: answer([provider("anthropic")]))
    let service = UsageService(link: link)

    let plain = try await service.accountUsage(profile: "researcher", refresh: false)
    #expect(plain?.providers.map(\.provider) == ["anthropic"])

    _ = try await service.accountUsage(profile: nil, refresh: true)

    let calls = link.calls.filter { $0.method == "account.usage" }.map(\.params)
    #expect(calls.count == 2)
    #expect(calls[0]["profile"] == "researcher")
    #expect(calls[0]["refresh"] == nil, "a plain read does not ask for a re-read")
    #expect(calls[1]["profile"] == nil, "the launch profile is the gateway's default")
    #expect(calls[1]["refresh"] == .bool(true))
  }

  @Test func aGatewayWithoutTheMethodIsUnsupportedAndNotConnectedIsOffline() async {
    let link = ScriptedLink()
    link.refuse("account.usage") { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }
    let service = UsageService(link: link)

    await #expect(throws: UsageFailure.unsupported) { try await service.accountUsage(profile: nil, refresh: false) }

    let down = ScriptedLink()
    down.refuse("account.usage") { _ in GatewayRPCError(.notConnected, "gateway not connected") }

    await #expect(throws: UsageFailure.offline) {
      try await UsageService(link: down).accountUsage(profile: nil, refresh: false)
    }
  }

  @Test func aBackendThatNeverHeardOfItIsUnsupported() async {
    struct Old: UsageBackend {
      func daily(profile: String, days: Int) async throws -> [DailyUsage] { [] }
      func insights(profile: String, days: Int) async throws -> InsightsSummary? { nil }
      func nousBars() async throws -> NousUsageBars? { nil }
      func session(runtimeID: String, profile: String) async throws -> SessionUsage? { nil }
    }

    await #expect(throws: UsageFailure.unsupported) { try await Old().accountUsage(profile: nil, refresh: false) }
  }
}

@MainActor
@Suite struct AccountUsageModelTests {
  private func sample(_ plan: String = "Max") -> AccountUsage {
    AccountUsage(
      profile: "researcher",
      providers: [
        ProviderAccountUsage(
          provider: "anthropic", title: "Claude account limits", plan: plan,
          windows: [AccountWindow(id: "current_session", label: "Current session", usedPercent: 18)])
      ])
  }

  /// A clock a test moves.
  private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = usageNow

    var now: Date {
      lock.withLock { value }
    }

    func advance(_ seconds: TimeInterval) {
      lock.withLock { value = value.addingTimeInterval(seconds) }
    }
  }

  @Test func readsTheAccountsAndKeepsThem() async {
    let stub = StubUsage()
    stub.set(account: sample())
    let model = AccountUsageModel(profile: "researcher", backend: stub, now: { usageNow })

    #expect(model.phase == .idle)
    #expect(!model.isStructured)

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.isStructured)
    #expect(model.usage?.providers.first?.plan == "Max")
    #expect(model.readAt == usageNow)
    #expect(stub.accountCalls == [.init(profile: "researcher", refresh: false)])
  }

  @Test func aGatewayWithoutTheMethodSaysSoAndDrawsNoFieldsAndAGatewayThatGainsItDoes() async {
    let stub = StubUsage()
    let model = AccountUsageModel(profile: nil, backend: stub, now: { usageNow })

    await model.load()

    #expect(model.phase == .unsupported)
    #expect(model.usage == nil)
    #expect(!model.isStructured, "the text lines stand")

    stub.set(account: sample())
    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.isStructured)
  }

  @Test func aFailedReadKeepsWhatAnEarlierOneFoundAndWithoutOneItIsTheFailure() async {
    let stub = StubUsage()
    let model = AccountUsageModel(profile: nil, backend: stub, now: { usageNow })

    stub.failAccount(GatewayRPCError(.notConnected, "gateway not connected"))
    await model.load()
    #expect(model.phase == .failed(.offline))
    #expect(!model.isStructured)

    stub.set(account: sample())
    await model.load()

    stub.failAccount(GatewayRPCError(.timeout, "timed out"))
    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.usage?.providers.first?.plan == "Max", "a minute-old number beats none")
  }

  @Test func aGatewayThatLosesTheMethodDropsTheFieldsAndFallsBackToTheLines() async {
    let stub = StubUsage()
    stub.set(account: sample())
    let model = AccountUsageModel(profile: nil, backend: stub, now: { usageNow })
    await model.load()

    stub.failAccount(UsageFailure.unsupported)
    await model.load()

    #expect(model.phase == .unsupported)
    #expect(!model.isStructured)
  }

  @Test func anAnswerWithNothingUsableFallsBackUnlessSomethingWasKnown() async {
    let stub = StubUsage()
    stub.set(account: nil)
    let model = AccountUsageModel(profile: nil, backend: stub, now: { usageNow })

    await model.load()
    #expect(model.phase == .failed(.failed("")))
    #expect(!model.isStructured)

    stub.set(account: sample())
    await model.load()
    stub.set(account: nil)
    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.isStructured)
  }

  @Test func theFirstRefreshAsksTheGatewayToReadAgainAndOneInsideTheFloorDoesNot() async {
    let stub = StubUsage()
    stub.set(account: sample())
    let clock = Clock()
    let model = AccountUsageModel(profile: "researcher", backend: stub, now: { clock.now })

    await model.load()
    #expect(model.canForceRefresh)

    await model.refresh()
    #expect(stub.accountCalls.last == .init(profile: "researcher", refresh: true))
    #expect(!model.canForceRefresh, "the gateway would answer from its cache now")

    clock.advance(14)
    await model.refresh()
    #expect(stub.accountCalls.last == .init(profile: "researcher", refresh: false), "inside 15 s it is a plain read")
    #expect(model.phase == .loaded)
    #expect(!model.isRefreshing)

    clock.advance(1)
    #expect(model.canForceRefresh)
    await model.refresh()
    #expect(stub.accountCalls.last == .init(profile: "researcher", refresh: true))

    #expect(stub.accountCalls.map(\.refresh) == [false, true, false, true])
  }

  @Test func theFloorCountsFromTheLastForcedReadNotFromAnOrdinaryOne() async {
    let stub = StubUsage()
    stub.set(account: sample())
    let clock = Clock()
    let model = AccountUsageModel(profile: nil, backend: stub, now: { clock.now })

    await model.refresh()
    clock.advance(10)
    await model.load()
    await model.load()
    clock.advance(6)
    await model.refresh()

    #expect(stub.accountCalls.map(\.refresh) == [true, false, false, true])
  }

  @Test func aRefreshFailingLeavesTheButtonUsable() async {
    let stub = StubUsage()
    stub.set(account: sample())
    let model = AccountUsageModel(profile: nil, backend: stub, now: { usageNow })
    await model.load()

    stub.failAccount(GatewayRPCError(.rejected, "the provider refused", code: 5097))
    await model.refresh()

    #expect(!model.isRefreshing)
    #expect(model.phase == .loaded)
    #expect(model.isStructured)
  }
}

@MainActor
@Suite struct UsageModelsCarryAccountsTests {
  private let sample = AccountUsage(
    profile: "researcher", providers: [ProviderAccountUsage(provider: "anthropic", title: "Claude account limits")])

  @Test func aBotsPageAsksForItsOwnProfileAndKeepsTheTextLinesAsTheFallback() async {
    let stub = StubUsage()
    stub.set(session: SessionUsage(accountLines: ["Current session: 90% remaining"]))
    let model = BotUsageModel(bot: "researcher", backend: stub, runtimeID: { "rt-1" }, now: { usageNow })

    await model.load()

    // An older gateway: no fields, and the lines the live session carried are what is drawn.
    #expect(model.account.phase == .unsupported)
    #expect(!model.account.isStructured)
    #expect(model.live?.accountLines == ["Current session: 90% remaining"])
    #expect(stub.accountCalls == [.init(profile: "researcher", refresh: false)])

    stub.set(account: sample)
    await model.load()

    #expect(model.account.isStructured)
    #expect(model.account.usage?.providers.map(\.provider) == ["anthropic"])
    // The lines are still read: a screen decides which to draw.
    #expect(model.live?.accountLines == ["Current session: 90% remaining"])
  }

  @Test func theAccountsNeverSpoilTheDays() async {
    let stub = StubUsage()
    stub.set(days: [usageDay("2026-10-05", input: 10)], for: "researcher")
    stub.failAccount(GatewayRPCError(.rejected, "boom", code: 5097))
    let model = BotUsageModel(bot: "researcher", backend: stub, now: { usageNow })

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.today.totalTokens == 10)
    #expect(model.account.phase == .failed(.failed("boom")))
  }

  @Test func theOverviewAsksForTheLaunchProfilesAccounts() async {
    let stub = StubUsage()
    stub.set(account: sample)
    let model = UsageOverviewModel(backend: stub, bots: { ["researcher", "writer"] }, now: { usageNow })

    await model.load()

    #expect(model.account.isStructured)
    #expect(stub.accountCalls == [.init(profile: nil, refresh: false)])
  }

  @Test func theOverviewKeepsTheNousBalanceWhereTheGatewayHasNoFields() async {
    let stub = StubUsage()
    stub.set(nous: NousUsageBars(planName: "Pro", totalSpendable: "$5.00"))
    let model = UsageOverviewModel(backend: stub, bots: { ["researcher"] }, now: { usageNow })

    await model.load()

    #expect(model.account.phase == .unsupported)
    #expect(model.nous?.planName == "Pro")
  }
}
