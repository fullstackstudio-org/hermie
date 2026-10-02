/**
 * Handing a piece of TEXT to the rest of the system, as a file.
 *
 * The layer above `share-file.ts` rather than beside it: that one takes a URI
 * and this one makes the URI first. On the phones and on the Mac's iPad build
 * that means writing into the cache directory and offering the resulting
 * `file://` to the share sheet — which is what puts Files, Mail, Notes and Quick
 * Look in front of the reader without this app knowing any of them exist.
 *
 * ## Why a file rather than `Share.share({ message })`
 *
 * A share sheet given a `message` can only hand it to something that takes
 * text — Messages, Mail's body, a note. It cannot save. A conversation somebody
 * asked to EXPORT is a thing they want to keep, so the destination that matters
 * most is the one a bare string cannot reach.
 *
 * ## The cache directory, deliberately
 *
 * Not `document`, which is backed up and, on iOS with file sharing on, visible
 * in Files for ever. An export is a hand-off: the system copies what it needs
 * the moment the reader picks a destination, and what is left behind is a
 * duplicate of a conversation that already exists on the gateway. The cache is
 * where the operating system is allowed to reclaim it.
 *
 * The browser half is `share-text.web.ts`, and it is a download for the reason
 * that file gives.
 */
import { Directory, File, Paths } from 'expo-file-system'

import { shareFile } from './share-file'

export { SHARE_FILE_VERB } from './share-file'

/** Where exports land, so one round of them can be cleaned up together. */
const EXPORT_DIRECTORY = 'exports'

/**
 * Write `content` to a file called `name` and offer it to the system.
 *
 * Resolves `false` when the file could not be written or the sheet would not
 * open; a sheet the reader dismissed is a `true`, because choosing nothing is a
 * decision rather than a failure — the rule `share-file.ts` states.
 */
export async function shareText(name: string, content: string, _mimeType = 'text/markdown'): Promise<boolean> {
  if (!name || !content) {
    return false
  }

  try {
    const directory = new Directory(Paths.cache, EXPORT_DIRECTORY)

    if (!directory.exists) {
      directory.create({ intermediates: true })
    }

    const file = new File(directory, name)

    // Overwrite rather than uniquify. Two exports of the same chat on the same
    // day are the same file as far as a reader is concerned, and a cache
    // directory that accumulates one copy per tap is a cache nobody asked for.
    file.create({ intermediates: true, overwrite: true })
    file.write(content)

    return await shareFile(file.uri, name)
  } catch {
    // A cache directory that cannot be written to is not worth an error card
    // over: the conversation is still on screen and still on the gateway.
    return false
  }
}
