import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/**
 The gateway reads behind the Activity screen (`prefetchTail`, `loadActivity`, `activeSubagentCount`
 and `inFlightDeliveries` in the web client's chat controller).

 Nothing here writes to the transcript store. A bot whose chat is not live has its recent rows read
 into a state of the screen's own, so opening Activity neither hydrates chats nor moves a read mark.
 */
public struct ActivityService: ActivityBackend {
  /// The delivery runner a `message_agent` hand-off spawns (`tools/bot_mode_dm.py`): the one shape of
  /// background process `agents.list` reports that counts as a delivery in flight. Anything else in
  /// that list is somebody else's work.
  /// How many rows of each bot's chat the background load asks for.
  public static let tailLimit = 50

  public static let deliveryMarker = "bot_mode_dm.py --run-delivery"

  let link: any GatewayLink
  let store: TranscriptStore
  let roster: BotRoster

  public init(link: any GatewayLink, store: TranscriptStore, roster: BotRoster) {
    self.link = link
    self.store = store
    self.roster = roster
  }

  public func bots() async -> [Bot] {
    // A roster that cannot be read now still has the one read before (or the cached one).
    if let bots = try? await roster.refresh() {
      return bots
    }

    return await roster.bots
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

  /// The newest rows of the bot's Bot Chat: the REST transcript first, and where this gateway has none,
  /// `session.history`, which is unpaginated (the last rows are taken).
  public func tail(of bot: Bot) async -> ChatState? {
    let canonical: CanonicalSession

    do {
      canonical = try await roster.resolveCanonical(bot)
    } catch {
      // A bot whose chat cannot be resolved contributes nothing to the timeline; it must not take the
      // whole screen down.
      return nil
    }

    let limit = Self.tailLimit
    let rows: [TranscriptRow]
    let shape: RowShape

    if let page = await link.fetchMessages(canonical.resolvedID, MessageWindow(limit: limit, order: .latest)) {
      rows = page
      shape = .rest
    } else {
      guard
        let reply = try? await link.requestReply(
          RPC.SessionHistory.name,
          params: ["session_id": .string(canonical.id), "profile": .string(bot.name)])
      else {
        return nil
      }

      rows = (reply.result["messages"]?.arrayValue ?? []).suffix(limit).map {
        TranscriptRow(json: $0.objectValue ?? [:])
      }
      shape = .rpc
    }

    guard !rows.isEmpty else {
      return nil
    }

    return reconcile(
      createChatState(bot.name, canonical.id, canonical.resolvedID), rowsToItems(rows, shape))
  }

  public func counters(for bots: [Bot]) async -> ActivityCounters {
    let link = self.link
    let running = await roster.current.running
    let names = bots.map(\.name)

    async let subagents = Self.sum(over: names) { name in
      // A gateway without delegation support reports none rather than failing the whole header.
      let reply = try? await link.requestReply(RPC.DelegationStatus.name, params: ["profile": .string(name)])

      return reply?.result["active"]?.arrayValue?.count ?? 0
    }
    async let deliveries = Self.sum(over: names) { name in
      let reply = try? await link.requestReply(RPC.AgentsList.name, params: ["profile": .string(name)])

      return (reply?.result["processes"]?.arrayValue ?? []).filter {
        ($0["command"]?.stringValue ?? "").contains(Self.deliveryMarker)
      }.count
    }

    return await ActivityCounters(
      botsWorking: bots.filter { running.contains($0.name) }.count,
      activeSubagents: subagents,
      inFlightDeliveries: deliveries
    )
  }

  /// The sum of `count` over every name, asked at once.
  private static func sum(over names: [String], _ count: @escaping @Sendable (String) async -> Int) async -> Int {
    await withTaskGroup(of: Int.self) { group in
      for name in names {
        group.addTask { await count(name) }
      }

      return await group.reduce(0, +)
    }
  }
}
