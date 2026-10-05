import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

// The warning when a day's use reaches the limit the reader set: when it is due, that it is told once a
// day per limit, what is posted, and what happens when notifications are off, a gateway goes, or the
// limits change.

private func totals(cost: Double = 0, tokens: Int = 0) -> UsageTotals {
  var totals = UsageTotals()
  totals.add(DailyUsage(day: "2026-10-05", inputTokens: tokens, estimatedCost: cost))
  return totals
}

@Suite struct UsageAlertEvaluatorTests {
  private let limits = UsageAlertSettings(enabled: true, dailyCost: 5, dailyTokens: 1000)

  @Test func nothingFiresBelowTheLimits() {
    let (alerts, state) = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 4.99, tokens: 999), day: "2026-10-05", previous: nil)

    #expect(alerts.isEmpty)
    #expect(state == UsageAlertState(day: "2026-10-05"))
  }

  @Test func aLimitIsReachedAtTheLimit() {
    let cost = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 5, tokens: 10), day: "2026-10-05", previous: nil)
    let tokens = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 0.1, tokens: 1000), day: "2026-10-05", previous: nil)

    #expect(cost.alerts == [UsageAlert(kind: .cost, value: 5, limit: 5)])
    #expect(tokens.alerts == [UsageAlert(kind: .tokens, value: 1000, limit: 1000)])
  }

  @Test func bothLimitsCanFireTogetherAndAreEachToldOnce() {
    let first = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6, tokens: 2000), day: "2026-10-05", previous: nil)

    #expect(first.alerts.map(\.kind) == [.cost, .tokens])

    // The same day, read again with more used: said already.
    let again = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 9, tokens: 5000), day: "2026-10-05", previous: first.state)

    #expect(again.alerts.isEmpty)
    #expect(again.state == first.state)
  }

  @Test func oneLimitFiringDoesNotUseUpTheOther() {
    let first = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6, tokens: 10), day: "2026-10-05", previous: nil)
    let later = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6, tokens: 1500), day: "2026-10-05", previous: first.state)

    #expect(first.alerts.map(\.kind) == [.cost])
    #expect(later.alerts.map(\.kind) == [.tokens])
  }

  @Test func aNewDayStartsAfresh() {
    let monday = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6), day: "2026-10-05", previous: nil)
    let tuesday = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6), day: "2026-10-06", previous: monday.state)

    #expect(tuesday.alerts.map(\.kind) == [.cost])
    #expect(tuesday.state.day == "2026-10-06")
  }

  @Test func aLimitTheReaderChangedIsANewAlert() {
    let first = UsageAlertEvaluator.evaluate(
      settings: limits, today: totals(cost: 6), day: "2026-10-05", previous: nil)
    var higher = limits
    higher.dailyCost = 8
    var lower = limits
    lower.dailyCost = 2

    // Raised above what has been used: nothing yet, and told again when it is reached.
    let raised = UsageAlertEvaluator.evaluate(settings: higher, today: totals(cost: 6), day: "2026-10-05", previous: first.state)
    let reached = UsageAlertEvaluator.evaluate(settings: higher, today: totals(cost: 8.5), day: "2026-10-05", previous: raised.state)
    // Lowered under what has been used: due at once.
    let lowered = UsageAlertEvaluator.evaluate(settings: lower, today: totals(cost: 6), day: "2026-10-05", previous: first.state)

    #expect(raised.alerts.isEmpty)
    #expect(reached.alerts == [UsageAlert(kind: .cost, value: 8.5, limit: 8)])
    #expect(lowered.alerts == [UsageAlert(kind: .cost, value: 6, limit: 2)])
  }

  @Test func offIsOffAndAnUnsetLimitWatchesNothing() {
    let off = UsageAlertSettings(enabled: false, dailyCost: 1, dailyTokens: 1)
    let none = UsageAlertSettings(enabled: true, dailyCost: nil, dailyTokens: 0)
    let before = UsageAlertState(day: "2026-10-05", cost: 3)

    #expect(UsageAlertEvaluator.evaluate(settings: off, today: totals(cost: 9, tokens: 9), day: "2026-10-05", previous: before).alerts.isEmpty)
    #expect(UsageAlertEvaluator.evaluate(settings: none, today: totals(cost: 9, tokens: 9), day: "2026-10-05", previous: before).alerts.isEmpty)
    #expect(!off.isWatching)
    #expect(!none.isWatching)
    #expect(limits.isWatching)
  }

  @Test func aLimitThatIsNotAUsableNumberIsNoLimit() {
    #expect(UsageAlertSettings(enabled: true, dailyCost: -1).costLimit == nil)
    #expect(UsageAlertSettings(enabled: true, dailyCost: .nan).costLimit == nil)
    #expect(UsageAlertSettings(enabled: true, dailyCost: .infinity).costLimit == nil)
    #expect(UsageAlertSettings(enabled: true, dailyTokens: -5).tokenLimit == nil)
  }
}

