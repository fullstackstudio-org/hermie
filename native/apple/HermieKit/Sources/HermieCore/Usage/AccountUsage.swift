import Foundation
import HermieProtocol

/**
 What `account.usage` says about the provider accounts a profile's models run on, as plain values.

 The fork's gateway answers one entry per provider (Claude's subscription, Codex, OpenRouter or Nous
 credits): the plan, the quota windows with the share used and when each resets, a few detail lines, a
 money balance, or the reason there is none. Older gateways have only the text lines of `session.usage`
 (`SessionUsage.accountLines`), which stay the fallback.

 Everything here is a provider's text or number, made safe the way the rest of usage is (`UsageText`): lines
 are drawn as characters, a share is clamped to 0…100, anything that is not a finite number is nothing, and
 how much is kept is bounded.
 */

/// One quota window of a provider: how much of it is used, and when it starts over.
public struct AccountWindow: Sendable, Equatable, Identifiable {
  /// Stable per provider (`current_session`, `current_week`…).
  public var id: String
  public var label: String
  /// 0 to 100; nil where the provider gave none.
  public var usedPercent: Double?
  public var resetAt: Date?
  public var detail: String?

  public init(id: String, label: String, usedPercent: Double? = nil, resetAt: Date? = nil, detail: String? = nil) {
    self.id = id
    self.label = label
    self.usedPercent = usedPercent
    self.resetAt = resetAt
    self.detail = detail
  }

  /// How much of the window is used, 0 to 1, for a bar; nil where there is no share to draw.
  public var fraction: Double? {
    usedPercent.map { min(1, max(0, $0 / 100)) }
  }

  static func parse(_ value: JSONValue) -> AccountWindow? {
    guard case .object(let object) = value else {
      return nil
    }

    let label = UsageText.line(object["label"]?.stringValue)
    let id = UsageText.line(object["id"]?.stringValue)

    guard !label.isEmpty || !id.isEmpty else {
      return nil
    }

    let detail = UsageText.line(object["detail"]?.stringValue)

    return AccountWindow(
      id: id.isEmpty ? label : id,
      label: label.isEmpty ? id : label,
      usedPercent: object["used_percent"]?.doubleValue.flatMap { $0.isFinite ? min(100, max(0, $0)) : nil },
      resetAt: AccountUsage.date(object["reset_at"]?.stringValue),
      detail: detail.isEmpty ? nil : detail
    )
  }
}

/// A money balance: `remaining` of `total` (nil where the provider names no cap) in `currency`.
public struct AccountCredits: Sendable, Equatable {
  /// An ISO 4217 code where the provider gave one, else its own word.
  public var currency: String
  public var remaining: Double
  public var total: Double?

  public init(currency: String, remaining: Double, total: Double? = nil) {
    self.currency = currency
    self.remaining = remaining
    self.total = total
  }

  /// How much of the balance is left, 0 to 1; nil where there is no cap to be a share of.
  public var fraction: Double? {
    guard let total, total > 0 else {
      return nil
    }

    return min(1, max(0, remaining / total))
  }

  static func parse(_ value: JSONValue?) -> AccountCredits? {
    guard case .object(let object)? = value, let remaining = object["remaining"]?.doubleValue, remaining.isFinite else {
      return nil
    }

    let currency = UsageText.line(object["currency"]?.stringValue)

    guard !currency.isEmpty else {
      return nil
    }

    let total = object["total"]?.doubleValue.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }

    return AccountCredits(currency: currency, remaining: max(0, remaining), total: total)
  }
}

/// One provider account.
public struct ProviderAccountUsage: Sendable, Equatable, Identifiable {
  public var provider: String
  public var source: String
  public var title: String
  public var plan: String?
  /// False: there is nothing to show but `unavailableReason`.
  public var available: Bool
  public var unavailableReason: String?
  /// When the gateway read it from the provider.
  public var fetchedAt: Date?
  public var windows: [AccountWindow]
  public var details: [String]
  public var credits: AccountCredits?

  public var id: String { provider }

  public init(
    provider: String, source: String = "", title: String, plan: String? = nil, available: Bool = true,
    unavailableReason: String? = nil, fetchedAt: Date? = nil, windows: [AccountWindow] = [], details: [String] = [],
    credits: AccountCredits? = nil
  ) {
    self.provider = provider
    self.source = source
    self.title = title
    self.plan = plan
    self.available = available
    self.unavailableReason = unavailableReason
    self.fetchedAt = fetchedAt
    self.windows = windows
    self.details = details
    self.credits = credits
  }

  /// The most windows and detail lines kept for one provider.
  static let itemLimit = 8

  static func parse(_ value: JSONValue) -> ProviderAccountUsage? {
    guard case .object(let object) = value else {
      return nil
    }

    let provider = UsageText.line(object["provider"]?.stringValue)
    let title = UsageText.line(object["title"]?.stringValue)

    guard !provider.isEmpty || !title.isEmpty else {
      return nil
    }

    let plan = UsageText.line(object["plan"]?.stringValue)
    let reason = UsageText.line(object["unavailable_reason"]?.stringValue)

    return ProviderAccountUsage(
      provider: provider.isEmpty ? title : provider,
      source: UsageText.line(object["source"]?.stringValue),
      title: title.isEmpty ? provider : title,
      plan: plan.isEmpty ? nil : plan,
      available: object["available"] == .bool(true),
      unavailableReason: reason.isEmpty ? nil : reason,
      fetchedAt: AccountUsage.date(object["fetched_at"]?.stringValue),
      windows: (object["windows"]?.arrayValue ?? []).compactMap(AccountWindow.parse).prefix(itemLimit).map { $0 },
      details: (object["details"]?.arrayValue ?? []).compactMap { UsageText.line($0.stringValue) }.filter { !$0.isEmpty }
        .prefix(itemLimit).map { $0 },
      credits: AccountCredits.parse(object["credits"])
    )
  }
}

/// What `account.usage` answered for one profile.
public struct AccountUsage: Sendable, Equatable {
  /// The profile whose credentials were used.
  public var profile: String
  public var providers: [ProviderAccountUsage]

  public init(profile: String = "", providers: [ProviderAccountUsage]) {
    self.profile = profile
    self.providers = providers
  }

  /// The most providers kept: a profile's model and its fallback chain, with room to spare.
  static let providerLimit = 8

  /// The result of `account.usage`, or nil where the gateway sent nothing usable (not an object, no `providers`
  /// list, or `ok: false`). A list with no providers in it is an answer: this profile's models have no account.
  public static func parse(_ result: JSONValue?) -> AccountUsage? {
    guard case .object(let object)? = result, object["ok"] != .bool(false), let rows = object["providers"]?.arrayValue
    else {
      return nil
    }

    var seen = Set<String>()
    var providers: [ProviderAccountUsage] = []

    for row in rows {
      // A provider listed twice is one provider: the first entry stands.
      if let parsed = ProviderAccountUsage.parse(row), seen.insert(parsed.id).inserted {
        providers.append(parsed)
      }
    }

    return AccountUsage(
      profile: UsageText.line(object["profile"]?.stringValue), providers: Array(providers.prefix(providerLimit)))
  }

  /// An ISO 8601 time (`2026-10-05T12:00:00Z`), with or without fractional seconds.
  static func date(_ text: String?) -> Date? {
    guard let text, !text.isEmpty, text.count <= 40 else {
      return nil
    }

    if let date = try? Date(text, strategy: .iso8601) {
      return date
    }

    return try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
  }
}
