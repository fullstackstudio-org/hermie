/**
 * A remote attachment, brought down to a local file so it can be looked at.
 *
 * ## Why this is JavaScript and not Swift
 *
 * `QLPreviewController` reads a URL directly, so a remote attachment has to be
 * fetched to disk first — and `HermieQuickLook.swift` used to do the fetching
 * with a bare `URLSession.shared.data(from:)`. That fetch carried no
 * `Authorization` header, no front-door header and no cookie, which on a gated
 * gateway is not "a file that fails to preview" but a request that could never
 * have succeeded. Reproducing the credential ladder in Swift would mean a
 * second implementation of the thing `GatewayHttp` exists to be: the bearer,
 * the operator's extra headers, and the one 401 retry that asks the credential
 * provider for a fresh token before giving up.
 *
 * So the download moved here, where that client already is, and the Swift was
 * left doing the one thing only it can: presenting a previewer over the topmost
 * view controller. It now takes `file://` and nothing else.
 *
 * ## The caches directory, and a directory per fetch
 *
 * A copy of somebody else's file belongs where the system may reclaim it, which
 * is `Paths.cache` — the same reasoning `share-text.ts` gives for exports.
 *
 * Each fetch gets a directory of its own, named by the clock and a counter,
 * because two attachments can be called the same thing and the second must not
 * overwrite the first while the first is open in a previewer. Nothing deletes
 * these: a reader who chose "Save to Files" from inside the preview is still
 * reading from the copy, and deleting it out from under them would be a race
 * this has no way to win.
 *
 * ## The filename is the app's, and that is load-bearing
 *
 * Quick Look picks a previewer from the EXTENSION. A gateway route ending in
 * `/download` or `/attachments/7` previews as nothing at all, so the file is
 * written under the name the transcript knows.
 */
import { Directory, File, Paths } from 'expo-file-system'

/** Where previews land, so one reader's session can be reclaimed together. */
const PREVIEW_DIRECTORY = 'attachment-previews'

/** Enough to keep two fetches in the same millisecond apart. */
let sequence = 0

/**
 * A safe last path component built from the name the app knows.
 *
 * Everything that could make a path mean something other than a leaf is taken
 * out: a separator, a leading dot, and the two dots that climb. A name that is
 * nothing but those answers a constant, because a file still has to be written
 * somewhere and an extensionless one simply previews as plain data.
 */
export function previewFileName(name: string): string {
  const flattened = name
    .replace(/[/\\]+/g, '_')
    .replace(/^\.+/, '')
    .trim()

  return flattened.length > 0 ? flattened.slice(0, 120) : 'attachment'
}

/**
 * Fetch `url` into the caches directory and answer its `file://` URI.
 *
 * `null` for anything that did not end in a readable local file: a refusal, a
 * gateway that is not there, a caches directory that cannot be written to. The
 * caller treats that as "there is nothing to open", which is what it is —
 * there is no second thing to try, because the share sheet would have been
 * offered the same remote URL this could not fetch.
 */
export async function cacheRemoteAttachment(
  url: string,
  name: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    sequence += 1

    const folder = new Directory(Paths.cache, PREVIEW_DIRECTORY, `${Date.now()}-${sequence}`)

    folder.create({ intermediates: true })

    const target = new File(folder, previewFileName(name))
    const downloaded = await File.downloadFileAsync(url, target, { headers })

    return downloaded.uri
  } catch {
    return null
  }
}
