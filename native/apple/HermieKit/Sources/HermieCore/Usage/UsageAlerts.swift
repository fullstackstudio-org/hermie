import Foundation
import HermieStore
import Observation

/**
 The limits a person sets for a day's use, on this device.

 Device-wide and not carried through `ui_meta`: a notification is a fact about the device it lands on,
 and a phone that is not in your pocket is the wrong place to learn the Mac has spent the day's budget.
 Either limit may be left off. The day is the gateway's (UTC), for both: that is the only day the gateway
 can say a sum for.
 */
public struct UsageAlertSettings: Codable, Sendable, Equatable {
  /// The switch for the whole alert. Off, nothing is read for it and nothing is posted.
  public var enabled = false
  /// A day's cost, in US dollars, at which to alert. Nil (or not above zero) is no limit.
  public var dailyCost: Double?
  /// A day's tokens (read plus written, across every bot of the gateway) at which to alert.
  public var dailyTokens: Int?

  public init(enabled: Bool = false, dailyCost: Double? = nil, dailyTokens: Int? = nil) {
    self.enabled = enabled
    self.dailyCost = dailyCost
    self.dailyTokens = dailyTokens
  }

  /// The cost limit, when there is a usable one.
  public var costLimit: Double? {
    guard let dailyCost, dailyCost.isFinite, dailyCost > 0 else {
      return nil
    }

    return dailyCost
  }

  /// The token limit, when there is a usable one.
  public var tokenLimit: Int? {
    guard let dailyTokens, dailyTokens > 0 else {
      return nil
    }

    return dailyTokens
  }

  /// The alert is on and has a limit to watch.
  public var isWatching: Bool {
    enabled && (costLimit != nil || tokenLimit != nil)
  }
}

/// What the alert already told the reader for one gateway on one day, so a day's alert is told once
/// however often the numbers are read. A limit that was changed since is a new alert.
public struct UsageAlertState: Codable, Sendable, Equatable {
  public var day: String
  /// The cost limit that was alerted on `day`.
  public var cost: Double?
  /// The token limit that was alerted on `day`.
  public var tokens: Int?

  public init(day: String, cost: Double? = nil, tokens: Int? = nil) {
    self.day = day
    self.cost = cost
    self.tokens = tokens
  }
}

/// One limit that was reached.
public struct UsageAlert: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case cost
    case tokens
  }

  public var kind: Kind
  /// What the day has used (dollars, or tokens).
  public var value: Double
  /// The limit the reader set.
  public var limit: Double

  public init(kind: Kind, value: Double, limit: Double) {
    self.kind = kind
    self.value = value
    self.limit = limit
  }
}

/// Whether a day's use has reached what the reader set, and whether they were told already.
public enum UsageAlertEvaluator {
  /**
   The alerts that are new, and the state after them.

   - A limit is **reached** at the limit (`>=`): "when it passes" is when the day arrives there.
   - Told **once per day per limit**: the state remembers the limit it alerted on for `day`, so a later
     read of the same day with the same limit says nothing, a new day starts afresh, and a limit the
     reader changed is a new one (raising it above today's use re-arms it; lowering it below fires).
   - Off is off: with the alert off, or a limit unset, nothing fires and the state is as it was.
   */
  public static func evaluate(
    settings: UsageAlertSettings, today: UsageTotals, day: String, previous: UsageAlertState?
  ) -> (alerts: [UsageAlert], state: UsageAlertState) {
    var state = UsageAlertState(day: day)

    if let previous, previous.day == day {
      state = previous
    }

    guard settings.enabled else {
      return ([], state)
    }

    var alerts: [UsageAlert] = []

    if let limit = settings.costLimit, today.cost >= limit, state.cost != limit {
      alerts.append(UsageAlert(kind: .cost, value: today.cost, limit: limit))
      state.cost = limit
    }

    if let limit = settings.tokenLimit, today.totalTokens >= limit, state.tokens != limit {
      alerts.append(UsageAlert(kind: .tokens, value: Double(today.totalTokens), limit: Double(limit)))
      state.tokens = limit
    }

    return (alerts, state)
  }
}

