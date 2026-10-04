/**
 * The files a bot shares, as the page asks for them (`contract/outbox/`).
 *
 * A reply's attachment is `{id, name, kind, size, url, …}` (`@hermie/transcript`, `parseOutboxAttachments`),
 * and its bytes are `GET <gateway>/api/files/outbox/<id>/<name>?profile=<profile>`, answered with the
 * person's own credentials: the session cookie on a gateway with sign-in, `X-Hermes-Session-Token` on one
 * without. Three things follow, and this module is where each is decided:
 *
 *  - **The address** (`outboxHref`): the attachment's own `url`, joined onto the gateway's base URL the way
 *    every other thing a message loads is (`resolveImage`: the gateway's origin, under its base path, no dot
 *    segment, no credentials), with the chat's profile on it. Anything else is `null` and nothing is asked for.
 *  - **Who can load it directly.** An `<img>`, `<video>` or `<audio>` sends the cookie and nothing else, so
 *    with the cookie session the address is the `src` (and a video seeks by byte ranges, which the route
 *    answers). With the shared token there is no header to give an element, so the bytes are fetched with
 *    `fetch` and handed to the element as a `blob:` URL (`OutboxFiles.fetch`). Never `?token=`: an address that
 *    carried the token would be a leaked credential.
 *  - **A PDF is a download, as `file` is.** The route answers a browser that navigates to a PDF with `attachment`
 *    (a built-in PDF viewer does not run under the sandbox the route serves with, `contract/outbox` §4), and this
 *    page does not make its own `blob:` of the bytes to get round that: a `blob:` takes the origin of the page that
 *    made it, so a viewer opened on one would run outside the sandbox. A PDF is saved, and a native app shows it
 *    in its own viewer.
 *
 * A file of kind `file` or `pdf` is never shown in this page's origin: it is a download (`<a download>` where the
 * address works on its own, `saveBlob` of a fetched blob otherwise), and the blob it is saved from is typed
 * `application/octet-stream`. What an element does show from a fetched blob is typed here, by its kind, not by
 * what the gateway's answer said (`blobFor`): never `image/svg+xml` or `text/*`.
 */
import type { OutboxAttachment } from '@hermie/transcript'
import { redirectSeen } from '@hermie/gateway-client'

import { resolveImage } from '../../markdown/links'

/** Where the attachment's bytes are, or `null` when its url is not one this page may ask the gateway for. */
export function outboxHref(
  attachment: Pick<OutboxAttachment, 'url'>,
  gatewayBaseUrl: string | undefined,
  profile?: string
): string | null {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const resolved = resolveImage(`${attachment.url}${query}`, gatewayBaseUrl)

  return resolved.kind === 'image' ? resolved.src : null
}

/** Why a file did not arrive. */
export type OutboxFailure = 'missing' | 'refused' | 'too-large' | 'unreachable'

export class OutboxError extends Error {
  readonly reason: OutboxFailure

  constructor(reason: OutboxFailure, message: string) {
    super(message)
    this.name = 'OutboxError'
    this.reason = reason
  }
}

