/**
 * The browser half of `share-text.ts`. Read that file first.
 *
 * A page has no share sheet and no file system, so the text becomes a `Blob`,
 * the blob becomes an object URL, and `share-file.web.ts` clicks an `<a
 * download>` at it — which is the same mechanism a browser's own "Save as"
 * uses and the only one that does not navigate the tab away from the
 * conversation.
 *
 * The object URL is revoked afterwards, on a timer rather than immediately.
 * Revoking in the same tick as the click races the browser's own read of the
 * blob in Safari and lands as a download of zero bytes; a moment later it has
 * been read and the memory can go.
 */

import { shareFile } from './share-file'

export { SHARE_FILE_VERB } from './share-file'

/**
 * How long the object URL is kept alive after the click.
 *
 * Long enough for any browser to have started reading the blob, short enough
 * that a reader exporting several chats does not hold all of them in memory.
 */
const REVOKE_AFTER_MS = 30_000

export async function shareText(name: string, content: string, mimeType = 'text/markdown'): Promise<boolean> {
  if (!name || !content || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    return false
  }

  // `charset=utf-8` on purpose: without it a browser saving the file labels it
  // with the platform default, and a conversation is full of characters that
  // are not in one.
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }))

  try {
    return await shareFile(url, name)
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
  }
}
