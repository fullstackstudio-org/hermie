/**
 * What a hardware keyboard is doing, for the two questions UIKit will not answer
 * through a React Native `TextInput`.
 *
 * Both come from the local module in `expo/hermie/modules/hermie-mac`, which
 * reads GameController's HID state rather than the responder chain:
 *
 * - **`isShiftDown()`** is polled while handling a Return, because a text field's
 *   key event carries no modifier state on iOS — so Shift+Return and Return
 *   arrive as the same `"\n"` and are otherwise indistinguishable.
 * - **`subscribeToEscape()`** is pushed, because Escape inserts no text and so
 *   never reaches a text field's delegate at all. A `UIKeyCommand` would have to
 *   sit in the responder chain, which a presented `Modal` leaves — and a sheet is
 *   the main thing Escape should close.
 *
 * Everything degrades to "no keyboard": `false`, and a subscription that never
 * fires. That is the honest answer on a phone with nothing attached, in the Jest
 * environment and on Android, which is why none of this needs a platform check
 * of its own — keyboard presence is the question, not the operating system.
 */
import { requireOptionalNativeModule } from 'expo'

type MacKeyboardModule = {
  isShiftDown?: () => boolean
  hasHardwareKeyboard?: () => boolean
  addListener?: (event: string, listener: () => void) => { remove: () => void }
}

// A registry read, not a load: calling it twice hands back the same object, so
// `runs-on-mac.ts` asking separately costs nothing.
function nativeModule(): MacKeyboardModule | null {
  try {
    return requireOptionalNativeModule<MacKeyboardModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

/** Whether either Shift key is down right now. */
export function isShiftDown(): boolean {
  try {
    return mac?.isShiftDown?.() === true
  } catch {
    return false
  }
}

/** Whether a hardware keyboard is attached. Reported on the developer screen. */
export function hasHardwareKeyboard(): boolean {
  try {
    return mac?.hasHardwareKeyboard?.() === true
  } catch {
    return false
  }
}

/**
 * Every Escape press, while the app is in front. Returns the unsubscribe.
 *
 * Callers should go through `useEscapeKey`, which keeps one native subscription
 * and decides which of several open things the key belongs to.
 */
export function subscribeToEscape(handler: () => void): () => void {
  const subscription = mac?.addListener?.('onEscape', handler)

  return () => subscription?.remove()
}
