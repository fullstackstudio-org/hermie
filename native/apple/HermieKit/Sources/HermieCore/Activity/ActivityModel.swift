import Foundation
import Observation

import HermieTranscript

/// One day of the timeline: its rows, newest first.
public struct ActivityDay: Sendable, Equatable, Identifiable {
  /// The start of the day, in the calendar the timeline was grouped with.
  public var start: Date
  public var entries: [ActivityEntry]

  public var id: Date { start }

  public init(start: Date, entries: [ActivityEntry]) {
    self.start = start
    self.entries = entries
  }
}

/// The three counters at the top of the screen: the only thing on it that is not derived from the
/// transcripts. They are read while the screen is on top and forgotten when it is not.
public struct ActivityCounters: Sendable, Equatable {
  /// Bots with a session the gateway calls busy (`session.active_list`).
  public var botsWorking = 0
  /// Children running across every bot (`delegation.status`).
  public var activeSubagents = 0
  /// `message_agent` deliveries still in flight (`agents.list`).
  public var inFlightDeliveries = 0

  public init(botsWorking: Int = 0, activeSubagents: Int = 0, inFlightDeliveries: Int = 0) {
    self.botsWorking = botsWorking
    self.activeSubagents = activeSubagents
    self.inFlightDeliveries = inFlightDeliveries
  }
}

/// What the Activity screen asks of the session, as one seam: a test hands in a stub, production an
/// `ActivityService` over a session's store and roster.
public protocol ActivityBackend: Sendable {
  /// The roster, read again where it can be (the roster read the app already has where it cannot).
  func bots() async -> [Bot]
  /// The chats the transcript store holds, as they are now: the live truth, which a tail read must
  /// never overwrite.
  func liveStates() async -> [ChatState]
  /// A bot's recent rows as a chat state, read off the gateway for a bot whose chat is not live;
  /// nil where its chat cannot be resolved or read (it contributes nothing, and must not take the
  /// whole screen down).
  func tail(of bot: Bot) async -> ChatState?
  func counters(for bots: [Bot]) async -> ActivityCounters
}

/**
 Activity: one timeline of everything the bots said to each other (`ActivityScreen.tsx`).

 Bot-to-bot traffic is invisible in any per-chat view, because it is by definition spread across two
 chats. Everything the timeline shows is DERIVED from chat states: the ones the transcript store
 holds (the conversations opened this session) and, for every other bot, the recent tail of its chat
 read off the gateway. So a row and the chat it came from are one set of items with one set of ids,
 which is what lets a tap land on the exact message rather than on a copy of it.

 `refresh()` reads the gateway (the roster, every tail, the counters); `reload()` only re-derives from
 what is held plus the store's live states, which is cheap and what a live chat's new traffic needs.
 */
@MainActor
@Observable
public final class ActivityModel {
  public enum Phase: Equatable, Sendable {
    /// Nothing derived yet.
    case loading
    case ready
  }

  /// `delegation.status` and `agents.list` cadence while the screen is visible.
  public static let counterInterval: Duration = .seconds(10)

  public private(set) var phase = Phase.loading
  /// Oldest first, as `activityEntries` answers.
  public private(set) var entries: [ActivityEntry] = []
  /// Newest day first, and newest row first inside it: a timeline is read backwards.
  public private(set) var days: [ActivityDay] = []
  public private(set) var counters = ActivityCounters()
  public private(set) var bots: [Bot] = []
  /// A pull-to-refresh is running.
  public private(set) var refreshing = false

  @ObservationIgnored private let backend: any ActivityBackend
  @ObservationIgnored private let calendar: Calendar
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var tails: [String: ChatState] = [:]
  /// Only the newest read may write.
  @ObservationIgnored private var round = 0

  public init(
    backend: any ActivityBackend,
    calendar: Calendar = .current,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.backend = backend
    self.calendar = calendar
    self.now = now
  }

  /// The name to show for a routing handle (`researcher`): the bot's display name, or the handle itself
  /// for one the roster does not know.
  public func displayName(forHandle handle: String) -> String {
    let wanted = handle.lowercased()
    let bot = bots.first { $0.name == handle } ?? bots.first { $0.name.lowercased() == wanted }

    return bot?.displayName ?? handle
  }

  /// Whether `bot` names a chat this model can open: a bot the roster knows.
  public func knows(bot name: String) -> Bool {
    bots.contains { $0.name == name }
  }

  // MARK: Reading

  /// Read the gateway: the roster, the tail of every bot whose chat is not live, and the counters.
  /// Safe to call whenever the connection returns; a read a newer one overtook is dropped.
  public func refresh() async {
    round += 1
    let mine = round
    refreshing = true
    defer { refreshing = false }

    let roster = await backend.bots()
    let live = await backend.liveStates()
    let liveNames = Set(live.filter { !$0.order.isEmpty }.map(\.botName))
    let backend = self.backend
    let fresh = await withTaskGroup(of: (String, ChatState?).self) { group in
      for bot in roster where !liveNames.contains(bot.name) {
        group.addTask { (bot.name, await backend.tail(of: bot)) }
      }

      var out: [String: ChatState] = [:]

      for await (name, state) in group {
        if let state { out[name] = state }
      }

      return out
    }

    guard round == mine else {
      return
    }

    bots = roster
    // A bot whose tail could not be read now keeps the one read before: a flaky read is no reason to
    // empty its rows.
    tails = tails.filter { name, _ in roster.contains { $0.name == name } }.merging(fresh) { _, new in new }
    await derive(live: live)
    counters = await backend.counters(for: roster)
  }

  /// Derive the timeline again from what is held and the store's live states. No gateway read.
  public func reload() async {
    await derive(live: await backend.liveStates())
  }

  /// The counters alone, for the screen's poll.
  public func refreshCounters() async {
    counters = await backend.counters(for: bots)
  }

  private func derive(live: [ChatState]) async {
    // The store's chat wins over a tail of the same bot: it has the truth on the socket already.
    let held = live.filter { !$0.order.isEmpty }
    let liveNames = Set(held.map(\.botName))
    let chats = held + tails.values.filter { !liveNames.contains($0.botName) }
    let stamp = now()

    entries = activityEntries(chats, now: stamp.timeIntervalSince1970 * 1000)
    days = Self.group(entries, calendar: calendar)
    phase = .ready
  }

  /// Newest day first, and newest row first inside it.
  public nonisolated static func group(_ entries: [ActivityEntry], calendar: Calendar) -> [ActivityDay] {
    var days: [ActivityDay] = []

    for entry in entries.reversed() {
      let start = calendar.startOfDay(for: Date(timeIntervalSince1970: entry.at))

      if let last = days.last, last.start == start {
        days[days.count - 1].entries.append(entry)
      } else {
        days.append(ActivityDay(start: start, entries: [entry]))
      }
    }

    return days
  }
}
