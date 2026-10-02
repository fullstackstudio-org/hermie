import Foundation
import HermieStore
import Testing

@testable import HermieCore

/// A clock the test moves by hand.
final class TestClock: @unchecked Sendable {
  // @unchecked: only touched from the main actor in these tests; the lock covers the rest.
  private let lock = NSLock()
  private var value: Double = 1_000_000

  var now: Double { lock.withLock { value } }

  func advance(_ milliseconds: Double) {
    lock.withLock { value += milliseconds }
  }

  var read: @Sendable () -> Double {
    { [self] in now }
  }
}

@MainActor
private func makeLock(
  stored: String? = nil,
  authenticator: any DeviceAuthenticator = ScriptedAuthenticator(),
  forced: Bool = false,
  clock: TestClock = TestClock()
) async throws -> (AppLock, KeyValueStore) {
  let store = try SQLiteStore(.inMemory)
  let kv = KeyValueStore(store: store)

  if let stored {
    try await kv.setString(stored, forKey: StoreKeys.lock)
  }

  let lock = AppLock(settings: kv, authenticator: authenticator, forcedLock: forced, clock: clock.read)

  return (lock, kv)
}

@MainActor
@Suite("App lock: reading the setting")
struct AppLockHydrationTests {
  @Test("no stored setting is an open app, and nothing is written")
  func nothingStored() async throws {
    let (lock, kv) = try await makeLock()

    #expect(!lock.ready)
    await lock.hydrate()

    #expect(lock.ready)
    #expect(lock.machine == .start(.off))
    #expect(!lock.settingUnknown)
    #expect(try await kv.string(forKey: StoreKeys.lock) == nil)
  }

