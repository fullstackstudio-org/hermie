/**
 * How this gateway authenticates a page, and the cookie session when it is the
 * gateway's own sign-in (plan W5).
 *
 *  - `GET /api/status` is public. `auth_required: true` means the dashboard
 *    issues an `HttpOnly` session cookie, and the client rides it: REST carries
 *    no auth header, every socket dial mints a ticket, a rejection is always
 *    "sign in again". The client never sees, stores or sends a credential of
 *    its own.
 *  - Otherwise the gateway authenticates with a session token. Until W-23 the
 *    client does not handle that and says so.
 *
 * `SameOriginCookieCredentials` is `CookieSessionCredentials` with one change:
 * `credentials: 'same-origin'` instead of `'include'`. The package's default
 * exists for Hermie Web, which proxied the gateway onto its own origin; this
 * client is served BY the gateway, so the cookie never has to cross an origin
 * and must not be offered to one. The narrowing lives here, not in the package
 * (plan W-6), so the native apps and the contract corpus are untouched.
 */
import {
  CookieSessionCredentials,
  type CookieSessionCredentialsOptions,
  GatewayError,
  GatewayHttp,
  type AuthIdentity,
  type FetchLike,
  isGatewayError,
  ownAuthorOf,
  probeGateway,
  type ProbeResult
} from '@hermie/gateway-client'

export type AuthMode = { kind: 'cookie'; probe: ProbeResult } | { kind: 'token'; probe: ProbeResult }

/**
 * Probe the gateway and name its auth mode. Throws the probe's `GatewayError`
 * (network, timeout, not a gateway, a proxy in front) for the caller to show.
 */
export async function detectAuthMode(baseUrl: string, fetchImpl?: FetchLike): Promise<AuthMode> {
  const probe = await probeGateway(baseUrl, {}, fetchImpl ?? defaultFetch)

  return probe.authRequired ? { kind: 'cookie', probe } : { kind: 'token', probe }
}

/**
 * The page's `fetch`, looked up when called. Bound, because a `fetch` called
 * as a method of something other than the window throws "Illegal invocation"
 * in some browsers.
 */
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** The gateway's cookie session, never offered to another origin. */
export class SameOriginCookieCredentials extends CookieSessionCredentials {
  override readonly fetchCredentials: RequestCredentials = 'same-origin'
}

export interface CookieSession {
  credentials: SameOriginCookieCredentials
  http: GatewayHttp
}

export function createCookieSession(baseUrl: string, fetchImpl?: FetchLike): CookieSession {
  const options: CookieSessionCredentialsOptions = { baseUrl, fetchImpl: fetchImpl ?? defaultFetch }
  const credentials = new SameOriginCookieCredentials(options)
  const http = new GatewayHttp({ baseUrl, credentials, fetchImpl: fetchImpl ?? defaultFetch })

  return { credentials, http }
}

/** Who is signed in, in the two shapes the client uses. */
export interface SignedInIdentity {
  identity: AuthIdentity
  /** The reader's own author stamp (`ownAuthorOf`); undefined when the gateway names no identity. */
  author: { id: string; name?: string } | undefined
}

export type IdentityResult = { kind: 'signed_in'; signedIn: SignedInIdentity } | { kind: 'needs_signin' }

/**
 * `GET /api/auth/me`. A 401 means the session lapsed between the document load
 * and now: `needs_signin`. A 403 does not: the gateway answers a missing or lapsed
 * session with 401, so a 403 is a proxy, a firewall or an origin check speaking
 * for it, and signing in again would reload into the same 403 (a loop). It is
 * thrown, like any other failure, for the caller to show as "cannot reach the
 * gateway", with the status.
 */
export async function readIdentity(http: GatewayHttp): Promise<IdentityResult> {
  try {
    const identity = await http.authMe()

    return { kind: 'signed_in', signedIn: { identity, author: ownAuthorOf(identity) } }
  } catch (error) {
    if (isGatewayError(error) && error.kind === 'auth' && error.status !== 403) {
      return { kind: 'needs_signin' }
    }

    throw error instanceof GatewayError
      ? error
      : new GatewayError('network', 'Reading the signed-in identity failed.', { cause: error })
  }
}
