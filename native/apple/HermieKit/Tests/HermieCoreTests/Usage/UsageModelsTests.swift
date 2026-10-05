import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

// What the usage screens read: the days and the rest per bot, the overview across bots, and the
// service's own words for what a gateway can and cannot answer.

/// The gateway's side of the usage calls, scripted per profile.
final class StubUsage: UsageBackend, Sendable {
  private struct State {
    var days: [String: Result<[DailyUsage], any Error>] = [:]
    var insights: Result<InsightsSummary?, any Error> = .success(nil)
    var nous: Result<NousUsageBars?, any Error> = .success(nil)
    var session: Result<SessionUsage?, any Error> = .success(nil)
    /// An older gateway until a test gives it the method.
    var account: Result<AccountUsage?, any Error> = .failure(UsageFailure.unsupported)
    var accountCalls: [AccountCall] = []
    var calls: [String] = []
    var inFlight = 0
    var peak = 0
    var gated = false
  }

  /// One `account.usage` call: whose profile (nil: the launch profile's) and whether it asked for a refresh.
  struct AccountCall: Sendable, Equatable {
    var profile: String?
    var refresh: Bool
  }

  private let state = Mutex(State())
  let gate = SearchGate()

  var accountCalls: [AccountCall] { state.withLock { $0.accountCalls } }
  func set(account: AccountUsage?) { state.withLock { $0.account = .success(account) } }
  func failAccount(_ error: any Error) { state.withLock { $0.account = .failure(error) } }

  var calls: [String] { state.withLock { $0.calls } }
  var peak: Int { state.withLock { $0.peak } }

  func set(days: [DailyUsage], for profile: String) { state.withLock { $0.days[profile] = .success(days) } }
  func fail(_ profile: String, _ error: any Error) { state.withLock { $0.days[profile] = .failure(error) } }
  func set(insights: InsightsSummary?) { state.withLock { $0.insights = .success(insights) } }
  func set(nous: NousUsageBars?) { state.withLock { $0.nous = .success(nous) } }
  func set(session: SessionUsage?) { state.withLock { $0.session = .success(session) } }
  func failNous(_ error: any Error) { state.withLock { $0.nous = .failure(error) } }
  func setGated(_ gated: Bool) { state.withLock { $0.gated = gated } }

  func daily(profile: String, days: Int) async throws -> [DailyUsage] {
    let gated = state.withLock { state -> Bool in
      state.calls.append("daily \(profile) \(days)")
      state.inFlight += 1
      state.peak = max(state.peak, state.inFlight)
      return state.gated
    }

    defer { state.withLock { $0.inFlight -= 1 } }

    if gated {
      try await gate.wait()
    }

    return try state.withLock { $0.days[profile] ?? .success([]) }.get()
  }

  func insights(profile: String, days: Int) async throws -> InsightsSummary? {
    state.withLock { $0.calls.append("insights \(profile) \(days)") }
    return try state.withLock { $0.insights }.get()
  }

  func nousBars() async throws -> NousUsageBars? {
    state.withLock { $0.calls.append("bars") }
    return try state.withLock { $0.nous }.get()
  }

  func session(runtimeID: String, profile: String) async throws -> SessionUsage? {
    state.withLock { $0.calls.append("session \(runtimeID) \(profile)") }
    return try state.withLock { $0.session }.get()
  }

  func accountUsage(profile: String?, refresh: Bool) async throws -> AccountUsage? {
    state.withLock {
      $0.calls.append("account \(profile ?? "-") \(refresh)")
      $0.accountCalls.append(AccountCall(profile: profile, refresh: refresh))
    }

    return try state.withLock { $0.account }.get()
  }
}

struct UsageRefused: Error {}

private let today = "2026-10-05"

@MainActor
@Suite struct BotUsageModelTests {
  private func model(_ stub: StubUsage, runtime: String? = "rt-1", context: ContextUsage? = nil) -> BotUsageModel {
    BotUsageModel(
      bot: "researcher", backend: stub, runtimeID: { runtime }, contextMeter: { context }, now: { usageNow })
  }

