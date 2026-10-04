import HermieCore
import SwiftUI

/**
 The Crons section's list, in the sidebar (`CronScreen.tsx` in the Expo app): every cron of every
 profile of the live gateway, split into the ones that will run and the paused ones, each saying what it
 is, when it runs, where it delivers and how it last went.

 Selection is the router's: a row is tagged with its cron's id, and picking one opens it in the detail
 column (pushed over the list on iPhone). A row's menu (long press, swipe, the Mac's right click) pauses
 and resumes it, runs it now, edits it and deletes it; Run now and Delete ask first.

 The banner at the top is the one thing on the screen that is not about a single cron: with the scheduler
 down every row below is a plan rather than a promise.

 The list is read when the screen opens and when the connection returns, again when the gateway
 broadcasts `cron.changed` (debounced), and on a pull. A failed refresh keeps the rows that were there.

 It reads the session from `LiveGateway` in the environment.
 */
struct CronsScreen: View {
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.cronsHolder) private var holder

  var body: some View {
    Group {
      if let live, let router, live.gatewayID == router.selectedGatewayId, live.phase == .live,
        let session = live.session, let model = holder?.model(for: session)
      {
        CronsList(session: session, model: model)
          .id(ObjectIdentifier(session))
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.Cron.List.loading)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
      }
    }
    .accessibilityIdentifier("hermie.crons")
  }
}

/// The list over a running session.
struct CronsList: View {
  let session: GatewaySession
  let model: CronsModel

  @Environment(AppRouter.self) private var router: AppRouter?
  @State private var editing: CronEditing?
  @State private var confirming: CronConfirmation?

  var body: some View {
    let connected = session.status.phase == .ready

    content
      .safeAreaInset(edge: .top, spacing: 0) {
        VStack(spacing: 0) {
          ConnectionBanner(
            status: session.status,
            retry: { Task { await session.retryNow() } },
            signIn: {}
          )

          if model.gatewayRunning == false {
            schedulerBanner
          }
        }
      }
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            editing = CronEditing(job: nil)
          } label: {
            Label(Strings.Cron.List.add, systemImage: "plus")
          }
          .disabled(!connected)
          .accessibilityIdentifier("hermie.crons.new")
        }
      }
      .task(id: connected) {
        // Read when the socket is up, and followed for as long as the screen is: a cancelled task is
        // the screen going away.
        guard connected else {
          return
        }

        await model.load()
        await model.watch()
      }
      .refreshable { await model.load() }
      .sheet(item: $editing) { request in
        CronEditorSheet(model: model, session: session, editing: request.job)
      }
      .cronConfirmations($confirming, model: model, onDeleted: { closeIfOpen($0) })
  }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case .loading:
      VStack(spacing: 12) {
        ProgressView()
        Text(Strings.Cron.List.loading)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
    case .failed(let message):
      EmptyState(
        Strings.Cron.title,
        systemImage: "exclamationmark.triangle",
        message: Text(verbatim: Strings.Cron.List.failed(reason: message))
      ) {
        Button(Strings.App.Common.retry) { Task { await model.load() } }
          .buttonStyle(.bordered)
      }
    case .ready where model.jobs.isEmpty:
      EmptyState(
        Strings.Cron.title,
        systemImage: "clock.arrow.circlepath",
        message: Text(Strings.Cron.List.empty)
      ) {
        Button(Strings.Cron.List.add) { editing = CronEditing(job: nil) }
          .buttonStyle(.borderedProminent)
      }
    case .ready:
      list
    }
  }

  private var list: some View {
    List(selection: selection) {
      if !model.active.isEmpty {
        Section(Strings.Cron.Sections.active) {
          ForEach(model.active) { row($0) }
        }
      }

      if !model.paused.isEmpty {
        Section(Strings.Cron.Sections.paused) {
          ForEach(model.paused) { row($0) }
        }
      }
    }
    .accessibilityIdentifier("hermie.crons.list")
  }

  private var selection: Binding<String?> {
    Binding(
      get: { router?.selectedCron?.id },
      set: { id in
        guard let router else {
          return
        }

        if let id, let job = model.job(id: id) {
          router.openCron(CronRef(gatewayId: session.gatewayID, id: id, profile: job.profile))
        } else {
          router.closeCron()
        }
      }
    )
  }

  /// A deleted cron that was open in the detail column closes it.
  private func closeIfOpen(_ job: CronJob) {
    if router?.selectedCron?.id == job.id {
      router?.closeCron()
    }
  }

  private func row(_ job: CronJob) -> some View {
    CronRow(job: job, showsProfile: model.showsProfiles, targets: model.targets, busy: model.busy.contains(job.id))
      .tag(job.id)
      .contextMenu { CronMenu(job: job, model: model, editing: $editing, confirming: $confirming) }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button(role: .destructive) {
          confirming = .delete(job)
        } label: {
          Label(Strings.Cron.Detail.delete, systemImage: "trash")
        }

        Button {
          editing = CronEditing(job: job)
        } label: {
          Label(Strings.Cron.Detail.edit, systemImage: "pencil")
        }
        .tint(.orange)
      }
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        Button {
          Task { _ = await (job.status == .paused ? model.resume(job) : model.pause(job)) }
        } label: {
          if job.status == .paused {
            Label(Strings.Cron.Detail.resume, systemImage: "play")
          } else {
            Label(Strings.Cron.Detail.pause, systemImage: "pause")
          }
        }
        .tint(.accentColor)
      }
  }

  /// The scheduler process is down: the one thing painted in the danger tint.
  private var schedulerBanner: some View {
    Label(Strings.Cron.gatewayBanner, systemImage: "exclamationmark.triangle.fill")
      .font(.callout)
      .foregroundStyle(.red)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal)
      .padding(.vertical, 8)
      .background(.red.opacity(0.12))
      .accessibilityIdentifier("hermie.crons.schedulerBanner")
  }
}

