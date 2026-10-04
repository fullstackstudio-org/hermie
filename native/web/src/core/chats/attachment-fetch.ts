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
 * Both are asked with the page's own credentials (`GatewayHttp.fetchAuthenticatedPicture`), never from
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

/** One fetch of a reference: the files route, then the picture route for a picture. `null`: it cannot be had. */
export async function fetchAttachment(fetcher: AttachmentFetcher, reference: string): Promise<LoadedAttachment | null> {
  const route = attachmentRoute(reference)

  if (!route) {
    return null
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
  fetcher: AttachmentFetcher
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
        return await fetchAttachment(fetcher, reference)
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
