/**
 * Reading a browser's `paste` event for files, off the composer's own field.
 *
 * A no-op everywhere but the web: React Native's `TextInput` fires no DOM event
 * at all on the phones or the Mac, so there is no node to bind a listener to and
 * nothing this function could do. See `platform/native-paste.ts` for how ⌘V
 * reaches the composer there instead — a keyboard shortcut reported below the
 * responder chain, rather than a `ClipboardEvent`.
 *
 * Nothing imports this file directly; import `./composer-paste` and let the
 * bundler pick.
 */
import type { DroppedFile } from './file-drop.shared'

export type { DroppedFile } from './file-drop.shared'

/** Nothing to bind to on this platform; the caller gets a harmless unsubscribe. */
export function attachPasteListener(_node: unknown, _onFiles: (files: DroppedFile[]) => void): () => void {
  return () => undefined
}
