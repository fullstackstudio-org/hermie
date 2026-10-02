/**
 * The browser half of `share-file.ts`. Read that file first.
 *
 * A page has no share sheet, so the action is a download: an `<a download>`
 * clicked once and thrown away, which is the same mechanism a browser's own
 * "Save image as" uses and the only one that does not navigate the tab away
 * from the conversation.
 *
 * `download` is honoured only for a same-origin URL or a `blob:` — which is
 * exactly what an attachment here is, since the composer's thumbnails are
 * object URLs and a gateway image is fetched from the gateway's own origin.
 * For anything else the browser ignores the attribute and navigates instead,
 * so those open in a new tab rather than replacing the page under the reader.
 */

/** What the action is called on this platform, for a menu item or a hint. */
export const SHARE_FILE_VERB: 'share' | 'download' = 'download'

const SAME_ORIGIN_OR_BLOB = /^blob:/i

function isDownloadable(uri: string): boolean {
  if (SAME_ORIGIN_OR_BLOB.test(uri)) {
    return true
  }

  try {
    return new URL(uri, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export async function shareFile(uri: string, name?: string): Promise<boolean> {
  if (!uri || typeof document === 'undefined') {
    return false
  }

  const anchor = document.createElement('a')

  anchor.href = uri

  if (isDownloadable(uri)) {
    // An empty string is a valid value and means "use the server's filename";
    // a name is better when there is one, because an object URL has none at all
    // and would otherwise be saved as a random token.
    anchor.download = name ?? ''
  } else {
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
  }

  // Off-document is fine for a click, unlike a file input, and leaves nothing
  // behind if the click throws.
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  return true
}
