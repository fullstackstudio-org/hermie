import Foundation
import HermieTranscript
import Observation

/// How far back the screens look. The gateway is asked for the longest once, and a shorter span is a
/// narrower window over the same days.
public enum UsageSpan: Int, Sendable, CaseIterable, Identifiable {
  case week = 7
  case month = 30

  public var id: Int { rawValue }

  /// The longest span, which is what is read.
  public static let longest = UsageSpan.month
}

/// Where a usage read stands.
public enum UsagePhase: Sendable, Equatable {
  case idle
  case loading
  case loaded
  case failed(UsageFailure)
}

/**
 One bot's use: tokens and cost per day, the sessions and messages behind them, how full the chat's
 context window is, and what the provider account says about its limits.

 The days are the one thing the screen cannot do without (`GET /api/analytics/usage`); everything else is
 best-effort and a failure of it costs only its own part. A read is replaced by a newer one
 (`generation`), so a slow answer never paints over a fresh one.

 Everything shown is for one gateway, as that gateway counts it: days are UTC days, costs are USD, a
 cost the gateway priced itself is an estimate (`UsageTotals.estimated`).
 */
@MainActor
@Observable
public final class BotUsageModel {
  public let bot: String

  public private(set) var phase = UsagePhase.idle
  /// The days read, oldest first.
  public private(set) var days: [DailyUsage] = []
  public var span = UsageSpan.week
  /// Sessions and messages over the longest span.
  public private(set) var insights: InsightsSummary?
  /// The chat's live session, where one is attached: its tokens and the provider's account lines.
  public private(set) var live: SessionUsage?
  /// How full the chat's context window is, as the chat last heard it.
  public private(set) var context: ContextUsage?
  /// The Nous account's balance, where the gateway has one.
  public private(set) var nous: NousUsageBars?
  /// When the days were last read.
  public private(set) var refreshedAt: Date?

  @ObservationIgnored private let backend: any UsageBackend
  @ObservationIgnored private let runtimeID: @Sendable () async -> String?
  @ObservationIgnored private let contextMeter: @MainActor @Sendable () async -> ContextUsage?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var generation = 0

  public init(
    bot: String,
    backend: any UsageBackend,
    runtimeID: @escaping @Sendable () async -> String? = { nil },
    contextMeter: @escaping @MainActor @Sendable () async -> ContextUsage? = { nil },
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.bot = bot
    self.backend = backend
    self.runtimeID = runtimeID
    self.contextMeter = contextMeter
    self.now = now
  }

  // MARK: What the screen draws

  /// The days of the chosen span, ending today.
  public var window: [String] {
    UsageDays.window(count: span.rawValue, endingAt: now())
  }

  /// The chosen span, one row per day, zeros for a day with no use.
  public var perDay: [DailyUsage] {
    UsageAggregation.filled(days, in: window)
  }

  public var totals: UsageTotals {
    UsageAggregation.totals(days, in: window)
  }

  /// Today, as the gateway counts it (UTC).
  public var today: UsageTotals {
    UsageAggregation.totals(days, in: UsageDays.window(count: 1, endingAt: now()))
  }

  // MARK: Reading

  /// Read everything again. The days decide the phase; the rest is a bonus.
  public func load() async {
    generation += 1
    let mine = generation

    if phase != .loaded {
      phase = .loading
    }

    async let read = Result { try await backend.daily(profile: bot, days: UsageSpan.longest.rawValue) }
    async let counted = Result { try await backend.insights(profile: bot, days: UsageSpan.longest.rawValue) }
    async let balance = Result { try await backend.nousBars() }
    async let session = liveUsage()
    async let meter = contextMeter()

    let (daysRead, insightsRead, balanceRead, sessionRead, meterRead) = await (read, counted, balance, session, meter)

    guard generation == mine else {
      return
    }

    switch daysRead {
    case .success(let rows):
      days = rows
      refreshedAt = now()
      phase = .loaded
    case .failure(let error):
      // A failed read keeps what an earlier one found: a number that is a minute old beats none.
      phase = days.isEmpty ? .failed(UsageFailure.classify(error)) : .loaded
    }

    if case .success(let value) = insightsRead {
      insights = value
    }

    if case .success(let value) = balanceRead {
      nous = value
    }

    live = sessionRead
    context = meterRead ?? sessionRead?.context
  }

  private func liveUsage() async -> SessionUsage? {
    guard let id = await runtimeID(), !id.isEmpty else {
      return nil
    }

    return try? await backend.session(runtimeID: id, profile: bot)
  }
}

