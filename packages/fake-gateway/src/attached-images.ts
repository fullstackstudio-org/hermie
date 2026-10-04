import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `GET /api/files/images/{name}?profile=<profile>`, by `hermes_cli/web_routers/files.py::get_attached_image`.
 *
 * The images clients attached to a chat live in `<profile home>/images/` (`image.attach_bytes` writes
 * `upload_<ts>_<n>.<ext>` there), and a turn names one by its absolute path. The route serves exactly that
 * folder's files and nothing else, whatever the managed-files root is: `name` is ONE path component with an
 * image suffix, the file has to be a regular file directly in the folder, neither the folder nor the file may
 * be a link, and the answer is 404 for everything it will not serve, with no hint whether the file exists.
 * The semantics are copied, not improved, so a client meets the route's limits here before a gateway does.
 *
 * Which folder is `<profile home>` is the fake's `profileHomes` option: a profile name to a directory on this
 * machine. The paths a test puts in its transcripts (`/root/.hermes/images/…`) never have to exist: the client
 * only reads their shape, and the bytes come from here.
 */

/** `_ATTACHED_IMAGE_NAME_RE`, matched against the whole name. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u

/** `_ATTACHED_IMAGE_TYPES`. */
export const ATTACHED_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** `_ATTACHED_IMAGE_MAX_BYTES`: what `image.attach_bytes` refuses to take, so the route refuses to give. */
export const ATTACHED_IMAGE_MAX_BYTES = 25 * 1024 * 1024

/** What `profiles.normalize_profile_name` + `validate_profile_name` accept. */
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u

export type AttachedImageAnswer =
  { status: 200; contentType: string; body: Buffer } | { status: 400 | 404 | 413; detail: string }

const NOT_FOUND: AttachedImageAnswer = { status: 404, detail: 'Image not found' }

/** The suffix `Path(name).suffix.lower()` gives: from the last dot that is not the first character. */
function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export interface AttachedImageSource {
  /** The profile a request without `profile` is for (the dashboard's own). */
  defaultProfile: string
  /** The profiles this gateway has. */
  profiles: ReadonlySet<string>
  /** A profile's home, where its `images/` folder is. A profile with none has no images. */
  homes: Readonly<Record<string, string>>
}

/** One attached image, or the answer the route gives instead. `profile` is the raw query value, if any. */
export function readAttachedImage(
  source: AttachedImageSource,
  name: string,
  profile: string | null
): AttachedImageAnswer {
  const suffix = suffixOf(name)

  if (!NAME_RE.test(name) || name.includes('..') || !(suffix in ATTACHED_IMAGE_TYPES)) {
    return NOT_FOUND
  }

  const raw = (profile ?? source.defaultProfile).trim() || 'default'
  const canon = raw.toLowerCase()

  if (!PROFILE_RE.test(canon)) {
    return { status: 400, detail: `Invalid profile name: ${raw}` }
  }

  if (!source.profiles.has(canon)) {
    return { status: 404, detail: `Profile '${canon}' does not exist.` }
  }

  const home = source.homes[canon]

  if (home === undefined) {
    return NOT_FOUND
  }

  let imagesDir: string

  try {
    imagesDir = join(realpathSync(home), 'images')
  } catch {
    return NOT_FOUND
  }

  return readFileIn(imagesDir, name, ATTACHED_IMAGE_TYPES[suffix] as string)
}

/** `_read_attached_image`: the file in `imagesDir`, opened without following a link at either step. */
function readFileIn(imagesDir: string, name: string, contentType: string): AttachedImageAnswer {
  try {
    if (lstatSync(imagesDir).isSymbolicLink()) {
      return NOT_FOUND
    }

    const target = join(imagesDir, name)

    if (!lstatSync(target).isFile()) {
      return NOT_FOUND
    }

    // O_NONBLOCK: a FIFO named like an image must not hang the request (it is refused above, but a file can
    // be swapped for one in between).
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)

    try {
      const info = fstatSync(fd)

      if (!info.isFile()) {
        return NOT_FOUND
      }

      if (info.size > ATTACHED_IMAGE_MAX_BYTES) {
        return { status: 413, detail: 'Image is too large' }
      }

      const body = Buffer.alloc(info.size)
      let read = 0

      while (read < info.size) {
        const count = readSync(fd, body, read, info.size - read, read)

        if (count === 0) {
          break
        }

        read += count
      }

      return { status: 200, contentType, body: body.subarray(0, read) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return NOT_FOUND
  }
}