  @Test func readsTheLongestSpanOnceAndNarrowsItLocally() async {
    let stub = StubUsage()
    stub.set(days: [usageDay("2026-09-20", input: 1000), usageDay("2026-10-05", input: 10, estimated: 0.5)], for: "researcher")
    let model = model(stub)

    await model.load()

    #expect(model.phase == .loaded)
    #expect(stub.calls.contains("daily researcher 30"))
    // Seven days see only the recent one; thirty see both: the same read.
    #expect(model.span == .week)
    #expect(model.totals.totalTokens == 10)
    model.span = .month
    #expect(model.totals.totalTokens == 1010)
    #expect(model.perDay.count == 30)
    #expect(model.today.totalTokens == 10)
    #expect(model.today.estimated)
    #expect(model.refreshedAt == usageNow)
  }

  @Test func theInsightsTheBalanceTheLiveSessionAndTheContextRideAlong() async {
    let stub = StubUsage()
    stub.set(insights: InsightsSummary(days: 30, sessions: 4, messages: 90))
    stub.set(nous: NousUsageBars(planName: "Pro", totalSpendable: "$5.00", planBar: ProviderUsageBar(kind: "plan", remaining: "$5", total: "$20", spent: "$15", percentUsed: 75, fillFraction: 0.25)))
    stub.set(session: SessionUsage(model: "m", accountLines: ["Current session: 90% remaining"]))
    let meter = ContextUsage(used: 50, limit: 100, fraction: 0.5, percent: 50, estimated: false)
    let model = model(stub, context: meter)

    await model.load()

    #expect(model.insights?.messages == 90)
    #expect(model.nous?.planName == "Pro")
    #expect(model.live?.accountLines == ["Current session: 90% remaining"])
    #expect(model.context == meter)
    #expect(stub.calls.contains("session rt-1 researcher"))
  }

  @Test func theContextComesFromTheSessionWhenTheChatHasNoMeterOfItsOwn() async {
    let stub = StubUsage()
    let fromSession = ContextUsage(used: 10, limit: 100, fraction: 0.1, percent: 10, estimated: false)
    stub.set(session: SessionUsage(context: fromSession))
    let model = model(stub, context: nil)

    await model.load()

    #expect(model.context == fromSession)
  }

  @Test func aChatWithNoLiveSessionIsNotAskedForOne() async {
    let stub = StubUsage()
    let model = model(stub, runtime: nil)

    await model.load()

    #expect(model.live == nil)
    #expect(!stub.calls.contains { $0.hasPrefix("session") })
  }

  @Test func aFailureOfTheBonusesCostsOnlyThemNotTheDays() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 5)], for: "researcher")
    stub.failNous(UsageFailure.unsupported)
    let model = model(stub)

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.totals.totalTokens == 5)
    #expect(model.nous == nil)
  }

  @Test func daysThatCannotBeReadAreSaidAsWhyAndAGatewayWithoutTheRouteIsUnsupported() async {
    let stub = StubUsage()
    stub.fail("researcher", GatewayError(.server, "HTTP 404", status: 404))
    let model = model(stub)

    await model.load()
    #expect(model.phase == .failed(.unsupported))

    stub.fail("researcher", GatewayRPCError(.timeout, "request timed out"))
    await model.load()
    #expect(model.phase == .failed(.offline))

    stub.fail("researcher", GatewayError(.server, "boom", status: 500, hint: "the database is busy"))
    await model.load()
    #expect(model.phase == .failed(.failed("the database is busy")))
  }

  @Test func aLaterFailedReadKeepsWhatAnEarlierOneFound() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 5)], for: "researcher")
    let model = model(stub)
    await model.load()

    stub.fail("researcher", GatewayRPCError(.timeout, "late"))
    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.totals.totalTokens == 5)
  }

  @Test func aSlowReadNeverPaintsOverANewerOne() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 1)], for: "researcher")
    stub.setGated(true)
    let model = model(stub)

    let slow = Task { await model.load() }

    await waitUntil("the first read to go out") { stub.calls.contains("daily researcher 30") }

    // A newer read answers at once; the older one is still out when it does.
    stub.setGated(false)
    stub.set(days: [usageDay(today, input: 2)], for: "researcher")
    await model.load()
    #expect(model.totals.totalTokens == 2)

    stub.gate.open()
    await slow.value

    #expect(model.totals.totalTokens == 2)
  }
}

