/**
 * What a tap on an attachment chip does, as one decision in one place.
 *
 * Two verbs, and the order between them is the whole of it: **look at it
 * first, send it somewhere second**. A share sheet is a list of destinations,
 * and it was what a tap did on every platform — so reading a PDF that somebody
 * attached meant choosing an app to read it in. Quick Look is the verb a
 * reader means, and on the Mac it is the one they press Space for.
 *
 * The fallback is not a safety net so much as the answer for three real
 * platforms: a browser downloads, Android has no `QLPreviewController`, and a
 * type Quick Look has no previewer for still has to go somewhere. Each of those
 * comes back as a plain `false` from the seam rather than as an error, which is
 * why this can be a two-line decision instead of a try/catch.
 *
 * Its own file, and it returns what it did, because the ordering is the part
 * that can silently regress: a change that made the share sheet fire first
 * would still "open the file" on every platform and would be invisible in every
 * screenshot.
 *
 * ## A remote attachment is fetched HERE, with credentials
 *
 * `QLPreviewController` reads a URL directly, so a remote one has to be on disk
 * before it can be shown. The Swift used to do that itself with a bare
 * `URLSession.shared.data(from:)` — no bearer, no front-door header, no cookie
 * — which on a gated gateway is not a file that fails to preview but a request
 * that could never have succeeded.
 *
 * So the fetch is this side's, through the same `GatewayHttp` everything else
 * goes through: it already owns the operator's extra headers, the bearer and
 * the single 401 retry that asks for a fresh credential before giving up.
 * Quick Look is handed a `file://` and the Swift previews local files only.
 *
 * With no client — a surface that has no gateway yet — a remote attachment
 * simply cannot be opened, and that is an honest `'nothing'`. Falling back to
 * the share sheet there would hand the system the very URL this could not
 * fetch.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import { cacheRemoteAttachment } from '../../platform/attachment-cache'
import { openInQuickLook } from '../../platform/quick-look'
import { shareFile } from '../../platform/share-file'

/** One attachment, as the transcript holds it. */
export interface OpenableAttachment {
  name: string
  /** Absent for a reference whose bytes this device does not have. */
  uri?: string
}

/** What the caller lends this, which today is one thing. */
export interface OpenAttachmentPorts {
  /**
   * The gateway's REST client, for an attachment that is a URL rather than a
   * path. Absent or null is not an error; it means a remote one cannot be
   * fetched, which is reported as `'nothing'`.
   */
  http?: GatewayHttp | null
}

/** Whether this is somebody else's bytes over the network. */
function isRemote(uri: string): boolean {
  return /^https?:\/\//i.test(uri)
}

/**
 * What happened, for a test and for nothing else.
 *
 * `'nothing'` is a legitimate outcome, not a failure: an attachment the gateway
 * stored on its own disk has no URI here, and a tap on it has nothing to open.
 * Opening an empty share sheet instead would be worse than doing nothing.
 */
export type AttachmentOpened = 'quick-look' | 'shared' | 'nothing'

export async function openAttachmentFile(
  attachment: OpenableAttachment,
  ports: OpenAttachmentPorts = {}
): Promise<AttachmentOpened> {
  const { name, uri } = attachment

  if (!uri) {
    return 'nothing'
  }

  const local = isRemote(uri) ? await fetched(uri, name, ports.http) : uri

  if (!local) {
    return 'nothing'
  }

  if (await openInQuickLook(local, name)) {
    return 'quick-look'
  }

  /*
    The LOCAL copy, not the remote URL.

    A type Quick Look has no previewer for still has somewhere to go, and what
    the share sheet is handed is the file this already has rather than an
    address the receiving app would have to authenticate to on its own.

    `shareFile` answers false as well — a sheet that would not open, a browser
    with no document. There is nothing left to try after it, so its answer is
    not branched on; the reader still has the transcript in front of them.
  */
  await shareFile(local, name)

  return 'shared'
}

/** A remote attachment brought down with this gateway's own headers. */
async function fetched(uri: string, name: string, http: GatewayHttp | null | undefined): Promise<string | null> {
  if (!http) {
    return null
  }

  try {
    return await cacheRemoteAttachment(uri, name, await http.requestHeaders())
  } catch {
    // `requestHeaders` reaches the credential provider, which can fail for the
    // same reasons anything else that needs a token fails. There is nothing to
    // open either way.
    return null
  }
}
