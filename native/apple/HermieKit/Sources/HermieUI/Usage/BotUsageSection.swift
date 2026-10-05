import HermieCore
import SwiftUI

/**
 A bot's Usage, on its settings page: what it used today and over a week or a month (tokens and
 cost), day by day, how full its chat's context window is, how many sessions and messages that was,
 and what the provider account says about its limits.

 It reads the live gateway (`BotUsageModel`): the days from the gateway's analytics route, the context
 window from the chat, the account's limits from the chat's live session. A gateway without the route
 says so in one line and shows nothing it could not know. Every number is the gateway's, in its UTC
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

    BotUsageContent(model: model)
      .task(id: connected) {
        if connected {
          await model.load()
        }
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
        ProviderAccountRows(accountLines: model.live?.accountLines ?? [], nous: model.nous)
      } header: {
        Text(NativeStrings.Usage.account)
      } footer: {
        Text(NativeStrings.Usage.accountNote)
          .foregroundStyle(Color.primary)
      }
      .accessibilityIdentifier("hermie.usage.accountSection")
    }
  }
}
