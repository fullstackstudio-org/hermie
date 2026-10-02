import Foundation
import HermieStore
import Observation

/// `hermie.lock`: `{"threshold":"off" | "immediately" | "1m" | "5m" | "15m"}`, the Expo app's shape.
public struct PersistedLock: Codable, Sendable, Equatable {
  /// Kept as text so a value this build does not know is caught here, not by the decoder.
  public var threshold: String

  public init(threshold: LockThreshold) {
    self.threshold = threshold.rawValue
  }
}

/**
 The app lock: the preference, the plate's up-or-down, and the one call that asks the device.

 The port of `features/lock/store.ts`, with one deliberate difference: it FAILS CLOSED. The Expo
 store reads an unreadable preference as "off"; here a setting that cannot be read (a database
 error, text that is not the shape, a threshold this build does not know) locks the app whenever
 the device can authenticate, and for the rest of the launch behaves as `immediately` until the
 person picks a value. A device that cannot authenticate would be stranded behind a plate it
 cannot open, so there the app opens and `settingNeedsAttention` says why.

 `requiresLockThisLaunch` from the launch report (the database was lost and the setting could not
 be restored) is the same unknown setting, decided before the first frame.

 The preference is per device and never synced (see `store.ts`). Every write goes through
 `KeyValueStore`, and the store mirrors `hermie.lock` into `LockMirror` on every commit.
 */
@MainActor
@Observable
public final class AppLock {
  /// What a request to change the setting came to.
  public enum ChangeOutcome: Sendable, Equatable {
    /// Authenticated and applied. `saved` is false when the write failed: it holds for this launch.
    case changed(saved: Bool)
    /// The value already in force: no prompt, nothing written.
    case unchanged
    /// The device has nothing to unlock with; switching a lock on would strand the person.
    case noEnrolment(DeviceEnrolment)
    /// The prompt answered no, was cancelled or could not run. Nothing changed.
    case refused
    /// Another prompt is already up.
    case busy
  }

  public private(set) var machine: LockMachine
  /// False until the preference has been read. The gate draws neither the app nor the plate before.
  public private(set) var ready: Bool
  /// True while the platform prompt is up. Lifecycle events are ignored meanwhile: the prompt itself
  /// takes the app out of the active state, and re-locking under it makes an unlock unfinishable.
  public private(set) var prompting = false
  /// What this device offers, once asked.
  public private(set) var enrolment: DeviceEnrolment?
  /// The stored setting is unknown or unreadable; the machine runs at `immediately` meanwhile.
  public private(set) var settingUnknown: Bool
  /// The setting could not be read and the app is open anyway, because this device cannot lock.
  public private(set) var settingNeedsAttention = false

  private let settings: KeyValueStore
  private let authenticator: any DeviceAuthenticator
  private let clock: @Sendable () -> Double
  /// The app is away (inactive or in the background), so a second "went away" is not a new one.
  private var away = false
  /// Set whenever the plate goes up on its own; the first active window asks once.
  private var autoPromptArmed = false
  /// The app came back from the background while a prompt was up.
  private var returnedDuringPrompt = false

  /**
   - Parameters:
     - forcedLock: `StoreLaunch.Report.requiresLockThisLaunch`. Decided now, before the first frame.
     - clock: milliseconds on a monotonic clock that includes sleep.
   */
  public init(
    settings: KeyValueStore,
    authenticator: any DeviceAuthenticator,
    forcedLock: Bool,
    clock: @escaping @Sendable () -> Double = AppLock.monotonicMilliseconds
  ) {
    self.settings = settings
    self.authenticator = authenticator
    self.clock = clock

    if forcedLock {
      machine = .start(.immediately)
      settingUnknown = true
      ready = true
      autoPromptArmed = true
    } else {
      machine = .start(.off)
      settingUnknown = false
      ready = false
    }
  }

  /// Whether the app switcher's snapshot must be covered: any lock is configured, or might be.
  public var coversWhenInactive: Bool {
    machine.threshold != .off || settingUnknown || machine.locked
  }