/**
 Every bot's use on the live gateway, side by side: the days of each (one read per bot, a few at a
 time), the whole gateway per day, each bot's share, and the Nous balance.

 One bot's failure is that bot's missing row (`failed` names them), not a failed overview; the overview
 fails only when not one bot could be read.
 */
@MainActor
@Observable
public final class UsageOverviewModel {
  public typealias Contexts = @MainActor @Sendable () async -> [String: ContextUsage]

  public private(set) var phase = UsagePhase.idle
  public private(set) var bots: [BotUsage] = []
  /// The bots whose days could not be read.
  public private(set) var failed: [String] = []
  public var span = UsageSpan.week
  /// How full each loaded chat's context window is.
  public private(set) var contexts: [String: ContextUsage] = [:]
  public private(set) var nous: NousUsageBars?
  public private(set) var refreshedAt: Date?

  @ObservationIgnored private let backend: any UsageBackend
  @ObservationIgnored private let botNames: @MainActor @Sendable () -> [String]
  @ObservationIgnored private let loadContexts: Contexts
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let concurrency: Int
  @ObservationIgnored private var generation = 0

  public init(
    backend: any UsageBackend,
    bots: @escaping @MainActor @Sendable () -> [String],
    contexts: @escaping Contexts = { [:] },
    concurrency: Int = 4,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.backend = backend
    self.botNames = bots
    self.loadContexts = contexts
    self.concurrency = max(1, concurrency)
    self.now = now
  }

  // MARK: What the screen draws

  public var window: [String] {
    UsageDays.window(count: span.rawValue, endingAt: now())
  }

  /// The whole gateway, one row per day of the span.
  public var perDay: [DayUsage] {
    UsageAggregation.perDay(bots, in: window)
  }

  /// Each bot's share of the span, the heaviest first.
  public var perBot: [BotUsageTotal] {
    UsageAggregation.perBot(bots, in: window)
  }

  public var totals: UsageTotals {
    UsageAggregation.total(bots, in: window)
  }

  public var today: UsageTotals {
    UsageAggregation.total(bots, in: UsageDays.window(count: 1, endingAt: now()))
  }

  // MARK: Reading

  public func load() async {
    generation += 1
    let mine = generation
    let names = botNames()
    let backend = self.backend
    let span = UsageSpan.longest.rawValue

    if phase != .loaded {
      phase = .loading
    }

    async let balance = Result { try await backend.nousBars() }
    async let meters = loadContexts()

    let outcomes = await Self.readAll(names, backend: backend, days: span, width: min(concurrency, max(1, names.count)))
    let (balanceRead, metersRead) = await (balance, meters)

    guard generation == mine else {
      return
    }

    var read: [BotUsage] = []
    var missed: [String] = []
    var firstError: (any Error)?

    for name in names {
      switch outcomes[name] {
      case .success(let days)?:
        read.append(BotUsage(bot: name, days: days))
      case .failure(let error)?:
        missed.append(name)
        firstError = firstError ?? error
      case nil:
        missed.append(name)
      }
    }

    failed = missed

    if read.isEmpty, let firstError, bots.isEmpty {
      phase = .failed(UsageFailure.classify(firstError))
    } else {
      // A bot that failed this time keeps what an earlier read found, rather than dropping out.
      let kept = bots.filter { old in missed.contains(old.bot) }

      bots = read + kept
      refreshedAt = now()
      phase = .loaded
    }

    if case .success(let value) = balanceRead {
      nous = value
    }

    contexts = metersRead
  }

  /// Every bot's days, at most `width` reads at a time; one failure is that bot's.
  nonisolated static func readAll(
    _ names: [String], backend: any UsageBackend, days: Int, width: Int
  ) async -> [String: Result<[DailyUsage], any Error>] {
    guard !names.isEmpty else {
      return [:]
    }

    return await withTaskGroup(of: (String, Result<[DailyUsage], any Error>).self) { group in
      var next = 0

      func addNext() {
        guard next < names.count else { return }

        let name = names[next]
        next += 1
        group.addTask { (name, await Result { try await backend.daily(profile: name, days: days) }) }
      }

      for _ in 0..<width {
        addNext()
      }

      var results: [String: Result<[DailyUsage], any Error>] = [:]

      while let (name, result) = await group.next() {
        results[name] = result
        addNext()
      }

      return results
    }
  }
}

extension Result where Failure == any Error {
  /// A throwing call as a value, so concurrent reads can be gathered without one failure cancelling the rest.
  init(_ body: () async throws -> Success) async {
    do {
      self = .success(try await body())
    } catch {
      self = .failure(error)
    }
  }
}
