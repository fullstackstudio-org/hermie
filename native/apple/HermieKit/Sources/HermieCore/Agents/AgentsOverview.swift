import Foundation

import HermieTranscript

// The agents overview (NX-9): what each bot is doing now, as one value
// ======================================================================
//
// Everything on the screen is derived from five things the app can already read, and this file is the
// pure function that puts them together, so it is tested without a screen or a socket:
//
//  - the roster (`profiles.list`): who the bots are;
//  - one `session.active_list`: which sessions are busy, and `waiting` for the one a bot has parked on a
//    question or an approval (`BotRoster.activeSessions`);
//  - the chats the app holds: the tool a live turn is running right now. The gateway does not expose the
//    current tool, so a bot whose chat is not open shows its newest line (`preview`) instead;
//  - `delegation.status` per bot: the subagents it has running;
//  - the cron list: each job's next run;
//  - the "Needs you" inbox: how many things wait on the person, per bot.
//
// When the gateway's list cannot be read, the overview does not say "idle" for everyone: it falls back
// to what the open chats say, and `isComplete` is false so the screen can say it is guessing.

/// What a bot is doing, in the three words the screen uses.
public enum AgentState: Int, Sendable, Equatable, Comparable {
  /// Waiting for the person: a question, an approval, a form, a connector to authorise.
  case waiting = 0
  /// A turn is running.
  case running = 1
  case idle = 2

  public static func < (lhs: AgentState, rhs: AgentState) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The tool a live turn is running.
public struct AgentTool: Sendable, Equatable {
  public var name: String
  /// The gateway's short preview of the call (`~80` characters), when it sent one.
  public var context: String?

  public init(name: String, context: String? = nil) {
    self.name = name
    self.context = context
  }
}

/// One subagent a bot has running (`delegation.status`).
public struct AgentSubagent: Sendable, Equatable, Identifiable {
  public var id: String
  public var goal: String
  /// `running` or `queued`, as the gateway says.
  public var status: String
  public var toolCount: Int
  public var model: String?
  public var startedAt: Date?

  public init(
    id: String, goal: String = "", status: String = "running", toolCount: Int = 0, model: String? = nil,
    startedAt: Date? = nil
  ) {
    self.id = id
    self.goal = goal
    self.status = status
    self.toolCount = toolCount
    self.model = model
    self.startedAt = startedAt
  }
}

/// A scheduled job that is going to run.
public struct AgentCron: Sendable, Equatable, Identifiable {
  public var id: String
  public var name: String
  /// The schedule as the gateway words it (`every 30m`, `0 9 * * 1-5`).
  public var schedule: String
  public var nextRunAt: Date
  /// The bot the job belongs to (a cron lives in one profile's store); nil when the gateway did not say.
  public var bot: String?

  public init(id: String, name: String, schedule: String = "", nextRunAt: Date, bot: String? = nil) {
    self.id = id
    self.name = name
    self.schedule = schedule
    self.nextRunAt = nextRunAt
    self.bot = bot
  }
}

/// One bot's line.
public struct AgentRow: Sendable, Equatable, Identifiable {
  public var id: String { bot.name }
  public var bot: Bot
  public var state: AgentState
  /// Things in the inbox that wait on the person for this bot.
  public var waitingCount: Int
  /// What the live turn is doing, when the app holds the chat and a tool is running.
  public var tool: AgentTool?
  /// The title of the session that is running, when the gateway lists one.
  public var sessionTitle: String?
  /// The newest line of the running session, from the gateway's list, for a bot whose chat is not open.
  public var preview: String?
  public var startedAt: Date?
  public var subagents: [AgentSubagent]
  /// The next time one of its cron jobs runs.
  public var nextCron: AgentCron?

  public init(
    bot: Bot, state: AgentState = .idle, waitingCount: Int = 0, tool: AgentTool? = nil, sessionTitle: String? = nil,
    preview: String? = nil, startedAt: Date? = nil, subagents: [AgentSubagent] = [], nextCron: AgentCron? = nil
  ) {
    self.bot = bot
    self.state = state
    self.waitingCount = waitingCount
    self.tool = tool
    self.sessionTitle = sessionTitle
    self.preview = preview
    self.startedAt = startedAt
    self.subagents = subagents
    self.nextCron = nextCron
  }
}

/// Everything the overview shows.
public struct AgentsOverview: Sendable, Equatable {
  /// Waiting first, then running, then idle; the roster's order inside each.
  public var rows: [AgentRow]
  /// Every bot's subagents, newest first, with the bot that owns each.
  public var subagents: [(bot: Bot, subagent: AgentSubagent)] {
    rows.flatMap { row in row.subagents.map { (row.bot, $0) } }
  }
  /// The jobs that run next, soonest first, across every bot.
  public var upcoming: [AgentCron]
  /// Sessions that run on the gateway and belong to no bot this app knows: a cron's run, a branch,
  /// another client's.
  public var otherRunning: Int
  /// `session.active_list` could be read. False: `rows` follow the open chats alone.
  public var isComplete: Bool
  /// The cron list could be read.
  public var cronsKnown: Bool

  public static let empty = AgentsOverview(rows: [], upcoming: [], otherRunning: 0, isComplete: true, cronsKnown: false)

  public init(rows: [AgentRow], upcoming: [AgentCron], otherRunning: Int, isComplete: Bool, cronsKnown: Bool) {
    self.rows = rows
    self.upcoming = upcoming
    self.otherRunning = otherRunning
    self.isComplete = isComplete
    self.cronsKnown = cronsKnown
  }

  public var running: Int { rows.filter { $0.state == .running }.count }
  public var waiting: Int { rows.filter { $0.state == .waiting }.count }
  public var idle: Int { rows.filter { $0.state == .idle }.count }
  public var subagentCount: Int { rows.reduce(0) { $0 + $1.subagents.count } }

