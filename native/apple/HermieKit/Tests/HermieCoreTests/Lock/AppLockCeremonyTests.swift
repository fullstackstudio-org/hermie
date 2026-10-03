import AuthenticationServices
import Foundation
import HermieStore
import Testing

@testable import HermieCore

@MainActor
private func openLock(_ threshold: String, clock: TestClock = TestClock()) async throws -> AppLock {
  let store = try SQLiteStore(.inMemory)
  let settings = KeyValueStore(store: store)

  try await settings.setString(#"{"threshold":"\#(threshold)"}"#, forKey: StoreKeys.lock)

  let lock = AppLock(settings: settings, authenticator: ScriptedAuthenticator(), forcedLock: false, clock: clock.read)

  await lock.hydrate()
  await lock.unlock(reason: "test")
  #expect(!lock.machine.locked)
  return lock
}

/// A passkey authenticator whose ceremony stays "on screen" until the test ends it.
@MainActor
private final class HeldCeremony: PasskeyAuthenticator {
  private var waiting: CheckedContinuation<Result<PasskeyAssertionResponse, PasskeyCeremonyError>, Never>?
  private var registering: CheckedContinuation<Result<PasskeyRegistration, PasskeyCeremonyError>, Never>?
  private(set) var cancels = 0

  var isUp: Bool { waiting != nil || registering != nil }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    try await withCheckedContinuation { registering = $0 }.get()
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    try await withCheckedContinuation { waiting = $0 }.get()
  }

  func cancel() async {
    cancels += 1
    end(.failure(.cancelled))
  }

  func end(_ result: Result<PasskeyAssertionResponse, PasskeyCeremonyError>) {
    let continuation = waiting
    waiting = nil
    continuation?.resume(returning: result)
  }

  func endRegistration(_ result: Result<PasskeyRegistration, PasskeyCeremonyError>) {
    let continuation = registering
    registering = nil
    continuation?.resume(returning: result)
  }

  func waitUntilUp() async {
    while !isUp {
      await Task.yield()
    }
  }
}

private let request = PasskeyAssertionRequest(rpID: "confirm.hermie.dev", challenge: [1], allowCredentialIDs: [[2]])
private let response = PasskeyAssertionResponse(
  credentialID: [2], authenticatorData: [3], clientDataJSON: [4], signature: [5], userHandle: nil)

@MainActor
@Suite("App lock: the passkey ceremony")
struct AppLockCeremonyTests {
  @Test("the system sheet's resign does not re-lock the app under it")
  func sheetDoesNotLock() async throws {
    let lock = try await openLock("immediately")

    lock.ceremonyBegan()
    // The passkey sheet takes the app out of the active state while it asks.
    lock.appWentAway()
    lock.appCameBack()
    lock.ceremonyEnded()

    #expect(!lock.machine.locked)
    #expect(!lock.consumeAutoPrompt())
    #expect(lock.ceremonies == 0)
  }

  @Test("without a ceremony the same resign locks at immediately")
  func controlCase() async throws {
    let lock = try await openLock("immediately")

    lock.appWentAway()
    lock.appCameBack()

    #expect(lock.machine.locked)
  }

  @Test("leaving entirely during the ceremony still locks")
  func leavingLocks() async throws {
    let lock = try await openLock("immediately")

    lock.ceremonyBegan()
    lock.appWentAway(entirely: true)

    #expect(lock.machine.locked)
    lock.ceremonyEnded()
    #expect(lock.machine.locked)
  }

  @Test("a return from a real departure during the ceremony is judged once the sheet is gone")
  func returnJudgedAfter() async throws {
    let clock = TestClock()
    let lock = try await openLock("1m", clock: clock)

    lock.ceremonyBegan()
    lock.appWentAway(entirely: true)
    clock.advance(2 * 60_000)
    lock.appCameBack()
    #expect(!lock.machine.locked, "judged later, not under the sheet")

    lock.ceremonyEnded()
    #expect(lock.machine.locked)
    #expect(lock.consumeAutoPrompt())
  }

  @Test("no automatic unlock prompt while the passkey sheet is up")
  func noAutoPromptUnderTheSheet() async throws {
    let lock = try await openLock("immediately")

    lock.appWentAway(entirely: true)
    lock.appCameBack()
    lock.ceremonyBegan()
    #expect(!lock.consumeAutoPrompt())

    lock.ceremonyEnded()
    #expect(lock.consumeAutoPrompt())
  }

