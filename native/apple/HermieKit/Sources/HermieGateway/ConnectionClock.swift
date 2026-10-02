import Foundation

/// Every piece of time the connection uses: a monotonic reading for intervals,
/// a wall reading for the timestamps it reports, and one-shot timers.
///
/// The connection never sleeps on a clock of its own and never reads the wall
/// clock directly, so a test can drive it with a clock that only moves when the
/// test says so (see `HermieGatewayTests/Connection/TestClock.swift`).
///
/// Timers are scheduled rather than slept on because registration has to be
/// synchronous: the connection schedules a timer inside one actor turn, and a
/// deterministic test needs that timer to exist the moment the turn ends, not
/// whenever a freshly created task first runs.
public protocol ConnectionClock: Sendable {
  /// Monotonic time since an arbitrary origin. Only differences are meaningful.
  var now: Duration { get }

  /// Wall time, for timestamps the connection reports (`lastReadyAt`).
  var date: Date { get }

  /// Run `action` once `delay` has elapsed, unless the returned timer is
  /// cancelled first.
  ///
  /// Cancelling is best effort: an action that has already started (or is
  /// already queued on the connection's actor) may still run, so every action
  /// the connection schedules checks that the timer it belongs to is still the
  /// current one.
  func schedule(after delay: Duration, _ action: @escaping @Sendable () async -> Void) -> ScheduledTimer
}

/// A handle on one scheduled action.
public struct ScheduledTimer: Sendable {
  private let onCancel: @Sendable () -> Void

  public init(cancel: @escaping @Sendable () -> Void) {
    onCancel = cancel
  }

  /// Stop the action from running, if it has not started yet.
  public func cancel() {
    onCancel()
  }
}

/// The production clock: any `Clock<Duration>` (a `ContinuousClock` by
/// default) for the timers and the monotonic reading, and an injected wall
/// clock for reported timestamps.
public struct SystemConnectionClock: ConnectionClock {
  private let elapsed: @Sendable () -> Duration
  private let sleep: @Sendable (Duration) async throws -> Void
  private let wall: @Sendable () -> Date

  public init<C: Clock>(_ clock: C, date: @escaping @Sendable () -> Date = { Date() }) where C.Duration == Duration {
    let origin = clock.now
    elapsed = { origin.duration(to: clock.now) }
    sleep = { delay in try await clock.sleep(for: delay) }
    wall = date
  }

  public init() {
    self.init(ContinuousClock())
  }

  public var now: Duration { elapsed() }

  public var date: Date { wall() }

  public func schedule(after delay: Duration, _ action: @escaping @Sendable () async -> Void) -> ScheduledTimer {
    let sleep = self.sleep
    let task = Task {
      do {
        try await sleep(max(delay, .zero))
      } catch {
        // Cancelled: the timer was cleared before it fired.
        return
      }

      await action()
    }

    return ScheduledTimer { task.cancel() }
  }
}

extension Duration {
  /// The duration in milliseconds, as the reference's numbers carry it.
  var milliseconds: Double {
    let parts = components
    return Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1_000_000_000_000_000
  }
}
