/**
 * Hold to talk, or tap to toggle — decided from two timestamps.
 *
 * One microphone button, two gestures people expect from it, and they have to
 * coexist without a mode switch:
 *
 *  - **Hold to talk.** Press, speak, let go. The walkie-talkie, and the one
 *    that is right when you are dictating one sentence into a half-written
 *    message: your finger is the end of the utterance, so nothing has to be
 *    tapped again and nothing keeps listening if you get distracted.
 *  - **Tap to toggle.** Tap, speak for a while, tap again. Right for a long
 *    message, and the only one available to somebody who cannot hold a button
 *    steadily.
 *
 * The rule is one number: a press that was released **quickly** leaves the
 * recognizer running, and one that was **held** stops it. That is exactly how
 * the platform keyboards' own dictation keys behave, and it needs no mode and no
 * setting.
 *
 * `HOLD_MS` is the whole of the design, so it is worth saying what it is
 * balanced against. Too low and a deliberate tap on a slow finger reads as a
 * hold, so the recognizer stops before the reader has said anything — which
 * looks like a button that does not work. Too high and a short "yes, send it"
 * held down reads as a tap and the microphone stays on after the finger leaves,
 * which is worse. 400ms is comfortably longer than a tap and comfortably shorter
 * than anything anybody says.
 *
 * Pure, and it takes its own clock, because the interesting cases are all about
 * milliseconds and a test should not have to wait for them.
 */

/** Longer than this, and letting go stops the recognizer. */
export const HOLD_MS = 400

export type PressOutcome = 'start' | 'stop' | 'none'

export interface PressState {
  /** When the current press went down, or `null` between presses. */
  downAt: number | null
  /** Whether this press is the one that started the session. */
  startedHere: boolean
}

export const PRESS_IDLE: PressState = { downAt: null, startedHere: false }

/**
 * A finger going down.
 *
 * On a session that is already running this is the second tap of a toggle, and
 * it stops — `startedHere` is false, so the release that follows does nothing.
 */
export function pressIn(state: PressState, listening: boolean, now: number): { state: PressState; do: PressOutcome } {
  if (listening) {
    return { state: { downAt: now, startedHere: false }, do: 'stop' }
  }

  return { state: { downAt: now, startedHere: true }, do: 'start' }
}

/**
 * And coming off.
 *
 * Only a press that STARTED the session can stop it, which is what keeps the
 * release of a toggling-off tap from immediately re-stopping something that is
 * already idle — and what keeps a press that arrived while the permission
 * dialog was up from cutting the session it was granted for.
 */
export function pressOut(state: PressState, now: number): { state: PressState; do: PressOutcome } {
  if (!state.startedHere || state.downAt === null) {
    return { state: PRESS_IDLE, do: 'none' }
  }

  return { state: PRESS_IDLE, do: now - state.downAt >= HOLD_MS ? 'stop' : 'none' }
}
