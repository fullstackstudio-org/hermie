import Foundation
import Observation

import HermieTranscript

/**
 The agents overview's state (NX-9): one screen for what every bot of the gateway is doing now. Idle,
 running, or waiting for the person; the tool a live turn is running; the subagents running; the cron
 jobs that run next.

 Two reads, at two speeds, because they cost differently:

 - `refreshLive()` is `session.active_list`, the chats the app holds and `delegation.status` for the bots
   that are busy. It runs when the screen opens, when the gateway says the sessions changed
   (`sessions.changed`), when the inbox moves, and every `liveInterval` while the screen is on top: the
   gateway announces a session's start and end but not what it is doing, so a screen that wants "now"
   polls gently.
 - `refresh()` also reads the roster and the cron list. The cron list is read again when the gateway
   broadcasts `cron.changed` (`watchCrons()`) and every `cronInterval`, because a job's next run moves
   whenever it fires.

 Nothing is patched: every read builds the whole overview again (`AgentsOverview.make`), so what is on
 screen is always one consistent reading. A read that a newer one overtook is dropped, and a read that
 failed keeps what was on screen.
 */
@MainActor
@Observable
public final class AgentsModel {
  public enum Phase: Equatable, Sendable {
    /// Nothing read yet.
    case loading
    case ready
  }

  /// How often the busy sessions are read while the screen is visible.
  public static let liveInterval: Duration = .seconds(5)
  /// How often the cron list is read while the screen is visible, on top of `cron.changed`.
  public static let cronInterval: Duration = .seconds(60)
  /// `cron.changed` fires about once per scheduler tick; a burst is coalesced for this long.
  public static let changedDebounce: Duration = .milliseconds(750)

  public private(set) var phase = Phase.loading
  public private(set) var overview = AgentsOverview.empty
  /// A pull-to-refresh or the first read is running.
  public private(set) var refreshing = false

  @ObservationIgnored private let backend: any AgentsBackend
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let debounce: Duration
  @ObservationIgnored private var bots: [Bot] = []
  @ObservationIgnored private var jobs: [CronJob]?
  @ObservationIgnored private var waiting: [String: Int] = [:]
  /// Only the newest read of each kind may write. A full read also overtakes the live reads before it.
  @ObservationIgnored private var fullRound = 0
  @ObservationIgnored private var liveRound = 0

  public init(
    backend: any AgentsBackend, now: @escaping @Sendable () -> Date = { Date() },
    debounce: Duration = AgentsModel.changedDebounce
  ) {
    self.backend = backend
    self.now = now
    self.debounce = debounce
  }

  /// What waits on the person, per bot: the inbox's part for this gateway. Rebuilds the overview from what
  /// is held; no gateway read.
  public func setWaiting(_ counts: [String: Int]) {
    guard counts != waiting else {
      return
    }

    waiting = counts

    if phase == .ready {
      rebuild(active: currentActive, live: nil)
    }
  }

  // MARK: Reading

  /// The roster, the busy sessions and the cron list. Safe to call whenever the connection returns.
  public func refresh() async {
    fullRound += 1
    liveRound += 1
    let mine = fullRound
    refreshing = true
    defer { refreshing = false }

    async let roster = backend.bots()
    async let list = backend.cronJobs()
    let read = await reading(of: await roster)
    let cron = await list

    guard fullRound == mine else {
      return
    }

    bots = read.bots
    // A list that cannot be read keeps the one before: a flaky read is no reason to empty the schedule.
    jobs = cron ?? jobs
    apply(read)
  }

  /// The busy sessions and what runs in them, over the roster already held.
  public func refreshLive() async {
    liveRound += 1
    let mine = liveRound

    if bots.isEmpty {
      bots = await backend.heldBots()
    }

    let read = await reading(of: bots)

    guard liveRound == mine else {
      return
    }

    apply(read)
  }

  /// The cron list alone, for the poll and for `cron.changed`.
  public func refreshCrons() async {
    guard let list = await backend.cronJobs() else {
      return
    }

    jobs = list

    if phase == .ready {
      rebuild(active: currentActive, live: nil)
    }
  }

  /// Follow the gateway's `cron.changed` broadcasts until the calling task is cancelled.
  public func watchCrons() async {
    var pending: Task<Void, Never>?

    defer { pending?.cancel() }

    for await _ in backend.cronChanges() {
      pending?.cancel()
      pending = Task { [debounce] in
        try? await Task.sleep(for: debounce)

        if !Task.isCancelled {
          await self.refreshCrons()
        }
      }
    }
  }

  // MARK: Building

  /// Everything one read of the gateway found.
  private struct Reading {
    var bots: [Bot]
    var active: [BotRoster.ActiveSession]?
    var live: [ChatState]
    var subagents: [String: [AgentSubagent]]
  }

  @ObservationIgnored private var currentActive: [BotRoster.ActiveSession]?
  @ObservationIgnored private var currentLive: [ChatState] = []
  @ObservationIgnored private var currentSubagents: [String: [AgentSubagent]] = [:]

  private func reading(of bots: [Bot]) async -> Reading {
    let active = await backend.activeSessions()
    let live = await backend.liveStates()
    // Subagents exist only while a turn runs, so only the busy bots are asked; where the list could not be
    // read, every bot is.
    let busy: [Bot] =
      active.map { rows in bots.filter { bot in rows.contains { $0.bot == bot.name } } } ?? bots

    return Reading(bots: bots, active: active, live: live, subagents: await backend.subagents(of: busy))
  }

  private func apply(_ read: Reading) {
    currentActive = read.active
    currentLive = read.live
    currentSubagents = read.subagents
    rebuild(active: read.active, live: read.live)
  }

  private func rebuild(active: [BotRoster.ActiveSession]?, live: [ChatState]?) {
    overview = AgentsOverview.make(
      AgentsInput(
        bots: bots, active: active, live: live ?? currentLive, subagents: currentSubagents, jobs: jobs,
        waiting: waiting, now: now()))
    phase = .ready
  }
}
