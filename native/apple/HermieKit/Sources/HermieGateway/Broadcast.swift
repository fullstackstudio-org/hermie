import Synchronization

/// A fan-out of values to any number of `AsyncStream` subscribers.
///
/// The connection publishes from its actor; subscribers attach and detach from
/// anywhere, which is why the subscriber table sits behind a mutex rather than
/// on the actor: a subscription has to exist the moment `subscribe()` returns,
/// and a consumer that stops iterating has to be dropped without hopping onto
/// the actor.
///
/// With `replaysLatest`, a new subscriber first receives the most recent value,
/// the way the reference's `onStatus` calls a new handler once with the current
/// status.
final class Broadcast<Element: Sendable>: Sendable {
  private struct State {
    var nextID: UInt64 = 0
    var subscribers: [UInt64: AsyncStream<Element>.Continuation] = [:]
    var latest: Element?
    var finished = false
  }

  private let state: Mutex<State>
  private let replaysLatest: Bool

  init(latest: Element? = nil, replaysLatest: Bool = false) {
    state = Mutex(State(latest: latest))
    self.replaysLatest = replaysLatest
  }

  /// A new, unbounded stream of everything published from now on.
  func subscribe() -> AsyncStream<Element> {
    let (stream, continuation) = AsyncStream<Element>.makeStream(bufferingPolicy: .unbounded)
    let id = state.withLock { state -> UInt64? in
      guard !state.finished else {
        return nil
      }

      defer { state.nextID += 1 }
      return state.nextID
    }

    guard let id else {
      continuation.finish()
      return stream
    }

    continuation.onTermination = { [weak self] _ in
      self?.remove(id)
    }

    state.withLock { state in
      state.subscribers[id] = continuation

      if replaysLatest, let latest = state.latest {
        continuation.yield(latest)
      }
    }

    return stream
  }

  /// Hand `value` to every subscriber (and keep it as the latest).
  func publish(_ value: Element) {
    let subscribers = state.withLock { state in
      if replaysLatest {
        state.latest = value
      }

      return state.subscribers
    }

    for (id, continuation) in subscribers {
      if case .terminated = continuation.yield(value) {
        remove(id)
      }
    }
  }

  /// The most recent value published (or the initial one).
  var latest: Element? {
    state.withLock { $0.latest }
  }

  var hasSubscribers: Bool {
    state.withLock { !$0.subscribers.isEmpty }
  }

  /// End every stream; later subscribers get a stream that is already finished.
  func finish() {
    let subscribers = state.withLock { state in
      state.finished = true
      defer { state.subscribers = [:] }
      return state.subscribers
    }

    // Outside the lock: `finish()` runs `onTermination`, which takes it again.
    for continuation in subscribers.values {
      continuation.finish()
    }
  }

  private func remove(_ id: UInt64) {
    _ = state.withLock { $0.subscribers.removeValue(forKey: id) }
  }
}
