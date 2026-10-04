import Foundation
import HermieTranscript

/// One child of a delegation as the agents bar and its sheet list it: the engine's `Subagent` and how
/// deep it hangs in the tree (0 for a child the turn itself spawned).
public struct SubagentRow: Sendable, Equatable, Identifiable {
  public var subagent: Subagent
  public var depth: Int

  public var id: String { subagent.id }

  public init(subagent: Subagent, depth: Int = 0) {
    self.subagent = subagent
    self.depth = depth
  }

  /// Queued or running: the child can still be steered, stopped and tailed.
  public var isLive: Bool { subagent.status == .running || subagent.status == .queued }

  /// The child can be handed a correction: it is live, and the gateway did not say it stopped taking
  /// them (`accepting_steer`).
  public var canSteer: Bool { isLive && subagent.acceptingSteer != false }

  /// The child has a stored session of its own to read after it is gone.
  public var childSession: String? {
    guard let id = subagent.childSessionID, !id.isEmpty else {
      return nil
    }

    return id
  }

  /// The tree of `state`, parents before their children, in the engine's order (`subagentTree`).
  /// Empty without a child, which is nearly every frame, so the tree is not built for nothing.
  public static func rows(of state: ChatState) -> [SubagentRow] {
    guard !state.subagents.isEmpty else {
      return []
    }

    var rows: [SubagentRow] = []
    // Pre-order without recursion: a stack of what is left to visit, the first root on top.
    var pending: [(node: SubagentNode, depth: Int)] = subagentTree(state).reversed().map { ($0, 0) }

    while let (node, depth) = pending.popLast() {
      rows.append(SubagentRow(subagent: node.subagent, depth: depth))
      pending.append(contentsOf: node.children.reversed().map { ($0, depth + 1) })
    }

    return rows
  }
}

/// What the bar over the composer says: how many children are queued or running, and since when.
public struct SubagentBar: Sendable, Equatable {
  /// Children queued or running. Zero hides the bar.
  public var running: Int
  /// When the oldest live child started, in epoch MILLISECONDS (the engine's unit for `startedAt`).
  public var startedAtMs: Double?

  public init(running: Int, startedAtMs: Double? = nil) {
    self.running = running
    self.startedAtMs = startedAtMs
  }

  public init(_ rows: [SubagentRow]) {
    let live = rows.filter(\.isLive)

    self.init(running: live.count, startedAtMs: live.map(\.subagent.startedAt).filter { $0 > 0 }.min())
  }

  public var isShown: Bool { running > 0 }

  /// Seconds since the oldest live child started, never negative; nil when nothing says when.
  public func elapsed(atMs nowMs: Double) -> Double? {
    startedAtMs.map { max(0, (nowMs - $0) / 1000) }
  }

  /// `formatElapsedClock`: `0:42`, `12:05`, `1:02:03`. A time that is not a time reads `0:00`.
  public static func clock(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite, seconds >= 0 else {
      return "0:00"
    }

    let whole = Int(seconds.rounded(.down))
    let minutes = whole / 60
    let rest = String(format: "%02d", whole % 60)

    if minutes < 60 {
      return "\(minutes):\(rest)"
    }

    return "\(minutes / 60):" + String(format: "%02d", minutes % 60) + ":\(rest)"
  }
}
