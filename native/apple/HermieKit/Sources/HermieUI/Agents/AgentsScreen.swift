import HermieCore
import SwiftUI

/**
 The agents overview (NX-9) as a sheet (`AppSheet.agents`): what each bot is doing now, on one screen.
 Opened from the sidebar's toolbar on the iPhone, the iPad and the Mac, and from the Mac's (and the iPad's)
 menu bar. A tap on a bot opens its chat.

 What is on it is read, never kept: `AgentsModel` reads the gateway while the screen is on top, every few
 seconds, and again at once when the gateway says its sessions or its crons changed, and forgets it all when
 the sheet goes. It reads the session from `LiveGateway` in the environment, like the Activity screen.
 */
struct AgentsSheet: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      AgentsScreen(close: { dismiss() })
    }
    #if os(macOS)
      .frame(minWidth: 480, minHeight: 520)
    #endif
    .accessibilityIdentifier("hermie.agents")
  }
}

/// The screen over whichever session is live, or a quiet "reading" while there is none.
struct AgentsScreen: View {
  let close: () -> Void

  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    Group {
      if let live, let router, live.gatewayID == router.selectedGatewayId, live.phase == .live,
        let session = live.session
      {
        AgentsList(session: session, close: close)
          .id(ObjectIdentifier(session))
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text(NativeStrings.Agents.loading)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
      }
    }
    .navigationTitle(NativeStrings.Agents.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(Strings.App.Common.done) { close() }
          .keyboardShortcut(.cancelAction)
      }
    }
  }
}

/// The list over a running session.
struct AgentsList: View {
  let session: GatewaySession
  let close: () -> Void

  @State private var model: AgentsModel
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.liveWiring) private var wiring

  init(session: GatewaySession, close: @escaping () -> Void) {
    self.session = session
    self.close = close
    _model = State(initialValue: session.agents())
  }

  var body: some View {
    let connected = session.status.phase == .ready
    let waiting = AgentsOverview.waitingCounts(in: wiring?.inbox?.items ?? [], gatewayId: session.gatewayID)

    content(connected: connected)
      .safeAreaInset(edge: .top, spacing: 0) {
        ConnectionBanner(
          status: session.status,
          retry: { Task { await session.retryNow() } },
          signIn: {}
        )
      }
      // Read once the socket is up: a read before that fails with "not connected" and would say every
      // bot is idle.
      .task(id: connected) {
        if connected {
          await model.refresh()
        }
      }
      // The beat: the busy sessions every few seconds, and the cron list on a slower one.
      .task(id: connected) {
        guard connected else {
          return
        }

        var ticks = 0
        let crons = max(1, Int(AgentsModel.cronInterval / AgentsModel.liveInterval))

        while !Task.isCancelled {
          try? await Task.sleep(for: AgentsModel.liveInterval)

          guard !Task.isCancelled else {
            return
          }

          ticks += 1
          await model.refreshLive()

          if ticks % crons == 0 {
            await model.refreshCrons()
          }
        }
      }
      // The gateway says when a job's list moved.
      .task(id: connected) {
        if connected {
          await model.watchCrons()
        }
      }
      // A session started or ended: no waiting for the beat.
      .onChange(of: session.sessionsChangedCount) {
        if connected {
          Task { await model.refreshLive() }
        }
      }
      .onChange(of: waiting, initial: true) { _, counts in
        model.setWaiting(counts)
      }
      .refreshable { await model.refresh() }
  }

  @ViewBuilder private func content(connected: Bool) -> some View {
    let overview = model.overview

    List {
      Section {
        header(overview)
      }
      .listRowSeparator(.hidden)

      if !overview.rows.isEmpty {
        Section {
          ForEach(overview.rows) { row in
            AgentRowView(
              row: row, avatar: session.chatList.rows[row.bot.name]?.avatar, now: .now,
              action: { open(row) })
          }
        } header: {
          Text(NativeStrings.Agents.bots)
        } footer: {
          footer(overview)
        }
      }

      if overview.subagentCount > 0 {
        Section {
          ForEach(overview.subagents, id: \.subagent.id) { entry in
            AgentSubagentRowView(owner: entry.bot.displayName, subagent: entry.subagent, now: .now)
          }
        } header: {
          Text(NativeStrings.Agents.subagents)
        }
      }

      if model.phase == .ready {
        Section {
          if overview.upcoming.isEmpty {
            Text(overview.cronsKnown ? NativeStrings.Agents.noCrons : NativeStrings.Agents.cronsUnknown)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("hermie.agents.crons.empty")
          } else {
            ForEach(overview.upcoming) { cron in
              CronRowView(cron: cron, owner: owner(of: cron), now: .now)
            }
          }
        } header: {
          Text(NativeStrings.Agents.crons)
        }
      }
    }
    .overlay {
      if overview.rows.isEmpty {
        placeholder(connected: connected)
      }
    }
    .accessibilityIdentifier("hermie.agents.list")
  }

  /// Three chips, in the order of urgency: what waits on the person, what runs, what is quiet.
  private func header(_ overview: AgentsOverview) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.Agents.subtitle)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      HStack(spacing: 8) {
        chip(overview.waiting, .waiting)
        chip(overview.running, .running)
        chip(overview.idle, .idle)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func chip(_ value: Int, _ state: AgentState) -> some View {
    HStack(spacing: 5) {
      Text(verbatim: String(value))
        .fontWeight(.bold)
        .foregroundStyle(value > 0 ? Color.accentColor : Color.secondary)
        .monospacedDigit()

      Text(verbatim: NativeStrings.Agents.state(state))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .font(.footnote)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(.quaternary, in: .capsule)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.agents.count.\(state)")
  }

  @ViewBuilder private func footer(_ overview: AgentsOverview) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if !overview.isComplete {
        Text(NativeStrings.Agents.incomplete)
      }

      if overview.otherRunning > 0 {
        Text(NativeStrings.Agents.otherRunning(overview.otherRunning))
      }
    }
  }

  @ViewBuilder private func placeholder(connected: Bool) -> some View {
    if model.phase == .loading, connected {
      VStack(spacing: 12) {
        ProgressView()
        Text(NativeStrings.Agents.loading)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    } else if model.phase == .ready {
      EmptyState(
        NativeStrings.Agents.emptyTitle, systemImage: "person.2", message: Text(NativeStrings.Agents.emptyMessage)
      )
      .accessibilityIdentifier("hermie.agents.empty")
    } else {
      Text(NativeStrings.Agents.offline)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .padding(32)
        .frame(maxWidth: 420)
        .accessibilityIdentifier("hermie.agents.offline")
    }
  }

  private func owner(of cron: AgentCron) -> String? {
    cron.bot.flatMap { name in model.overview.row(for: name)?.bot.displayName }
  }

  /// Open the bot's chat, and put the sheet away: it would stand over the chat.
  private func open(_ row: AgentRow) {
    guard let router else {
      return
    }

    router.openChat(ChatRef(gatewayId: session.gatewayID, bot: row.bot.name))
    close()
  }
}