  /// Read the preference. The one place `ready` turns true after a normal launch.
  public func hydrate() async {
    let stored: LockThreshold?

    do {
      if let persisted = try await settings.value(PersistedLock.self, forKey: StoreKeys.lock) {
        stored = LockThreshold(rawValue: persisted.threshold)
      } else {
        // Never written: no lock was chosen, unless the launch already said the setting was lost.
        stored = settingUnknown ? nil : .off
      }
    } catch {
      stored = nil
    }

    if let stored {
      // A forced launch stays locked whatever the stored value says, until the prompt opens it.
      let wasLocked = machine.locked

      machine = .start(stored)
      machine.locked = machine.locked || wasLocked
      settingUnknown = false
    } else if authenticator.canAuthenticate() {
      machine = .start(.immediately)
      settingUnknown = true
    } else {
      machine = .start(.off)
      settingUnknown = true
      settingNeedsAttention = true
    }

    if machine.locked {
      autoPromptArmed = true
    }

    ready = true
  }

  // MARK: The lifecycle

  /**
   The app resigned active (the switcher, a call, another app, the Mac app losing the front).

   Ignored while a prompt is up, since the prompt itself resigns the app. `entirely` is a real
   departure (the background on iOS, a hidden app on the Mac), which no prompt causes, so it counts
   even then: leaving in the middle of a settings prompt must still start the clock.
   */
  public func appWentAway(entirely: Bool = false) {
    guard !prompting || entirely, !away else {
      return
    }

    let before = machine

    away = true
    machine = machine.background(now: clock())

    // `immediately` locks on the way out; the return should ask without a tap.
    if machine.locked && !before.locked {
      autoPromptArmed = true
    }
  }

  /// The app is active again.
  public func appCameBack() {
    guard !prompting else {
      // Back from a real departure while a prompt was still settling: judged once it has.
      returnedDuringPrompt = returnedDuringPrompt || away
      return
    }

    let before = machine

    away = false
    machine = machine.foreground(now: clock())

    if machine.locked && !before.locked {
      autoPromptArmed = true
    }
  }

  /// True once after the plate went up on its own, so the first active window asks without a tap.
  public func consumeAutoPrompt() -> Bool {
    guard autoPromptArmed, machine.locked, ready, !prompting else {
      return false
    }

    autoPromptArmed = false

    return true
  }

  // MARK: Asking

  /// Ask the device. Answers whether the app is now open.
  @discardableResult
  public func unlock(reason: String) async -> Bool {
    guard !prompting, machine.locked else {
      return !machine.locked
    }

    prompting = true
    defer { endPrompt() }

    // A platform that cannot run the prompt is a refusal, never an excuse to open.
    guard await authenticator.authenticate(reason: reason) == .ok else {
      machine = machine.unlockFailed()
      return false
    }

    machine = machine.unlocked()
    away = false
    autoPromptArmed = false

    return true
  }

  /// Re-read what the hardware offers.
  @discardableResult
  public func checkEnrolment() async -> DeviceEnrolment {
    let answer = await authenticator.enrolment()

    enrolment = answer

    return answer
  }

  /**
   Change the preference. Authenticates FIRST, in both directions and with `off` included (HERM-106),
   so the picker itself is the proof: anyone holding an unlocked device could otherwise weaken or
   remove somebody else's lock. Switching a lock on without anything to unlock it with is refused.
   */
  public func changeThreshold(_ next: LockThreshold, reason: String) async -> ChangeOutcome {
    guard !prompting else {
      return .busy
    }

    if next == machine.threshold && !settingUnknown {
      return .unchanged
    }

    if next != .off {
      let answer = await checkEnrolment()

      guard answer.canUnlock else {
        return .noEnrolment(answer)
      }
    }

    prompting = true

    let verdict = await authenticator.authenticate(reason: reason)

    endPrompt()

    guard verdict == .ok else {
      return .refused
    }

    machine = machine.thresholdChanged(next)
    settingUnknown = false
    settingNeedsAttention = false

    do {
      try await settings.set(PersistedLock(threshold: next), forKey: StoreKeys.lock)
      return .changed(saved: true)
    } catch {
      return .changed(saved: false)
    }
  }

  private func endPrompt() {
    prompting = false

    if returnedDuringPrompt {
      returnedDuringPrompt = false
      appCameBack()
    }
  }

  // MARK: The clock

  private nonisolated static let origin = ContinuousClock.now

  /// Milliseconds since the first read, on `ContinuousClock`, which keeps counting while asleep.
  public nonisolated static func monotonicMilliseconds() -> Double {
    let elapsed = ContinuousClock.now - origin
    let parts = elapsed.components

    return Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15
  }
}
