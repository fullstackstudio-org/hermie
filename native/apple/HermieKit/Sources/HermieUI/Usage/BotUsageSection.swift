import HermieCore
import SwiftUI

/**
 A bot's Usage, on its settings page: one row, in the style of the capability rows, that says what the bot
 used today and opens its own page (`BotUsagePage`): today and a week or a month (tokens and cost), day by
 day, how full its chat's context window is, how many sessions and messages that was, and what the provider
 account says about its limits.

 It reads the live gateway (`BotUsageModel`): the days from the gateway's analytics route, the context
 window from the chat, the account's limits from the chat's live session. A gateway without the route
 says so on the page and shows nothing it could not know. Every number is the gateway's, in its UTC
 days, and a cost it priced itself carries a `~`.
 */
struct BotUsageSection: View {
  let chat: ChatRef
  let session: GatewaySession

  @State private var model: BotUsageModel

  init(chat: ChatRef, session: GatewaySession) {
    self.chat = chat
    self.session = session
    _model = State(initialValue: session.usage(for: chat.bot))
  }

  var body: some View {
    let connected = session.status.phase == .ready

    Section {
      NavigationLink {
        BotUsagePage(session: session, bot: chat.bot)
      } label: {
        LabeledContent {
          summary
        } label: {
          Label(NativeStrings.Usage.title, systemImage: "chart.bar.xaxis")
        }
      }
      .accessibilityIdentifier("hermie.botSettings.usage")
    }
    .task(id: connected) {
      if connected {
        await model.load()
      }
    }
  }

  /// What the row says on the right: today's use, a spinner while it is read, a dash where there is none.
  @ViewBuilder private var summary: some View {
    switch model.phase {
    case .idle, .loading:
      ProgressView()
        .controlSize(.small)
    case .loaded:
      Text(verbatim: model.today.isEmpty ? "–" : UsageWords.cost(model.today))
        .foregroundStyle(.secondary)
        .monospacedDigit()
    case .failed:
      Text(verbatim: "–")
        .foregroundStyle(.secondary)
    }
  }
}

/// The section over a model.
struct BotUsageContent: View {
  @Bindable var model: BotUsageModel

  var body: some View {
    Section {
      UsageStateRow(phase: model.phase) { Task { await model.load() } }

      if model.phase == .loaded {
        UsageSpanPicker(span: $model.span)

        if model.totals.isEmpty, model.today.isEmpty {
          Text(NativeStrings.Usage.noUse)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("hermie.usage.none")
        } else {
          UsageSummaryRows(totals: model.totals, today: model.today, span: model.span, insights: model.insights)
        }

        ContextMeterRow(context: model.context)

        DisclosureGroup(NativeStrings.Usage.perDay) {
          UsageDayRows(days: model.perDay)
        }
        .accessibilityIdentifier("hermie.usage.days")
      }
    } header: {
      Text(NativeStrings.Usage.title)
    } footer: {
      if model.phase == .loaded {
        Text(NativeStrings.Usage.dayNote)
          .foregroundStyle(Color.primary)
      }
    }
    .accessibilityIdentifier("hermie.usage.section")

    if model.phase == .loaded {
      Section {
        AccountSectionRows(account: model.account, accountLines: model.live?.accountLines ?? [], nous: model.nous)
      } header: {
        Text(NativeStrings.Usage.account)
      } footer: {
        Text(AccountSectionRows.footer(structured: model.account.isStructured, forBot: true))
          .foregroundStyle(Color.primary)
      }
      .accessibilityIdentifier("hermie.usage.accountSection")
    }
  }
}
