import Foundation
import Synchronization

@testable import HermieGateway

/// A clock that moves only when a test says so.
///
/// `advance(by:)` runs every timer that falls due inside the step, in deadline
/// order, setting `now` to each timer's deadline as it fires, and awaits each
/// action before the next. The connection's timer actions are actor methods
/// that do synchronous work, so when `advance` returns, everything a due timer
/// does synchronously has happened. What a timer starts asynchronously (a dial)
/// is awaited by the test through what it observes.
final class TestClock: ConnectionClock {
  private struct Entry {
    let id: UInt64
    let deadline: Duration
    let action: @Sendable () async -> Void
  }

  private struct State {
    var now: Duration = .zero
    var entries: [Entry] = []
    var nextID: UInt64 = 0
  }

  private let state = Mutex(State())

  /// Where `date` starts: 2023-11-14T22:13:20Z.
  static let epoch = Date(timeIntervalSince1970: 1_700_000_000)

  var now: Duration { state.withLock { $0.now } }

  var date: Date { Self.epoch.addingTimeInterval(now.milliseconds / 1000) }

  func schedule(after delay: Duration, _ action: @escaping @Sendable () async -> Void) -> ScheduledTimer {
    let id = state.withLock { state in
      defer { state.nextID += 1 }
      state.entries.append(Entry(id: state.nextID, deadline: state.now + max(delay, .zero), action: action))
      return state.nextID
    }

    return ScheduledTimer { [weak self] in
      self?.state.withLock { $0.entries.removeAll { $0.id == id } }
    }
  }

  /// Timers that have not fired and were not cancelled.
  var pendingCount: Int { state.withLock { $0.entries.count } }

  /// Move time forward by `step`, firing what falls due on the way.
  func advance(by step: Duration) async {
    let target = state.withLock { $0.now + step }

    while let entry = takeNextDue(by: target) {
      await entry.action()
    }

    state.withLock { $0.now = max($0.now, target) }
  }

  private func takeNextDue(by target: Duration) -> Entry? {
    state.withLock { state in
      let due = state.entries.enumerated()
        .filter { $0.element.deadline <= target }
        .min { lhs, rhs in
          (lhs.element.deadline, lhs.element.id) < (rhs.element.deadline, rhs.element.id)
        }

      guard let due else {
        return nil
      }

      state.entries.remove(at: due.offset)
      state.now = max(state.now, due.element.deadline)
      return due.element
    }
  }
}