  @Test("an end without a beginning changes nothing")
  func unbalancedEnd() async throws {
    let lock = try await openLock("immediately")

    lock.ceremonyEnded()
    #expect(lock.ceremonies == 0)

    lock.appWentAway()
    #expect(lock.machine.locked, "the lifecycle is not held")
  }

  // MARK: The wrapper

  @Test("the guarded authenticator holds the lock exactly while an assertion runs")
  func guardsAnAssertion() async throws {
    let lock = try await openLock("immediately")
    let held = HeldCeremony()
    let guarded = LockGuardedPasskeyAuthenticator(held, lock: lock)

    let running = Task { try await guarded.assert(request) }

    await held.waitUntilUp()
    #expect(lock.ceremonies == 1)
    lock.appWentAway()
    #expect(!lock.machine.locked)

    lock.appCameBack()
    held.end(.success(response))
    #expect(try await running.value == response)
    #expect(lock.ceremonies == 0)
    #expect(!lock.machine.locked)

    lock.appWentAway()
    #expect(lock.machine.locked, "held no longer")
  }

  @Test("a ceremony that fails or is cancelled releases the lock too")
  func releasesOnError() async throws {
    let lock = try await openLock("immediately")
    let held = HeldCeremony()
    let guarded = LockGuardedPasskeyAuthenticator(held, lock: lock)

    let failing = Task { try await guarded.assert(request) }
    await held.waitUntilUp()
    held.end(.failure(.failed("x")))
    await #expect(throws: PasskeyCeremonyError.failed("x")) { try await failing.value }
    #expect(lock.ceremonies == 0)

    let cancelled = Task { try await guarded.assert(request) }
    await held.waitUntilUp()
    await guarded.cancel()
    await #expect(throws: PasskeyCeremonyError.cancelled) { try await cancelled.value }
    #expect(held.cancels == 1, "cancel reaches the system authenticator")
    #expect(lock.ceremonies == 0)
  }

  @Test("an enrolment's sheet is guarded as well")
  func guardsARegistration() async throws {
    let lock = try await openLock("immediately")
    let held = HeldCeremony()
    let guarded = LockGuardedPasskeyAuthenticator(held, lock: lock)
    let registration = PasskeyRegistration(credentialID: [1], clientDataJSON: [2], attestationObject: [3], transports: [])
    let new = PasskeyRegistrationRequest(
      rpID: "confirm.hermie.dev", challenge: [1], userHandle: [2], name: "n", displayName: "n")

    let running = Task { try await guarded.register(new) }

    await held.waitUntilUp()
    #expect(lock.ceremonies == 1)
    held.endRegistration(.success(registration))
    #expect(try await running.value == registration)
    #expect(lock.ceremonies == 0)
  }

  @Test("with the system authenticator: busy is released at once, and the sheet's run is held")
  func withTheSystemAuthenticator() async throws {
    let lock = try await openLock("immediately")
    let completions = Completions()
    let system = SystemPasskeyAuthenticator(driver: { RecordingDriver(completions) })
    let guarded = LockGuardedPasskeyAuthenticator(system, lock: lock)

    let running = Task { try await guarded.assert(request) }
    while completions.all.isEmpty {
      await Task.yield()
    }
    #expect(lock.ceremonies == 1)

    await #expect(throws: PasskeyCeremonyError.busy) { try await guarded.assert(request) }
    #expect(lock.ceremonies == 1, "the busy call began and ended its own hold")

    completions.all[0](.assertion(response))
    #expect(try await running.value == response)
    #expect(lock.ceremonies == 0)
  }
}

@MainActor
private final class Completions {
  var all: [@MainActor (PasskeyAuthorizationOutcome) -> Void] = []
}

@MainActor
private final class RecordingDriver: PasskeyAuthorizationDriver {
  private let completions: Completions

  init(_ completions: Completions) {
    self.completions = completions
  }

  func perform(_ request: ASAuthorizationRequest, completion: @escaping @MainActor (PasskeyAuthorizationOutcome) -> Void) {
    completions.all.append(completion)
  }

  func cancel() {}
}
