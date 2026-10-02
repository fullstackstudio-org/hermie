/**
 * Haptics on the web: nothing happens.
 *
 * `navigator.vibrate` exists on some Android browsers and is deliberately NOT
 * used. It is a blunt motor buzz rather than the Taptic punctuation the three
 * moments were designed as, Safari does not have it at all, and Chrome ignores
 * it until the user has interacted with the page — so the honest answer on the
 * web is a no-op that keeps the call sites identical everywhere.
 */
import type { HapticMoment } from './platform-contracts'

export type { HapticMoment } from './platform-contracts'

export function haptic(_moment: HapticMoment): void {
  // No haptic engine in a browser tab. See the note above.
}
