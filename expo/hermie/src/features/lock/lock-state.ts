/**
 * When the app is locked, decided without a clock, a store or a native module.
 *
 * Everything here is a pure function of the previous state, one event and the
 * time that event happened at. The reason is that the three questions this
 * feature gets wrong are all timing questions — did the grace period elapse
 * while the app was away, does a cold start honour it, does a cancelled prompt
 * leave the app open — and none of them is answerable from a screenshot. They
 * are answerable from a table, and `__tests__/app-lock-state.test.ts` is that
 * table.
 *
 * The store in `store.ts` owns the side of this that touches disk and the
 * biometric prompt; it holds one `LockMachine` and does nothing to it except
 * hand it to the functions below.
 */

/**
 * How long the app may sit in the background before it asks again.
 *
 * A closed set rather than a number of seconds, because it is a preference a
 * person picks from a list and every value has to mean the same thing on every
 * platform. `off` is the default: a lock nobody asked for is a lock that reads
 * as a bug the first time it appears.
 */
export type LockThreshold = 'off' | 'immediately' | '1m' | '5m' | '15m'

export const LOCK_THRESHOLDS: readonly LockThreshold[] = ['off', 'immediately', '1m', '5m', '15m']

export const DEFAULT_LOCK_THRESHOLD: LockThreshold = 'off'

/** Milliseconds of background the threshold tolerates. `off` never locks at all. */
const GRACE_MS: Record<LockThreshold, number> = {
  off: Number.POSITIVE_INFINITY,
  immediately: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000
}

export function graceMsOf(threshold: LockThreshold): number {
  return GRACE_MS[threshold]
}

export function isLockThreshold(value: unknown): value is LockThreshold {
  return typeof value === 'string' && (LOCK_THRESHOLDS as readonly string[]).includes(value)
}

export interface LockMachine {
  threshold: LockThreshold
  /** Whether the plate is up. Nothing below it is rendered while this is true. */
  locked: boolean
  /**
   * When the app last went to the background, or `null` while it is in front.
   *
   * Held in memory only, and deliberately: a timestamp written to disk is a
   * timestamp anyone holding the device can edit, and the one case it would
   * buy — honouring a 15 minute grace period across a process the OS killed —
   * is the case `start()` refuses to honour anyway.
   */
  sinceBackground: number | null
}

/**
 * The state a launch begins in.
 *
 * An enabled lock locks on a cold start whatever the threshold says, including
 * `15m`. The grace period exists so that switching to the password manager and
 * back does not cost a prompt; a process that was killed and started again is
 * not that. There is also nothing to measure against — the only record of when
 * the app went away died with it — so honouring the threshold here would mean
 * trusting a number written to disk to decide whether to ask for a face.
 */
export function start(threshold: LockThreshold): LockMachine {
  return { threshold, locked: threshold !== 'off', sinceBackground: null }
}

/**
 * The app went away. `immediately` locks here rather than on the way back,
 * because the app switcher's snapshot is taken on this transition: locking on
 * the return would put the transcript in the card the switcher shows.
 */
export function background(state: LockMachine, now: number): LockMachine {
  if (state.threshold === 'off') {
    return state
  }

  return {
    ...state,
    locked: state.locked || state.threshold === 'immediately',
    sinceBackground: now
  }
}

/** The app came back. Locks when it was away for at least the grace period. */
export function foreground(state: LockMachine, now: number): LockMachine {
  if (state.threshold === 'off') {
    return { ...state, locked: false, sinceBackground: null }
  }

  if (state.locked || state.sinceBackground === null) {
    return { ...state, sinceBackground: null }
  }

  const away = now - state.sinceBackground

  return { ...state, locked: away >= graceMsOf(state.threshold), sinceBackground: null }
}

/** The prompt answered yes. */
export function unlocked(state: LockMachine): LockMachine {
  return { ...state, locked: false, sinceBackground: null }
}

/**
 * The prompt answered no, was cancelled, or the module refused.
 *
 * A failure changes nothing on purpose. There is no attempt counter and no
 * back-off: the platform owns both — iOS falls back to the device passcode
 * after a run of failed faces and locks biometry out after that — and a
 * counter of our own would only add a second, weaker policy on top of the one
 * already being enforced. What matters is what this does NOT do, which is
 * unlock.
 */
export function unlockFailed(state: LockMachine): LockMachine {
  return state
}

/**
 * The reader changed the setting.
 *
 * Turning it off unlocks, so the plate cannot outlive the preference that put
 * it there. Turning it on leaves the app open: they were holding it when they
 * chose, and demanding a face for the screen they just used reads as the app
 * not having heard them.
 */
export function thresholdChanged(state: LockMachine, threshold: LockThreshold): LockMachine {
  return { threshold, locked: threshold === 'off' ? false : state.locked, sinceBackground: state.sinceBackground }
}
