import Foundation

/**
 How long the app may sit in the background before it asks again.

 The port of `LockThreshold` in `expo/hermie/src/features/lock/lock-state.ts`: a closed set a person
 picks from a list, stored under `hermie.lock` as `{"threshold":"<raw value>"}`. `off` is the
 default: a lock nobody asked for reads as a bug the first time it appears.
 */
public enum LockThreshold: String, Sendable, CaseIterable, Codable {
  case off
  case immediately
  case oneMinute = "1m"
  case fiveMinutes = "5m"
  case fifteenMinutes = "15m"

  /// `DEFAULT_LOCK_THRESHOLD`.
  public static let `default` = LockThreshold.off

  /// `graceMsOf`: milliseconds of background the threshold tolerates. `off` never locks.
  public var graceMilliseconds: Double {
    switch self {
    case .off: .infinity
    case .immediately: 0
    case .oneMinute: 60_000
    case .fiveMinutes: 5 * 60_000
    case .fifteenMinutes: 15 * 60_000
    }
  }

  /// `isLockThreshold`: a stored value read defensively.
  public static func isLockThreshold(_ value: String?) -> Bool {
    value.flatMap(LockThreshold.init(rawValue:)) != nil
  }
}

/**
 When the app is locked, decided without a clock, a store or a prompt.

 Every transition is a pure function of the previous state, one event and the time it happened
 at, exactly as in `lock-state.ts`; `LockStateTests` is the TypeScript table, case for case.
 `AppLock` owns the side that touches disk and the prompt and does nothing to this but hand it to
 the functions below.

 Times are milliseconds on a monotonic clock that keeps running while the device sleeps
 (`AppLock.monotonicMilliseconds`), so neither a wall-clock change nor a night on the nightstand
 bends the grace period.
 */
public struct LockMachine: Sendable, Equatable {
  public var threshold: LockThreshold
  /// Whether the plate is up. Nothing below it is rendered while this is true.
  public var locked: Bool
  /// When the app last went away, or nil while it is in front. Memory only, never written down.
  public var sinceBackground: Double?

  public init(threshold: LockThreshold, locked: Bool, sinceBackground: Double?) {
    self.threshold = threshold
    self.locked = locked
    self.sinceBackground = sinceBackground
  }

  /// `start`: the state a launch begins in. An enabled lock locks on a cold start whatever the
  /// threshold says, `15m` included: a killed process is not a quick trip to the password manager.
  public static func start(_ threshold: LockThreshold) -> LockMachine {
    LockMachine(threshold: threshold, locked: threshold != .off, sinceBackground: nil)
  }

  /// `background`: the app went away. `immediately` locks here rather than on the way back,
  /// because the app switcher's snapshot is taken on this transition.
  public func background(now: Double) -> LockMachine {
    guard threshold != .off else {
      return self
    }

    return LockMachine(threshold: threshold, locked: locked || threshold == .immediately, sinceBackground: now)
  }

  /// `foreground`: the app came back. Locks when it was away for at least the grace period.
  public func foreground(now: Double) -> LockMachine {
    if threshold == .off {
      return LockMachine(threshold: threshold, locked: false, sinceBackground: nil)
    }

    guard !locked, let since = sinceBackground else {
      return LockMachine(threshold: threshold, locked: locked, sinceBackground: nil)
    }

    return LockMachine(threshold: threshold, locked: now - since >= threshold.graceMilliseconds, sinceBackground: nil)
  }

  /// `unlocked`: the prompt answered yes.
  public func unlocked() -> LockMachine {
    LockMachine(threshold: threshold, locked: false, sinceBackground: nil)
  }

  /// `unlockFailed`: the prompt answered no, was cancelled, or could not run. Changes nothing, on
  /// purpose: the platform owns attempt counting and back-off; what matters is that this does not
  /// unlock.
  public func unlockFailed() -> LockMachine {
    self
  }

  /// `thresholdChanged`: turning the lock off unlocks; turning it on leaves the app open, because
  /// the person choosing is holding it.
  public func thresholdChanged(_ next: LockThreshold) -> LockMachine {
    LockMachine(threshold: next, locked: next == .off ? false : locked, sinceBackground: sinceBackground)
  }
}