export interface OutboxFiles {
  /**
   * Whether an address loads in an element as it is: the cookie session carries the credential.
   * Otherwise (the shared token) the bytes are fetched here.
   */
  direct: boolean
  /** The bytes of `url`, fetched with the person's credentials. Rejects with an `OutboxError`. */
  fetch(url: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<Blob>
}

/** What the token mode fetches to show a picture, in bytes: past this a picture is a file to save. */
export const OUTBOX_IMAGE_FETCH_MAX = 25 * 1024 * 1024
/** What it fetches to play a video or a sound, in bytes (the whole file is held; it cannot seek by ranges). */
export const OUTBOX_MEDIA_FETCH_MAX = 64 * 1024 * 1024
/** What it fetches to save a file or a PDF, in bytes. */
export const OUTBOX_FILE_FETCH_MAX = 200 * 1024 * 1024

/** What the page knows about how it is signed in: enough to fetch a file (`createOutboxFiles`), and nothing to load. */
export interface OutboxCredentials {
  /** `GatewayHttp.requestHeaders`: the credential a `fetch` of this page adds (none with the cookie session). */
  headers: () => Promise<Record<string, string>>
  /** The gateway signs people in with its own cookie (`GET /api/status`: `auth_required`). */
  gated: boolean
}

export interface OutboxFilesOptions extends OutboxCredentials {
  fetchImpl?: typeof fetch
}

export function createOutboxFiles(options: OutboxFilesOptions): OutboxFiles {
  return {
    direct: options.gated,
    async fetch(url, { signal, maxBytes } = {}) {
      const doFetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
      let response: Response

      try {
        response = await doFetch(url, {
          method: 'GET',
          headers: await options.headers(),
          // The cookie goes to the gateway's own origin and to nobody else; a redirect would carry the header on.
          credentials: 'same-origin',
          redirect: 'manual',
          ...(signal ? { signal } : {})
        })
      } catch (cause) {
        throw new OutboxError('unreachable', cause instanceof Error ? cause.message : 'The gateway did not answer.')
      }

      if (redirectSeen(response, url)) {
        throw new OutboxError('refused', 'The gateway redirected the request, and it was not followed.')
      }

      if (response.status === 404) {
        throw new OutboxError('missing', 'The file is no longer there.')
      }

      if (!response.ok) {
        throw new OutboxError('refused', `The gateway answered ${response.status}.`)
      }

      const announced = Number(response.headers?.get('content-length') ?? '')

      if (maxBytes !== undefined && Number.isFinite(announced) && announced > maxBytes) {
        void response.body?.cancel().catch(() => undefined)
        throw new OutboxError('too-large', 'The file is too large to hold in the page.')
      }

      return readCapped(response, maxBytes)
    }
  }
}

/**
 * The body of an answer, held in memory no further than `maxBytes`: a gateway that sent no `Content-Length` (or a
 * wrong one) is stopped as the bytes arrive, and the rest is never read.
 */
async function readCapped(response: Response, maxBytes: number | undefined): Promise<Blob> {
  const type = response.headers?.get('content-type') ?? ''
  const reader = maxBytes === undefined ? undefined : response.body?.getReader()

  try {
    if (!reader || maxBytes === undefined) {
      const whole = await response.blob()

      if (maxBytes !== undefined && whole.size > maxBytes) {
        throw new OutboxError('too-large', 'The file is too large to hold in the page.')
      }

      return whole
    }

    const chunks: Uint8Array[] = []
    let total = 0

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      total += value.byteLength

      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new OutboxError('too-large', 'The file is too large to hold in the page.')
      }

      chunks.push(value)
    }

    return new Blob(chunks as BlobPart[], { type })
  } catch (cause) {
    if (cause instanceof OutboxError) {
      throw cause
    }

    throw new OutboxError('unreachable', cause instanceof Error ? cause.message : 'The file did not arrive.')
  }
}

/** A fetched file as something to save: whatever type it came with, it is bytes to keep, never a page. */
export function asDownload(bytes: Blob): Blob {
  return new Blob([bytes], { type: 'application/octet-stream' })
}

const SAFE_IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/u
const SAFE_VIDEO_TYPE = /^video\/[a-z0-9][a-z0-9.+-]*$/u
const SAFE_AUDIO_TYPE = /^audio\/[a-z0-9][a-z0-9.+-]*$/u

/**
 * Fetched bytes as something an element may be given: the same bytes under a type chosen here. A picture is only
 * a raster type a browser draws without running anything (not `image/svg+xml`, which is a document), a video is
 * `video/*` and a sound `audio/*`; anything else, or a type that does not belong to the kind, is
 * `application/octet-stream`, which an element refuses to play (it fails safely, and the file is still there to
 * save). A `text/*` type is never kept.
 */
export function blobFor(kind: OutboxAttachment['kind'], bytes: Blob): Blob {
  const type = (bytes.type.split(';')[0] ?? '').trim().toLowerCase()
  const safe =
    kind === 'image'
      ? SAFE_IMAGE_TYPE.test(type)
      : kind === 'video'
        ? SAFE_VIDEO_TYPE.test(type)
        : kind === 'audio'
          ? SAFE_AUDIO_TYPE.test(type)
          : false

  return new Blob([bytes], { type: safe ? type : 'application/octet-stream' })
}
