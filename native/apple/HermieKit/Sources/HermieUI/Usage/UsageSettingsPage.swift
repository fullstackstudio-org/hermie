import HermieCore
import SwiftUI

/**
 Settings, Usage: every bot of the live gateway side by side, the gateway per day, the Nous balance, and
 the limit that warns the person when a day's use reaches it.

 The numbers are the live gateway's (`UsageOverviewModel`), one read per bot; a bot whose read failed is
 named, not silently missing. A bot's row opens its own page (the same section the bot's settings page
 has). The limit is this device's (`UsageAlertSettingsModel`), watched by `UsageAlertDriver` while the app
 runs.
 */
struct UsageSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.usage.page") { session in
      UsageSettingsContent(session: session)
    }
  }
}

struct UsageSettingsContent: View {
  let session: GatewaySession

  @Environment(AppLaunch.self) private var launch
  @State private var model: UsageOverviewModel

  init(session: GatewaySession) {
    self.session = session
    _model = State(initialValue: session.usageOverview())
  }

  var body: some View {
    let connected = session.status.phase == .ready

    Form {
      Section {
        UsageStateRow(phase: model.phase) { Task { await model.load() } }

        if model.phase == .loaded {
          UsageSpanPicker(span: $model.span)

          if model.totals.isEmpty, model.today.isEmpty {
            Text(NativeStrings.Usage.noUse)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("hermie.usage.none")
          } else {
            UsageSummaryRows(totals: model.totals, today: model.today, span: model.span)
          }

          if !model.failed.isEmpty {
            Label(
              NativeStrings.Usage.failedBots(model.failed.map { session.chatName($0) }.joined(separator: ", ")),
              systemImage: "exclamationmark.triangle"
            )
            .font(.callout)
            .accessibilityIdentifier("hermie.usage.failedBots")
          }
        }
      } header: {
        Text(NativeStrings.Usage.allBots)
      } footer: {
        if model.phase == .loaded {
          Text(NativeStrings.Usage.dayNote)
            .foregroundStyle(Color.primary)
        }
      }

      if model.phase == .loaded {
        botsSection
        daysSection

        // The accounts as fields where the gateway has them; else the Nous balance, which is all an older one has.
        if model.account.isStructured || model.nous != nil {
          Section {
            AccountSectionRows(account: model.account, nous: model.nous)
          } header: {
            Text(NativeStrings.Usage.account)
          } footer: {
            if model.account.isStructured {
              Text(AccountSectionRows.footer(structured: true, forBot: false))
                .foregroundStyle(Color.primary)
            }
          }
          .accessibilityIdentifier("hermie.usage.accountSection")
        }
      }

      UsageAlertSection(model: launch.usageAlerts)
    }
    .formStyle(.grouped)
    .task(id: connected) {
      if connected {
        await model.load()
      }
    }
    .refreshable { await model.load() }
    .navigationTitle(NativeStrings.Usage.title)
    .accessibilityIdentifier("hermie.usage.page")
  }

  /// Each bot's share of the span: its cost and tokens, a bar to the heaviest, and its context window where its
  /// chat has said. A row opens that bot's own page.
  @ViewBuilder private var botsSection: some View {
    let bots = model.perBot
    let heaviest = max(1, bots.map(\.totals.totalTokens).max() ?? 1)

    if !bots.isEmpty {
      Section {
        ForEach(bots) { entry in
          NavigationLink {
            BotUsagePage(session: session, bot: entry.bot)
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              HStack(alignment: .firstTextBaseline) {
                Text(verbatim: session.chatName(entry.bot))
                Spacer()
                Text(verbatim: UsageWords.line(entry.totals))
                  .font(.callout)
                  .monospacedDigit()
                  .foregroundStyle(.secondary)
              }

              UsageBar(fraction: Double(entry.totals.totalTokens) / Double(heaviest))

              if let context = model.contexts[entry.bot] {
                Text(
                  verbatim:
                    "\(NativeStrings.Usage.context): \(UsageFormat.percent(context.fraction))"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
              }
            }
          }
          .accessibilityIdentifier("hermie.usage.bot.\(entry.bot)")
        }
      } header: {
        Text(NativeStrings.Usage.perBot)
      }
    }
  }

  /// The whole gateway, day by day.
  @ViewBuilder private var daysSection: some View {
    let days = model.perDay.map { entry -> DailyUsage in
      var day = DailyUsage(day: entry.day)
      day.inputTokens = entry.totals.inputTokens
      day.outputTokens = entry.totals.outputTokens
      day.cacheReadTokens = entry.totals.cacheReadTokens
      day.reasoningTokens = entry.totals.reasoningTokens
      // The cost is a sum of costs, each already the better of billed and estimated; the day keeps saying
      // whether any of it was a guess.
      if entry.totals.estimated {
        day.estimatedCost = entry.totals.cost
      } else {
        day.actualCost = entry.totals.cost
      }

      day.sessions = entry.totals.sessions
      day.apiCalls = entry.totals.apiCalls
      return day
    }

    Section {
      DisclosureGroup(NativeStrings.Usage.perDay) {
        UsageDayRows(days: days)
      }
      .accessibilityIdentifier("hermie.usage.days")
    }
  }
}

