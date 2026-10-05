import HermieCore
import HermieTranscript
import SwiftUI

/// The words of the numbers, as plain functions so they are tested without a view.
enum UsageWords {
  /// `12K tokens`.
  static func tokens(_ count: Int) -> String {
    NativeStrings.Usage.tokenCount(UsageFormat.tokens(count))
  }

  /// A cost, with `~` in front where it is the gateway's estimate and not a billed figure.
  static func cost(_ amount: Double, estimated: Bool) -> String {
    (estimated ? "~" : "") + UsageFormat.cost(amount)
  }

  static func cost(_ totals: UsageTotals) -> String {
    cost(totals.cost, estimated: totals.estimated)
  }

  static func cost(_ day: DailyUsage) -> String {
    cost(day.cost, estimated: day.isEstimate)
  }

  /// What a day or a span used, as one line: tokens and cost.
  static func line(_ totals: UsageTotals) -> String {
    "\(tokens(totals.totalTokens)) · \(cost(totals))"
  }

  /// The failure as a sentence.
  static func words(_ failure: UsageFailure) -> String {
    switch failure {
    case .unsupported: NativeStrings.Usage.unsupported
    case .offline: NativeStrings.Usage.offline
    case .failed(let reason): reason.isEmpty ? NativeStrings.Usage.unsupported : NativeStrings.Usage.failed(reason)
    }
  }
}

/// The choice of how far back usage is shown.
struct UsageSpanPicker: View {
  @Binding var span: UsageSpan

