import HermieCore
import SwiftUI

/// The words of the provider accounts, as plain functions so they are tested without a view.
enum AccountWords {
  /// How much of a window is used, "18%"; a dash where the provider gave no share.
  static func percent(_ window: AccountWindow, locale: Locale = .current) -> String {
    window.fraction.map { UsageFormat.percent($0, locale: locale) } ?? "–"
  }

  /// "18% used"; a dash where the provider gave no share.
  static func used(_ window: AccountWindow, locale: Locale = .current) -> String {
    window.fraction.map { NativeStrings.Usage.windowUsed(UsageFormat.percent($0, locale: locale)) } ?? "–"
  }

  /// "Resets in 2h 10m"; nil where the window has no reset time or it has passed.
  static func resets(_ window: AccountWindow, now: Date, locale: Locale = .current) -> String? {
    window.resetAt.flatMap { UsageFormat.timeUntil($0, from: now, locale: locale) }
      .map { NativeStrings.Usage.resetsIn($0) }
  }

  /// "$4.20 of $10.00 left", or "$4.20 left" where the provider names no cap.
  static func credits(_ credits: AccountCredits, locale: Locale = .current) -> String {
    let remaining = UsageFormat.money(credits.remaining, currency: credits.currency, locale: locale)

    guard let total = credits.total else {
      return NativeStrings.Usage.remaining(remaining)
    }

    return NativeStrings.Usage.creditsLeft(
      remaining: remaining, total: UsageFormat.money(total, currency: credits.currency, locale: locale))
  }

  /// Why a provider has nothing to show: the gateway's reason, else a sentence of ours.
  static func reason(_ provider: ProviderAccountUsage) -> String {
    provider.unavailableReason ?? NativeStrings.Usage.accountUnavailable
  }

  /// When the gateway read the provider, "Updated 2 minutes ago"; nil where it did not say.
  static func updated(_ provider: ProviderAccountUsage, now: Date, locale: Locale = .current) -> String? {
    provider.fetchedAt.map { read in
      let formatter = RelativeDateTimeFormatter()

      formatter.locale = locale
      formatter.unitsStyle = .full
      formatter.dateTimeStyle = .named

      // A read that claims to be from the future is from now.
      return NativeStrings.Usage.updated(formatter.localizedString(for: min(read, now), relativeTo: now))
    }
  }
}

/// A bar for one window: how much of it is used.
struct AccountWindowRow: View {
  let window: AccountWindow
  var now = Date()

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: window.label)
        Spacer()
        Text(verbatim: AccountWords.percent(window))
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }

      if let fraction = window.fraction {
        UsageBar(fraction: fraction, tint: fraction >= 0.9 ? .orange : .accentColor)
      }

      if let resets = AccountWords.resets(window, now: now) {
        Text(verbatim: resets)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if let detail = window.detail {
        Text(verbatim: detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(window.label)
    .accessibilityValue(
      [AccountWords.used(window), AccountWords.resets(window, now: now)].compactMap { $0 }.joined(separator: ", ")
    )
    .accessibilityIdentifier("hermie.usage.account.window.\(window.id)")
  }
}

/// One provider account: its title and plan, each quota window as a bar, the detail lines, the credits, or the
/// reason there is nothing to show.
struct ProviderAccountCard: View {
  let provider: ProviderAccountUsage
  var now = Date()

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: provider.title)
          .font(.headline)

        if let plan = provider.plan {
          Text(verbatim: plan)
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 0)
      }

      if provider.available {
        ForEach(provider.windows) { window in
          AccountWindowRow(window: window, now: now)
        }

        if let credits = provider.credits {
          creditsRow(credits)
        }

        ForEach(Array(provider.details.enumerated()), id: \.offset) { _, line in
          Text(verbatim: line)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("hermie.usage.account.detail")
        }

        if let updated = AccountWords.updated(provider, now: now) {
          Text(verbatim: updated)
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      } else {
        Label(AccountWords.reason(provider), systemImage: "exclamationmark.circle")
          .font(.callout)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.usage.account.unavailable")
      }
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.usage.account.provider.\(provider.provider)")
  }

  private func creditsRow(_ credits: AccountCredits) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline) {
        Text(NativeStrings.Usage.credits)
        Spacer()
        Text(verbatim: AccountWords.credits(credits))
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }

      // How much of the balance is left, as a share of the cap; a balance with no cap is only said.
      if let fraction = credits.fraction {
        UsageBar(fraction: fraction)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.usage.account.credits")
  }
}

/// The provider accounts of a usage screen: the accounts as fields where the gateway has `account.usage`, with a
/// refresh button, and what the screen showed before (the text lines of a live chat, the Nous balance) where it
/// does not.
struct AccountSectionRows: View {
  let account: AccountUsageModel
  /// The text lines of the chat's `session.usage`, the fallback.
  var accountLines: [String] = []
  var nous: NousUsageBars?

  var body: some View {
    if let usage = account.usage {
      if usage.providers.isEmpty {
        Text(NativeStrings.Usage.accountNone)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.usage.accountNone")
      } else {
        ForEach(usage.providers) { provider in
          ProviderAccountCard(provider: provider)
        }
      }

      refreshRow
    } else {
      ProviderAccountRows(accountLines: accountLines, nous: nous)
    }
  }

  private var refreshRow: some View {
    Button {
      Task { await account.refresh() }
    } label: {
      HStack(spacing: 8) {
        if account.isRefreshing {
          ProgressView()
            .controlSize(.small)
          Text(NativeStrings.Usage.accountRefreshing)
        } else {
          Label(NativeStrings.Usage.accountRefresh, systemImage: "arrow.clockwise")
        }
      }
    }
    .disabled(account.isRefreshing)
    .accessibilityIdentifier("hermie.usage.account.refresh")
  }

  /// The footer under the section: what the numbers are.
  static func footer(structured: Bool, forBot: Bool) -> String {
    if structured {
      forBot ? NativeStrings.Usage.accountNoteLive : NativeStrings.Usage.accountNoteGateway
    } else {
      NativeStrings.Usage.accountNote
    }
  }
}
