import Foundation
import HermieStore
import Observation

/**
 Posts a local notification when a day's use reaches a limit the reader set.

 It is handed a gateway's days (`check`) and decides: the day's total across the gateway's bots against
 the limits (`UsageAlertEvaluator`), told once per gateway, day and limit. What it told is kept
 (`hermie.usage.alertState`), so a relaunch does not tell it again, and dropped with the gateway
 (`forget`). Nothing is posted while the system does not let the app show notifications or the reader's
 notification switch is off, and then nothing is marked as told either: the alert is still due when they
 are on.

 It never asks for permission: the notification onboarding does.
 */
@MainActor
public final class UsageAlertMonitor {
  private let center: any LocalNotificationCenter
  private let settings: UsageAlertSettingsModel
  private let keyValues: KeyValueStore?
  private let copy: UsageAlertCopy
  private let allowed: @MainActor () -> Bool
  private let namesBots: @MainActor () -> Bool
  private let now: @Sendable () -> Date
  private let locale: Locale

  private var states: [String: UsageAlertState] = [:]
  private var stateLoaded = false

  /// - Parameters:
  ///   - allowed: the system lets the app show notifications and the reader's switch is on.
  ///   - namesBots: the reader allowed previews, so the notification may name the bot that used the
  ///     most. Without it the notification says how much and where, and nothing more.
  ///   - keyValues: where what was told is kept; nil keeps it in memory.
  public init(
    center: any LocalNotificationCenter,
    settings: UsageAlertSettingsModel,
    keyValues: KeyValueStore? = nil,
    copy: UsageAlertCopy = .english,
    allowed: @escaping @MainActor () -> Bool = { true },
    namesBots: @escaping @MainActor () -> Bool = { true },
    now: @escaping @Sendable () -> Date = { Date() },
    locale: Locale = .current
  ) {
    self.center = center
    self.settings = settings
    self.keyValues = keyValues
    self.copy = copy
    self.allowed = allowed
    self.namesBots = namesBots
    self.now = now
    self.locale = locale
  }

  /**
   Look at a gateway's days. Answers the alerts that were posted.

   - Parameter names: what the reader calls each bot, by profile name, for "most: …".
   */
  @discardableResult
  public func check(gatewayID: String, gatewayName: String, bots: [BotUsage], names: [String: String] = [:]) async
    -> [UsageAlert]
  {
    let current = settings.settings

    guard current.isWatching else {
      return []
    }

    await hydrate()

    let day = UsageDays.key(for: now())
    let today = UsageAggregation.total(bots, in: [day])
    let (alerts, next) = UsageAlertEvaluator.evaluate(
      settings: current, today: today, day: day, previous: states[gatewayID])

    guard !alerts.isEmpty, allowed() else {
      return []
    }

    // Marked before it is posted: a second look that arrives while the centre is busy finds it told.
    states[gatewayID] = next
    persist()

    let top = namesBots() ? UsageAggregation.perDay(bots, in: [day]).first?.bots.first?.bot : nil
    let topName = top.map { names[$0] ?? $0 }

    for alert in alerts {
      await center.post(
        UsageAlertContent.make(
          alert, gatewayID: gatewayID, gatewayName: gatewayName, day: day, topBot: topName, copy: copy,
          locale: locale))
    }

    return alerts
  }

  /// A gateway was signed out of or removed: what was told about it is forgotten, and a notification
  /// still on the screen is taken away.
  public func forget(gatewayID: String) async {
    await hydrate()

    let held = states.removeValue(forKey: gatewayID)

    if held != nil {
      persist()
    }

    if let day = held?.day {
      await center.remove(
        identifiers: [UsageAlert.Kind.cost, .tokens].map {
          UsageAlertContent.identifier(gatewayID: gatewayID, day: day, kind: $0)
        })
    }
  }

  // MARK: What was told

  /// What this gateway was told today, for a screen that says so.
  public func told(gatewayID: String) -> UsageAlertState? {
    states[gatewayID]
  }