/// A cron's menu, for its row and for its detail: one list.
struct CronMenu: View {
  let job: CronJob
  let model: CronsModel
  @Binding var editing: CronEditing?
  @Binding var confirming: CronConfirmation?

  var body: some View {
    if job.status == .paused {
      Button(Strings.Cron.Detail.resume, systemImage: "play") {
        Task { _ = await model.resume(job) }
      }
    } else {
      Button(Strings.Cron.Detail.pause, systemImage: "pause") {
        Task { _ = await model.pause(job) }
      }
    }

    // The ellipsis is the platform's own promise that a line asks before it acts.
    Button("\(Strings.Cron.Detail.runNow)…", systemImage: "bolt") {
      confirming = .run(job)
    }

    Button(Strings.Cron.Detail.edit, systemImage: "pencil") {
      editing = CronEditing(job: job)
    }

    Button("\(Strings.Cron.Detail.delete)…", systemImage: "trash", role: .destructive) {
      confirming = .delete(job)
    }
  }
}

/// One cron: a dot, what it is (its name over its schedule in words and where it delivers), the last
/// error where there is one, and a right-aligned pair that says WHEN: a small label over a relative
/// time.
///
/// `next_run_at` is shown as a relative phrase on purpose: the scheduler's timezone is not the phone's.
/// Which label wins (next, last, or next overdue) is `CronJob.rowWhen`, not this view: a paused row that
/// still carries a stale `next_run_at` must not read "next 14h ago".
///
/// The row's shape does not change while it is on screen: the lines are the same lines whatever the
/// gateway answers next, so a refresh never moves the rows under it.
struct CronRow: View {
  let job: CronJob
  let showsProfile: Bool
  let targets: [CronDeliveryTarget]
  let busy: Bool

  var body: some View {
    let when = CronText.when(job.rowWhen())
    let summary = job.lastErrorSummary

    HStack(alignment: .top, spacing: 12) {
      CronStatusDot(tone: job.status.tone)
        .padding(.top, 6)

      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: job.name)
          .font(.headline)
          .lineLimit(1)

        Text(verbatim: meta)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)

        if !summary.isEmpty {
          Text(verbatim: summary)
            .font(.caption)
            .foregroundStyle(.red)
            .lineLimit(2)
        }
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 1) {
        Text(verbatim: when.label.uppercased())
          .font(.caption2)
          .foregroundStyle(.tertiary)

        Text(verbatim: when.value)
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
      .fixedSize()
    }
    // A paused cron is dimmed, not greyed out: it is still a cron.
    .opacity(job.status == .paused ? 0.68 : 1)
    .overlay(alignment: .trailing) {
      if busy {
        ProgressView().controlSize(.small)
      }
    }
    .frame(minHeight: 48, alignment: .top)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel(when: when))
    .accessibilityIdentifier("hermie.crons.row.\(job.id)")
  }

  /// The schedule in words, and where the cron delivers; the profile only where it tells two rows apart.
  private var meta: String {
    var parts = [CronText.schedule(job.schedule)]

    if !job.deliver.isEmpty {
      parts.append(CronText.delivery(job.deliver, targets: targets))
    }

    if showsProfile, let profile = job.profile {
      parts.append(profile)
    }

    return parts.joined(separator: " · ")
  }

  private func accessibilityLabel(when: (label: String, value: String)) -> String {
    // Two profiles may hold a cron of the same name, so the name alone does not identify the row.
    let name = showsProfile && job.profile != nil ? "\(job.name), \(Strings.Cron.List.profile(name: job.profile ?? ""))" : job.name

    return [name, CronText.status(job.status), meta, "\(when.label) \(when.value)"].joined(separator: ", ")
  }
}
