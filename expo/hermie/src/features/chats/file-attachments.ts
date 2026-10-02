/**
 * Picking an arbitrary file for the composer.
 *
 * Separate from `attachments.ts` because the two go to the gateway by different
 * roads and share nothing but the composer. An image is resized, base64-encoded
 * and handed to `image.attach_bytes` over the socket. A file is not touched at
 * all: upstream has no file-attach RPC, so the bytes go over HTTP and the prompt
 * references where they landed (see `file-upload.ts`, and the 2026-09-19 section
 * of docs/platform-notes.md for why that is the only shape that works).
 *
 * So this module deliberately does NOT read the file. It returns the URI the
 * picker gave it and lets `fetch` stream from there — a 90 MB archive read into
 * a JavaScript string would be the one thing the streaming upload exists to
 * avoid, and base64 would inflate it by a third on the way.
 *
 * There is no "is this supported" flag, for the same reason `attachments.ts` no
 * longer has one: every target this builds for has a picker — UIKit's document
 * picker on the Mac's iPad build, an `<input type="file">` in a browser. Which
 * one, and what it hands back, is `src/platform/attachments-picker.ts`. A flag
 * that is always true only invites a caller to branch on it.
 */
import { openFilePicker } from '../../platform/attachments-picker'
import type { DroppedFile } from '../../platform/file-drop'

export interface PickedFile {
  name: string
  /** Bytes. `0` when the platform did not say; the upload then finds out. */
  size: number
  mimeType: string
  /** A local `file://` URI on the phones, an object URL in a browser. */
  uri: string
  /**
   * The part the upload appends to its `FormData`, exactly as the platform
   * handed it over: a `File` in a browser, React Native's `{uri, name, type}`
   * blob everywhere else. See `src/platform/attachments-picker.ts`.
   */
  body: unknown
}

const FALLBACK_MIME_TYPE = 'application/octet-stream'

function nameFor(uri: string, given: string | null | undefined): string {
  if (given) {
    return given
  }

  const tail = uri.split('/').pop()?.split('?')[0]

  return tail ? decodeURIComponent(tail) : 'attachment'
}

/**
 * Open the document picker and return one file, or `null` when the user backed
 * out.
 *
 * `copyToCacheDirectory` is on, and it is load-bearing rather than a default
 * worth trimming: without it iOS hands back a URI inside the provider's own
 * sandbox, which stops resolving the moment the picker closes — and this
 * function returns before the upload starts.
 */
export async function pickFile(): Promise<PickedFile | null> {
  const picked = await openFilePicker()

  if (!picked?.uri) {
    // Cancelled, or a picker that answered with nothing: not an error, and
    // nothing to show for it.
    return null
  }

  return {
    name: nameFor(picked.uri, picked.name),
    size: Number.isFinite(picked.size) ? picked.size : 0,
    mimeType: picked.mimeType || FALLBACK_MIME_TYPE,
    uri: picked.uri,
    body: picked.body
  }
}

/**
 * A dropped file, as the same thing the picker produces.
 *
 * The two roads into the composer are a document picker and a drag from the
 * Finder, and they differ only in how the URI was obtained — the native side
 * has already copied the bytes somewhere that outlives the gesture. So the drop
 * is normalised HERE rather than at the call site, and everything downstream
 * (the chip, the upload, the prompt) stays a single path.
 */
export function droppedFile(file: DroppedFile): PickedFile {
  return {
    name: nameFor(file.uri, file.name),
    size: Number.isFinite(file.size) ? file.size : 0,
    mimeType: file.mimeType || FALLBACK_MIME_TYPE,
    uri: file.uri,
    // A browser drop already carries the `File`, and only that object can be
    // streamed by a browser's `FormData` — rebuilding the React Native blob
    // over the top of it would fail at the upload. Everywhere else there is no
    // body and the `{uri}` shape is what streams from disk.
    body: file.body ?? { uri: file.uri, name: file.name || 'attachment', type: file.mimeType || FALLBACK_MIME_TYPE }
  }
}