@MainActor
@Suite struct UsageOverviewModelTests {
  private func overview(_ stub: StubUsage, bots: [String], contexts: [String: ContextUsage] = [:], concurrency: Int = 4)
    -> UsageOverviewModel
  {
    UsageOverviewModel(backend: stub, bots: { bots }, contexts: { contexts }, concurrency: concurrency, now: { usageNow })
  }

  @Test func readsEveryBotAndTotalsTheGatewayPerDayAndPerBot() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 1000, estimated: 0.2), usageDay("2026-10-04", input: 100)], for: "researcher")
    stub.set(days: [usageDay(today, input: 500, estimated: 0.9)], for: "writer")
    let meter = ContextUsage(used: 1, limit: 2, fraction: 0.5, percent: 50, estimated: false)
    stub.set(nous: NousUsageBars(planName: "Pro", totalSpendable: "$5.00"))
    let model = overview(stub, bots: ["researcher", "writer", "idle"], contexts: ["writer": meter])

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.failed.isEmpty)
    #expect(model.bots.map(\.bot) == ["researcher", "writer", "idle"])
    #expect(model.today.totalTokens == 1500)
    #expect(model.totals.totalTokens == 1600)
    #expect(model.perBot.map(\.bot) == ["writer", "researcher"])
    #expect(model.perDay.last?.bots.map(\.bot) == ["writer", "researcher"])
    #expect(model.contexts["writer"] == meter)
    #expect(model.nous?.planName == "Pro")
    #expect(stub.calls.filter { $0.hasPrefix("daily") }.count == 3)
    #expect(stub.calls.contains("daily writer 30"))
  }

  @Test func oneBotsFailureIsThatBotsRowAndNotAFailedOverview() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 5)], for: "researcher")
    stub.fail("writer", GatewayError(.server, "no such profile", status: 404))
    let model = overview(stub, bots: ["researcher", "writer"])

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.failed == ["writer"])
    #expect(model.bots.map(\.bot) == ["researcher"])
  }

  @Test func noBotThatCouldBeReadIsAFailedOverview() async {
    let stub = StubUsage()
    stub.fail("researcher", GatewayRPCError(.notConnected, "gateway not connected"))
    stub.fail("writer", GatewayRPCError(.notConnected, "gateway not connected"))
    let model = overview(stub, bots: ["researcher", "writer"])

    await model.load()

    #expect(model.phase == .failed(.offline))
    #expect(Set(model.failed) == ["researcher", "writer"])
  }

  @Test func aBotThatFailsThisTimeKeepsItsEarlierDays() async {
    let stub = StubUsage()
    stub.set(days: [usageDay(today, input: 5)], for: "researcher")
    stub.set(days: [usageDay(today, input: 7)], for: "writer")
    let model = overview(stub, bots: ["researcher", "writer"])
    await model.load()

    stub.fail("writer", GatewayRPCError(.timeout, "late"))
    await model.load()

    #expect(model.failed == ["writer"])
    #expect(model.today.totalTokens == 12)
  }

  @Test func theReadsAreBoundedAndNoGatewayWithNoBotsIsAskedAnything() async {
    let stub = StubUsage()
    stub.setGated(true)
    let model = overview(stub, bots: (0..<10).map { "bot\($0)" }, concurrency: 3)

    let task = Task { await model.load() }

    await waitUntil("three reads in flight") { stub.calls.filter { $0.hasPrefix("daily") }.count >= 3 }
    try? await Task.sleep(for: .milliseconds(50))
    #expect(stub.peak == 3)

    stub.gate.open()
    await task.value

    #expect(stub.calls.filter { $0.hasPrefix("daily") }.count == 10)
    #expect(stub.peak <= 3)

    let empty = overview(StubUsage(), bots: [])
    await empty.load()
    #expect(empty.phase == .loaded)
    #expect(empty.bots.isEmpty)
  }
}

/// A REST side that answers one route from a script.
final class UsageREST: GatewayREST, Sendable {
  private let state = Mutex<[String]>([])
  let answer: @Sendable (String) throws -> JSONValue?

