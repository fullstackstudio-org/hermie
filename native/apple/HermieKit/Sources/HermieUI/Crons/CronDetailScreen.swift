import HermieCore
import SwiftUI

/// The detail column's cron (`DetailRoot`, with the Crons section open): the one the list selected, over
/// the live session's model.
struct CronDetailRoute: View {
  let ref: CronRef

  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(\.cronsHolder) private var holder

  var body: some View {
    Group {
      if let live, live.gatewayID == ref.gatewayId, live.phase == .live, let session = live.session,
        let model = holder?.model(for: session)
      {
        CronDetailScreen(ref: ref, session: session, model: model)
          .id(ObjectIdentifier(session))
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.Cron.Detail.loading)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
      }
    }
    .accessibilityIdentifier("hermie.cron.detail")
  }
}

/**
 One cron (`CronDetailScreen.tsx`): what it does, when it runs next, the actions, and its run history.

 Everything on it is the gateway's answer. In particular `next_run_at` is shown as the server sent it
 rather than recomputed from the schedule, because the scheduler owns the timezone and the DST rules.
 The full prompt is read when the screen opens (the list row carries what the list answered) and the
 history is read beside it.

 A run opens in a read-only transcript, pushed over the cron. Where the cron delivers into a bot's chat,
 the way to that chat is a button here and in the run's transcript.
 */
struct CronDetailScreen: View {
  let ref: CronRef
  let session: GatewaySession
  let model: CronsModel

  @Environment(AppRouter.self) private var router: AppRouter?
  @State private var editing: CronEditing?
  @State private var confirming: CronConfirmation?
  @State private var openedRun: CronRun?

  private var current: CronJob? { model.job(id: ref.id) }