/// One bot's usage as a page of its own: the Usage section of its settings, reached from the overview.
struct BotUsagePage: View {
  let session: GatewaySession
  let bot: String

  var body: some View {
    BotUsagePageContent(session: session, bot: bot)
      .navigationTitle(session.chatName(bot))
  }
}

private struct BotUsagePageContent: View {
  let session: GatewaySession
  let bot: String

  @State private var model: BotUsageModel

  init(session: GatewaySession, bot: String) {
    self.session = session
    self.bot = bot
    _model = State(initialValue: session.usage(for: bot))
  }

  var body: some View {
    Form {
      BotUsageContent(model: model)
    }
    .formStyle(.grouped)
    .task { await model.load() }
    .refreshable { await model.load() }
    .accessibilityIdentifier("hermie.usage.botPage")
  }
}

/// The limit: a switch, a cost and a token limit for a day, and what it does.
struct UsageAlertSection: View {
  let model: UsageAlertSettingsModel

  @State private var costText = ""
  @State private var tokensText = ""

  var body: some View {
    Section {
      Toggle(
        NativeStrings.Usage.Alert.toggle,
        isOn: Binding(get: { model.settings.enabled }, set: { model.setEnabled($0) })
      )
      .accessibilityIdentifier("hermie.usage.alert.switch")

      if model.settings.enabled {
        LabeledContent(NativeStrings.Usage.Alert.costLimit) {
          TextField(NativeStrings.Usage.Alert.costLimit, text: $costText, prompt: Text(NativeStrings.Usage.Alert.off))
            .labelsHidden()
            .multilineTextAlignment(.trailing)
            #if os(iOS)
              .keyboardType(.decimalPad)
            #endif
            .accessibilityIdentifier("hermie.usage.alert.cost")
        }

        LabeledContent(NativeStrings.Usage.Alert.tokenLimit) {
          TextField(
            NativeStrings.Usage.Alert.tokenLimit, text: $tokensText, prompt: Text(NativeStrings.Usage.Alert.off)
          )
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          #if os(iOS)
            .keyboardType(.numberPad)
          #endif
          .accessibilityIdentifier("hermie.usage.alert.tokens")
        }
      }
    } header: {
      Text(NativeStrings.Usage.Alert.header)
    } footer: {
      Text(NativeStrings.Usage.Alert.footer)
        .foregroundStyle(Color.primary)
    }
    // The fields show what was kept, once it has been read.
    .onChange(of: model.loaded, initial: true) { _, _ in
      costText = UsageAlertInput.text(cost: model.settings.dailyCost)
      tokensText = UsageAlertInput.text(tokens: model.settings.dailyTokens)
    }
    .onChange(of: costText) { _, text in model.setDailyCost(UsageAlertInput.cost(text)) }
    .onChange(of: tokensText) { _, text in model.setDailyTokens(UsageAlertInput.tokens(text)) }
  }
}

/// What a person types into the limit fields, and how it is read.
enum UsageAlertInput {
  /// A cost in dollars: digits with one decimal point or comma, a leading `$` and spaces allowed. Anything
  /// else, or zero, is no limit.
  static func cost(_ text: String) -> Double? {
    let cleaned = text.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
      .replacingOccurrences(of: ",", with: ".")

    guard !cleaned.isEmpty, cleaned.filter({ $0 == "." }).count <= 1,
      cleaned.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }), let value = Double(cleaned), value > 0,
      value.isFinite
    else {
      return nil
    }

    return value
  }

  /// A count of tokens: digits, with a `k` or an `m` after them for thousands and millions. Separators
  /// inside the digits are ignored (`1,500,000`). Anything else, or zero, is no limit.
  static func tokens(_ text: String) -> Int? {
    var cleaned = text.lowercased().filter { !$0.isWhitespace && $0 != "," && $0 != "." && $0 != "_" }
    var factor = 1

    if cleaned.hasSuffix("k") {
      factor = 1_000
      cleaned.removeLast()
    } else if cleaned.hasSuffix("m") {
      factor = 1_000_000
      cleaned.removeLast()
    }

    guard !cleaned.isEmpty, cleaned.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(cleaned), value > 0,
      value <= Int.max / factor
    else {
      return nil
    }

    return value * factor
  }

  static func text(cost: Double?) -> String {
    guard let cost, cost > 0 else {
      return ""
    }

    return cost == cost.rounded() ? String(Int(cost)) : String(cost)
  }

  static func text(tokens: Int?) -> String {
    tokens.map(String.init) ?? ""
  }
}
