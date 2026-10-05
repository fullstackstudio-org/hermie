import Foundation
import Observation

/// One calendar day of the log, newest decision first.
public struct DecisionDay: Sendable, Equatable, Identifiable {
  /// The start of the day, in the calendar the model was given.
  public var day: Date
  public var entries: [DecisionEntry]

  public var id: Date { day }
}

/**
 The decision log as a screen reads it: every entry (or one bot's), narrowed by bot, kind and a search, grouped by
 day, and exportable as it is narrowed.

 Reads from `DecisionLog` when `load()` is called; the screen calls it again when `log.revision` moves.
 Filtering and grouping are plain functions of what was read, so they cost nothing to redo.
 */
@MainActor
@Observable
public final class DecisionLogModel {
  /// What the model shows of the log: everything, or one bot of one gateway (a bot's settings page).
  public struct Scope: Sendable, Equatable {
    public var gatewayID: String?
    public var bot: String?

    public init(gatewayID: String? = nil, bot: String? = nil) {
      self.gatewayID = gatewayID
      self.bot = bot
    }

    public static let everything = Scope()
  }

  public let log: DecisionLog
  public let scope: Scope

  /// What is in the scope, newest first.
  public private(set) var entries: [DecisionEntry] = []
  /// Whether the log was read at least once.
  public private(set) var loaded = false

  /// Only this bot's decisions; nil: every bot. Not used when the scope already names one.
  public var botFilter: String?
  /// Only this kind; nil: every kind.
  public var kindFilter: DecisionKind?
  /// Words that must all appear in an entry's bot, gateway, chat, summary or kind, in any order; blank: no search.
  public var query = ""

  /// More text an entry can be found by (the screen adds the words it shows for the kind and the outcome, in the
  /// reader's language).
  @ObservationIgnored public var searchText: (@MainActor (DecisionEntry) -> String)?

  @ObservationIgnored private let calendar: Calendar

  public init(log: DecisionLog, scope: Scope = .everything, calendar: Calendar = .current) {
    self.log = log
    self.scope = scope
    self.calendar = calendar
  }

  /// Read the log.
  public func load() async {
    entries = await log.entries(gatewayID: scope.gatewayID, bot: scope.bot)
    loaded = true

    // A bot that left the log is no longer a filter either.
    if let botFilter, !bots.contains(botFilter) {
      self.botFilter = nil
    }
  }

  /// The bots that have a decision in the scope, by name.
  public var bots: [String] {
    Array(Set(entries.map(\.bot).filter { !$0.isEmpty })).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
  }

  /// The kinds that have a decision in the scope, in the order the kinds are declared.
  public var kinds: [DecisionKind] {
    let present = Set(entries.map(\.kind))

    return DecisionKind.allCases.filter(present.contains)
  }

  /// Whether a filter or a search narrows the list.
  public var isNarrowed: Bool {
    botFilter != nil || kindFilter != nil || !terms.isEmpty
  }

  /// The entries the filters and the search leave, newest first.
  public var filtered: [DecisionEntry] {
    let terms = self.terms

    return entries.filter { entry in
      if scope.bot == nil, let botFilter, entry.bot != botFilter {
        return false
      }

      if let kindFilter, entry.kind != kindFilter {
        return false
      }

      guard !terms.isEmpty else {
        return true
      }

      let haystack = haystack(entry)

      return terms.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
  }

  /// `filtered`, grouped by calendar day, the latest day first.
  public var days: [DecisionDay] {
    Self.group(filtered, calendar: calendar)
  }

  static func group(_ entries: [DecisionEntry], calendar: Calendar) -> [DecisionDay] {
    var order: [Date] = []
    var byDay: [Date: [DecisionEntry]] = [:]

    for entry in entries {
      let day = calendar.startOfDay(for: entry.at)

      if byDay[day] == nil {
        order.append(day)
      }

      byDay[day, default: []].append(entry)
    }

    return order.sorted(by: >).map { DecisionDay(day: $0, entries: byDay[$0] ?? []) }
  }

  /// What the person sees narrowed, as a file.
  public func export(as format: DecisionExportFormat, now: Date = Date()) -> Data {
    DecisionExport.data(filtered, as: format, exportedAt: now)
  }

  public func fileName(_ format: DecisionExportFormat, now: Date = Date()) -> String {
    DecisionExport.fileName(format, now: now)
  }

  // MARK: Searching

  private var terms: [String] {
    query.split(whereSeparator: \.isWhitespace).map(String.init)
  }

  private func haystack(_ entry: DecisionEntry) -> String {
    [
      entry.bot, entry.gateway, entry.session, entry.summary ?? "", entry.kind.rawValue, entry.outcome.rawValue,
      entry.method.rawValue, searchText?(entry) ?? ""
    ].joined(separator: "\n")
  }
}