  var body: some View {
    let connected = session.status.phase == .ready

    Group {
      if let job = current {
        content(job)
      } else if model.phase == .ready {
        // Deleted somewhere else: there is nothing to show, and the list is where this goes back to.
        EmptyState(Strings.Cron.title, systemImage: "clock.arrow.circlepath", message: Text(Strings.Cron.Detail.unknown))
          .onAppear { router?.closeCron() }
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(current?.name ?? Strings.Cron.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task(id: connected) {
      if connected {
        await reload()
      }
    }
    .sheet(item: $editing) { request in
      CronEditorSheet(model: model, session: session, editing: request.job)
    }
    .cronConfirmations($confirming, model: model, onDeleted: { _ in router?.closeCron() })
    .navigationDestination(item: $openedRun) { run in
      if let job = current {
        CronRunScreen(session: session, job: job, run: run)
      }
    }
  }

  private func reload() async {
    let job = current ?? CronJob(id: ref.id, profile: ref.profile)

    async let detail: Void = model.loadDetail(of: job)
    async let runs: Void = model.loadRuns(of: job)
    _ = await (detail, runs)
  }

  private func content(_ job: CronJob) -> some View {
    let busy = model.busy.contains(job.id)

    return List {
      summary(job)

      Section(Strings.Cron.Detail.instructions) {
        Text(verbatim: job.displayPrompt.isEmpty ? Strings.Cron.Detail.noPrompt : job.displayPrompt)
          .textSelection(.enabled)
          .accessibilityIdentifier("hermie.cron.detail.prompt")
      }

      details(job)
      actions(job, busy: busy)
      history(job)
    }
    .refreshable {
      await model.load()
      await reload()
    }
    .accessibilityIdentifier("hermie.cron.detail.list")
  }

  // MARK: Sections

  /// The design board's contact card: when it next runs, and how it stands.
  private func summary(_ job: CronJob) -> some View {
    let status = job.status

    return Section {
      VStack(alignment: .leading, spacing: 6) {
        Text(Strings.Cron.Detail.nextRun)
          .font(.caption)
          .foregroundStyle(.secondary)

        Text(verbatim: nextRun(job))
          .font(.title2.weight(.semibold))

        HStack(spacing: 8) {
          CronStatusDot(tone: status.tone)
          Text(verbatim: CronText.status(status))
            .foregroundStyle(.secondary)
        }

        if !job.lastErrorSummary.isEmpty {
          Text(verbatim: job.lastErrorSummary)
            .font(.footnote)
            .foregroundStyle(.red)
            .textSelection(.enabled)
            .accessibilityIdentifier("hermie.cron.detail.error")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
    }
  }

  private func nextRun(_ job: CronJob) -> String {
    // A paused cron is not going anywhere, even where the gateway still carries a stale next run.
    guard job.status != .paused, let next = job.nextRunAt else {
      return Strings.Cron.List.noNextRun
    }

    return next < .now ? Strings.Cron.List.overdue : CronText.relative(next)
  }

  private func details(_ job: CronJob) -> some View {
    Section(Strings.Cron.Detail.details) {
      LabeledContent(Strings.Cron.Detail.scheduleLabel) {
        Text(verbatim: CronText.schedule(job.schedule))
          .multilineTextAlignment(.trailing)
      }

      LabeledContent(Strings.Cron.Detail.deliverLabel) {
        Text(verbatim: CronText.delivery(job.deliver, targets: model.targets))
          .multilineTextAlignment(.trailing)
      }

      if let profile = job.profile {
        LabeledContent(Strings.Cron.Editor.profile) {
          Text(verbatim: bot(named: profile)?.displayName ?? profile)
        }
      }

      LabeledContent(Strings.Cron.Detail.repeatLabel) {
        Text(verbatim: job.repeatTimes.map(String.init) ?? Strings.Cron.Detail.repeatForever)
      }

      LabeledContent(Strings.Cron.Detail.lastRunLabel) {
        Text(verbatim: job.lastRunAt.map { CronText.relative($0) } ?? Strings.Cron.List.neverRun)
      }

      LabeledContent(Strings.Cron.Detail.lastStatusLabel) {
        // The gateway's own word, made readable: printing `ok` two rows under a humanised `Success`
        // read as two different facts.
        Text(verbatim: CronText.humanised(job.lastStatus) ?? Strings.Cron.Detail.unknown)
      }

      if let model = job.model {
        LabeledContent(Strings.Cron.Detail.modelLabel) {
          Text(verbatim: model)
            .multilineTextAlignment(.trailing)
        }
      }

      if !job.skills.isEmpty {
        LabeledContent(Strings.Cron.Detail.skillsLabel) {
          Text(verbatim: job.skills.joined(separator: ", "))
            .multilineTextAlignment(.trailing)
        }
      }

      if let reason = job.pausedReason {
        LabeledContent(Strings.Cron.Detail.pausedReasonLabel) {
          Text(verbatim: reason)
            .multilineTextAlignment(.trailing)
        }
      }
    }
  }

  /// One primary, then what changes the cron, then the destructive one on its own.
  private func actions(_ job: CronJob, busy: Bool) -> some View {
    let paused = job.status == .paused

    return Section(Strings.Cron.Detail.actions) {
      Button {
        Task { _ = await model.runNow(job) }
      } label: {
        Label(busy ? Strings.Cron.Detail.running : Strings.Cron.Detail.runNow, systemImage: "bolt")
      }
      .disabled(busy)
      .accessibilityIdentifier("hermie.cron.detail.runNow")

      Button {
        Task { _ = await (paused ? model.resume(job) : model.pause(job)) }
      } label: {
        Label(
          paused ? Strings.Cron.Detail.resume : Strings.Cron.Detail.pause,
          systemImage: paused ? "play" : "pause")
      }
      .disabled(busy)
      .accessibilityIdentifier("hermie.cron.detail.togglePause")

      Button {
        editing = CronEditing(job: job)
      } label: {
        Label(Strings.Cron.Detail.edit, systemImage: "pencil")
      }
      .disabled(busy)
      .accessibilityIdentifier("hermie.cron.detail.edit")

      if let bot = chatBot(of: job) {
        Button {
          router?.openChat(ChatRef(gatewayId: session.gatewayID, bot: bot.name))
        } label: {
          Label(Strings.App.Activity.openChat(bot: bot.displayName), systemImage: "bubble.left")
        }
        .accessibilityIdentifier("hermie.cron.detail.openChat")
      }

      Button(role: .destructive) {
        confirming = .delete(job)
      } label: {
        Label(Strings.Cron.Detail.delete, systemImage: "trash")
      }
      .disabled(busy)
      .accessibilityIdentifier("hermie.cron.detail.delete")
    }
  }

  private func history(_ job: CronJob) -> some View {
    Section(Strings.Cron.Detail.runHistory) {
      switch model.runs[job.id] {
      case nil, .loading?:
        HStack(spacing: 10) {
          ProgressView()
          Text(Strings.Cron.Detail.loadingRuns)
            .foregroundStyle(.secondary)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
      case .failed(let reason)?:
        Text(verbatim: Strings.Cron.Detail.runsFailed(reason: reason))
          .foregroundStyle(.red)
      case .loaded(let runs)?:
        if runs.isEmpty {
          Text(Strings.Cron.Detail.noRuns)
            .foregroundStyle(.secondary)
        } else {
          ForEach(runs) { run in
            Button {
              openedRun = run
            } label: {
              CronRunRow(run: run)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("hermie.cron.detail.run.\(run.id)")
          }
        }
      }
    }
  }

  // MARK: Bots

  private func bot(named name: String) -> Bot? {
    session.chatList.rows[name]?.bot
  }

  /// The bot whose chat this cron's result lands in: the delivery target's, else the profile it runs as,
  /// where the roster knows it.
  private func chatBot(of job: CronJob) -> Bot? {
    if let target = job.deliveredBot {
      return bot(named: target)
    }

    // A bare `bot-chat` delivers into the chat of the profile the cron runs as.
    if job.deliver == "bot-chat", let profile = job.profile {
      return bot(named: profile)
    }

    return nil
  }
}

/// One run of a cron: its outcome dot, when it started and the first words of what it did.
struct CronRunRow: View {
  let run: CronRun

  var body: some View {
    let outcome = run.outcome

    HStack(spacing: 10) {
      CronStatusDot(tone: outcome.tone, size: 8)

      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: CronText.runWhen(run))
          .lineLimit(1)

        if !run.preview.isEmpty {
          Text(verbatim: run.preview)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 8)

      Text(verbatim: CronText.outcome(run))
        .font(.caption)
        .foregroundStyle(outcome == .failed ? Color.red : Color.secondary)

      Image(systemName: "chevron.right")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 44)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}