  var body: some View {
    Picker(NativeStrings.Usage.span, selection: $span) {
      ForEach(UsageSpan.allCases) { span in
        Text(verbatim: NativeStrings.Usage.spanTitle(span)).tag(span)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityIdentifier("hermie.usage.span")
  }
}

/// One line of a labelled number.
struct UsageValueRow: View {
  let label: String
  let value: String
  var detail: String?

  var body: some View {
    LabeledContent {
      VStack(alignment: .trailing, spacing: 2) {
        Text(verbatim: value)
          .monospacedDigit()

        if let detail {
          Text(verbatim: detail)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    } label: {
      Text(verbatim: label)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A bar drawn to a fraction of its width.
struct UsageBar: View {
  let fraction: Double
  var tint: Color = .accentColor

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Capsule().fill(.quaternary)
        Capsule()
          .fill(tint)
          .frame(width: max(fraction > 0 ? 3 : 0, proxy.size.width * min(1, max(0, fraction))))
      }
    }
    .frame(height: 6)
    .accessibilityHidden(true)
  }
}

/// What the chosen span, and today, used.
struct UsageSummaryRows: View {
  let totals: UsageTotals
  let today: UsageTotals
  let span: UsageSpan
  var insights: InsightsSummary?

  var body: some View {
    UsageValueRow(
      label: NativeStrings.Usage.today, value: UsageWords.cost(today),
      detail: UsageWords.tokens(today.totalTokens)
    )
    .accessibilityIdentifier("hermie.usage.today")

    UsageValueRow(
      label: NativeStrings.Usage.period(days: span.rawValue), value: UsageWords.cost(totals),
      detail: UsageWords.tokens(totals.totalTokens)
    )
    .accessibilityIdentifier("hermie.usage.period")

    if totals.totalTokens > 0 {
      UsageValueRow(
        label: UsageWords.tokens(totals.totalTokens),
        value: NativeStrings.Usage.inOut(
          input: UsageFormat.tokens(totals.inputTokens), output: UsageFormat.tokens(totals.outputTokens)),
        detail: totals.cacheReadTokens > 0 ? NativeStrings.Usage.cached(UsageFormat.tokens(totals.cacheReadTokens)) : nil
      )
      .accessibilityIdentifier("hermie.usage.tokens")
    }

    if totals.sessions > 0 {
      UsageValueRow(label: NativeStrings.Usage.sessions, value: totals.sessions.formatted())
    }

    if totals.apiCalls > 0 {
      UsageValueRow(label: NativeStrings.Usage.apiCalls, value: totals.apiCalls.formatted())
    }

    if let insights, span == .month, insights.messages > 0 {
      UsageValueRow(label: NativeStrings.Usage.messages, value: insights.messages.formatted())
    }
  }
}

/// One row per day, newest first, with a bar to the heaviest day's tokens.
struct UsageDayRows: View {
  let days: [DailyUsage]

  var body: some View {
    let heaviest = max(1, days.map(\.totalTokens).max() ?? 1)

    ForEach(days.reversed()) { day in
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline) {
          Text(verbatim: UsageFormat.day(day.day))
          Spacer()
          Text(verbatim: day.totalTokens == 0 ? "–" : UsageWords.line(totals(of: day)))
            .font(.callout)
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }

        UsageBar(fraction: Double(day.totalTokens) / Double(heaviest))
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(UsageFormat.day(day.day))
      .accessibilityValue(day.totalTokens == 0 ? NativeStrings.Usage.noUse : UsageWords.line(totals(of: day)))
      .accessibilityIdentifier("hermie.usage.day.\(day.day)")
    }
  }

  private func totals(of day: DailyUsage) -> UsageTotals {
    var totals = UsageTotals()
    totals.add(day)
    return totals
  }
}

/// How full the chat's context window is.
struct ContextMeterRow: View {
  let context: ContextUsage?

  var body: some View {
    if let context {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(NativeStrings.Usage.context)
          Spacer()
          Text(verbatim: UsageFormat.percent(context.fraction))
            .monospacedDigit()
        }

        ProgressView(value: context.fraction)
          .tint(context.fraction >= 0.9 ? .orange : .accentColor)

        Text(
          verbatim: NativeStrings.Usage.contextDetail(
            used: UsageFormat.tokens(Int(context.used)), limit: UsageFormat.tokens(Int(context.limit)))
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(NativeStrings.Usage.context)
      .accessibilityValue(
        "\(UsageFormat.percent(context.fraction)), "
          + NativeStrings.Usage.contextDetail(
            used: UsageFormat.tokens(Int(context.used)), limit: UsageFormat.tokens(Int(context.limit)))
      )
      .accessibilityIdentifier("hermie.usage.context")
    } else {
      UsageValueRow(label: NativeStrings.Usage.context, value: "–", detail: NativeStrings.Usage.contextNone)
        .accessibilityIdentifier("hermie.usage.context")
    }
  }
}

/// The provider account's limits: the lines the gateway worded (Anthropic's subscription windows,
/// Codex's quota), and the Nous balance as bars where the gateway has one. Plain text throughout.
struct ProviderAccountRows: View {
  let accountLines: [String]
  let nous: NousUsageBars?

  var body: some View {
    if let nous {
      nousRows(nous)
    }

    if !accountLines.isEmpty {
      ForEach(Array(accountLines.enumerated()), id: \.offset) { _, line in
        Text(verbatim: line)
          .font(.callout)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("hermie.usage.accountLine")
      }
    }

    if nous == nil, accountLines.isEmpty {
      Text(NativeStrings.Usage.accountNone)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("hermie.usage.accountNone")
    }
  }

  @ViewBuilder private func nousRows(_ nous: NousUsageBars) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(NativeStrings.Usage.nous).font(.headline)
        if !nous.planName.isEmpty {
          Text(verbatim: nous.planName).foregroundStyle(.secondary)
        }
        Spacer()
        if !nous.totalSpendable.isEmpty {
          Text(verbatim: NativeStrings.Usage.spendable(nous.totalSpendable))
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }

      if let plan = nous.planBar {
        bar(NativeStrings.Usage.plan, plan, used: true)
      }

      if let topup = nous.topupBar {
        bar(NativeStrings.Usage.topup, topup, used: false)
      }

      if !nous.renews.isEmpty {
        Text(verbatim: NativeStrings.Usage.renews(nous.renews))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.usage.nous")
  }

  private func bar(_ title: String, _ bar: ProviderUsageBar, used: Bool) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(verbatim: title)
        Spacer()
        Text(verbatim: NativeStrings.Usage.remaining(bar.remaining))
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }

      // The plan bar is how much of the allowance is LEFT, as the gateway's own fill says.
      UsageBar(fraction: bar.fillFraction)
    }
  }
}

/// Reading, failed, or nothing: the line a section shows while it has no numbers.
struct UsageStateRow: View {
  let phase: UsagePhase
  let retry: () -> Void

  var body: some View {
    switch phase {
    case .idle, .loading:
      HStack(spacing: 10) {
        ProgressView()
        Text(NativeStrings.Usage.loading)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.usage.loading")
    case .failed(let failure):
      Label(UsageWords.words(failure), systemImage: "exclamationmark.triangle")
        .accessibilityIdentifier("hermie.usage.failed")

      if failure != .unsupported {
        Button(Strings.App.Common.retry, action: retry)
      }
    case .loaded:
      EmptyView()
    }
  }
}
