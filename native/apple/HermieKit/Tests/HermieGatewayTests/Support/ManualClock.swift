import Synchronization

/// A clock that only moves when a test moves it, so a timeout can be reached
/// without waiting for it.
final class ManualClock: Clock, Sendable {
  struct Instant: InstantProtocol {
    var offset: Duration

    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  private struct Sleeper {
    var deadline: Instant
    var continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var nextID = 0
    var sleepers: [Int: Sleeper] = [:]
    var cancelledBeforeSleeping: Set<Int> = []
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }

  /// How many sleeps are waiting right now.
  var sleeperCount: Int { state.withLock { $0.sleepers.count } }

  func sleep(until deadline: Instant, tolerance: Duration? = nil) async throws {
    let id = state.withLock { state in
      state.nextID += 1
      return state.nextID
    }

    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let outcome: Result<Void, any Error>? = state.withLock { state in
          if state.cancelledBeforeSleeping.remove(id) != nil {
            return .failure(CancellationError())
          }

          if deadline <= state.now {
            return .success(())
          }

          state.sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
          return nil
        }

        if let outcome {
          continuation.resume(with: outcome)
        }
      }
    } onCancel: {
      let sleeper = state.withLock { state in
        guard let sleeper = state.sleepers.removeValue(forKey: id) else {
          state.cancelledBeforeSleeping.insert(id)
          return Sleeper?.none
        }

        return sleeper
      }

      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Move time on, waking every sleep whose deadline has come.
  func advance(by duration: Duration) {
    let due = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.value.deadline <= now }

      for id in due.keys {
        state.sleepers.removeValue(forKey: id)
      }

      return due.values.map(\.continuation)
    }

    for continuation in due {
      continuation.resume()
    }
  }

  /// Wait (in real time, briefly) until `count` sleeps are pending.
  func waitForSleepers(_ count: Int = 1) async {
    for _ in 0..<2_000 where sleeperCount < count {
      try? await Task.sleep(for: .milliseconds(1))
    }
  }
}
