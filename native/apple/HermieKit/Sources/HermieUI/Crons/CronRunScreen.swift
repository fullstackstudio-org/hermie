import HermieCore
import HermieTranscript
import SwiftUI

/**
 One run of a cron, read and not answered (`CronRunScreen.tsx`), pushed over the cron in the detail
 column.

 A run is an ordinary session, so it draws through the same projection as a chat and a tool call in a cron
 run looks like a tool call in a conversation. It is a snapshot (`CronRunModel`): a cron session has no
 live agent behind it, so there is no composer, nothing is written to the chat cache and no read mark
 moves. A line says so, with the way to the chat where the cron delivers.
 */
struct CronRunScreen: View {
  let session: GatewaySession
  let job: CronJob
  let run: CronRun

  var body: some View {
    Group {
      if let model = session.cronRun(job: job, run: run) {
        CronRunContent(session: session, model: model, bot: deliveredBot)
          .id(run.id)
      } else {
        EmptyState(Strings.Cron.Run.title, systemImage: "clock.arrow.circlepath", message: Text(Strings.Cron.Run.empty))
      }
    }
    .navigationTitle(run.displayTitle == run.id ? Strings.Cron.Run.title : run.displayTitle)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .accessibilityIdentifier("hermie.cron.run")
  }

  /// The bot whose chat the cron delivers into, where the roster knows it.
  private var deliveredBot: Bot? {
    let name = job.deliveredBot ?? (job.deliver == "bot-chat" ? job.profile : nil)

    return name.flatMap { session.chatList.rows[$0]?.bot }
  }
}

private struct CronRunContent: View {
  let session: GatewaySession
  let bot: Bot?

  @State private var model: CronRunModel
  @State private var rows = TranscriptListItems<TranscriptRow>()
  @State private var listState = TranscriptListState()
  @State private var expansion = TranscriptExpansion()
  @State private var pipeline = ChatRowPipeline()
  @Environment(AppRouter.self) private var router: AppRouter?

  init(session: GatewaySession, model: CronRunModel, bot: Bot?) {
    self.session = session
    self.bot = bot
    _model = State(initialValue: model)
  }

  var body: some View {
    let connected = session.status.phase == .ready

    VStack(spacing: 0) {
      banner

      ZStack {
        TranscriptList(rows, state: listState, spacing: 0) { row in
          TranscriptItemView(row: row, gaps: .chat)
            .padding(.horizontal, ChatSpacing.edgeMargin)
        }
        .environment(\.transcriptExpansion, expansion)
        .modifier(OwnAuthor(session: session))

        state(connected: connected)
      }
    }
    .task(id: connected) {
      if connected, model.phase != .ready {
        await model.load()
      }
    }
    .task(id: model.revision) {
      guard model.phase == .ready else {
        return
      }

      rows = await pipeline.rows(for: model.items, historyComplete: true).rows
    }
  }

  /// "Read-only: a cron run cannot be continued from here", and the way to the chat.
  private var banner: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(Strings.Cron.Run.readOnly)
        .font(.callout)

      if let bot, let router {
        Button(Strings.App.Activity.openChat(bot: bot.displayName)) {
          router.openChat(ChatRef(gatewayId: session.gatewayID, bot: bot.name))
        }
        .buttonStyle(.borderless)
        .font(.callout)
        .accessibilityIdentifier("hermie.cron.run.openChat")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, ChatSpacing.edgeMargin)
    .padding(.vertical, 8)
    .background(.bar)
    .accessibilityElement(children: .contain)
  }

  /// Loading, why it failed, or that nothing was said: over the (empty) list.
  @ViewBuilder private func state(connected: Bool) -> some View {
    switch model.phase {
    case .loading:
      VStack(spacing: 12) {
        if connected {
          ProgressView()
          Text(Strings.Cron.Run.loading)
            .foregroundStyle(.secondary)
        } else {
          Label(Strings.Chat.Sessions.loadFailed, systemImage: "wifi.slash")
        }
      }
      .accessibilityElement(children: .combine)
    case .failed(let message):
      VStack(spacing: 12) {
        Text(verbatim: Strings.Cron.Run.failed(reason: message))
          .multilineTextAlignment(.center)

        Button(Strings.App.Common.retry) { Task { await model.load() } }
      }
      .padding()
    case .ready:
      if model.items.isEmpty {
        Text(Strings.Cron.Run.empty)
          .foregroundStyle(.secondary)
          .padding()
      }
    }
  }
}
