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
/**
 * The send route's request cap. The relay began at 8 KB for every route and
 * raises `/v1/send` to 96 KB; a sender must not rely on more than its own
 * 7.5 KB, so the fake takes the larger number and the sender's own tests pin
 * the smaller.
 */
const REQUEST_LIMIT_BYTES = 96 * 1024
const MAX_MESSAGES = 20
/** `protocol.ts`: the serialised `message` object, at most 3.5 KB. */
const MAX_MESSAGE_BYTES = 3_584
const MAX_TTL_SECONDS = 28 * 86_400
const MESSAGE_KEYS = new Set(['title', 'body', 'category', 'thread', 'collapseId', 'priority', 'ttl', 'data'])
const CATEGORY = /^[A-Za-z0-9._-]{1,64}$/u
const COLLAPSE_ID = /^[\x21-\x7E]{1,64}$/u

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The relay's message schema (`src/server/push/protocol.ts`, strict): unknown
 * members refused, `title` not empty, `category` and `collapseId` by their
 * patterns, `thread` 1 to 256 characters, `priority` high or normal, `ttl` an
 * integer up to 28 days, `data` an object; and the compact re-serialisation of
 * the whole message at most 3,584 bytes. `null` when it passes, the relay's
 * `rejected` reason when it does not.
 */
function messageProblem(message: unknown): 'invalid_message' | 'payload_too_large' | null {
  if (!isObject(message)) {
    return 'invalid_message'
  }

  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MAX_MESSAGE_BYTES) {
    return 'payload_too_large'
  }

  const valid =
    Object.keys(message).every(key => MESSAGE_KEYS.has(key)) &&
    typeof message.title === 'string' &&
    message.title.length > 0 &&
    typeof message.body === 'string' &&
    (message.category === undefined || (typeof message.category === 'string' && CATEGORY.test(message.category))) &&
    (message.thread === undefined ||
      (typeof message.thread === 'string' && message.thread.length >= 1 && message.thread.length <= 256)) &&
    (message.collapseId === undefined ||
      (typeof message.collapseId === 'string' && COLLAPSE_ID.test(message.collapseId))) &&
    (message.priority === undefined || message.priority === 'high' || message.priority === 'normal') &&
    (message.ttl === undefined ||
      (typeof message.ttl === 'number' &&
        Number.isInteger(message.ttl) &&
        message.ttl >= 0 &&
        message.ttl <= MAX_TTL_SECONDS)) &&
    (message.data === undefined || isObject(message.data))

  return valid ? null : 'invalid_message'
}

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

    if (!(new Headers(init.headers).get('content-type') ?? '').startsWith('application/json')) {
      return jsonResponse(415, { error: 'unsupported_media_type' })
    }

    if (Buffer.byteLength(rawBody, 'utf8') > REQUEST_LIMIT_BYTES) {
      return jsonResponse(413, { error: 'request_too_large' })
    }

    const envelope = body as { v?: unknown; messages?: unknown } | null
    const messages = Array.isArray(envelope?.messages) ? (envelope.messages as Record<string, unknown>[]) : null

    if (
      envelope?.v !== 1 ||
      !messages ||
      messages.length < 1 ||
      messages.length > MAX_MESSAGES ||
      !messages.every(
        entry =>
          isObject(entry) &&
          typeof entry.handle === 'string' &&
          entry.handle.length <= 200 &&
          typeof entry.secret === 'string' &&
          entry.secret.length <= 200
      )
    ) {
      return jsonResponse(400, { error: 'invalid_request' })
    }

    const results = messages.map(entry => {
      const problem = messageProblem(entry.message)

      if (problem) {
        return { handle: String(entry.handle), status: 'rejected' as const, reason: problem }
      }

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