  @Test("a stored threshold starts locked, whatever its grace period")
  func storedThresholdLocks() async throws {
    let (lock, _) = try await makeLock(stored: #"{"threshold":"15m"}"#)

    await lock.hydrate()

    #expect(lock.machine == .start(.fifteenMinutes))
    #expect(lock.machine.locked)
    #expect(lock.consumeAutoPrompt())
    #expect(!lock.consumeAutoPrompt())
  }

  @Test(
    "fails closed: an unreadable setting locks when the device can authenticate",
    arguments: [#"{"threshold":"5 minutes"}"#, "not json", #"{"lock":"5m"}"#, #"{"threshold":5}"#]
  )
  func unreadableLocks(text: String) async throws {
    let (lock, kv) = try await makeLock(stored: text)

    await lock.hydrate()

    #expect(lock.machine.locked)
    #expect(lock.machine.threshold == .immediately)
    #expect(lock.settingUnknown)
    #expect(!lock.settingNeedsAttention)
    // Nothing is deleted or rewritten: the person decides.
    #expect(try await kv.string(forKey: StoreKeys.lock) == text)
  }

  @Test("fails open only where the device cannot authenticate, and says so")
  func unreadableWithoutAuthentication() async throws {
    let (lock, _) = try await makeLock(stored: "not json", authenticator: ScriptedAuthenticator(enrolment: .none))

    await lock.hydrate()

    #expect(!lock.machine.locked)
    #expect(lock.settingUnknown)
    #expect(lock.settingNeedsAttention)
  }

  @Test("a launch that lost the setting starts locked before anything is read")
  func forcedLock() async throws {
    let (lock, _) = try await makeLock(forced: true)

    // Decided at construction: the very first frame already has the plate.
    #expect(lock.ready)
    #expect(lock.machine.locked)

    await lock.hydrate()

    #expect(lock.machine.locked)
    #expect(lock.machine.threshold == .immediately)
    #expect(lock.settingUnknown)
  }

  @Test("a forced lock stays up even when a readable setting says off")
  func forcedLockIgnoresOff() async throws {
    let (lock, _) = try await makeLock(stored: #"{"threshold":"off"}"#, forced: true)

    await lock.hydrate()

    #expect(lock.machine.locked)
    #expect(!lock.settingUnknown)
  }

  @Test("the privacy cover is wanted whenever a lock is configured or unknown")
  func coverPolicy() async throws {
    let (off, _) = try await makeLock()
    await off.hydrate()
    #expect(!off.coversWhenInactive)

    let (on, _) = try await makeLock(stored: #"{"threshold":"5m"}"#)
    await on.hydrate()
    #expect(on.coversWhenInactive)

    let (unknown, _) = try await makeLock(stored: "garbage", authenticator: ScriptedAuthenticator(enrolment: .none))
    await unknown.hydrate()
    #expect(unknown.coversWhenInactive)
  }
}

@MainActor
@Suite("App lock: the lifecycle and the prompt")
struct AppLockLifecycleTests {
  @Test("immediately locks on every resign, and the return arms one automatic prompt")
  func immediately() async throws {
    let authenticator = ScriptedAuthenticator()
    let (lock, _) = try await makeLock(stored: #"{"threshold":"immediately"}"#, authenticator: authenticator)

    await lock.hydrate()
    #expect(lock.consumeAutoPrompt())
    #expect(await lock.unlock(reason: "test"))

    lock.appWentAway()
    #expect(lock.machine.locked)

    lock.appCameBack()
    #expect(lock.consumeAutoPrompt())
  }

  @Test("a timed threshold locks only once the grace period has passed")
  func timed() async throws {
    let clock = TestClock()
    let (lock, _) = try await makeLock(stored: #"{"threshold":"1m"}"#, clock: clock)

    await lock.hydrate()
    await lock.unlock(reason: "test")

    lock.appWentAway()
    clock.advance(59_000)
    lock.appCameBack()
    #expect(!lock.machine.locked)

    lock.appWentAway()
    clock.advance(30_000)
    // A second resign while already away does not restart the clock.
    lock.appWentAway()
    clock.advance(30_000)
    lock.appCameBack()
    #expect(lock.machine.locked)
  }

  @Test("a refused or unavailable prompt never opens the app")
  func refusedPrompt() async throws {
    let authenticator = ScriptedAuthenticator(verdicts: [.failed, .unavailable, .ok])
    let (lock, _) = try await makeLock(stored: #"{"threshold":"5m"}"#, authenticator: authenticator)

    await lock.hydrate()

    #expect(!(await lock.unlock(reason: "test")))
    #expect(lock.machine.locked)
    #expect(!(await lock.unlock(reason: "test")))
    #expect(lock.machine.locked)
    #expect(await lock.unlock(reason: "test"))
    #expect(!lock.machine.locked)
    #expect(authenticator.prompts == 3)
  }

  @Test("the prompt's own resign does not re-lock the app underneath it")
  func promptGuard() async throws {
    let gate = PromptGate()
    let (lock, _) = try await makeLock(stored: #"{"threshold":"immediately"}"#, authenticator: gate.authenticator)

    await lock.hydrate()

    let unlocking = Task { await lock.unlock(reason: "test") }

    await gate.waitForPrompt()
    #expect(lock.prompting)

    // Face ID takes the app out of the active state while it asks.
    lock.appWentAway()
    lock.appCameBack()

    gate.answer(.ok)
    #expect(await unlocking.value)
    #expect(!lock.machine.locked)
  }

  @Test("leaving entirely during a settings prompt still starts the clock")
  func leavingDuringPrompt() async throws {
    let clock = TestClock()
    let gate = PromptGate()
    let (lock, _) = try await makeLock(stored: #"{"threshold":"1m"}"#, authenticator: gate.authenticator, clock: clock)

    await lock.hydrate()
    gate.authenticator.setVerdicts([.ok])
    gate.passThrough = true
    await lock.unlock(reason: "test")
    gate.passThrough = false

    let changing = Task { await lock.changeThreshold(.fiveMinutes, reason: "test") }

    await gate.waitForPrompt()
    lock.appWentAway(entirely: true)
    clock.advance(10 * 60_000)
    lock.appCameBack()
    gate.answer(.failed)

    #expect(await changing.value == AppLock.ChangeOutcome.refused)
    #expect(lock.machine.locked)
  }
}

@MainActor
@Suite("App lock: changing the setting")
struct AppLockChangeTests {
  @Test("switching off authenticates first, and a refusal changes nothing")
  func offNeedsAuthentication() async throws {
    let authenticator = ScriptedAuthenticator(verdicts: [.ok, .failed])
    let (lock, kv) = try await makeLock(stored: #"{"threshold":"5m"}"#, authenticator: authenticator)

    await lock.hydrate()
    await lock.unlock(reason: "test")

    #expect(await lock.changeThreshold(.off, reason: "test") == .refused)
    #expect(lock.machine.threshold == .fiveMinutes)
    #expect(try await kv.string(forKey: StoreKeys.lock) == #"{"threshold":"5m"}"#)
    #expect(authenticator.prompts == 2)
  }

  @Test("weakening authenticates, applies, and writes the Expo shape")
  func weakening() async throws {
    let authenticator = ScriptedAuthenticator()
    let (lock, kv) = try await makeLock(stored: #"{"threshold":"immediately"}"#, authenticator: authenticator)

    await lock.hydrate()
    await lock.unlock(reason: "test")

    #expect(await lock.changeThreshold(.fifteenMinutes, reason: "test") == .changed(saved: true))
    #expect(lock.machine.threshold == .fifteenMinutes)
    #expect(try await kv.string(forKey: StoreKeys.lock) == #"{"threshold":"15m"}"#)
    #expect(authenticator.prompts == 2)
  }

  @Test("the value already in force costs no prompt")
  func unchanged() async throws {
    let authenticator = ScriptedAuthenticator()
    let (lock, _) = try await makeLock(stored: #"{"threshold":"5m"}"#, authenticator: authenticator)

    await lock.hydrate()
    await lock.unlock(reason: "test")

    #expect(await lock.changeThreshold(.fiveMinutes, reason: "test") == .unchanged)
    #expect(authenticator.prompts == 1)
  }

  @Test("switching on with nothing to unlock with is refused without a prompt")
  func noEnrolment() async throws {
    let authenticator = ScriptedAuthenticator(enrolment: .none)
    let (lock, kv) = try await makeLock(authenticator: authenticator)

    await lock.hydrate()

    #expect(await lock.changeThreshold(.oneMinute, reason: "test") == .noEnrolment(.none))
    #expect(lock.machine.threshold == .off)
    #expect(authenticator.prompts == 0)
    #expect(try await kv.string(forKey: StoreKeys.lock) == nil)
  }

  @Test("an unknown setting is replaced only through an authenticated pick")
  func unknownReplaced() async throws {
    let authenticator = ScriptedAuthenticator()
    let (lock, kv) = try await makeLock(stored: "garbage", authenticator: authenticator)

    await lock.hydrate()
    await lock.unlock(reason: "test")

    // Even the value the machine runs at meanwhile is a real change.
    #expect(await lock.changeThreshold(.immediately, reason: "test") == .changed(saved: true))
    #expect(!lock.settingUnknown)
    #expect(try await kv.string(forKey: StoreKeys.lock) == #"{"threshold":"immediately"}"#)
  }

  @Test("every change reaches the lock mirror")
  func mirror() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-lock-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let launch = try StoreLaunch.run(applicationSupport: directory, appGroupContainer: nil, deviceCanAuthenticate: { true })
    let lock = AppLock(settings: KeyValueStore(store: launch.store), authenticator: ScriptedAuthenticator(), forcedLock: false)

    await lock.hydrate()
    _ = await lock.changeThreshold(.oneMinute, reason: "test")

    #expect(LockMirror(applicationSupport: directory).read() == .some(#"{"threshold":"1m"}"#))
  }
}

/// An authenticator whose answer the test gives, after it has seen the question.
@MainActor
final class PromptGate {
  let authenticator = HeldAuthenticator()
  var passThrough: Bool {
    get { authenticator.passThrough }
    set { authenticator.passThrough = newValue }
  }

  func waitForPrompt() async {
    while !authenticator.isWaiting {
      await Task.yield()
    }
  }

  func answer(_ verdict: AuthenticationVerdict) {
    authenticator.answer(verdict)
  }
}

final class HeldAuthenticator: DeviceAuthenticator, @unchecked Sendable {
  // @unchecked: every stored property is guarded by `lock`.
  private let lock = NSLock()
  private var continuation: CheckedContinuation<AuthenticationVerdict, Never>?
  private var verdicts: [AuthenticationVerdict] = [.ok]
  private var _passThrough = false

  var passThrough: Bool {
    get { lock.withLock { _passThrough } }
    set { lock.withLock { _passThrough = newValue } }
  }

  var isWaiting: Bool { lock.withLock { continuation != nil } }

  func setVerdicts(_ next: [AuthenticationVerdict]) {
    lock.withLock { verdicts = next }
  }

  func answer(_ verdict: AuthenticationVerdict) {
    let waiting = lock.withLock {
      defer { continuation = nil }
      return continuation
    }

    waiting?.resume(returning: verdict)
  }

  func canAuthenticate() -> Bool { true }

  func enrolment() async -> DeviceEnrolment { .biometric }

  func authenticate(reason: String) async -> AuthenticationVerdict {
    if passThrough {
      return lock.withLock { verdicts.first ?? .ok }
    }

    return await withCheckedContinuation { continuation in
      lock.withLock { self.continuation = continuation }
    }
  }
}
