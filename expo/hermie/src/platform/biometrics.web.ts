/**
 * There is no app lock in a browser, and pretending otherwise would be worse
 * than not having one.
 *
 * WebAuthn can prove a person is present, but what it protects is a server's
 * idea of a session — it cannot stop anything on this page being read, because
 * the page and the thing that would enforce the lock are the same JavaScript.
 * A tab is closed and a screen is locked by the operating system; a plate this
 * app drew over its own DOM is one devtools panel away from being removed.
 *
 * So the seam answers "there is no such prompt here", the settings screen shows
 * a note instead of the picker, and `features/lock/store.ts` never leaves `off`.
 */
import type { Biometrics, BiometricEnrolment, BiometricVerdict } from './platform-contracts'

export type { Biometrics, BiometricEnrolment, BiometricVerdict } from './platform-contracts'

export const biometrics: Biometrics = {
  available: false,

  async enrolment(): Promise<BiometricEnrolment> {
    return 'unavailable'
  },

  async authenticate(): Promise<BiometricVerdict> {
    return 'unavailable'
  }
}
