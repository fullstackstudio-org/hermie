/**
 * The browser's answer to `native-paste.ts`. Read that file first.
 *
 * A browser reads its own pasteboard through the DOM `paste` event's
 * `clipboardData` — see `composer-paste.web.ts` — so there is no ⌘V shortcut to
 * report here and nothing to ask a native module for. Both exports are the
 * honest "not on this platform" answer, kept in the same shape as the native
 * side so a caller does not have to know which one it got.
 */
import type { DroppedFile } from './file-drop.shared'

export type { DroppedFile } from './file-drop.shared'

/** The browser has no pasteboard-reading shortcut of its own to ask for. */
export const HAS_NATIVE_PASTEBOARD = false

export async function readPasteboardAttachment(): Promise<DroppedFile[]> {
  return []
}
