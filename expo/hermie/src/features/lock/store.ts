/**
 * The app lock, as one store: the preference, the plate's up-or-down, and the
 * one call that asks the device to prove who is holding it.
 *
 * Every decision about WHEN is in `lock-state.ts` and is pure. What is here is
 * the part that cannot be: reading the preference off disk, following the app
 * lifecycle, and the prompt itself.
 *
 * **The preference is per device and is never synced.** ADR-0016 carries the
 * app-wide settings section to the gateway so a second device inherits the
 * theme and the verbosity; a lock must not travel that way. It is a statement
 * about one piece of hardware and the person holding it — a phone with Face ID
 * and a Mac in a locked study are not the same question — and a lock that
 * arrived from somewhere else is a lock nobody in the room chose. So it has its
 * own key, it is not part of `HermieAppSection`, and `store/ui-meta-bridge.ts`
 * does not know it exists.
 */
import { AppState, type AppStateStatus } from 'react-native'
import { create } from 'zustand'

import { strings } from '../../i18n/strings'
import { keyValueStore } from '../../platform/key-value-store'
import { biometrics } from '../../platform/biometrics'
import type { BiometricEnrolment } from '../../platform/platform-contracts'
import {
  background,
  DEFAULT_LOCK_THRESHOLD,
  foreground,
  isLockThreshold,
  type LockMachine,
  type LockThreshold,
  start,
  thresholdChanged,
  unlockFailed,
  unlocked
} from './lock-state'

/** Where the threshold lives. Its own key, in the plain preference store. */
export const APP_LOCK_KEY = 'hermie.lock'

interface PersistedLock {
  threshold: LockThreshold
}

export interface LockState {
  machine: LockMachine
  /**
   * False until the preference has been read.
   *
   * The gate draws NOTHING while this is false — not the app and not the plate.
   * Drawing the app would flash a transcript at anyone who enabled the lock;
   * drawing the plate would flash a lock screen at everyone who did not. The
   * splash colour under both is the same, so the third option is invisible.
   */
  ready: boolean
  /**
   * True while the platform prompt is on screen.
   *
   * It is a guard, not a spinner. The prompt itself takes the app out of the
   * active state on both platforms, and without this the resulting `inactive`
   * would re-lock the app underneath its own Face ID sheet — an unlock that can
   * never finish because asking is what breaks it.
   */
  prompting: boolean
  /** What this device can offer, once asked. `null` before the first check. */
  enrolment: BiometricEnrolment | null
  hydrate: () => Promise<void>
  /** Follow the app lifecycle. Returns its own unsubscribe. */
  watchLifecycle: () => () => void
  /** Ask the device. Answers whether the app is now open. */
  unlock: () => Promise<boolean>
  /** Re-read what the hardware offers; also the settings screen's check. */
  checkEnrolment: () => Promise<BiometricEnrolment>
  /**
   * Change the preference. HERM-106: authenticates FIRST, in both directions
   * and with `off` included, so the picker itself is the proof rather than a
   * segmented control anyone could tap past.
   *
   * Answers false — having changed nothing, in the stored preference or in
   * `machine` — when the device has nothing to unlock with (switching a lock
   * on with no face, no finger and no passcode enrolled would close the app
   * behind a plate the device cannot open) or when the prompt was refused,
   * cancelled, or could not run.
   */
  changeThreshold: (threshold: LockThreshold) => Promise<boolean>
}

export const useLockStore = create<LockState>((set, get) => ({
  machine: start('off'),
  ready: false,
  prompting: false,
  enrolment: null,

  async hydrate() {
    let threshold: LockThreshold = DEFAULT_LOCK_THRESHOLD

    try {
      const stored = await keyValueStore.getJson<PersistedLock>(APP_LOCK_KEY)

      if (isLockThreshold(stored?.threshold)) {
        threshold = stored.threshold
      }
    } catch {
      // An unreadable preference is an unlocked app. The alternative — failing
      // closed on a disk error — locks somebody out of their own chats over a
      // corrupt JSON blob, with no way to reach the setting that would fix it.
    }

    // `start` locks whatever the threshold says, including `15m`: see the note
    // on it. This is also the ONE place `ready` is set, so the gate's blank
    // frame lasts exactly one disk read.
    set({ machine: start(threshold), ready: true })

    if (threshold !== 'off' && biometrics.available) {
      void get().unlock()
    }
  },

  watchLifecycle() {
    const onChange = (next: AppStateStatus) => {
      // The prompt takes the app out of `active` on its own. Reacting to that
      // is how an unlock becomes unfinishable.
      if (get().prompting) {
        return
      }

      if (next === 'active') {
        const before = get().machine
        const after = foreground(before, Date.now())

        set({ machine: after })

        if (after.locked && !before.locked) {
          void get().unlock()
        }

        return
      }

      /*
        `inactive` counts as going away, and not only `background`.

        `inactive` is the transition the app-switcher snapshot is taken on, and
        it is the one a Mac window reports when it loses focus. Locking only on
        `background` would put the transcript in the card the switcher shows,
        which is the one place a lock is supposed to be looking.
      */
      set({ machine: background(get().machine, Date.now()) })
    }

    const subscription = AppState.addEventListener('change', onChange)

    return () => subscription.remove()
  },

  async checkEnrolment() {
    const enrolment = await biometrics.enrolment()

    set({ enrolment })

    return enrolment
  },

  async unlock() {
    if (get().prompting || !get().machine.locked) {
      return !get().machine.locked
    }

    set({ prompting: true })

    try {
      const verdict = await biometrics.authenticate(strings.lock.prompt)

      if (verdict === 'ok') {
        set({ machine: unlocked(get().machine) })

        return true
      }

      /*
        A module that cannot run is treated as a refusal, not as an excuse.

        The alternative is to open the app when the prompt is unavailable, which
        turns every way of breaking the module into a way past the lock. The
        reader is not stranded: the enrolment check refuses to switch the lock
        ON without something to unlock it, so the only route into this state is
        a device that lost its passcode after the fact, and the plate says what
        to do about it.
      */
      set({ machine: unlockFailed(get().machine) })

      return false
    } finally {
      set({ prompting: false })
    }
  },

  async changeThreshold(threshold) {
    // Not reachable from the picker page, which never calls this for the
    // value already in force — but a store method has to hold on its own,
    // and stacking this prompt on top of the lifecycle watcher's would be
    // exactly the bug the `prompting` guard exists to prevent.
    if (get().prompting) {
      return false
    }

    if (threshold !== 'off') {
      const enrolment = await get().checkEnrolment()

      if (enrolment === 'unavailable' || enrolment === 'none') {
        return false
      }
    }

    /*
      `off` prompts too. A lock is a promise to whoever is in the room that
      the transcript needs a face to open, and switching it off is the one
      change that promise cannot survive unauthenticated: anyone holding an
      unlocked phone could reach this row and turn the lock off on someone
      else's behalf. Nothing is skipped for `off` except the enrolment gate
      above, which exists to keep the lock from being switched ON behind a
      plate the device cannot open — a question `off` does not ask.
    */
    set({ prompting: true })

    try {
      const verdict = await biometrics.authenticate(strings.lock.prompt)

      if (verdict !== 'ok') {
        return false
      }
    } finally {
      set({ prompting: false })
    }

    set({ machine: thresholdChanged(get().machine, threshold) })

    try {
      await keyValueStore.setJson(APP_LOCK_KEY, { threshold } satisfies PersistedLock)
    } catch {
      // The setting holds for this launch and resets on the next one, which is
      // the failure mode every other preference in the app already has.
    }

    return true
  }
}))
