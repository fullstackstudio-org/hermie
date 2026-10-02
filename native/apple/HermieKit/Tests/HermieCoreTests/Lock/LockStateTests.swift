import Testing

@testable import HermieCore

/**
 The app lock's timing, as a table: `expo/hermie/__tests__/app-lock-state.test.ts`, case for case
 and name for name.
 */
private let t0: Double = 1_700_000_000_000

@Suite("the threshold")
struct LockThresholdTests {
  @Test("is off by default, so a lock nobody asked for never appears")
  func offByDefault() {
    #expect(LockThreshold.default == .off)
    #expect(!LockMachine.start(.off).locked)
  }

  @Test("reads a stored value defensively")
  func readsDefensively() {
    #expect(LockThreshold.isLockThreshold("5m"))
    #expect(!LockThreshold.isLockThreshold("5 minutes"))
    #expect(!LockThreshold.isLockThreshold(nil))
  }

  @Test(
    "gives %s a grace period of %i ms",
    arguments: [
      (LockThreshold.immediately, 0.0),
      (.oneMinute, 60_000),
      (.fiveMinutes, 300_000),
      (.fifteenMinutes, 900_000)
    ]
  )
  func gracePeriod(threshold: LockThreshold, milliseconds: Double) {
    #expect(threshold.graceMilliseconds == milliseconds)
  }
}

@Suite("a cold start")
struct LockColdStartTests {
  @Test(
    "locks at %s, whatever the grace period says",
    arguments: [LockThreshold.immediately, .oneMinute, .fiveMinutes, .fifteenMinutes]
  )
  func locks(threshold: LockThreshold) {
    #expect(LockMachine.start(threshold).locked)
  }

  @Test("leaves the app open when the lock is off")
  func openWhenOff() {
    #expect(LockMachine.start(.off) == LockMachine(threshold: .off, locked: false, sinceBackground: nil))
  }
}

@Suite("going away and coming back")
struct LockLifecycleTests {
  @Test("locks on the way out at \"immediately\", so the switcher snapshot is the plate")
  func immediatelyLocksOnTheWayOut() {
    let open = LockMachine.start(.immediately).unlocked()

    #expect(!open.locked)
    #expect(open.background(now: t0).locked)
  }

  @Test("does not lock on the way out at a timed threshold")
  func timedDoesNotLockOnTheWayOut() {
    let open = LockMachine.start(.fiveMinutes).unlocked()

    #expect(open.background(now: t0) == LockMachine(threshold: .fiveMinutes, locked: false, sinceBackground: t0))
  }

  @Test("stays open when the app comes back inside the grace period")
  func staysOpenInsideGrace() {
    let away = LockMachine.start(.fiveMinutes).unlocked().background(now: t0)

    #expect(!away.foreground(now: t0 + 299_999).locked)
  }

  @Test("locks when the app comes back after the grace period")
  func locksAfterGrace() {
    let away = LockMachine.start(.fiveMinutes).unlocked().background(now: t0)

    #expect(away.foreground(now: t0 + 300_000).locked)
  }

  @Test("locks exactly at the boundary, not one millisecond later")
  func locksAtTheBoundary() {
    let away = LockMachine.start(.oneMinute).unlocked().background(now: t0)

    #expect(!away.foreground(now: t0 + 59_999).locked)
    #expect(away.foreground(now: t0 + 60_000).locked)
  }

  @Test("forgets the timestamp once it has been read, so the next return is not judged by an old one")
  func forgetsTheTimestamp() {
    let away = LockMachine.start(.fifteenMinutes).unlocked().background(now: t0)
    let back = away.foreground(now: t0 + 1_000)

    #expect(back.sinceBackground == nil)
    // A whole day later with no intervening background: still open, because nothing went away.
    #expect(!back.foreground(now: t0 + 86_400_000).locked)
  }

  @Test("never locks while the threshold is off, however long the app was away")
  func neverLocksWhenOff() {
    let away = LockMachine.start(.off).background(now: t0)

    #expect(away.sinceBackground == nil)
    #expect(!away.foreground(now: t0 + 86_400_000).locked)
  }
}

@Suite("the prompt")
struct LockPromptTests {
  @Test("opens the app when it succeeds")
  func opensOnSuccess() {
    #expect(LockMachine.start(.oneMinute).unlocked() == LockMachine(threshold: .oneMinute, locked: false, sinceBackground: nil))
  }

  @Test("keeps the plate up when it fails")
  func keepsThePlateUp() {
    let locked = LockMachine.start(.oneMinute)

    #expect(locked.unlockFailed() == locked)
    #expect(locked.unlockFailed().locked)
  }

  @Test("keeps the plate up however many times it fails")
  func keepsThePlateUpRepeatedly() {
    var state = LockMachine.start(.immediately)

    for _ in 0..<10 {
      state = state.unlockFailed()
    }

    #expect(state.locked)
  }
}

@Suite("changing the setting")
struct LockSettingChangeTests {
  @Test("unlocks when it is switched off, so the plate cannot outlive the preference")
  func offUnlocks() {
    #expect(
      LockMachine.start(.immediately).thresholdChanged(.off)
        == LockMachine(threshold: .off, locked: false, sinceBackground: nil)
    )
  }

  @Test("leaves the app open when it is switched on, because the reader is holding it")
  func onLeavesItOpen() {
    let open = LockMachine.start(.off).unlocked()

    #expect(open.thresholdChanged(.fiveMinutes) == LockMachine(threshold: .fiveMinutes, locked: false, sinceBackground: nil))
  }

  @Test("takes effect on the next return, not retroactively")
  func nextReturn() {
    let away = LockMachine.start(.off).unlocked().thresholdChanged(.oneMinute).background(now: t0)

    #expect(!away.foreground(now: t0 + 30_000).locked)
    #expect(away.foreground(now: t0 + 61_000).locked)
  }
}
