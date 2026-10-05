#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func usageWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, ready, as the app holds one.
@MainActor
private func usageSession(_ gateway: FakeGateway, open: Bool = false) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-usage", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await usageWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
      && session.chatList.names.count > 1
  }

  if open {
    try await session.open(researcher)
  }

  return session
}

private func withUsageSession(
  open: Bool = false,
  _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await usageSession(gateway, open: open)

    do {
      try await body(gateway, session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

/// A day's analytics row as the route answers it.
private func row(
  _ day: String, input: Double, output: Double, cost: Double, actual: Double = 0, sessions: Double = 1
) -> JSONValue {
  .object([
    "day": .string(day), "input_tokens": .number(input), "output_tokens": .number(output),
    "cache_read_tokens": .number(0), "reasoning_tokens": .number(0), "estimated_cost": .number(cost),
    "actual_cost": .number(actual), "sessions": .number(sessions), "api_calls": .number(3)
  ])
}

extension Integration {
  /// Usage against the real fake gateway, over real HTTP and a real socket: the days the analytics route
  /// answers per profile, what `insights.get`, `usage.bars` and `session.usage` add to them, and the
  /// threshold alert over the days a live session reads.
  @Suite("Usage") @MainActor
  struct UsageIntegrationTests {
    @Test("a bot's days come from the analytics route, one profile at a time, with today among them")
    func readsABotsDays() async throws {
      try await withUsageSession { _, session in
        let model = session.usage(for: researcher)

        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.days.count > 1)
        #expect(model.days.last?.day == UsageDays.key(for: Date()))
        #expect(model.today.totalTokens > 0)
        #expect(model.totals.totalTokens >= model.today.totalTokens)
        // The fake prices its own days: every cost is the gateway's estimate.
        #expect(model.totals.estimated)
        #expect(model.perDay.count == UsageSpan.week.rawValue)

        // Another bot is another history.
        let other = session.usage(for: "writer")
        await other.load()

        #expect(other.phase == .loaded)
        #expect(other.days != model.days)
      }
    }

    @Test("staged days are read exactly, and a quiet bot is zeros and not a failure")
    func readsStagedDays() async throws {
      try await withUsageSession { gateway, session in
        let today = UsageDays.key(for: Date())
        let earlier = UsageDays.key(for: Date().addingTimeInterval(-3 * 86_400))

        try await gateway.stageUsage([
          "days": .object([
            researcher: .array([
              row(earlier, input: 1000, output: 500, cost: 0.25),
              row(today, input: 2000, output: 1000, cost: 0.5, actual: 0.6, sessions: 2)
            ]),
            "writer": .array([])
          ])
        ])

        let model = session.usage(for: researcher)
        await model.load()

        #expect(model.days.map(\.day) == [earlier, today])
        #expect(model.today.totalTokens == 3000)
        #expect(model.today.cost == 0.6)
        // A billed day beats an estimated one, and the sum says one of its days was a guess.
        #expect(model.totals.cost == 0.85)
        #expect(model.totals.estimated)
        #expect(model.totals.sessions == 3)

        let quiet = session.usage(for: "writer")
        await quiet.load()

        #expect(quiet.phase == .loaded)
        #expect(quiet.totals.isEmpty)
      }
    }

    @Test("the overview adds every bot up per day and per bot, and the heaviest bot is first")
    func overview() async throws {
      try await withUsageSession { gateway, session in
        let today = UsageDays.key(for: Date())

        try await gateway.stageUsage([
          "days": .object([
            researcher: .array([row(today, input: 1000, output: 0, cost: 1)]),
            "writer": .array([row(today, input: 500, output: 0, cost: 3)])
          ])
        ])

        let model = session.usageOverview()
        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.failed.isEmpty)
        #expect(model.bots.count == session.chatList.names.count)
        #expect(model.perBot.first?.bot == "writer")
        #expect(model.perDay.last?.bots.first?.bot == "writer")
        #expect(model.today.cost >= 4)
      }
    }

    @Test("the sessions and messages behind the days come from insights.get")
    func insights() async throws {
      try await withUsageSession { _, session in
        let model = session.usage(for: researcher)

        await model.load()

        let insights = try #require(model.insights)
        #expect(insights.days == UsageSpan.longest.rawValue)
        #expect(insights.sessions > 0)
        #expect(insights.messages > 0)
      }
    }

    @Test("the Nous balance is a structured read and every other account has none")
    func nousBalance() async throws {
      try await withUsageSession { gateway, session in
        let none = session.usage(for: researcher)
        await none.load()
        #expect(none.nous == nil)

        try await gateway.stageUsage(["bars": true])

        let model = session.usage(for: researcher)
        await model.load()

        #expect(model.nous?.planName == "Pro")
        #expect(model.nous?.totalSpendable == "$15.00")
        #expect(model.nous?.planBar?.percentUsed == 40)
        #expect(model.nous?.topupBar?.percentUsed == nil)
      }
    }

    @Test("the provider account's limits are text lines a live chat's session.usage carries")
    func accountLines() async throws {
      try await withUsageSession(open: true) { gateway, session in
        try await gateway.stageUsage(["accountLines": true])

        let model = session.usage(for: researcher)
        await model.load()

        #expect(model.live?.accountLines.contains("Current session: 82% remaining (18% used) • resets in 2h 10m") == true)
        // The same call gives how full the window is.
        #expect(model.context?.limit ?? 0 > 0)

        // A bot whose chat is not open has no live session to ask, so no lines: said, not guessed.
        let closed = session.usage(for: "writer")
        await closed.load()
        #expect(closed.live == nil)
      }
    }

    @Test("a gateway without the calls says so, in a sentence, and not as a failure to try again")
    func unsupportedGateway() async throws {
      try await withUsageSession { gateway, session in
        try await gateway.stageUsage(["unsupported": true])

        let model = session.usage(for: researcher)
        await model.load()

        #expect(model.phase == .failed(.unsupported))

        let overview = session.usageOverview()
        await overview.load()

        #expect(overview.phase == .failed(.unsupported))
      }
    }

    @Test("a day over the limit is a notification once, over a real gateway's days")
    func thresholdAlert() async throws {
      try await withUsageSession { gateway, session in
        let today = UsageDays.key(for: Date())

        try await gateway.stageUsage([
          "days": .object([
            researcher: .array([row(today, input: 1000, output: 1000, cost: 4)]),
            "writer": .array([row(today, input: 100, output: 100, cost: 3)])
          ])
        ])

        let settings = UsageAlertSettingsModel()
        settings.setEnabled(true)
        settings.setDailyCost(5)

        let center = RecordingCenter()
        let monitor = UsageAlertMonitor(center: center, settings: settings, locale: Locale(identifier: "en_US"))
        let driver = UsageAlertDriver(monitor: monitor, settings: settings)

        driver.start(
          UsageAlertDriver.Source(
            gatewayID: session.gatewayID, gatewayName: "Fake",
            bots: { session.chatList.names.map { (name: $0, displayName: $0) } },
            backend: session.usageService, ready: { session.status.phase == .ready }))

        try await usageWait("the warning") { !center.posted.isEmpty }
        await driver.checkNow()
        await driver.checkNow()
        driver.stop()

        // Seven dollars over a five dollar limit, told once however often the days were read.
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.body.contains("$7.00") == true)
        #expect(center.posted.first?.body.contains("Most: researcher") == true)
      }
    }
  }
}

/// A notification centre that remembers what it was asked to post.
@MainActor
private final class RecordingCenter: LocalNotificationCenter {
  private(set) var posted: [LocalNotificationContent] = []

  func post(_ content: LocalNotificationContent) async {
    posted.append(content)
  }

  func remove(identifiers: [String]) async {}
}
#endif
