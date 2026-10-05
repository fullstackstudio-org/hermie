import Foundation
import HermieCore

/// The usage screens' own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Usage {
    /// Usage (the Settings category, the bot settings section, the page)
    static var title: String { String(localized: "native.usage.title", table: "Native", bundle: .module) }
    /// Tokens and cost per bot and per day, and a limit that warns you. (under the Settings category)
    static var blurb: String { String(localized: "native.usage.blurb", table: "Native", bundle: .module) }
    /// Period (the label of the choice of how far back usage is shown)
    static var span: String { String(localized: "native.usage.span", table: "Native", bundle: .module) }
    /// 7 days / 30 days
    static func spanTitle(_ span: UsageSpan) -> String {
      switch span {
      case .week: String(localized: "native.usage.span.week", table: "Native", bundle: .module)
      case .month: String(localized: "native.usage.span.month", table: "Native", bundle: .module)
      }
    }
    /// Today
    static var today: String { String(localized: "native.usage.today", table: "Native", bundle: .module) }
    /// Last {days} days
    static func period(days: Int) -> String {
      String(localized: "native.usage.period", defaultValue: "Last \(days) days", table: "Native", bundle: .module)
    }
    /// {count} tokens (already abbreviated)
    static func tokenCount(_ count: String) -> String {
      String(localized: "native.usage.tokenCount", defaultValue: "\(count) tokens", table: "Native", bundle: .module)
    }
    /// {in} in, {out} out
    static func inOut(input: String, output: String) -> String {
      String(
        localized: "native.usage.inOut", defaultValue: "\(input) in, \(output) out", table: "Native", bundle: .module)
    }
    /// {count} read from cache
    static func cached(_ count: String) -> String {
      String(localized: "native.usage.cached", defaultValue: "\(count) read from cache", table: "Native", bundle: .module)
    }
    /// Sessions
    static var sessions: String { String(localized: "native.usage.sessions", table: "Native", bundle: .module) }
    /// Messages
    static var messages: String { String(localized: "native.usage.messages", table: "Native", bundle: .module) }
    /// Model calls
    static var apiCalls: String { String(localized: "native.usage.apiCalls", table: "Native", bundle: .module) }
    /// Per day
    static var perDay: String { String(localized: "native.usage.perDay", table: "Native", bundle: .module) }
    /// Per bot
    static var perBot: String { String(localized: "native.usage.perBot", table: "Native", bundle: .module) }
    /// No use in this period.
    static var noUse: String { String(localized: "native.usage.noUse", table: "Native", bundle: .module) }
    /// Reading usage…
    static var loading: String { String(localized: "native.usage.loading", table: "Native", bundle: .module) }
    /// This gateway does not report usage.
    static var unsupported: String { String(localized: "native.usage.unsupported", table: "Native", bundle: .module) }
    /// Usage cannot be read without a connection.
    static var offline: String { String(localized: "native.usage.offline", table: "Native", bundle: .module) }
    /// Usage could not be read: {reason}
    static func failed(_ reason: String) -> String {
      String(
        localized: "native.usage.failed", defaultValue: "Usage could not be read: \(reason)", table: "Native",
        bundle: .module)
    }
    /// Updated {time}
    static func updated(_ time: String) -> String {
      String(localized: "native.usage.updated", defaultValue: "Updated \(time)", table: "Native", bundle: .module)
    }
    /// The gateway counts days in UTC… (the footer under the numbers)
    static var dayNote: String { String(localized: "native.usage.dayNote", table: "Native", bundle: .module) }
    /// Context window
    static var context: String { String(localized: "native.usage.context", table: "Native", bundle: .module) }
    /// {used} of {limit} tokens
    static func contextDetail(used: String, limit: String) -> String {
      String(
        localized: "native.usage.contextDetail", defaultValue: "\(used) of \(limit) tokens", table: "Native",
        bundle: .module)
    }
    /// Not known until this bot's chat has been open.
    static var contextNone: String { String(localized: "native.usage.contextNone", table: "Native", bundle: .module) }
    /// Provider account
    static var account: String { String(localized: "native.usage.account", table: "Native", bundle: .module) }
    /// The limits of the account this bot's model runs on… (footer)
    static var accountNote: String { String(localized: "native.usage.accountNote", table: "Native", bundle: .module) }
    /// The limits of the accounts this bot's models run on, as the providers report them… (footer)
    static var accountNoteLive: String {
      String(localized: "native.usage.accountNoteLive", table: "Native", bundle: .module)
    }
    /// The limits of the accounts the gateway's own models run on… (footer of the overview)
    static var accountNoteGateway: String {
      String(localized: "native.usage.accountNoteGateway", table: "Native", bundle: .module)
    }
    /// Refresh (reads the provider accounts again)
    static var accountRefresh: String {
      String(localized: "native.usage.accountRefresh", table: "Native", bundle: .module)
    }
    /// Refreshing…
    static var accountRefreshing: String {
      String(localized: "native.usage.accountRefreshing", table: "Native", bundle: .module)
    }
    /// Resets in {duration}
    static func resetsIn(_ duration: String) -> String {
      String(localized: "native.usage.resetsIn", defaultValue: "Resets in \(duration)", table: "Native", bundle: .module)
    }
    /// {percent} used
    static func windowUsed(_ percent: String) -> String {
      String(localized: "native.usage.windowUsed", defaultValue: "\(percent) used", table: "Native", bundle: .module)
    }
    /// No usage reported for this account.
    static var accountUnavailable: String {
      String(localized: "native.usage.accountUnavailable", table: "Native", bundle: .module)
    }
    /// Credits
    static var credits: String { String(localized: "native.usage.credits", table: "Native", bundle: .module) }
    /// {remaining} of {total} left
    static func creditsLeft(remaining: String, total: String) -> String {
      String(
        localized: "native.usage.creditsLeft", defaultValue: "\(remaining) of \(total) left", table: "Native",
        bundle: .module)
    }
    /// No provider limits reported yet.
    static var accountNone: String { String(localized: "native.usage.accountNone", table: "Native", bundle: .module) }
    /// Nous credits
    static var nous: String { String(localized: "native.usage.nous", table: "Native", bundle: .module) }
    /// Plan
    static var plan: String { String(localized: "native.usage.plan", table: "Native", bundle: .module) }
    /// Top-up
    static var topup: String { String(localized: "native.usage.topup", table: "Native", bundle: .module) }
    /// Renews {date}
    static func renews(_ date: String) -> String {
      String(localized: "native.usage.renews", defaultValue: "Renews \(date)", table: "Native", bundle: .module)
    }
    /// {amount} left
    static func remaining(_ amount: String) -> String {
      String(localized: "native.usage.remaining", defaultValue: "\(amount) left", table: "Native", bundle: .module)
    }
    /// {amount} spendable
    static func spendable(_ amount: String) -> String {
      String(
        localized: "native.usage.spendable", defaultValue: "\(amount) spendable", table: "Native", bundle: .module)
    }
    /// All bots
    static var allBots: String { String(localized: "native.usage.allBots", table: "Native", bundle: .module) }
    /// Could not read the usage of: {names}
    static func failedBots(_ names: String) -> String {
      String(
        localized: "native.usage.failedBots", defaultValue: "Could not read the usage of: \(names)", table: "Native",
        bundle: .module)
    }

    enum Alert {
      /// Limit (header)
      static var header: String { String(localized: "native.usage.alerts", table: "Native", bundle: .module) }
      /// Warn me when a day reaches a limit
      static var toggle: String { String(localized: "native.usage.alertSwitch", table: "Native", bundle: .module) }
      /// Cost per day (US dollars)
      static var costLimit: String {
        String(localized: "native.usage.alertCostLimit", table: "Native", bundle: .module)
      }
      /// Tokens per day
      static var tokenLimit: String {
        String(localized: "native.usage.alertTokenLimit", table: "Native", bundle: .module)
      }
      /// Off (the placeholder of a limit field with no limit)
      static var off: String { String(localized: "native.usage.alertOff", table: "Native", bundle: .module) }
      /// Adds up every bot on this gateway… (footer)
      static var footer: String { String(localized: "native.usage.alertFooter", table: "Native", bundle: .module) }
      /// Usage limit reached (the notification's title)
      static var title: String { String(localized: "native.usage.alertTitle", table: "Native", bundle: .module) }

      static func cost(spent: String, gateway: String, limit: String) -> String {
        String(
          localized: "native.usage.alertCost",
          defaultValue: "\(spent) spent today on \(gateway), over your limit of \(limit).", table: "Native",
          bundle: .module)
      }

      static func cost(spent: String, gateway: String, limit: String, top: String) -> String {
        String(
          localized: "native.usage.alertCostTop",
          defaultValue: "\(spent) spent today on \(gateway), over your limit of \(limit). Most: \(top).",
          table: "Native", bundle: .module)
      }

      static func tokens(used: String, gateway: String, limit: String) -> String {
        String(
          localized: "native.usage.alertTokens",
          defaultValue: "\(used) tokens used today on \(gateway), over your limit of \(limit).", table: "Native",
          bundle: .module)
      }

      static func tokens(used: String, gateway: String, limit: String, top: String) -> String {
        String(
          localized: "native.usage.alertTokensTop",
          defaultValue: "\(used) tokens used today on \(gateway), over your limit of \(limit). Most: \(top).",
          table: "Native", bundle: .module)
      }
    }
  }
}

extension UsageAlertCopy {
  /// The notification's sentences in the reader's language.
  public static var localized: UsageAlertCopy {
    UsageAlertCopy(
      title: NativeStrings.Usage.Alert.title,
      cost: { spent, limit, gateway, top in
        if let top {
          NativeStrings.Usage.Alert.cost(spent: spent, gateway: gateway, limit: limit, top: top)
        } else {
          NativeStrings.Usage.Alert.cost(spent: spent, gateway: gateway, limit: limit)
        }
      },
      tokens: { used, limit, gateway, top in
        if let top {
          NativeStrings.Usage.Alert.tokens(used: used, gateway: gateway, limit: limit, top: top)
        } else {
          NativeStrings.Usage.Alert.tokens(used: used, gateway: gateway, limit: limit)
        }
      })
  }
}
