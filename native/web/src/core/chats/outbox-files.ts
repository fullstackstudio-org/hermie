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
 *  - **A PDF is fetched either way** (`openPdf`). The route answers a browser that navigates to it (a new tab)
 *    with `attachment`, because a built-in PDF viewer does not run under the sandbox the route serves with; a
 *    `fetch` is answered `inline`, and the page shows the bytes it holds in a tab of its own, once they are
 *    known to be a PDF.
 *
 * A file of kind `file` is never shown in this page's origin: it is a download (`<a download>` where the
 * address works on its own, `saveBlob` of a fetched blob otherwise), and the blob it is saved from is typed
 * `application/octet-stream`.
 */
import type { OutboxAttachment } from '@hermie/transcript'
import { redirectSeen } from '@hermie/gateway-client'

import { resolveImage } from '../../markdown/links'
import { openBlankTab } from '../../platform/open-link'

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
/** What it fetches to open a PDF or save a file, in bytes. */
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
        throw new OutboxError('too-large', 'The file is too large to hold in the page.')
      }

      try {
        return await response.blob()
      } catch (cause) {
        throw new OutboxError('unreachable', cause instanceof Error ? cause.message : 'The file did not arrive.')
      }
    }
  }
}

/** How long a PDF's `blob:` address stays valid: a reload of the tab it opened in is still served. */
const PDF_URL_LIFETIME_MS = 10 * 60_000

/**
 * Show a PDF in a tab of its own, from the bytes this page fetched.
 *
 * The tab is opened first, in the press itself (a popup blocker lets only that through), and told where to go
 * once the bytes are in and are a PDF (`%PDF-`): a file that says it is one and is not is never given to the
 * browser's viewer. The new tab is cut off from this one (`opener` is cleared) before anything is loaded in it.
 * `'blocked'` means the browser would not open a tab: the caller offers the download.
 */
export async function openPdf(
  files: OutboxFiles,
  href: string,
  options: { maxBytes?: number; open?: typeof window.open; revoke?: (url: string) => void } = {}
): Promise<'opened' | 'blocked' | 'not-a-pdf'> {
  const target = openBlankTab(options.open)

  if (!target) {
    return 'blocked'
  }

  try {
    target.opener = null
  } catch {
    // A browser that will not let it go still opens a tab the page cannot be reached through by name.
  }

  try {
    const bytes = await files.fetch(href, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    const head = await bytes.slice(0, 5).text()

    if (head !== '%PDF-') {
      target.close()

      return 'not-a-pdf'
    }

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))

    target.location.href = url
    setTimeout(() => (options.revoke ?? (value => URL.revokeObjectURL(value)))(url), PDF_URL_LIFETIME_MS)

    return 'opened'
  } catch (cause) {
    target.close()
    throw cause
  }
}

/** A fetched file as something to save: whatever type it came with, it is bytes to keep, never a page. */
export function asDownload(bytes: Blob): Blob {
  return new Blob([bytes], { type: 'application/octet-stream' })
}
