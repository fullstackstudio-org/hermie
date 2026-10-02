import { type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import { bytesToBase64 } from './base64'
import { bearerFrom, type CredentialProvider } from './credentials'
import { type FetchLike, parseJsonBody, redirectSeen, requestText } from './fetch-json'
import { apiUrl, normalizeHeaders } from './url'
import { GatewayError } from './types'

/** Default window for one REST call once the gateway is configured. */
export const DEFAULT_REST_TIMEOUT_MS = 30_000

export interface GatewayHttpOptions {
  baseUrl: string
  credentials: CredentialProvider
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  defaultTimeoutMs?: number
  /** Where a 401 on a REST call is recorded. */
  timeline?: AuthTimelineSink
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface AuthIdentity {
  userId: string
  email: string
  displayName: string
  orgId: string
  provider: string
  expiresAt: number
  /**
   * Where this person's picture lives, relative — `/api/auth/picture?id=…` —
   * or empty when the gateway is not holding one right now.
   *
   * Present only on a fork that sends it at all (HERM-120); an upstream
   * Hermes gateway answers `/api/auth/me` without the field, which parses the
   * same as an empty string. Join it onto the gateway's base URL with
   * `apiUrl` before fetching it — it is already the full path, including the
   * query, not a bare id.
   */
  pictureUrl: string
}

export interface WsTicket {
  ticket: string
  ttlSeconds: number
}

/** What fetching `/api/auth/picture` (or a `picture_url`) came back with. */
export type PictureFetchOutcome =
  | { kind: 'ready'; dataUri: string }
  /** The gateway does not have this picture — an unknown id, or none held. */
  | { kind: 'missing' }
  /** Anything else: refused, unreachable, or an answer that was not an image. */
  | { kind: 'error' }

/**
 * The REST half of a gateway connection: everything that is not the JSON-RPC
 * socket. It owns the one retry the auth contract allows — a 401 asks the
 * credential provider whether a fresh credential exists, and only then does the
 * call go out a second time.
 */
export class GatewayHttp {
  private readonly extraHeaders: Record<string, string>

  constructor(private readonly options: GatewayHttpOptions) {
    this.extraHeaders = normalizeHeaders(options.extraHeaders)
  }

  get baseUrl(): string {
    return this.options.baseUrl
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.send<T>('GET', path, undefined, options)
  }

  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('POST', path, body, options)
  }

  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('PUT', path, body, options)
  }

  /**
   * `PATCH`, which the profile rename route is the first caller of.
   *
   * Hermes spells that one `PATCH /api/profiles/{name}` and not
   * `POST …/rename`, so the verb has to exist here rather than being worked
   * around at the call site: everything that makes this class worth using —
   * the base URL, the extra headers, the credential provider and the single
   * 401 retry — lives inside `send`, and a hand-rolled `fetch` beside it would
   * have none of them.
   */
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('PATCH', path, body, options)
  }

  delete<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('DELETE', path, body, options)
  }

  /** `GET /api/auth/me` — the identity check the wizard runs before it saves. */
  async authMe(options?: RequestOptions): Promise<AuthIdentity> {
    const body = await this.get<Record<string, unknown>>('/api/auth/me', options)

    return {
      userId: typeof body.user_id === 'string' ? body.user_id : '',
      email: typeof body.email === 'string' ? body.email : '',
      displayName: typeof body.display_name === 'string' ? body.display_name : '',
      orgId: typeof body.org_id === 'string' ? body.org_id : '',
      provider: typeof body.provider === 'string' ? body.provider : '',
      expiresAt: typeof body.expires_at === 'number' ? body.expires_at : 0,
      pictureUrl: typeof body.picture_url === 'string' ? body.picture_url : ''
    }
  }

  /**
   * `GET` an authenticated picture — `/api/auth/picture?id=…`, or the exact
   * `picture_url` `/api/auth/me` handed back — and return it as a `data:` URI.
   *
   * Bytes rather than a URL, on purpose: the caller (an `Image`) never gets
   * the authenticated address itself, only what it drew, so nothing downstream
   * can log it, export it, or hand it to a second `Image` implementation that
   * would need to be taught this gateway's auth all over again. It carries the
   * same 401-then-retry the rest of this class gives every call, since the
   * endpoint sits behind the same auth as everything else here.
   *
   * `path` must already be relative to this gateway's base URL — `apiUrl`
   * joins it, exactly as every other call on this class does.
   */
  async fetchAuthenticatedPicture(path: string, options: RequestOptions = {}): Promise<PictureFetchOutcome> {
    const first = await this.attemptBinary(path, options, {})

    if (first.status !== 401) {
      return outcomeOf(first)
    }

    ;(this.options.timeline ?? NULL_AUTH_TIMELINE).record({ event: 'rest.unauthorized', kind: 'auth', status: 401 })

    const verdict = await this.options.credentials.onRejected(first.usedToken)

    if (verdict === 'reauth') {
      return { kind: 'error' }
    }

    const retry = await this.attemptBinary(path, options, { forceRefresh: false })

    return outcomeOf(retry)
  }

  /**
   * The headers a fetch this client does NOT make would still need.
   *
   * A Markdown image in a reply is loaded by the platform's own image loader,
   * not by this class, and a gated gateway answers 401 without them. Callers
   * are expected to resolve this once and hold the result: it mints nothing and
   * refreshes nothing, so a stale bearer here fails the way any other stale
   * bearer does, with a 401 the caller sees as a failed image.
   */
  async requestHeaders(): Promise<Record<string, string>> {
    return { ...this.extraHeaders, ...(await this.options.credentials.httpAuthHeaders()) }
  }

  /** `POST /api/auth/ws-ticket` — single-use, 30 s TTL, one per dial. */
  async wsTicket(options?: RequestOptions): Promise<WsTicket> {
    const body = await this.post<Record<string, unknown>>('/api/auth/ws-ticket', {}, options)

    if (typeof body.ticket !== 'string' || !body.ticket) {
      throw new GatewayError('protocol', 'The gateway answered /api/auth/ws-ticket without a ticket.')
    }

    return { ticket: body.ticket, ttlSeconds: typeof body.ttl_seconds === 'number' ? body.ttl_seconds : 0 }
  }

  private async send<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const attempt = await this.attempt(method, path, body, options, {})

    if (attempt.status !== 401) {
      return this.unwrap<T>(attempt, method, path)
    }

    ;(this.options.timeline ?? NULL_AUTH_TIMELINE).record({ event: 'rest.unauthorized', kind: 'auth', status: 401 })

    const verdict = await this.options.credentials.onRejected(attempt.usedToken)

    if (verdict === 'reauth') {
      throw new GatewayError('auth', `The gateway rejected the credentials for ${method} ${path}. Sign in again.`, {
        status: 401
      })
    }

    const retry = await this.attempt(method, path, body, options, { forceRefresh: false })

    return this.unwrap<T>(retry, method, path)
  }

  private async attempt(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    authOptions: { forceRefresh?: boolean }
  ): Promise<{ status: number; ok: boolean; text: string; url: string; usedToken?: string }> {
    const url = apiUrl(this.options.baseUrl, path)
    const auth = await this.options.credentials.httpAuthHeaders(authOptions)
    const response = await requestText(url, {
      method,
      headers: { ...this.extraHeaders, ...auth },
      ...(body === undefined ? {} : { body }),
      ...(this.options.credentials.fetchCredentials === undefined
        ? {}
        : { credentials: this.options.credentials.fetchCredentials }),
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    })

    const usedToken = bearerFrom(auth)

    // The URL the answer came from, not the one asked: `requestText` has
    // already refused one from another origin, and what is left is worth
    // naming as it is.
    return { ...response, url: response.url || url, ...(usedToken === undefined ? {} : { usedToken }) }
  }

  /**
   * `attempt`'s binary sibling: a plain `GET`, read as bytes rather than text.
   *
   * `requestText` cannot serve `fetchAuthenticatedPicture` — it always resolves
   * `response.text()` — so this goes straight to the injected `fetchImpl` (or
   * the platform's own `fetch`) instead. It still honours the same timeout,
   * the same extra headers, the same credential mode, and the same signal a
   * caller passed in; it does not honour `TLS`/`timeout` classification, since
   * a picture that failed to load is `'error'` regardless of why.
   */
  private async attemptBinary(
    path: string,
    options: RequestOptions,
    authOptions: { forceRefresh?: boolean }
  ): Promise<{ status: number; ok: boolean; buffer: ArrayBuffer | null; contentType: string; usedToken?: string }> {
    const url = apiUrl(this.options.baseUrl, path)
    const auth = await this.options.credentials.httpAuthHeaders(authOptions)
    const usedToken = bearerFrom(auth)
    const fetchImpl = this.options.fetchImpl ?? fetch
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS
    const controller = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    const abortOuter = () => controller.abort()

    options.signal?.addEventListener('abort', abortOuter, { once: true })

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { ...this.extraHeaders, ...auth },
        cache: 'no-store',
        // The same rule as every other credentialed call: see
        // `JsonRequest.followRedirects`.
        redirect: 'manual',
        ...(this.options.credentials.fetchCredentials === undefined
          ? {}
          : { credentials: this.options.credentials.fetchCredentials }),
        signal: controller.signal
      })

      if (redirectSeen(response, url)) {
        // A picture from somewhere else is not this gateway's picture.
        return {
          status: 0,
          ok: false,
          buffer: null,
          contentType: '',
          ...(usedToken === undefined ? {} : { usedToken })
        }
      }

      if (!response.ok) {
        return {
          status: response.status,
          ok: false,
          buffer: null,
          contentType: '',
          ...(usedToken === undefined ? {} : { usedToken })
        }
      }

      const buffer = await response.arrayBuffer()
      const contentType = response.headers?.get('content-type') ?? ''

      return {
        status: response.status,
        ok: true,
        buffer,
        contentType,
        ...(usedToken === undefined ? {} : { usedToken })
      }
    } catch {
      // Network failure, abort, a fetch double that throws — all the same
      // answer here: this picture could not be loaded this time.
      return { status: 0, ok: false, buffer: null, contentType: '', ...(usedToken === undefined ? {} : { usedToken }) }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }

      options.signal?.removeEventListener('abort', abortOuter)
    }
  }

  private unwrap<T>(
    response: { status: number; ok: boolean; text: string; url: string },
    method: string,
    path: string
  ): T {
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError('auth', `The gateway refused ${method} ${path} (HTTP ${response.status}).`, {
        status: response.status
      })
    }

    if (response.status === 404) {
      throw new GatewayError('protocol', `The gateway has no ${method} ${path} endpoint (HTTP 404).`, { status: 404 })
    }

    if (response.status >= 500) {
      throw new GatewayError('server', `The gateway answered HTTP ${response.status} on ${method} ${path}.`, {
        status: response.status
      })
    }

    if (!response.ok) {
      throw new GatewayError('protocol', `${method} ${path} failed with HTTP ${response.status}.`, {
        status: response.status,
        ...(detailOf(response.text) === null ? {} : { hint: detailOf(response.text) as string })
      })
    }

    if (!response.text.trim()) {
      return undefined as T
    }

    // Object or array: a REST route may legitimately answer with either, and the
    // caller's own reader decides which it wanted (see `parseJsonBody`).
    return parseJsonBody(response.text, response.url, 'protocol') as T
  }
}