  init(_ answer: @escaping @Sendable (String) throws -> JSONValue?) {
    self.answer = answer
  }

  var paths: [String] { state.withLock { $0 } }

  func restJSON(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue? {
    state.withLock { $0.append("\(method) \(path)") }
    return try answer(path)
  }
}

@Suite struct UsageServiceTests {
  @Test func theDaysAreAskedOfTheAnalyticsRouteForOneProfileWithTheSpanClamped() async throws {
    let rest = UsageREST { _ in
      .object(["daily": [["day": "2026-10-05", "input_tokens": 5]]])
    }
    let service = UsageService(link: ScriptedLink(), rest: rest)

    let days = try await service.daily(profile: "code reviewer&co", days: 30)

    #expect(days.map(\.inputTokens) == [5])
    #expect(rest.paths == ["GET /api/analytics/usage?days=30&profile=code%20reviewer%26co"])

    _ = try await service.daily(profile: "x", days: 9999)
    _ = try await service.daily(profile: "x", days: 0)
    #expect(rest.paths.suffix(2) == ["GET /api/analytics/usage?days=365&profile=x", "GET /api/analytics/usage?days=1&profile=x"])
  }

  @Test func aLinkWithNoRESTSideAndAGatewayWithoutTheRouteAreBothUnsupported() async {
    let none = UsageService(link: ScriptedLink())
    let missing = UsageService(link: ScriptedLink(), rest: UsageREST { _ in throw GatewayError(.server, "HTTP 404", status: 404) })

    await #expect(throws: UsageFailure.unsupported) { try await none.daily(profile: "x", days: 7) }
    await #expect(throws: UsageFailure.unsupported) { try await missing.daily(profile: "x", days: 7) }
  }

  @Test func aBodyThatIsNotAnObjectIsAFailureNotAnEmptyHistory() async {
    let service = UsageService(link: ScriptedLink(), rest: UsageREST { _ in .string("<html>") })

    await #expect(throws: UsageFailure.failed("")) { try await service.daily(profile: "x", days: 7) }
  }

  @Test func theRPCsAreReadAsTheirTypes() async throws {
    let link = ScriptedLink()
    link.respond(to: "insights.get", with: .object(["days": 30, "sessions": 2, "messages": 8]))
    link.respond(
      to: "usage.bars",
      with: .object(["available": true, "plan_name": "Pro", "total_spendable_display": "$9.00"]))
    link.respond(
      to: "session.usage", with: .object(["input": 10, "output": 5, "account_lines": ["Provider: codex"]]))
    let service = UsageService(link: link)

    #expect(try await service.insights(profile: "researcher", days: 30)?.messages == 8)
    #expect(try await service.nousBars()?.planName == "Pro")
    #expect(try await service.session(runtimeID: "rt-1", profile: "researcher")?.accountLines == ["Provider: codex"])

    let sent = link.calls.first { $0.method == "insights.get" }?.params
    #expect(sent?["profile"] == "researcher")
    #expect(sent?["days"]?.doubleValue == 30)
    #expect(link.calls.first { $0.method == "session.usage" }?.params["session_id"] == "rt-1")
  }

  @Test func aMethodTheGatewayDoesNotHaveIsUnsupportedAndASocketThatDroppedIsOffline() async {
    let link = ScriptedLink()
    link.refuse("usage.bars") { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }
    link.refuse("insights.get") { _ in GatewayRPCError(.notConnected, "gateway not connected") }
    let service = UsageService(link: link)

    await #expect(throws: UsageFailure.unsupported) { try await service.nousBars() }
    await #expect(throws: UsageFailure.offline) { try await service.insights(profile: "x", days: 7) }
  }

  @Test func theFailureWordsAreBoundedPlainText() {
    let failure = UsageFailure.classify(GatewayRPCError(.rejected, "bad\nline\u{202E}", code: 5000))

    guard case .failed(let words) = failure else {
      Issue.record("not a refusal: \(failure)")
      return
    }

    #expect(!words.contains("\n"))
    #expect(!words.contains("\u{202E}"))
    #expect(UsageFailure.classify(CancellationError()) == .offline)
  }
}