// MARK: - Rows

/// One bot: its picture, its name and state, and under them the one or two lines that say what it is
/// doing (the tool it runs, its newest line, since when, its sub-agents) or, when it is quiet, its next cron.
struct AgentRowView: View {
  let row: AgentRow
  let avatar: String?
  let now: Date
  let action: () -> Void

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 12) {
        BotAvatar(name: row.bot.displayName, avatar: avatar, size: 40)

        VStack(alignment: .leading, spacing: 3) {
          if typeSize.isAccessibilitySize {
            Text(verbatim: row.bot.displayName).font(.headline)
            AgentStateBadge(state: row.state)
          } else {
            HStack(alignment: .firstTextBaseline) {
              Text(verbatim: row.bot.displayName).font(.headline)
              Spacer(minLength: 8)
              AgentStateBadge(state: row.state)
            }
          }

          ForEach(lines, id: \.self) { line in
            Text(verbatim: line)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: ([row.bot.displayName, NativeStrings.Agents.state(row.state)] + lines).joined(separator: ", ")))
    .accessibilityHint(Text(NativeStrings.Agents.rowHint))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.agents.row.\(row.bot.name)")
  }

  /// What is under the name, in the order of what matters.
  var lines: [String] {
    var out: [String] = []

    if row.waitingCount > 0 {
      out.append(NativeStrings.NeedsYou.count(row.waitingCount))
    }

    if let tool = row.tool {
      out.append([NativeStrings.Agents.using(tool.name), tool.context].compactMap { $0 }.joined(separator: " · "))
    } else if row.state != .idle, let preview = row.preview {
      out.append(preview)
    }

    if row.state != .idle, let started = row.startedAt {
      out.append(NativeStrings.Agents.started(CronText.relative(started, now: now)))
    }

    if !row.subagents.isEmpty {
      out.append(NativeStrings.Agents.subagentsRunning(row.subagents.count))
    }

    if row.state == .idle, let next = row.nextCron {
      out.append(NativeStrings.Agents.nextCron(next.name, CronText.relative(next.nextRunAt, now: now)))
    }

    return out
  }
}

/// The state, as a dot and a word. The word carries the meaning; the colour only helps.
struct AgentStateBadge: View {
  let state: AgentState

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(color)
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)

      Text(verbatim: NativeStrings.Agents.state(state))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }

  private var color: Color {
    switch state {
    case .waiting: .orange
    case .running: .green
    case .idle: .secondary.opacity(0.5)
    }
  }
}

/// One sub-agent: what it was asked, whose it is, and how far along.
struct AgentSubagentRowView: View {
  let owner: String
  let subagent: AgentSubagent
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: subagent.goal.isEmpty ? NativeStrings.Agents.unnamedSubagent : subagent.goal)
        .font(.subheadline.weight(.semibold))
        .lineLimit(3)

      Text(verbatim: detail)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.agents.subagent.\(subagent.id)")
  }

  private var detail: String {
    var parts = [owner]

    if subagent.status == "queued" {
      parts.append(NativeStrings.Agents.queued)
    }

    if subagent.toolCount > 0 {
      parts.append(NativeStrings.Agents.toolCalls(subagent.toolCount))
    }

    if let started = subagent.startedAt {
      parts.append(NativeStrings.Agents.started(CronText.relative(started, now: now)))
    }

    return parts.joined(separator: " · ")
  }
}

/// One cron that runs next: its name, whose it is and how it repeats, and when.
struct CronRowView: View {
  let cron: AgentCron
  let owner: String?
  let now: Date

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: cron.name)
          .font(.subheadline.weight(.semibold))
          .lineLimit(2)

        Text(verbatim: [owner, cron.schedule.isEmpty ? nil : CronText.schedule(cron.schedule)].compactMap { $0 }.joined(separator: " · "))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }

      Spacer(minLength: 8)

      Text(verbatim: CronText.relative(cron.nextRunAt, now: now))
        .font(.subheadline)
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.agents.cron.\(cron.id)")
  }
}

// MARK: - Entry point

/// The sidebar's toolbar item that opens the overview.
struct AgentsButton: View {
  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    Button {
      router?.present(.agents)
    } label: {
      Label(NativeStrings.Agents.title, systemImage: "person.2.wave.2")
    }
    .help(NativeStrings.Agents.title)
    .accessibilityIdentifier("hermie.toolbar.agents")
  }
}
