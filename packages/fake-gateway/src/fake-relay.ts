/**
 * A stand-in for the push relay's `POST /v1/send`, as a `fetch`.
 *
 * In process and not a socket on purpose. A sender posts only to https origins
 * on its allow-list, and a fake listening on `http://127.0.0.1:<port>` is
 * neither — so a test would have to switch off exactly the checks it exists to
 * exercise. Handed in as `fetchImpl`, this answers for `https://push.hermie.dev`
 * (or any origin it is given) without leaving the process, and it records every
 * request the sender made, to ANY address, so a test can assert that a foreign
 * origin was never contacted at all.
 *
 * Shaped after the relay design: a request is `{ v: 1, messages: [...] }`, one
 * to twenty messages, each with its own `handle` and `secret`, at most 8 KB in
 * total; each answer is `{ handle, status, reason?, retryAfter? }`. An unknown
 * handle and a wrong secret are the same `gone`, as on the real relay.
 */

export type FakeRelayStatus = 'sent' | 'gone' | 'rejected' | 'retry' | 'limited'

export interface FakeRelayResult {
  status: FakeRelayStatus
  reason?: string
  retryAfter?: number
}

/** One call the sender made, whatever its address. */
export interface FakeRelayRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** `fetch`'s `redirect` option, so a test can check the sender never follows one. */
  redirect: string | undefined
  /** Whether the call carried an abort signal, which is how a sender times out. */
  timed: boolean
  body: unknown
}

/** One message the relay accepted for delivery. */
export interface FakeRelayDelivery {
  handle: string
  message: Record<string, unknown>
}

/** A whole-request failure, for the next call only. */
export type FakeRelayFailure = { network: true } | { status: number; headers?: Record<string, string>; body?: unknown }

export interface FakeRelay {
  readonly origin: string
  readonly requests: FakeRelayRequest[]
  readonly delivered: FakeRelayDelivery[]
  /** Hand this to the sender as its `fetchImpl`. */
  readonly fetch: typeof fetch
  /**
   * Make a handle known, with the secret that authorises it. Once any handle is
   * known, every other handle (and a wrong secret) answers `gone`; before that,
   * every handle is accepted.
   */
  register(handle: string, secret: string): void
  /** Script the next answers for one handle, used in order; then the default. */
  answer(handle: string, ...results: (FakeRelayStatus | FakeRelayResult)[]): void
  /** Fail the next call as a whole. Several queue up. */
  failNext(failure: FakeRelayFailure): void
}

export interface FakeRelayOptions {
  /** The origin it answers for. Default the project's relay. */
  origin?: string
}

const SEND_PATH = '/v1/send'
const REQUEST_LIMIT_BYTES = 8 * 1024
const MAX_MESSAGES = 20

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function createFakeRelay(options: FakeRelayOptions = {}): FakeRelay {
  const origin = options.origin ?? 'https://push.hermie.dev'
  const requests: FakeRelayRequest[] = []
  const delivered: FakeRelayDelivery[] = []
  const known = new Map<string, string>()
  const scripted = new Map<string, FakeRelayResult[]>()
  const failures: FakeRelayFailure[] = []

  const answerFor = (entry: Record<string, unknown>): FakeRelayResult & { handle: string } => {
    const handle = typeof entry.handle === 'string' ? entry.handle : ''
    const queue = scripted.get(handle)
    const next = queue?.shift()

    if (next) {
      return { handle, ...next }
    }

    if (known.size && known.get(handle) !== entry.secret) {
      return { handle, status: 'gone' }
    }

    return { handle, status: 'sent' }
  }

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawBody = typeof init.body === 'string' ? init.body : ''
    let body: unknown = rawBody

    try {
      body = JSON.parse(rawBody)
    } catch {
      // Recorded as the string it was.
    }

    requests.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      redirect: init.redirect,
      timed: Boolean(init.signal),
      body
    })

    const failure = failures.shift()

    if (failure) {
      if ('network' in failure) {
        throw new TypeError('fetch failed')
      }

      return new Response(failure.body === undefined ? null : JSON.stringify(failure.body), {
        status: failure.status,
        headers: failure.headers ?? {}
      })
    }

    if (url !== `${origin}${SEND_PATH}` || init.method !== 'POST') {
      return jsonResponse(404, { error: 'not_found' })
    }

    if (Buffer.byteLength(rawBody, 'utf8') > REQUEST_LIMIT_BYTES) {
      return jsonResponse(413, { error: 'payload_too_large' })
    }

    const envelope = body as { v?: unknown; messages?: unknown } | null
    const messages = Array.isArray(envelope?.messages) ? (envelope.messages as Record<string, unknown>[]) : null

    if (envelope?.v !== 1 || !messages || messages.length < 1 || messages.length > MAX_MESSAGES) {
      return jsonResponse(400, { error: 'invalid_request' })
    }

    const results = messages.map(entry => {
      const result = answerFor(entry ?? {})

      if (result.status === 'sent') {
        delivered.push({ handle: result.handle, message: (entry.message ?? {}) as Record<string, unknown> })
      }

      return result
    })

    return jsonResponse(200, { results })
  }

  return {
    origin,
    requests,
    delivered,
    fetch: fakeFetch as typeof fetch,
    register(handle, secret) {
      known.set(handle, secret)
    },
    answer(handle, ...results) {
      const queue = scripted.get(handle) ?? []

      queue.push(...results.map(result => (typeof result === 'string' ? { status: result } : result)))
      scripted.set(handle, queue)
    },
    failNext(failure) {
      failures.push(failure)
    }
  }
}
