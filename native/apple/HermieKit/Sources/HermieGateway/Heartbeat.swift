/// The `gateway.ping` keepalive of the vendored `JsonRpcRequestChannel`, as
/// pure state. A silent drop (sleep, a proxy's idle timeout, a VPN reconnect)
/// kills the TCP socket without a close event, so the client pings and drops a
/// socket that has shown no sign of life for a full deadline.
///
/// The connection runs it only when `gateway.ready` advertised `heartbeat:
/// true` (an older backend would answer `-32601` and never count as alive),
/// and counts any inbound frame as liveness, the desktop and web contract
/// (`heartbeatLiveness: 'any-inbound'`).
struct HeartbeatState {
  /// `DEFAULT_HEARTBEAT_INTERVAL_MS`.
  static let defaultInterval: Duration = .seconds(15)
  /// `DEFAULT_HEARTBEAT_DEADLINE_MS`.
  static let defaultDeadline: Duration = .seconds(45)
  /// `MAX_OUTSTANDING_PINGS`: a backend that streams but never answers keeps
  /// the socket alive in any-inbound mode; the set of unanswered ids is capped.
  static let maxOutstandingPings = 8
  /// What the connection drops the socket with when the deadline passes.
  static let failureMessage = "WebSocket heartbeat acknowledgement timed out"

  /// When the socket last showed it was alive.
  var lastLivenessAt: Duration = .zero
  private var sequence = 0
  /// Unanswered ping ids, oldest first.
  private(set) var outstanding: [String] = []

  enum Tick: Equatable {
    /// The deadline passed without a sign of life: drop the socket.
    case dead
    /// Send this ping.
    case ping(id: String)
  }

  /// One interval elapsed at `now`.
  mutating func tick(now: Duration, deadline: Duration) -> Tick {
    if now - lastLivenessAt >= deadline {
      return .dead
    }

    sequence += 1
    let id = "heartbeat-\(sequence)"
    outstanding.append(id)

    if outstanding.count > Self.maxOutstandingPings {
      outstanding.removeFirst()
    }

    return .ping(id: id)
  }

  /// A response with this id arrived. True when it answered one of our pings.
  mutating func acknowledge(_ id: String) -> Bool {
    guard let index = outstanding.firstIndex(of: id) else {
      return false
    }

    outstanding.remove(at: index)
    return true
  }

  /// `stopHeartbeat`: forget every unanswered ping.
  mutating func stop() {
    outstanding.removeAll()
  }
}
