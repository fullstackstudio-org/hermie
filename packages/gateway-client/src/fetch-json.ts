import { GatewayError } from './types'

export type FetchLike = typeof fetch

/** Default window for a single HTTP call to a gateway. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000

export interface JsonRequest {
  method?: string
  /**
   * Whether the platform's HTTP cache may answer this.
   *
   * Every call this package makes passes `no-store`, and it is not an
   * optimisation. A gateway's `/api/status` is a liveness answer, its REST
   * routes are a live session, and none of it is worth a byte of cache — while
   * a single cached 301 outlived an app's whole installation and sent the next
   * one to the wrong host. Left overridable so a caller with a genuine reason
   * can say otherwise, and nothing in this package does.
   */
  cache?: RequestCache
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
  /**
   * `credentials` as `fetch` means it. Only the browser build sets it, to
   * `include`, so the gateway's session cookie rides along; everywhere else it
   * is absent and the platform default applies.
   */
  credentials?: RequestCredentials
  /**
   * Let the platform follow a redirect, as long as the answer still comes from
   * the origin that was asked.
   *
   * Off by default, and off is the only safe setting for a request that carries
   * anything worth stealing. A platform that follows a redirect takes the
   * request's headers with it: Node forwards everything but `Authorization`,
   * OkHttp on Android does the same and will also go from https to http, so a
   * front-door secret or a session token reached whatever host the redirect
   * named, possibly in the clear. With this off the request goes out with
   * `redirect: 'manual'` and any redirect is a `redirect` failure; see
   * `redirectSeen` for how each platform reports one.
   *
   * Only the onboarding probe turns it on, and only while it sends no header of
   * its own: then there is nothing to carry, and following is how it learns
   * where an address that moved now lives. Even then, an answer from a
   * different origin is refused rather than read.
   */
  followRedirects?: boolean
}

/** The statuses that send a client somewhere else. 304 is a 3xx and is not one. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
 * Where the Android build's redirect guard puts a `Location` it refused to
 * follow. See `expo/hermie/plugins/with-android-redirect-guard.js`: OkHttp only
 * stops following when the header is gone, and the target is still worth
 * naming to the person who typed the address.
 */
export const REFUSED_LOCATION_HEADER = 'x-hermie-refused-location'

/** The parts of a `Response` the redirect check reads. Test doubles may omit any of them. */
interface ResponseLike {
  status: number
  type?: string
  url?: string
  headers?: { get(name: string): string | null } | null
}

