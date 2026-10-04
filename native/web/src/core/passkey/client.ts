/**
 * The six passkey routes of the gateway (plan "HTTP routes"; the fake gateway's
 * `src/passkey/routes.ts` for the shapes): the status read, registration with an
 * enrolment code, and the step-ups that mint an invite or revoke a credential.
 *
 * On the page's own origin with the cookie session (`credentials: 'same-origin'`),
 * so the browser sends the `Origin` the gateway checks on every cookie write
 * against the level's own base URLs. Not through `GatewayHttp`: a refusal's body
 * (`error`, `reason`) is what the page shows, and that class keeps only the
 * status.
 *
 * Nothing here logs a body: codes and assertions travel through it.
 */
import { DEFAULT_RPC_TIMEOUT_MS, type FetchLike } from '@hermie/gateway-client'

/** One credential of the signed-in user, as the routes describe it. */
export interface PasskeyCredentialInfo {
  id: string
  name: string
  rp_id: string
  provider?: string
  created_at?: number
  last_used_at?: number | null
  backed_up?: boolean
  created_via?: string
}

/** `GET /api/auth/passkeys`. */
export interface PasskeyStatus {
  v: number
  enabled: boolean
  reason: string
  gateway_id: string
  user: { id: string; handle: string }
  rp: { native: string[]; web: string[] }
  base_urls?: string[]
  user_invites: boolean
  credentials: PasskeyCredentialInfo[]
}

export interface RegisterBeginResult {
  registration_id: string
  nonce: string
  expires_at?: number
  user: { handle: string; name?: string; display_name?: string }
  exclude_credentials?: { type?: string; id: string }[]
}

export interface StepupBeginResult {
  stepup_id: string
  purpose?: string
  subject?: string
  nonce: string
  expires_at?: number
  credentials: { rp_id: string; ids: string[] }[]
}

/** The `passkey` object of a confirm answer, and a step-up's `assertion`. */
export interface PasskeyAssertion {
  v: 1
  rp_id: string
  base_url: string
  credential_id: string
  authenticator_data: string
  client_data_json: string
  signature: string
  user_handle?: string
}

export interface RegisterFinishBody {
  registration_id: string
  base_url: string
  code: string
  credential: { id: string; client_data_json: string; attestation_object: string; transports?: string[] }
}

/** Why a route call did not do what it was asked. */
export class PasskeyRouteError extends Error {
  constructor(
    /** `not_offered`: the gateway has no such route (the level is off or unknown); `refused`: it said no; `transport`: no answer. */
    readonly kind: 'not_offered' | 'refused' | 'transport',
    message: string,
    readonly status = 0,
    /** The route's `error` (`code_invalid`, `assertion_invalid`, ...). */
    readonly error = '',
    /** The contract's `reason`, when the route gave one. */
    readonly reason = '',
    /** Seconds the gateway asked the caller to wait (`Retry-After` on a 429), when it said. */
    readonly retryAfter: number | null = null
  ) {
    super(message)
    this.name = 'PasskeyRouteError'
  }
}

export interface PasskeyClient {
  status(): Promise<PasskeyStatus>
  registerBegin(body: { rp_id: string; base_url: string; name: string }): Promise<RegisterBeginResult>
  registerFinish(body: RegisterFinishBody): Promise<{ ok: true; credential?: PasskeyCredentialInfo }>
  stepupBegin(body: { purpose: 'invite' | 'revoke'; subject: string }): Promise<StepupBeginResult>
  invite(body: {
    stepup_id: string
    base_url: string
    assertion: PasskeyAssertion
  }): Promise<{ code: string; expires_at?: number }>
  revoke(body: {
    credential_id: string
    stepup_id: string
    base_url: string
    assertion: PasskeyAssertion
  }): Promise<{ ok: true }>
}

const PREFIX = '/api/auth/passkeys'

/**
 * How long a route call may take, body included, before it fails as `transport`: the RPC calls' own bound. A gateway
 * that never answers the status read must not hold up what waits on it (the advert of a socket).
 */
export const PASSKEY_ROUTE_TIMEOUT_MS = DEFAULT_RPC_TIMEOUT_MS

/** `Retry-After` as whole seconds: delta-seconds, or an HTTP date taken against `now` (ms). `null` when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const raw = value?.trim()

  if (!raw) {
    return null
  }

  if (/^\d+$/u.test(raw)) {
    return Number(raw)
  }

  const at = Date.parse(raw)

  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

/** The page's `fetch`, looked up when called. */
const pageFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/**
 * The routes on the gateway at `baseUrl` (origin plus prefix). `fetchImpl` is
 * the page's own unless a test hands in its own; every call is aborted after
 * `timeoutMs` (`PASSKEY_ROUTE_TIMEOUT_MS`) and fails as `transport`.
 */
export function createPasskeyClient(
  baseUrl: string,
  fetchImpl: FetchLike = pageFetch,
  timeoutMs: number = PASSKEY_ROUTE_TIMEOUT_MS
): PasskeyClient {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, timeoutMs)
    let response: Response
    let parsed: unknown = null

    try {
      try {
        response = await fetchImpl(`${baseUrl}${PREFIX}${path}`, {
          method,
          headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'same-origin',
          cache: 'no-store',
          // A redirect is somebody else answering; the session is not followed anywhere.
          redirect: 'manual',
          signal: abort.signal
        })
      } catch (error) {
        throw new PasskeyRouteError(
          'transport',
          timedOut ? 'The gateway did not answer in time.' : error instanceof Error ? error.message : String(error)
        )
      }

      try {
        parsed = await response.json()
      } catch {
        parsed = null
      }

      // A body that stalled until the timeout is no answer either.
      if (timedOut) {
        throw new PasskeyRouteError('transport', 'The gateway did not answer in time.')
      }
    } finally {
      clearTimeout(timer)
    }

    const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
    const text = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '')

    if (response.ok && parsed !== null) {
      return parsed as T
    }

    if (response.status === 404 || response.status === 405) {
      throw new PasskeyRouteError('not_offered', text('detail') || `HTTP ${response.status}`, response.status)
    }

    if (response.status === 0 || response.type === 'opaqueredirect') {
      throw new PasskeyRouteError('transport', 'The gateway answered with a redirect.', 0)
    }

    throw new PasskeyRouteError(
      'refused',
      text('detail') || text('error') || `HTTP ${response.status}`,
      response.status,
      text('error'),
      text('reason'),
      response.status === 429 ? parseRetryAfter(response.headers?.get('retry-after')) : null
    )
  }

  return {
    status: () => call('GET', ''),
    registerBegin: body => call('POST', '/register/begin', body),
    registerFinish: body => call('POST', '/register/finish', body),
    stepupBegin: body => call('POST', '/stepup/begin', body),
    invite: body => call('POST', '/invites', body),
    revoke: body => call('POST', '/revoke', body)
  }
}