@MainActor
@Suite struct UsageAlertSettingsModelTests {
  @Test func theLimitsAreKeptAndReadBack() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)
    let model = UsageAlertSettingsModel(keyValues: keyValues)
    await model.hydrate()

    model.setEnabled(true)
    model.setDailyCost(7.5)
    model.setDailyTokens(250_000)
    // The writes are in order, one after the other.
    try await Task.sleep(for: .milliseconds(50))

    let reread = UsageAlertSettingsModel(keyValues: keyValues)
    await reread.hydrate()

    #expect(reread.settings == UsageAlertSettings(enabled: true, dailyCost: 7.5, dailyTokens: 250_000))
  }

  @Test func aLimitThatIsNotUsableTakesTheLimitAway() {
    let model = UsageAlertSettingsModel()

    model.setDailyCost(5)
    model.setDailyCost(0)
    #expect(model.settings.dailyCost == nil)

    model.setDailyTokens(10)
    model.setDailyTokens(-3)
    #expect(model.settings.dailyTokens == nil)

    model.setDailyCost(.nan)
    #expect(model.settings.dailyCost == nil)
  }

  @Test func aChoiceMadeBeforeTheReadFinishesWins() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)
    try await keyValues.set(UsageAlertSettings(enabled: true, dailyCost: 1), forKey: StoreKeys.usageAlerts)

    let model = UsageAlertSettingsModel(keyValues: keyValues)
    model.setDailyTokens(50)
    await model.hydrate()

    #expect(model.settings.dailyTokens == 50)
    #expect(model.loaded)
  }
}

@MainActor
@Suite struct UsageAlertMonitorTests {
  @MainActor private struct Rig {
    let center = RecordingLocalNotifications()
    let settings: UsageAlertSettingsModel
    let monitor: UsageAlertMonitor
    let keyValues: KeyValueStore?
    let allowed: AllowedFlag

    @MainActor
    final class AllowedFlag {
      var allowed = true
      var previews = true
    }

    init(limits: UsageAlertSettings = UsageAlertSettings(enabled: true, dailyCost: 5, dailyTokens: 1000), keyValues: KeyValueStore? = nil) {
      let settings = UsageAlertSettingsModel()
      settings.setEnabled(limits.enabled)
      settings.setDailyCost(limits.dailyCost)
      settings.setDailyTokens(limits.dailyTokens)
      let flag = AllowedFlag()

      self.settings = settings
      self.allowed = flag
      self.keyValues = keyValues
      monitor = UsageAlertMonitor(
        center: center, settings: settings, keyValues: keyValues, copy: .english,
        allowed: { flag.allowed }, namesBots: { flag.previews }, now: { usageNow }, locale: Locale(identifier: "en_US"))
    }
  }

  private let bots = [
    BotUsage(bot: "researcher", days: [usageDay("2026-10-05", input: 500, estimated: 4)]),
    BotUsage(bot: "writer", days: [usageDay("2026-10-05", input: 300, estimated: 2)])
  ]

  @Test func aDayThatReachesTheCostLimitIsOneNotificationNamingTheBotThatUsedTheMost() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))

    let alerts = await rig.monitor.check(
      gatewayID: "g1", gatewayName: "Home", bots: bots, names: ["researcher": "Researcher"])
    let note = rig.center.posted.first

    #expect(alerts.map(\.kind) == [.cost])
    #expect(rig.center.posted.count == 1)
    #expect(note?.title == "Usage limit reached")
    #expect(note?.body == "$6.00 spent today on Home, over your limit of $5.00. Most: Researcher.")
    #expect(note?.identifier == "usage.g1.2026-10-05.cost")
    #expect(note?.threadIdentifier == "usage")
  }

  @Test func theTokenLimitHasItsOwnNotification() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyTokens: 700))

    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)

    #expect(rig.center.posted.count == 1)
    #expect(rig.center.posted.first?.body == "800 tokens used today on Home, over your limit of 700. Most: researcher.")
    #expect(rig.center.posted.first?.identifier == "usage.g1.2026-10-05.tokens")
  }

  @Test func underTheLimitsNothingIsPosted() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 50, dailyTokens: 90_000))

    #expect(await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots).isEmpty)
    #expect(rig.center.posted.isEmpty)
  }

  @Test func aDayIsToldOnceHoweverOftenItIsLookedAt() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))

    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)

    #expect(rig.center.posted.count == 1)
  }

  @Test func anotherGatewayIsItsOwnAlert() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))

    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    await rig.monitor.check(gatewayID: "g2", gatewayName: "Work", bots: bots)

    #expect(rig.center.posted.map(\.identifier) == ["usage.g1.2026-10-05.cost", "usage.g2.2026-10-05.cost"])
  }

  @Test func whatWasToldSurvivesARelaunch() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)
    let first = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5), keyValues: keyValues)

    await first.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    try await Task.sleep(for: .milliseconds(50))

    let second = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5), keyValues: keyValues)
    await second.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)

    #expect(first.center.posted.count == 1)
    #expect(second.center.posted.isEmpty)
  }

  @Test func whileNotificationsAreNotAllowedNothingIsPostedAndNothingIsMarkedAsTold() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))
    rig.allowed.allowed = false

    #expect(await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots).isEmpty)
    #expect(rig.center.posted.isEmpty)
    #expect(rig.monitor.told(gatewayID: "g1") == nil)

    // They are allowed later: the alert is still due.
    rig.allowed.allowed = true
    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)

    #expect(rig.center.posted.count == 1)
  }

  @Test func withTheAlertOffNothingIsEvenWorkedOut() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: false, dailyCost: 1, dailyTokens: 1))

    #expect(await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots).isEmpty)
    #expect(rig.center.posted.isEmpty)
  }

  @Test func withoutPreviewsTheBotIsNotNamed() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))
    rig.allowed.previews = false

    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots, names: ["researcher": "Researcher"])

    #expect(rig.center.posted.first?.body == "$6.00 spent today on Home, over your limit of $5.00.")
  }

  @Test func aGatewayThatLeavesIsForgottenAndItsNotificationTakenAway() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))

    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    #expect(rig.center.delivered.count == 1)

    await rig.monitor.forget(gatewayID: "g1")

    #expect(rig.center.delivered.isEmpty)
    #expect(rig.monitor.told(gatewayID: "g1") == nil)

    // A gateway that signs in again starts afresh.
    await rig.monitor.check(gatewayID: "g1", gatewayName: "Home", bots: bots)
    #expect(rig.center.posted.count == 2)
  }

  @Test func theTokensInANotificationAreAbbreviatedAndTheDollarsAreDollars() {
    let content = UsageAlertContent.make(
      UsageAlert(kind: .tokens, value: 1_250_000, limit: 1_000_000), gatewayID: "g1", gatewayName: "Home",
      day: "2026-10-05", topBot: nil, copy: .english, locale: Locale(identifier: "en_US"))

    #expect(content.body == "1.25M tokens used today on Home, over your limit of 1M.")
  }
}