  public func row(for bot: String) -> AgentRow? {
    rows.first { $0.bot.name == bot }
  }
}

/// What the overview is made from.
public struct AgentsInput: Sendable {
  public var bots: [Bot]
  /// The busy sessions of the gateway; nil when `session.active_list` could not be read.
  public var active: [BotRoster.ActiveSession]?
  /// The chats the app holds.
  public var live: [ChatState]
  /// Each bot's subagents, by bot name.
  public var subagents: [String: [AgentSubagent]]
  /// The gateway's cron jobs; nil when they could not be read.
  public var jobs: [CronJob]?
  /// Things waiting on the person, by bot name.
  public var waiting: [String: Int]
  public var now: Date

  public init(
    bots: [Bot], active: [BotRoster.ActiveSession]?, live: [ChatState] = [], subagents: [String: [AgentSubagent]] = [:],
    jobs: [CronJob]? = nil, waiting: [String: Int] = [:], now: Date
  ) {
    self.bots = bots
    self.active = active
    self.live = live
    self.subagents = subagents
    self.jobs = jobs
    self.waiting = waiting
    self.now = now
  }
}

extension AgentsOverview {
  /// How many jobs the list of what runs next holds.
  public static let upcomingLimit = 8
  /// A newest line is cut to this many characters.
  public static let previewLimit = 140

  /// Put what was read together. Pure: the same input is the same overview.
  public static func make(_ input: AgentsInput) -> AgentsOverview {
    let names = Set(input.bots.map(\.name))
    let live = Dictionary(input.live.map { ($0.botName, $0) }, uniquingKeysWith: { first, _ in first })
    let active = input.active
    let jobs = upcoming(input.jobs ?? [], now: input.now, names: names)

    var nextCron: [String: AgentCron] = [:]

    for job in jobs {
      if let bot = job.bot, nextCron[bot] == nil {
        nextCron[bot] = job
      }
    }

    var rows: [AgentRow] = []

    for bot in input.bots {
      let session = active?.first { $0.bot == bot.name }
      let chat = live[bot.name]
      // The gateway's list is the truth where it could be read: a chat that thinks its turn is busy while
      // the list says otherwise has finished. Where it could not be, the open chats are all there is.
      let isRunning = active == nil ? (chat.map(isBusy) ?? false) : session != nil
      let waitingCount = input.waiting[bot.name] ?? 0
      let isWaiting = waitingCount > 0 || session?.status == "waiting" || (chat.map(hasOpenRequest) ?? false)

      rows.append(
        AgentRow(
          bot: bot,
          state: isWaiting ? .waiting : isRunning ? .running : .idle,
          waitingCount: waitingCount,
          tool: isRunning || isWaiting ? chat.flatMap(runningTool) : nil,
          sessionTitle: session.flatMap { clean($0.title) },
          preview: session.flatMap { clean($0.preview, limit: previewLimit) },
          startedAt: session?.startedAt.map(Date.init(timeIntervalSince1970:)),
          subagents: (input.subagents[bot.name] ?? []).sorted { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) },
          nextCron: nextCron[bot.name]
        ))
    }

    // Stable: waiting, then running, then idle; the roster's order inside each.
    let ordered = rows.enumerated().sorted {
      ($0.element.state, $0.offset) < ($1.element.state, $1.offset)
    }.map(\.element)

    return AgentsOverview(
      rows: ordered,
      upcoming: Array(jobs.prefix(upcomingLimit)),
      otherRunning: active?.filter { $0.bot == nil }.count ?? 0,
      isComplete: active != nil,
      cronsKnown: input.jobs != nil
    )
  }

  /// The jobs that are going to run: enabled, with a next run, soonest first; ties by name.
  static func upcoming(_ jobs: [CronJob], now: Date, names: Set<String>) -> [AgentCron] {
    jobs.compactMap { job -> AgentCron? in
      guard job.enabled, job.status != .paused, let next = job.nextRunAt else {
        return nil
      }

      let bot = job.profile.flatMap { names.contains($0) ? $0 : nil }
      let name = job.name.trimmingCharacters(in: .whitespacesAndNewlines)

      return AgentCron(
        id: job.profile.map { "\($0)/\(job.id)" } ?? job.id, name: name.isEmpty ? job.id : name,
        schedule: job.schedule, nextRunAt: next, bot: bot)
    }
    .sorted { ($0.nextRunAt, $0.name, $0.id) < ($1.nextRunAt, $1.name, $1.id) }
  }

  /// The tool a chat's live turn is running: the newest one still running or being written.
  static func runningTool(_ chat: ChatState) -> AgentTool? {
    for id in chat.order.reversed() {
      guard case .tool(let tool)? = chat.items[id], tool.status == .running || tool.status == .generating else {
        continue
      }

      let context = tool.context.flatMap { clean($0, limit: previewLimit) }

      return AgentTool(name: tool.name, context: context)
    }

    return nil
  }

  /// A line of the gateway's or a bot's words, trimmed, on one line, cut; nil when nothing is left.
  static func clean(_ text: String, limit: Int = 200) -> String? {
    let line = text.split(whereSeparator: \.isNewline).joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard !line.isEmpty else {
      return nil
    }

    return line.count > limit ? String(line.prefix(limit)) + "…" : line
  }

  /// The inbox's waiting items, counted per bot, for one gateway.
  public static func waitingCounts(in items: [NeedsYouItem], gatewayId: String) -> [String: Int] {
    items.filter { $0.gatewayId == gatewayId }.reduce(into: [:]) { counts, item in counts[item.bot, default: 0] += 1 }
  }
}
