/**
 * The browser's answers to the two questions `keyboard-modifiers.ts` asks.
 *
 * Read that file first. The difference here is that a browser answers BOTH of
 * them itself — a `keydown` carries `shiftKey`, `metaKey` and `ctrlKey`, and
 * Escape reaches `window` whatever has focus — so nothing in this file talks to
 * a native module and `isShiftDown` is never the thing that decides a Return.
 *
 * ## Why `hasHardwareKeyboard` is a question about the POINTER
 *
 * It decides one thing: whether a bare Return sends the message or breaks the
 * line (`chat-ui/send-key.ts`). On a laptop the answer is "sends" — that is
 * what every messenger in a tab does, and the shared table already says so for
 * a keyboard case on an iPad. On a phone browser the answer must stay "breaks
 * the line", for the same reason it does on the native phone build: the Return
 * on a software keyboard is the key people use to write a second line, and
 * taking it away leaves a reader with no way to write one at all.
 *
 * There is no browser API for "a physical keyboard is attached". The closest
 * honest proxy is the PRIMARY POINTER: `pointer: fine` means a mouse or a
 * trackpad, which in practice means a machine with keys. It is a heuristic and
 * it is wrong for exactly one arrangement — a tablet with a trackpad case, where
 * Return will send and Shift+Return still breaks the line — which is the
 * gentler of the two ways to be wrong.
 *
 * It is read on every call rather than cached: a window moved to a second
 * display, or a tablet whose case is attached mid-session, changes the answer
 * and nothing re-mounts.
 */

/**
 * Whether Shift is down right now.
 *
 * Always false, and deliberately so. On this platform the key event itself
 * carries `shiftKey`, so the composer never has to poll for it — and a poll
 * that could only ever guess would be worse than the flag it would override.
 */
export function isShiftDown(): boolean {
  return false
}

export function hasHardwareKeyboard(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true
  } catch {
    // A browser with no `matchMedia` is old enough that the softer answer — a
    // Return that breaks the line — is the safer of the two.
    return false
  }
}

/**
 * Every Escape press, while the document has focus.
 *
 * `window` rather than the focused element, and in the CAPTURE phase, for the
 * same reason the native side reads HID state rather than the responder chain:
 * the thing Escape usually has to close is a sheet or a popover that is not
 * where the caret is.
 */
export function subscribeToEscape(handler: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      handler()
    }
  }

  window.addEventListener('keydown', listener, true)

  return () => window.removeEventListener('keydown', listener, true)
}