@MainActor
@Suite struct UsageAlertDriverTests {
  @MainActor private struct Rig {
    let center = RecordingLocalNotifications()
    let settings = UsageAlertSettingsModel()
    let backend = StubUsage()
    let driver: UsageAlertDriver
    let ready = Ready()

    @MainActor
    final class Ready { var value = true }

    init(limits: UsageAlertSettings) {
      settings.setEnabled(limits.enabled)
      settings.setDailyCost(limits.dailyCost)
      settings.setDailyTokens(limits.dailyTokens)

      let monitor = UsageAlertMonitor(
        center: center, settings: settings, now: { usageNow }, locale: Locale(identifier: "en_US"))

      driver = UsageAlertDriver(monitor: monitor, settings: settings)
      driver.interval = .seconds(3600)
      backend.set(days: [usageDay("2026-10-05", input: 10, estimated: 9)], for: "researcher")
    }

    func source() -> UsageAlertDriver.Source {
      let ready = self.ready

      return UsageAlertDriver.Source(
        gatewayID: "g1", gatewayName: "Home", bots: { [(name: "researcher", displayName: "Researcher")] },
        backend: backend, ready: { ready.value })
    }
  }

  @Test func itReadsTheLastTwoDaysOfEveryBotAndTheMonitorWarns() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))

    rig.driver.start(rig.source())
    await waitUntil("the warning") { !rig.center.posted.isEmpty }

    #expect(rig.backend.calls.contains("daily researcher 2"))
    #expect(rig.center.posted.first?.body.contains("$9.00") == true)

    rig.driver.stop()
  }

  @Test func withTheAlertOffNothingIsRead() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: false, dailyCost: 5))

    rig.driver.start(rig.source())
    await rig.driver.checkNow()

    #expect(rig.backend.calls.isEmpty)
    #expect(rig.center.posted.isEmpty)

    rig.driver.stop()
  }

  @Test func nothingIsReadWhileTheConnectionIsNotUp() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))
    rig.ready.value = false

    rig.driver.start(rig.source())
    await rig.driver.checkNow()

    #expect(rig.backend.calls.isEmpty)

    rig.driver.stop()
  }

  @Test func switchingTheAlertOnReadsAtOnce() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: false, dailyCost: 5))

    rig.driver.start(rig.source())
    #expect(rig.center.posted.isEmpty)

    rig.settings.setEnabled(true)
    await waitUntil("the warning after the switch") { !rig.center.posted.isEmpty }

    rig.driver.stop()
  }

  @Test func aGatewayThatCouldNotBeReadSaysNothingAboutTheDay() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 5))
    rig.backend.fail("researcher", GatewayRPCError(.timeout, "late"))

    rig.driver.start(rig.source())
    await rig.driver.checkNow()

    #expect(rig.center.posted.isEmpty)

    rig.driver.stop()
  }

  @Test func afterStopNothingIsRead() async {
    let rig = Rig(limits: UsageAlertSettings(enabled: true, dailyCost: 500))

    rig.driver.start(rig.source())
    await waitUntil("the first look") { !rig.backend.calls.isEmpty }
    rig.driver.stop()
    let seen = rig.backend.calls.count

    await rig.driver.checkNow()
    rig.settings.setDailyCost(400)
    try? await Task.sleep(for: .milliseconds(50))

    #expect(rig.backend.calls.count == seen)
  }
}