function originOfUrl(url: string): string {
  try {
    const origin = new URL(url).origin

    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}

/**
 * Did this answer come from a redirect, followed or not? Returns where it led
 * (`''` when the platform hides that), or `null` for an ordinary answer.
 *
 * Three platforms, three ways of saying so:
 *
 *  - **A browser** honours `redirect: 'manual'` with an opaque response:
 *    `type === 'opaqueredirect'`, status 0, no headers. The target is hidden.
 *  - **Node** (undici) honours it with the real 3xx and its `Location`. So does
 *    the Android build once its guard has refused an origin change, except that
 *    the guard has moved `Location` to `REFUSED_LOCATION_HEADER`.
 *  - **React Native** ignores `redirect` altogether and the platform follows.
 *    On iOS the follow-up carries none of the original headers; on Android the
 *    guard refuses an origin change. Either way `response.url` is where the
 *    answer came from, so an origin that differs from the one asked is the
 *    redirect, noticed after the fact and before the body is used.
 *
 * Only an ORIGIN change is caught after the fact. A redirect within one origin
 * that a platform followed by itself took nothing anywhere it was not already
 * going, and comparing whole URLs would trip over each platform's own way of
 * serialising one.
 */
export function redirectSeen(response: ResponseLike, requestedUrl: string): { target: string } | null {
  const resolve = (location: string | null | undefined): string => {
    if (!location) {
      return ''
    }

    try {
      return new URL(location, requestedUrl).toString()
    } catch {
      return ''
    }
  }

  if (response.type === 'opaqueredirect') {
    return { target: '' }
  }

  if (REDIRECT_STATUSES.has(response.status)) {
    return {
      target: resolve(response.headers?.get('location') ?? response.headers?.get(REFUSED_LOCATION_HEADER))
    }
  }

  const landed = typeof response.url === 'string' ? response.url : ''
  const asked = originOfUrl(requestedUrl)

  if (!landed || !asked) {
    // Nothing reported, or nothing to compare with: nothing is claimed.
    return null
  }

  const landedOrigin = originOfUrl(landed)

  // A URL the platform reports and nobody can read is not proof of the same
  // origin, so it fails closed, naming nothing.
  return landedOrigin === asked ? null : { target: landedOrigin ? landed : '' }
}

/**
 * The `redirect` failure for a request that was sent somewhere else.
 *
 * The sentence names what changed. A different host is the story the cached
 * 301 told (see `probe.ts`); the same host on another scheme or port is a
 * different server as far as credentials are concerned, and https to http on
 * the same name is the one worth spelling out, because it is the downgrade the
 * stored address would otherwise hide.
 */
export function redirectError(requestedUrl: string, target: string, status?: number): GatewayError {
  const askedOrigin = originOfUrl(requestedUrl)
  const landedOrigin = originOfUrl(target)
  const askedHost = askedOrigin ? new URL(askedOrigin).hostname.replace(/^\[|\]$/g, '') : ''
  const landedHost = landedOrigin ? new URL(landedOrigin).hostname.replace(/^\[|\]$/g, '') : ''
  const advice = 'Nothing was read from it. Change the gateway address to the one you meant.'
  let message: string

  if (!landedOrigin) {
    message = `${requestedUrl} answered with a redirect that was not followed. ${advice}`
  } else if (landedHost !== askedHost) {
    message = `${askedHost} redirected to ${landedHost}, which is a different host. ${advice}`
  } else if (askedOrigin.startsWith('https:') && landedOrigin.startsWith('http:')) {
    message = `${askedOrigin} redirected to ${landedOrigin}, which is not https. ${advice}`
  } else if (landedOrigin !== askedOrigin) {
    message = `${askedOrigin} redirected to ${landedOrigin}, which is a different address. ${advice}`
  } else {
    message = `${requestedUrl} redirected to ${target}, which was not followed. ${advice}`
  }

  return new GatewayError('redirect', message, {
    ...(status ? { status } : {}),
    ...(landedHost ? { redirectedTo: landedHost } : {}),
    ...(landedOrigin ? { redirectedOrigin: landedOrigin } : {})
  })
}

/** Let go of a body nobody is going to read. Best effort: a test double may have none. */
function discardBody(response: { body?: unknown }): void {
  try {
    const body = response.body as { cancel?: () => Promise<unknown> } | null | undefined

    void body?.cancel?.().catch(() => undefined)
  } catch {
    // Nothing to release.
  }
}

export interface JsonResponse {
  status: number
  ok: boolean
  text: string
  /**
   * The URL the answer actually came from, after any redirects were followed.
   *
   * It exists because of a cache. The iOS URL cache kept a 301 from one host to
   * another ACROSS INSTALLS of the same bundle id, so the onboarding probe
   * quietly reached a gateway the owner had moved away from and then reported
   * "that is not a Hermes gateway" about the address they had typed. A caller
   * that can see where it landed can say so instead.
   *
   * Empty where the platform does not report it; a caller must treat that as
   * "no redirect was observed" rather than as a redirect to nowhere.
   *
   * `requestText` no longer returns an answer from another origin at all (see
   * `JsonRequest.followRedirects`), so this differs from the requested URL only
   * by a redirect within the same origin.
   */
  url: string
  /**
   * The `server` response header, lowercased key, verbatim value.
   *
   * Read for one sentence and one only: when an address answers something that
   * is not a gateway, WHO answered is the fact that ends the guessing. A
   * reverse proxy in front of an unrelated site answers `POST
   * /api/auth/ws-ticket` with a 405 and names itself here, and "the answer came
   * from <that>" is the difference between an owner checking their gateway and
   * an owner checking the thing that is actually in the way.
   *
   * Empty when the header is absent, which is ordinary — many servers suppress
   * it — so a caller must say nothing rather than say "unknown".
   */
  server: string
}

/**
 * Did the secure channel fail, whatever the reason?
 *
 * Worth knowing where this DOES and does not fire, because the honest answer is
 * "nowhere a real `fetch` runs", and an earlier version of this comment claimed
 * otherwise.
 *
 * React Native's `fetch` is `whatwg-fetch` over its own `XMLHttpRequest`, and
 * the polyfill's `onerror` rejects with a flat `TypeError('Network request
 * failed')` — the `NSError` and OkHttp's exception are both discarded before
 * JavaScript sees them. Measured on iOS 27 against a gateway serving a
 * self-signed certificate: CFNetwork logged `NSURLErrorDomain -1202 "The
 * certificate for this server is invalid"` for a request the app reported as
 * unreachable.
 *
 * Node is NOT the exception it was said to be. Node 22's global `fetch` is
 * undici, and it rejects with `TypeError('fetch failed')`; the real reason
 * (`DEPTH_ZERO_SELF_SIGNED_CERT`, "self-signed certificate") is one level down
 * in `error.cause`, which `requestText` does not read. Measured the same day,
 * against the same gateway.
 *
 * So what these predicates actually serve is the tests, where a descriptive
 * message is thrown on purpose, and any future caller that hands them a message
 * it has dug out itself. Reading the cause chain would make them fire for real
 * — and would also stop the scheme fallback for a self-signed https server,
 * which is the shape of gateway this fallback exists to reach. That trade is a
 * decision, not an oversight; `docs/adr/0014-plain-http-on-private-networks.md`
 * is where it belongs.
 */
export function looksLikeTlsFailure(message: string): boolean {
  const lowered = message.toLowerCase()

  return (
    lowered.includes('ssl') || lowered.includes('certificate') || lowered.includes('tls') || lowered.includes('-1200')
  )
}

/**
 * Did the secure channel fail because of the CERTIFICATE, rather than because
 * there was no TLS there at all?
 *
 * The difference decides whether an address the user typed without a scheme may
 * be retried in the clear. A rejected certificate means there IS an https
 * server on that port and it has a problem worth fixing; a handshake that died
 * because the peer answered in plain HTTP means there is no https server there,
 * which is the ordinary shape of `hermes serve` on a tailnet port somebody
 * probed with `https://` first.
 */
export function looksLikeCertificateFailure(message: string): boolean {
  const lowered = message.toLowerCase()

  return (
    lowered.includes('certificate') ||
    lowered.includes('untrusted') ||
    lowered.includes('self signed') ||
    lowered.includes('self-signed') ||
    // NSURLErrorServerCertificateUntrusted and its neighbours.
    /-120[2-6]\b/.test(lowered)
  )
}

/**
 * One HTTP round trip with a timeout, returning the raw body. Transport
 * failures come back as `GatewayError` (`timeout` / `tls` / `network`); HTTP
 * status codes are the caller's to interpret, because what a 404 means depends
 * on which endpoint was asked.
 */
export async function requestText(url: string, request: JsonRequest = {}): Promise<JsonResponse> {
  const fetchImpl = request.fetchImpl ?? fetch
  const timeoutMs = request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined

  const abortOuter = () => controller.abort()
  request.signal?.addEventListener('abort', abortOuter, { once: true })

  const headers: Record<string, string> = { accept: 'application/json', ...request.headers }
  let body: string | undefined

  if (request.body !== undefined) {
    body = JSON.stringify(request.body)
    headers['content-type'] = 'application/json'
  }

  try {
    const response = await fetchImpl(url, {
      method: request.method ?? 'GET',
      headers,
      // `no-store` unless a caller insists. React Native maps it onto
      // `NSURLRequest.reloadIgnoringLocalCacheData`; a browser passes it to the
      // Fetch standard's own cache mode. See the note on `JsonRequest.cache`.
      cache: request.cache ?? 'no-store',
      // See `JsonRequest.followRedirects`. React Native ignores this; the check
      // below is what holds there.
      redirect: request.followRedirects === true ? 'follow' : 'manual',
      ...(body === undefined ? {} : { body }),
      ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
      signal: controller.signal
    })

    // Before the body is touched: an answer from somewhere else is not read.
    const redirected = redirectSeen(response, url)

    if (redirected) {
      discardBody(response)

      throw redirectError(url, redirected.target, response.status)
    }

    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
      url: typeof response.url === 'string' ? response.url : '',
      // `headers` is absent on some hand-rolled test doubles, and a missing
      // header is the same story as a suppressed one: nothing to say.
      server: response.headers?.get('server') ?? ''
    }
  } catch (error) {
    if (error instanceof GatewayError && error.kind === 'redirect') {
      throw error
    }

    if (timedOut) {
      throw new GatewayError('timeout', `${url} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, {
        cause: error
      })
    }

    if (request.signal?.aborted) {
      throw new GatewayError('network', `The request to ${url} was cancelled.`, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (looksLikeTlsFailure(message)) {
      // Two different stories, and naming a certificate that was never offered
      // sends the reader looking for one.
      throw new GatewayError(
        'tls',
        looksLikeCertificateFailure(message)
          ? `The TLS certificate for ${url} was rejected: ${message}`
          : `The TLS handshake with ${url} failed: ${message}`,
        { cause: error }
      )
    }

    throw new GatewayError('network', `Could not reach ${url}: ${message}`, { cause: error })
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }

    request.signal?.removeEventListener('abort', abortOuter)
  }
}

/** Parse a response body that must be a JSON object. */
export function parseJsonObject(text: string, url: string, kind: 'not_hermes' | 'protocol'): Record<string, unknown> {
  const parsed = parseJsonBody(text, url, kind)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(kind, `${url} answered with JSON that is not an object.`)
  }

  return parsed as Record<string, unknown>
}

/**
 * Parse a response body that must be JSON, object or ARRAY.
 *
 * Not every REST route answers with an envelope. `GET /api/cron/jobs` answers
 * with a bare array — the cron controller says so in `listRows` and reads both
 * shapes — so a transport that rejected an array made that route unreachable
 * whatever the caller was prepared to accept. Which SHAPE is acceptable is the
 * caller's question; the transport's question is only whether it is JSON.
 *
 * `parseJsonObject` stays for the handshakes that genuinely require an object:
 * the status probe, the credential exchange, the token endpoints. An array
 * arriving there is a gateway that is not the gateway, and saying so early is
 * the point of that check.
 */
export function parseJsonBody(text: string, url: string, kind: 'not_hermes' | 'protocol'): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new GatewayError(kind, `${url} answered with something that is not JSON.`, { cause: error })
  }
}