/// The words of a usage notification, in the reader's language. The app shell hands over the localised
/// ones (`UsageAlertCopy.localized` in HermieUI); `english` is what the tests read.
public struct UsageAlertCopy: Sendable {
  public var title: String
  /// Today's cost reached the limit. Arguments: what was spent, the limit, the gateway, the bot that
  /// used the most (nil for none).
  public var cost: @Sendable (_ spent: String, _ limit: String, _ gateway: String, _ top: String?) -> String
  /// Today's tokens reached the limit. Arguments: the tokens used, the limit, the gateway, the bot that used
  /// the most.
  public var tokens: @Sendable (_ used: String, _ limit: String, _ gateway: String, _ top: String?) -> String

  public init(
    title: String,
    cost: @escaping @Sendable (String, String, String, String?) -> String,
    tokens: @escaping @Sendable (String, String, String, String?) -> String
  ) {
    self.title = title
    self.cost = cost
    self.tokens = tokens
  }

  public static let english = UsageAlertCopy(
    title: "Usage limit reached",
    cost: { spent, limit, gateway, top in
      "\(spent) spent today on \(gateway), over your limit of \(limit)." + (top.map { " Most: \($0)." } ?? "")
    },
    tokens: { used, limit, gateway, top in
      "\(used) tokens used today on \(gateway), over your limit of \(limit)." + (top.map { " Most: \($0)." } ?? "")
    })
}

/// The notification for an alert.
public enum UsageAlertContent {
  /// The identifier a day's alert is posted under: one per gateway, day and kind, so the same alert posted
  /// twice is one notification.
  public static func identifier(gatewayID: String, day: String, kind: UsageAlert.Kind) -> String {
    "usage.\(gatewayID).\(day).\(kind == .cost ? "cost" : "tokens")"
  }

  public static func make(
    _ alert: UsageAlert, gatewayID: String, gatewayName: String, day: String, topBot: String?,
    copy: UsageAlertCopy, locale: Locale = .current
  ) -> LocalNotificationContent {
    let body =
      switch alert.kind {
      case .cost:
        copy.cost(
          UsageFormat.cost(alert.value, locale: locale), UsageFormat.cost(alert.limit, locale: locale), gatewayName, topBot)
      case .tokens:
        copy.tokens(
          UsageFormat.tokens(Int(alert.value), locale: locale), UsageFormat.tokens(Int(alert.limit), locale: locale),
          gatewayName, topBot)
      }

    return LocalNotificationContent(
      identifier: identifier(gatewayID: gatewayID, day: day, kind: alert.kind),
      title: copy.title,
      body: body,
      threadIdentifier: "usage"
    )
  }
}

/**
 The limits the reader set, as the Settings page reads and writes them. Kept in `hermie.usage.alerts`;
 what was alerted lives apart (`UsageAlertMonitor`), so changing a limit does not forget what was said.
 */
@MainActor
@Observable
public final class UsageAlertSettingsModel {
  public private(set) var settings = UsageAlertSettings()
  public private(set) var loaded = false

  @ObservationIgnored private let keyValues: KeyValueStore?
  @ObservationIgnored private var writing: Task<Void, Never>?
  @ObservationIgnored private var chosenBeforeLoad = false

  /// - Parameter keyValues: where the limits are kept; nil keeps them in memory (tests, previews).
  public init(keyValues: KeyValueStore? = nil) {
    self.keyValues = keyValues
  }

  /// Read what the device kept. Idempotent; the launch calls it. A choice made before it finishes wins.
  public func hydrate() async {
    guard !loaded else {
      return
    }

    let stored = try? await keyValues?.value(UsageAlertSettings.self, forKey: StoreKeys.usageAlerts)

    if let stored, !chosenBeforeLoad {
      settings = stored
    }

    loaded = true
    chosenBeforeLoad = false
  }

  public func setEnabled(_ on: Bool) {
    update { $0.enabled = on }
  }

  /// A cost limit in dollars; nil or a number that is not above zero takes the limit away.
  public func setDailyCost(_ dollars: Double?) {
    update { $0.dailyCost = dollars.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } }
  }

  /// A token limit; nil or a number that is not above zero takes the limit away.
  public func setDailyTokens(_ tokens: Int?) {
    update { $0.dailyTokens = tokens.flatMap { $0 > 0 ? $0 : nil } }
  }

  private func update(_ change: (inout UsageAlertSettings) -> Void) {
    var next = settings

    change(&next)

    guard next != settings else {
      return
    }

    settings = next
    chosenBeforeLoad = !loaded

    guard let keyValues else {
      return
    }

    let before = writing

    writing = Task {
      await before?.value
      try? await keyValues.set(next, forKey: StoreKeys.usageAlerts)
    }
  }
}
