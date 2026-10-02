import HermieProtocol

/// The lossless-reconnect bookkeeping of the vendored `JsonRpcGatewayClient`:
/// the last event `seq` seen per session, the server's replay epoch, and the
/// frames parked while a replay is in flight.
///
/// Pure state, owned by the connection actor. The connection decides when to
/// fetch a replay and when a socket generation dies; this type only answers
/// "is this event new" and "which frames were parked".
struct ReplayState {
  /// `REPLAY_REQUEST_TIMEOUT_MS`: bounded so a wedged backend cannot hold the
  /// guard open; generous enough for a 512-frame ring to drain.
  static let requestTimeout: Duration = .seconds(10)

  /// Last observed seq per session id, in first-seen order (a JavaScript
  /// `Map` iterates in insertion order, and the replay requests go out in it).
  private(set) var watermarks = OrderedMap<String, Double>()
  /// Set while a post-reconnect replay fetch is in flight.
  var inFlight = false
  /// Invalidates an interrupted replay so its cleanup cannot own a replacement socket.
  var generation = 0
  /// While a replay is in flight, live seq'd frames for the sessions being
  /// replayed are parked here instead of dispatching.
  var hold: OrderedMap<String, [GatewayEvent]>?
  /// The server process identity (from `gateway.ready` / `session.events.since`).
  var epoch: String?

  /// The session id and seq the replay contract reads: a non-empty session id
  /// and a finite number. Anything else (a session-less broadcast, a legacy
  /// backend) has no ordering to keep.
  static func position(of event: GatewayEvent) -> (session: String, seq: Double)? {
    guard let session = event.sessionID, !session.isEmpty,
      let seq = event.json["seq"]?.doubleValue, seq.isFinite
    else {
      return nil
    }

    return (session, seq)
  }

  /// `handleEvent`'s hold check: park a live frame for a session being replayed.
  /// Returns true when the frame was parked.
  mutating func park(_ event: GatewayEvent) -> Bool {
    guard hold != nil, let session = event.sessionID, !session.isEmpty,
      event.json["seq"]?.doubleValue != nil, hold?[session] != nil
    else {
      return false
    }

    hold?[session]?.append(event)
    return true
  }

  /// `recordSeq`: advance the session's watermark, never regress it.
  mutating func record(_ event: GatewayEvent) {
    guard let (session, seq) = Self.position(of: event) else {
      return
    }

    if seq > (watermarks[session] ?? 0) {
      watermarks[session] = seq
    }
  }

  /// `dispatchIfNewer`'s gate: true when the event should be dispatched (and
  /// its watermark has been advanced). Seq-less events always dispatch.
  mutating func admit(_ event: GatewayEvent) -> Bool {
    guard let (session, seq) = Self.position(of: event) else {
      return true
    }

    if seq <= (watermarks[session] ?? 0) {
      return false
    }

    watermarks[session] = seq
    return true
  }

  /// `adoptReplayEpoch`: on a change of epoch (the backend restarted) the old
  /// watermarks describe a numbering that no longer exists.
  mutating func adopt(epoch newEpoch: String) {
    guard epoch != newEpoch else {
      return
    }

    if epoch != nil {
      watermarks.removeAll()
    }

    epoch = newEpoch
  }

  /// The start of `fetchReplay`: nothing to do unless something was observed
  /// and no replay is running. Returns the generation and the watermarks to ask
  /// about, with a hold installed for each of their sessions.
  mutating func begin() -> (generation: Int, entries: [(session: String, lastSeen: Double)])? {
    guard !inFlight, !watermarks.isEmpty else {
      return nil
    }

    inFlight = true
    generation += 1

    var parked = OrderedMap<String, [GatewayEvent]>()

    for session in watermarks.keys {
      parked[session] = []
    }

    hold = parked
    return (generation, watermarks.elements)
  }

  /// `dropSocket`'s part: the replay belonged to the socket that started it.
  mutating func abandon() {
    generation += 1
    inFlight = false
    hold = nil
  }

  /// Take the parked frames (and clear the hold), in the order they were parked.
  mutating func releaseHold() -> [GatewayEvent] {
    let parked = hold
    hold = nil
    return parked?.values.flatMap { $0 } ?? []
  }
}

/// A minimal insertion-ordered map with JavaScript `Map` semantics: setting an
/// existing key keeps its position.
struct OrderedMap<Key: Hashable, Value> {
  private(set) var keys: [Key] = []
  private var storage: [Key: Value] = [:]

  var isEmpty: Bool { keys.isEmpty }

  var values: [Value] { keys.compactMap { storage[$0] } }

  var elements: [(Key, Value)] { keys.compactMap { key in storage[key].map { (key, $0) } } }

  subscript(key: Key) -> Value? {
    get { storage[key] }
    set {
      if let newValue {
        if storage.updateValue(newValue, forKey: key) == nil {
          keys.append(key)
        }
      } else if storage.removeValue(forKey: key) != nil {
        keys.removeAll { $0 == key }
      }
    }
  }

  mutating func removeAll() {
    keys.removeAll()
    storage.removeAll()
  }
}
