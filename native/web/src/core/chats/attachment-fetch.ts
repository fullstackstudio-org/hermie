/**
 * Fetching what a message's attachment names, through the gateway's own routes.
 *
 * An attachment is a reference (`@file:/root/uploads/x.pdf`, `@image:/root/.hermes/images/upload_1.png`,
 * the `[Image attached at: <path>]` handle the gateway writes for an attached image, or a
 * `/api/files/…` path an agent put in a reply). The reference names a place on the gateway's disk, and
 * the gateway serves what its own policy allows through two routes:
 *
 *  - `GET /api/files/download?path=<absolute path>`: the managed-files route, where an upload went to;
 *  - `GET /api/media?path=<absolute path>`: a picture under its images, screenshots and cache folders,
 *    answered as JSON with a `data_url`.
 *
 * A picture an image attached to a chat names by the gateway's own `images/` folder has a third, narrower
 * route that works where the managed-files root is locked: `GET /api/files/images/<name>?profile=<profile>`
 * (`attachedImageRoute`). It is asked FIRST, and only for a path whose folder is that profile's `images/`
 * folder (never the file name of some other path: a file of that name there would be a different picture);
 * the two routes above are what is left for every other path, and for a gateway that does not have it.
 *
 * All are asked with the page's own credentials (`GatewayHttp.fetchAuthenticatedPicture`), never from
 * the reference's own address: a web address is never fetched (the sender is untrusted, and a request is
 * a way to say "this person read it"), and a path that climbs is not asked for at all.
 *
 * What comes back is judged by its first bytes, not by its name: an image dropped from a screenshot tool
 * has no extension, and a file called `.png` may be anything. A picture the browser can draw
 * (png, jpeg, gif, webp) is an `image` the viewer opens; anything else is a `file` to save.
 */
import { handleName, sniffImageType } from '@hermie/transcript'

/** What the gateway's `fetchAuthenticatedPicture` answers. */
export type FetchedPicture = { kind: 'ready'; dataUri: string } | { kind: 'missing' } | { kind: 'error' }

export interface AttachmentFetcher {
  fetchPicture(path: string): Promise<FetchedPicture>
}

export type LoadedAttachment =
  /** A picture the browser can draw, as a `data:` URI of a type it will accept. */
  | { kind: 'image'; src: string; name: string }
  /** Anything else, to be saved. */
  | { kind: 'file'; blob: Blob; name: string }

/** The largest file held in memory for a tap, in bytes of the encoded answer. */
export const ATTACHMENT_MAX_ENCODED = 140 * 1024 * 1024

