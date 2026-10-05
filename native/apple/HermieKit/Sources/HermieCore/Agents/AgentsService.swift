import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// What the agents overview asks of the gateway, as one seam: a test hands in a stub, production an
/// `AgentsService` over a session's link, store, roster and cron backend. Nothing here writes to the
/// transcript store or moves a read mark: it only looks.
public protocol AgentsBackend: Sendable {
  /// The roster as it is held (no gateway read).
  func heldBots() async -> [Bot]
  /// The roster, read again; the held one where it cannot be.
  func bots() async -> [Bot]
  /// The busy sessions of the gateway; nil where `session.active_list` cannot be read.
  func activeSessions() async -> [BotRoster.ActiveSession]?
  /// The chats the app holds, as they are now.
  func liveStates() async -> [ChatState]
  /// The subagents each of these bots has running; a bot whose gateway cannot say has none.
  func subagents(of bots: [Bot]) async -> [String: [AgentSubagent]]
  /// The gateway's cron jobs; nil where they cannot be read (a gateway with no REST side, a refusal).
  func cronJobs() async -> [CronJob]?
  /// One value per `cron.changed` broadcast; the stream ends with the connection.
  func cronChanges() -> AsyncStream<Void>
}

/**
 The gateway reads behind the agents overview. Each one is a call the app already makes somewhere else:
 `session.active_list` (the roster's running dot and the emergency stop), `delegation.status` (the
 Activity counters) and the cron list (the Crons screen). The overview adds no wire method.
 */
public struct AgentsService: AgentsBackend {
  let link: any GatewayLink
  let store: TranscriptStore
  let roster: BotRoster
  let cron: (any CronBackend)?

  public init(link: any GatewayLink, store: TranscriptStore, roster: BotRoster, cron: (any CronBackend)? = nil) {
    self.link = link
    self.store = store
    self.roster = roster
    self.cron = cron
  }

  public func heldBots() async -> [Bot] {
    await roster.bots
  }

  public func bots() async -> [Bot] {
    // A roster that cannot be read now still has the one read before (or the cached one).
    if let bots = try? await roster.refresh() {
      return bots
    }

    return await roster.bots
  }

  public func activeSessions() async -> [BotRoster.ActiveSession]? {
    await roster.activeSessions()
  }

  public func liveStates() async -> [ChatState] {
    var states: [ChatState] = []

    for key in await store.chatKeys {
      if let state = await store.state(of: key) {
        states.append(state)
      }
    }

    return states
  }

  public func subagents(of bots: [Bot]) async -> [String: [AgentSubagent]] {
    let link = self.link

    return await withTaskGroup(of: (String, [AgentSubagent]).self) { group in
      for bot in bots {
        group.addTask {
          // A gateway without delegation support reports none rather than failing the whole screen.
          let reply = try? await link.requestReply(RPC.DelegationStatus.name, params: ["profile": .string(bot.name)])

          return (bot.name, Self.subagents(in: reply?.result))
        }
      }

      var out: [String: [AgentSubagent]] = [:]

      for await (name, list) in group where !list.isEmpty {
        out[name] = list
      }

      return out
    }
  }

  /// The children `delegation.status` lists as active. A row without an id is not one the screen can
  /// tell apart from another, so it is left out; a queued child counts as running work.
  static func subagents(in result: JSONValue?) -> [AgentSubagent] {
    var seen = Set<String>()

    return (result?["active"]?.arrayValue ?? []).compactMap { row -> AgentSubagent? in
      guard let id = row["subagent_id"]?.stringValue, !id.isEmpty, seen.insert(id).inserted else {
        return nil
      }

      return AgentSubagent(
        id: id,
        goal: row["goal"]?.stringValue ?? "",
        status: row["status"]?.stringValue ?? "running",
        toolCount: row["tool_count"]?.intValue ?? 0,
        model: row["model"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
        startedAt: row["started_at"]?.doubleValue.map(Date.init(timeIntervalSince1970:)))
    }
  }

  public func cronJobs() async -> [CronJob]? {
    guard let cron else {
      return nil
    }

    return try? await cron.list().jobs
  }

  public func cronChanges() -> AsyncStream<Void> {
    cron?.changes() ?? AsyncStream { $0.finish() }
  }
}