  private func hydrate() async {
    guard !stateLoaded else {
      return
    }

    stateLoaded = true

    guard let keyValues, let stored = try? await keyValues.value([String: UsageAlertState].self, forKey: StoreKeys.usageAlertState)
    else {
      return
    }

    // What was marked while this was reading wins.
    states = stored.merging(states) { _, current in current }
  }

  private var writing: Task<Void, Never>?

  private func persist() {
    guard let keyValues else {
      return
    }

    let value = states
    let before = writing

    writing = Task {
      await before?.value
      try? await keyValues.set(value, forKey: StoreKeys.usageAlertState)
    }
  }
}

/**
 Keeps `UsageAlertMonitor` looking at the live gateway: once when the alert is switched on or a limit
 changes, once when the connection comes up, and then every `interval` while the app runs.

 It reads each bot's last two days (one small REST call per bot, a few at a time) only while the alert is
 on and the connection is ready, and stops when told (a sign-out, another gateway). It runs while the app
 runs: nothing here wakes a suspended app, so an alert is told the next time the app is awake and
 looks.
 */
@MainActor
public final class UsageAlertDriver {
  /// What one gateway offers to look at.
  public struct Source {
    public var gatewayID: String
    public var gatewayName: String
    /// The bots: profile name and the name the reader gave it.
    public var bots: @MainActor () -> [(name: String, displayName: String)]
    public var backend: any UsageBackend
    /// The connection is up.
    public var ready: @MainActor () -> Bool

    public init(
      gatewayID: String,
      gatewayName: String,
      bots: @escaping @MainActor () -> [(name: String, displayName: String)],
      backend: any UsageBackend,
      ready: @escaping @MainActor () -> Bool
    ) {
      self.gatewayID = gatewayID
      self.gatewayName = gatewayName
      self.bots = bots
      self.backend = backend
      self.ready = ready
    }
  }

  /// How often a running app looks again.
  public var interval: Duration = .seconds(10 * 60)

  private let monitor: UsageAlertMonitor
  private let settings: UsageAlertSettingsModel
  private var source: Source?
  private var tasks: [Task<Void, Never>] = []
  private var checking = false

  public init(monitor: UsageAlertMonitor, settings: UsageAlertSettingsModel) {
    self.monitor = monitor
    self.settings = settings
  }

  /// Watch this gateway from now on, in place of the one watched before.
  public func start(_ source: Source) {
    stop()
    self.source = source

    let settings = self.settings
    let interval = self.interval
    let changes = Observations { () -> Trigger in
      Trigger(limits: settings.settings, ready: source.ready())
    }

    tasks = [
      Task { [weak self] in
        for await _ in changes {
          guard !Task.isCancelled, let self else {
            return
          }

          await self.checkNow()
        }
      },
      Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: interval)

          guard !Task.isCancelled, let self else {
            return
          }

          await self.checkNow()
        }
      }
    ]
  }

  /// Stop watching: a sign-out, or the gateway is no longer the live one.
  public func stop() {
    for task in tasks {
      task.cancel()
    }

    tasks = []
    source = nil
  }

  private struct Trigger: Equatable {
    var limits: UsageAlertSettings
    var ready: Bool
  }

  /// Read the days and let the monitor look. One at a time: a look that is asked for while one is running
  /// is the running one's.
  public func checkNow() async {
    guard let source, settings.settings.isWatching, source.ready(), !checking else {
      return
    }

    checking = true
    defer { checking = false }

    let bots = source.bots()
    let outcomes = await UsageOverviewModel.readAll(
      bots.map(\.name), backend: source.backend, days: 2, width: min(4, max(1, bots.count)))

    guard !Task.isCancelled else {
      return
    }

    let read = bots.compactMap { bot -> BotUsage? in
      guard case .success(let days)? = outcomes[bot.name] else {
        return nil
      }

      return BotUsage(bot: bot.name, days: days)
    }

    // Nothing read is nothing to compare: a gateway that could not be asked says nothing about the day.
    guard !read.isEmpty else {
      return
    }

    var names: [String: String] = [:]

    for bot in bots {
      names[bot.name] = bot.displayName
    }

    await monitor.check(gatewayID: source.gatewayID, gatewayName: source.gatewayName, bots: read, names: names)
  }
}