/** At most this many references are held, by their reference. */
const CACHE_LIMIT = 48
/** At most this many are fetched at once. */
const CONCURRENCY = 3

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/iu
const DRAWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The reference without its `@file:` / `@image:` marker and its quotes. */
export function unwrapReference(reference: string): string {
  return reference
    .trim()
    .replace(/^@(?:file|image):/u, '')
    .replace(/^[`"']|[`"']$/gu, '')
}

/** Whether a reference names a picture by its marker or its extension. */
export function namesAPicture(reference: string): boolean {
  const value = unwrapReference(reference)

  return reference.trim().startsWith('@image:') || IMAGE_EXTENSION.test(value.split(/[?#]/u, 1)[0] ?? '')
}

/** What to ask the gateway for, or `null` when the reference is a name and nothing more. */
export function attachmentRoute(reference: string): { primary: string; media: string | null; name: string } | null {
  const value = unwrapReference(reference)
  const name = handleName(value)

  if (!value || /[\\\0]/u.test(value) || value.startsWith('//')) {
    return null
  }

  // What the gateway serves under its own path (a reply's `/api/files/chart.png`): asked as it is, never climbing.
  if (/^\/?api\/files\//u.test(value)) {
    const path = value.startsWith('/') ? value : `/${value}`

    return /(?:^|\/)\.\.?(?:\/|$)|%2e|%2f|%5c/iu.test(path) ? null : { primary: path, media: null, name }
  }

  if (!value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.')) {
    return null
  }

  const query = encodeURIComponent(value).replace(/%2F/gu, '/')

  return {
    primary: `/api/files/download?path=${query}`,
    media: IMAGE_EXTENSION.test(name) ? `/api/media?path=${query}` : null,
    name
  }
}

/** What `get_attached_image` takes as a name: one component, no `..`, an image suffix of the six it serves. */
const ATTACHED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u
const ATTACHED_SUFFIX = /\.(?:png|jpe?g|gif|webp|bmp)$/iu
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u

/**
 * The gateway's attached-image route for a reference, or `null` when its path is not one of `profile`'s own
 * attached images.
 *
 * An attached image is written to `<profile home>/images/<file>`, and the home is `<HERMES_HOME>` for the
 * default profile (`default`) or `<HERMES_HOME>/profiles/<name>` for any other. The client cannot see the
 * disk, so it reads the shape and refuses anything it cannot be sure of:
 *
 *  - the path is absolute, whole (no `.`/`..`, no empty or backslash part) and ends `images/<file>`, the file
 *    being a name the route serves (one component, an image suffix);
 *  - for `default`, no part of the folder above `images` is `profiles` (that is another profile's), and it is
 *    not itself called `images` (`<home>/images/images/<file>` is not `<home>/images/<file>`);
 *  - for any other profile, the folder above `images` is `profiles/<that profile>`, so a path in the default
 *    profile's folder, or in another profile's, is refused: the route would serve a different file of that
 *    name, or none.
 */
export function attachedImageRoute(reference: string, profile: string): string | null {
  const value = unwrapReference(reference)

  // `/api/files/…` is what the gateway itself serves (asked as it is), never a place on its disk.
  if (
    !PROFILE_NAME.test(profile) ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/api/files/') ||
    /[\\\0?#%]/u.test(value)
  ) {
    return null
  }

  const parts = value.slice(1).split('/')

  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return null
  }

  const file = parts.at(-1) ?? ''
  const home = parts.slice(0, -2)

  if (parts.length < 3 || parts.at(-2) !== 'images' || !ATTACHED_NAME.test(file) || file.includes('..')) {
    return null
  }

  if (!ATTACHED_SUFFIX.test(file)) {
    return null
  }

  const own =
    profile === 'default'
      ? !home.includes('profiles') && home.at(-1) !== 'images'
      : home.length >= 2 && home.at(-2) === 'profiles' && home.at(-1) === profile

  return own ? `/api/files/images/${file}?profile=${encodeURIComponent(profile)}` : null
}

function splitDataUri(uri: string): { type: string; base64: string } | null {
  const comma = uri.indexOf(',')

  if (!uri.startsWith('data:') || comma < 0) {
    return null
  }

  return { type: uri.slice(5, comma).split(';', 1)[0] ?? '', base64: uri.slice(comma + 1) }
}

function headOf(base64: string): number[] {
  const usable = Math.min(32, Math.floor(base64.length / 4) * 4)

  try {
    return usable < 4 ? [] : Array.from(atob(base64.slice(0, usable)), char => char.charCodeAt(0))
  } catch {
    return []
  }
}

function toBlob(base64: string, type: string): Blob | null {
  try {
    const raw = atob(base64)
    const bytes = new Uint8Array(raw.length)

    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index)
    }

    return new Blob([bytes], { type: type || 'application/octet-stream' })
  } catch {
    return null
  }
}

/** A `data:` URI the gateway answered with, judged by its bytes. */
export function judge(uri: string, name: string): LoadedAttachment | null {
  const parts = splitDataUri(uri)

  if (!parts || uri.length > ATTACHMENT_MAX_ENCODED) {
    return null
  }

  const sniffed = sniffImageType(headOf(parts.base64))

  if (sniffed && DRAWABLE.has(sniffed)) {
    return { kind: 'image', src: `data:${sniffed};base64,${parts.base64}`, name }
  }

  const blob = toBlob(parts.base64, sniffed ?? parts.type)

  return blob ? { kind: 'file', blob, name } : null
}

/** The picture inside a `/api/media` answer (`{"data_url": "data:image/png;base64,…"}`). */
function mediaPicture(uri: string): string | null {
  const parts = splitDataUri(uri)

  if (!parts) {
    return null
  }

  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(parts.base64), char => char.charCodeAt(0)))
    const answer = JSON.parse(text) as { data_url?: unknown }

    return typeof answer.data_url === 'string' ? answer.data_url : null
  } catch {
    return null
  }
}

/**
 * One fetch of a reference: the attached-image route for a picture in the chat's profile's own `images/`
 * folder (`profile` known), then the files route, then the picture route for a picture. `null`: it cannot
 * be had.
 */
export async function fetchAttachment(
  fetcher: AttachmentFetcher,
  reference: string,
  profile?: string
): Promise<LoadedAttachment | null> {
  const route = attachmentRoute(reference)

  if (!route) {
    return null
  }

  const attached = profile === undefined ? null : attachedImageRoute(reference, profile)

  if (attached) {
    const own = await fetcher.fetchPicture(attached)

    if (own.kind === 'ready') {
      return judge(own.dataUri, route.name)
    }
  }

  const first = await fetcher.fetchPicture(route.primary)

  if (first.kind === 'ready') {
    return judge(first.dataUri, route.name)
  }

  if (route.media) {
    const second = await fetcher.fetchPicture(route.media)
    const uri = second.kind === 'ready' ? mediaPicture(second.dataUri) : null

    return uri ? judge(uri, route.name) : null
  }

  return null
}

/**
 * A loader that shares what it fetched and fetches a few at a time: two rows (or a row and the viewer)
 * asking for one file make one request, and a chat with thirty pictures does not ask for them all at
 * once. A refusal is not kept, so the next tap asks again.
 */
export function createAttachmentLoader(
  fetcher: AttachmentFetcher,
  profile?: string
): (reference: string) => Promise<LoadedAttachment | null> {
  const held = new Map<string, Promise<LoadedAttachment | null>>()
  const waiting: (() => void)[] = []
  let running = 0

  const acquire = (): Promise<void> => {
    if (running < CONCURRENCY) {
      running += 1

      return Promise.resolve()
    }

    return new Promise(resolve => waiting.push(resolve))
  }
  const release = (): void => {
    const next = waiting.shift()

    if (next) {
      next()
    } else {
      running -= 1
    }
  }

  return reference => {
    const known = held.get(reference)

    if (known) {
      return known
    }

    const task = (async () => {
      await acquire()

      try {
        return await fetchAttachment(fetcher, reference, profile)
      } catch {
        return null
      } finally {
        release()
      }
    })()

    held.set(reference, task)

    if (held.size > CACHE_LIMIT) {
      const oldest = held.keys().next().value

      if (oldest !== undefined) {
        held.delete(oldest)
      }
    }

    void task.then(result => {
      if (result === null && held.get(reference) === task) {
        held.delete(reference)
      }
    })

    return task
  }
}
