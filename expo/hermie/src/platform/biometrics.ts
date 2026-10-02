/**
 * Face ID, Touch ID, Optic ID, Android's BiometricPrompt — and the device
 * passcode behind all of them.
 *
 * `expo-local-authentication` is asked exactly two things. Which of them
 * answers "is this usable" is worth stating, because the obvious pair is the
 * wrong one: `hasHardwareAsync()` plus `isEnrolledAsync()` says whether a
 * BIOMETRIC is enrolled and answers false on a phone with a passcode and no
 * face — which is a phone this lock works perfectly well on. `getEnrolledLevelAsync()`
 * is the question actually being asked: `NONE`, `SECRET` (a PIN, a pattern, a
 * passcode) or one of the two biometric levels.
 *
 * `disableDeviceFallback` stays at its default of false, which is what makes
 * the platform offer "Enter Passcode" after a face it does not recognise. The
 * alternative — handling the fallback here — would mean this app collecting a
 * device passcode, which it has no business ever seeing.
 */
import * as LocalAuthentication from 'expo-local-authentication'

import type { Biometrics, BiometricEnrolment, BiometricVerdict } from './platform-contracts'

export type { Biometrics, BiometricEnrolment, BiometricVerdict } from './platform-contracts'

export const biometrics: Biometrics = {
  available: true,

  async enrolment(): Promise<BiometricEnrolment> {
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync()

      if (level === LocalAuthentication.SecurityLevel.NONE) {
        // Nothing enrolled. Whether there is hardware decides which of the two
        // sentences the settings screen prints — "this device cannot" versus
        // "set up a passcode first" — and only the second is actionable.
        return (await LocalAuthentication.hasHardwareAsync()) ? 'none' : 'unavailable'
      }

      return level === LocalAuthentication.SecurityLevel.SECRET ? 'passcode' : 'biometric'
    } catch {
      // A module that throws on a platform it was not built for is the same
      // story as a device with no sensor: there is nothing to offer.
      return 'unavailable'
    }
  },

  async authenticate(reason: string): Promise<BiometricVerdict> {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        // Not `true`. The device passcode is the fallback the platform already
        // knows how to collect, and turning it off would strand anyone whose
        // face is not being recognised behind a plate with no way past it.
        disableDeviceFallback: false
      })

      return result.success ? 'ok' : 'failed'
    } catch {
      return 'unavailable'
    }
  }
}
