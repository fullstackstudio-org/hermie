/**
 * The pasteboard in a browser.
 *
 * `navigator.clipboard.writeText` is asynchronous and the seam is not, because
 * every caller is a menu item that cannot usefully wait — so the promise is
 * fired and its rejection swallowed, and the return value says only whether the
 * API was there to try. That is the same contract the native side answers, and
 * the same honest "no" on a browser that refuses (no secure context, no user
 * gesture, permission denied).
 */
export function copyToClipboard(text: string): boolean {
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) {
    return false
  }

  try {
    void navigator.clipboard.writeText(text).catch(() => undefined)

    return true
  } catch {
    return false
  }
}
