import Foundation

/// Why a reconcile was asked for (I11). Only `foreground` and the delayed reasons are throttled.
public enum SyncReason: String, Sendable, Hashable, CaseIterable {
  /// After the registry load, never blocking the first frame.
  case launch
  /// The scene became active; at most once per `SyncTiming.foregroundInterval`.
  case foreground
  /// A synced field changed here; runs `SyncTiming.localChangeDelay` later, coalesced.
  case localChange
  /// Signed in or out of a gateway; delayed like a local change.
  case signInChange
  /// "Sync Now", or an intent that wants the result at once.
  case manual
  /// Settings → Gateways was opened.
  case settingsOpened
  /// Before the onboarding wizard is shown.
  case onboarding
}

/// The two numbers of I11.
public struct SyncTiming: Sendable, Equatable {
  /// How long after a local change the reconcile runs; later changes in that window join it.
  public var localChangeDelay: Duration
  /// The least time, in milliseconds of the injected wall clock, between two foreground reconciles.
  public var foregroundInterval: Double

  public init(localChangeDelay: Duration = .seconds(1), foregroundInterval: Double = 30_000) {
    self.localChangeDelay = localChangeDelay
    self.foregroundInterval = foregroundInterval
  }
}

/// The engine's only sources of time: the wall clock in epoch milliseconds (stamps, throttling)
/// and a sleep for the debounce. Tests inject both; the engine has no other timer.
public struct SyncClock: Sendable {
  public var now: @Sendable () -> Double
  public var sleep: @Sendable (Duration) async throws -> Void

  public init(now: @escaping @Sendable () -> Double, sleep: @escaping @Sendable (Duration) async throws -> Void) {
    self.now = now
    self.sleep = sleep
  }

  public static let system = SyncClock(
    now: { (Date().timeIntervalSince1970 * 1000).rounded(.down) },
    sleep: { try await ContinuousClock().sleep(for: $0) }
  )
}

extension GatewaySyncEngine {
  /**
   Ask for a reconcile. Returns at once; the reconcile runs on the engine, one at a time, and
   requests that arrive while one is waiting to start join it.

   - `launch`, `manual`, `settingsOpened`, `onboarding`: queued now.
   - `foreground`: queued now unless one ran less than `foregroundInterval` ago.
   - `localChange`, `signInChange`: queued `localChangeDelay` later; while that delay runs, further
     ones join it (the delay is not restarted, so a stream of edits cannot postpone sync forever).
   */
  public func trigger(_ reason: SyncReason) {
    switch reason {
    case .foreground:
      let now = clock.now()
      if let last = lastForeground, now >= last, now - last < timing.foregroundInterval {
        return
      }
      lastForeground = now
      _ = enqueue(reason)
    case .localChange, .signInChange:
      scheduleDebounced(reason)
    case .launch, .manual, .settingsOpened, .onboarding:
      _ = enqueue(reason)
    }
  }

  /// Something synced changed on this device: reconcile one second from now.
  public func localDidChange() {
    trigger(.localChange)
  }

  /// Reconcile now (after the one that is running, if any) and return how it ended.
  @discardableResult
  public func reconcileNow(_ reason: SyncReason = .manual) async -> SyncOutcome {
    await enqueue(reason).value
  }

  /// Wait until no reconcile is running, queued or waiting for its debounce. For tests and for a
  /// caller that must not race the engine (a sign-out just before quitting).
  public func waitUntilIdle() async {
    while true {
      if let debounce {
        await debounce.value
        continue
      }
      if let chain, !chainFinished {
        _ = await chain.value
        continue
      }
      return
    }
  }

  func scheduleDebounced(_ reason: SyncReason) {
    guard debounce == nil else {
      return
    }

    let sleep = clock.sleep
    let delay = timing.localChangeDelay

    debounce = Task {
      do {
        try await sleep(delay)
      } catch {
        self.debounce = nil
        return
      }
      self.debounce = nil
      _ = self.enqueue(reason)
    }
  }

  /// One reconcile at a time: each waits for the one before it. A request made while the last
  /// queued one has not started yet gets that one.
  func enqueue(_ reason: SyncReason) -> Task<SyncOutcome, Never> {
    if let chain, queuedTicket != nil {
      return chain
    }

    let previous = chain
    ticket += 1
    let mine = ticket
    queuedTicket = mine
    chainFinished = false

    let task = Task {
      _ = await previous?.value
      if self.queuedTicket == mine { self.queuedTicket = nil }
      let outcome = await self.reconcileSerially(reason)
      if self.ticket == mine { self.chainFinished = true }
      return outcome
    }

    chain = task
    return task
  }
}
