import { type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import { type FetchLike, type JsonResponse, parseJsonObject, requestText } from './fetch-json'
import { revokeNativeGrant, type TokenCoordinator } from './native-auth'
import { notHermesHint } from './probe'
import { apiUrl, normalizeHeaders } from './url'
import { type DialPlan, type GatewayAuthMode, GatewayError } from './types'

/** The stable public subprotocol the gateway selects back on accept. */
export const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
/** Prefix of the credential-bearing subprotocol; never reflected back by the server. */
export const GATEWAY_WS_TICKET_PREFIX = 'hermes-gateway-ticket.'
/** Header an ungated gateway authenticates REST calls with. */
export const SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token'

export interface AuthHeaderOptions {
  forceRefresh?: boolean
  rejectedAccessToken?: string
}

/**
 * What the HTTP layer and the dial loop need from "however this gateway
 * authenticates us", so neither has to know which of the two flows is in play.
 */
export interface CredentialProvider {
  readonly mode: GatewayAuthMode
  /**
   * `credentials` for every `fetch` this client makes, when the flow needs one
   * that is not the platform default. Only the cookie flow sets it.
   */
  readonly fetchCredentials?: RequestCredentials
  /** Auth headers for one REST call. */
  httpAuthHeaders(options?: AuthHeaderOptions): Promise<Record<string, string>>
  /** Mint everything one WebSocket dial needs. Called immediately before connecting. */
  dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan>
  /**
   * A credential was rejected (HTTP 401 or WS close 4401). `retry` means a fresh
   * credential is available and the caller should try once more; `reauth` means
   * the user has to sign in again.
   */
  onRejected(rejectedToken?: string): Promise<'retry' | 'reauth'>
  signOut(): Promise<void>
}

/** Pull the bearer value back out of a header map, for 401 bookkeeping. */
export function bearerFrom(headers: Record<string, string>): string | undefined {
  const value = headers.authorization ?? headers.Authorization

  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined
}

export interface NativePkceCredentialsOptions {
  baseUrl: string
  coordinator: TokenCoordinator
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  /** Where the mint record goes, so a 4401 can be read next to the ticket it refused. */
  timeline?: AuthTimelineSink
  /** How long `signOut` may wait on the gateway. Defaults to `NATIVE_REVOKE_TIMEOUT_MS`. */
  revokeTimeoutMs?: number
}

/**
 * Gated gateway: `Authorization: Bearer` on REST, and a single-use ticket in the
 * WebSocket subprotocol list — browsers cannot set headers on an upgrade, so the
 * gateway made the ticket the only WS credential it accepts when gated.
 */
export class NativePkceCredentials implements CredentialProvider {
  readonly mode: GatewayAuthMode = 'native_pkce'

  constructor(private readonly options: NativePkceCredentialsOptions) {}

  async httpAuthHeaders(options: AuthHeaderOptions = {}): Promise<Record<string, string>> {
    const token = await this.options.coordinator.accessToken(options)

    if (!token) {
      throw new GatewayError('auth', 'You are signed out of this gateway. Sign in again.', { status: 401 })
    }

    return { authorization: `Bearer ${token}` }
  }

  async dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan> {
    const ticket = await mintWsTicket({
      baseUrl: this.options.baseUrl,
      headers: {
        ...normalizeHeaders(this.options.extraHeaders),
        ...extraHeaders,
        ...(await this.httpAuthHeaders())
      },
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.timeline ? { timeline: this.options.timeline } : {})
    })

    return {
      url: wsUrl,
      protocols: [GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}${ticket}`],
      headers: extraHeaders
    }
  }

  async onRejected(rejectedToken?: string): Promise<'retry' | 'reauth'> {
    const refreshed = await this.options.coordinator.accessToken({
      forceRefresh: true,
      ...(rejectedToken === undefined ? {} : { rejectedAccessToken: rejectedToken })
    })

    return refreshed ? 'retry' : 'reauth'
  }

  /**
   * End the grant at the gateway where it can, then forget it here.
   *
   * The refresh token and provider are read BEFORE the wipe, because the wipe is
   * what deletes them. The revoke is best effort and bounded by
   * `NATIVE_REVOKE_TIMEOUT_MS` (see `revokeNativeGrant`): a gateway that is down,
   * slow or too old to have the route costs at most that long, and the local
   * wipe happens whatever it answered.
   */
  async signOut(): Promise<void> {
    try {
      const tokens = await this.options.coordinator.current().catch(() => null)

      if (tokens) {
        await revokeNativeGrant(this.options.baseUrl, tokens, {
          extraHeaders: this.options.extraHeaders ?? {},
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          ...(this.options.revokeTimeoutMs === undefined ? {} : { timeoutMs: this.options.revokeTimeoutMs })
        })
      }
    } finally {
      await this.options.coordinator.clear()
    }
  }
}

export interface MintWsTicketOptions {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: FetchLike
  credentials?: RequestCredentials
  timeline?: AuthTimelineSink
}

/**
 * The mint got a well-formed HTTP answer that no gateway would give.
 *
 * "Minting a WebSocket ticket failed with HTTP 405" was true and told the owner
 * nothing: it reads as a gateway that is unwell, so the dial ladder hammered
 * away and the header said "Reconnecting…" while the thing on the other end was
 * never going to become a gateway. What was actually there — measured on a real
 * device — was a reverse proxy in front of an unrelated landing page, which
 * refuses a POST to a path it does not route and NAMES ITSELF in `server`.
 *
 * So this says what was seen and nothing more. What it is NOT allowed to do is
 * guess why: the network sentence comes from `notHermesHint`, which writes it
 * only for a host that is verifiably reachable on one network. It rides as
 * `hint` as well as in the message, because a screen that writes its own
 * sentence for a kind still has to be able to show the part specific to this
 * failure.
 */
function notAGateway(baseUrl: string, response: JsonResponse): GatewayError {
  const seen = `The address answered HTTP ${response.status}, but not as a Hermes gateway.`
  const who = response.server ? ` The answer came from ${response.server}.` : ''
  const hint = notHermesHint(baseUrl, response.text)

  return new GatewayError('protocol', hint ? `${seen}${who} ${hint}` : `${seen}${who}`, {
    status: response.status,
    ...(hint ? { hint } : {})
  })
}

/**
 * One ticket for one dial: `POST /api/auth/ws-ticket`, single-use, 30 s TTL.
 *
 * Shared by both flows that dial with a ticket, because this is the ONLY place
 * in a dial where a stale credential shows itself. The mint is an ordinary
 * authenticated POST, so the gateway's gate answers 401 here, whereas the
 * WebSocket upgrade verifies no credential at all and can only ever refuse the
 * ticket. The two must stay distinguishable, which is why the mint's status is
 * recorded.
 *
 * The mint carries the bearer token and any front-door headers, so a redirect
 * here is refused unfollowed (`requestText`'s default) and recorded as a
 * `redirect` failure: a 302 from the gateway's edge must not hand them to the
 * host it names.
 */
export async function mintWsTicket(options: MintWsTicketOptions): Promise<string> {
  const timeline = options.timeline ?? NULL_AUTH_TIMELINE
  const url = apiUrl(options.baseUrl, '/api/auth/ws-ticket')
  let response

  try {
    response = await requestText(url, {
      method: 'POST',
      headers: options.headers,
      body: {},
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })
  } catch (error) {
    timeline.record({
      event: 'ticket.failed',
      ...(error instanceof GatewayError ? { kind: error.kind } : {})
    })

    throw error
  }

  if (response.status === 401 || response.status === 403) {
    timeline.record({ event: 'ticket.failed', kind: 'auth', status: response.status })

    throw new GatewayError('auth', 'The gateway refused to mint a WebSocket ticket. Sign in again.', {
      status: response.status
    })
  }

  if (response.status >= 500) {
    timeline.record({ event: 'ticket.failed', kind: 'server', status: response.status })

    throw new GatewayError('server', `The gateway answered HTTP ${response.status} while minting a ticket.`, {
      status: response.status
    })
  }

  if (!response.ok) {
    timeline.record({ event: 'ticket.failed', kind: 'protocol', status: response.status })

    throw notAGateway(options.baseUrl, response)
  }

  const body = parseJsonObject(response.text, url, 'protocol')

  if (typeof body.ticket !== 'string' || !body.ticket) {
    timeline.record({ event: 'ticket.failed', kind: 'protocol', status: response.status })

    throw new GatewayError('protocol', `${url} answered without a ticket.`)
  }

  timeline.record({ event: 'ticket.minted' })

  return body.ticket
}

export interface SessionTokenCredentialsOptions {
  token: string
}

/**
 * Ungated gateway: the session token rides as a header on REST and as `?token=`
 * on the WebSocket. There is nothing to refresh, so a rejection is always a
 * "fix the token" story.
 */
export class SessionTokenCredentials implements CredentialProvider {
  readonly mode: GatewayAuthMode = 'session_token'

  constructor(private readonly options: SessionTokenCredentialsOptions) {}

  async httpAuthHeaders(): Promise<Record<string, string>> {
    return { [SESSION_TOKEN_HEADER]: this.options.token }
  }

  async dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan> {
    const url = new URL(wsUrl)
    url.searchParams.set('token', this.options.token)

    return { url: url.toString(), headers: extraHeaders }
  }

  async onRejected(): Promise<'retry' | 'reauth'> {
    return 'reauth'
  }

  async signOut(): Promise<void> {
    // Nothing is cached here; the app clears the stored token itself.
  }
}

export interface CookieSessionCredentialsOptions {
  baseUrl: string
  fetchImpl?: FetchLike
  /** Where the mint record goes, so a 4401 can be read next to the ticket it refused. */
  timeline?: AuthTimelineSink
}

/**
 * The gateway's own browser session, used from a page it serves.
 *
 * Nothing here holds a credential, and that is the whole design. The session is
 * an `HttpOnly` cookie set by `/auth/callback` or `/auth/password-login`; the
 * page cannot read it, cannot copy it into a header, and cannot put it on a
 * WebSocket upgrade. So:
 *
 *  - **REST** carries no auth header at all. `credentials: 'include'` is what
 *    makes the browser attach the cookie, and it is only honoured because
 *    Hermie Web serves the app and proxies the gateway on ONE origin.
 *  - **The socket** uses the ticket subprotocol, minted by a cookie-authenticated
 *    POST immediately before the dial. This is exactly why the gateway grew
 *    tickets in the first place: `new WebSocket(url, protocols)` is all a
 *    browser has.
 *  - **A rejection is always `reauth`.** There is no refresh token in reach —
 *    the gateway rotates its own behind the cookie — so a 401 means the session
 *    has genuinely lapsed and the user has to sign in again.
 *
 * `signOut` is a plain `POST /auth/logout`; the gateway answers with a 302 and
 * the `Max-Age=0` cookie deletions, which the browser applies whether or not the
 * redirect is followed. It is not: like every call here it goes out with
 * `redirect: 'manual'`, so the 302 surfaces as a `redirect` failure that
 * `signOut` swallows with the rest.
 */
export class CookieSessionCredentials implements CredentialProvider {
  readonly mode: GatewayAuthMode = 'cookie'
  readonly fetchCredentials: RequestCredentials = 'include'

  constructor(private readonly options: CookieSessionCredentialsOptions) {}

  async httpAuthHeaders(): Promise<Record<string, string>> {
    return {}
  }

  async dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan> {
    const ticket = await mintWsTicket({
      baseUrl: this.options.baseUrl,
      headers: extraHeaders,
      credentials: this.fetchCredentials,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.timeline ? { timeline: this.options.timeline } : {})
    })

    return {
      url: wsUrl,
      protocols: [GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}${ticket}`]
      // Deliberately no `headers`: a browser cannot set any on an upgrade.
    }
  }

  async onRejected(): Promise<'retry' | 'reauth'> {
    return 'reauth'
  }

  async signOut(): Promise<void> {
    try {
      await requestText(apiUrl(this.options.baseUrl, '/auth/logout'), {
        method: 'POST',
        credentials: this.fetchCredentials,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
      })
    } catch {
      // A sign-out the server never heard about still has to look like a
      // sign-out here: the app clears its own state either way, and the cookie
      // lapses on its own.
    }
  }
}