/**
 * A refusal's own sentence, out of a JSON error body.
 *
 * FastAPI puts the actionable half of a 4xx in `detail`, and until this existed
 * it was thrown away: every caller got "failed with HTTP 409" and none of them
 * could say WHY. Some of those sentences cannot be reconstructed by a client at
 * all — the Kanban router's refusal names the parent cards that are blocking a
 * move — so the body is the only place the information exists.
 *
 * It rides on `hint`, which already means "one extra sentence, when the
 * classification alone is not enough to act on". Anything that is not a JSON
 * object with a string `detail` yields `null` rather than a guess: an HTML
 * error page from a proxy in the way is not a sentence worth showing anybody.
 */
function detailOf(text: string): string | null {
  if (!text.trim().startsWith('{')) {
    return null
  }

  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail

    return typeof detail === 'string' && detail.trim() ? detail : null
  } catch {
    return null
  }
}

/** `attemptBinary`'s raw answer, turned into the outcome a caller actually wants. */
function outcomeOf(response: {
  status: number
  ok: boolean
  buffer: ArrayBuffer | null
  contentType: string
}): PictureFetchOutcome {
  if (response.status === 404) {
    return { kind: 'missing' }
  }

  if (!response.ok || !response.buffer) {
    return { kind: 'error' }
  }

  return {
    kind: 'ready',
    dataUri: `data:${response.contentType || 'image/png'};base64,${bytesToBase64(new Uint8Array(response.buffer))}`
  }
}
