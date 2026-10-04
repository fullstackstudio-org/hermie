/**
 * From document load to "we know the gateway, the auth mode and who is signed
 * in" (plan, "Runtime flow", steps 1 to 3), as one React-free function that
 * `main.tsx` renders the outcome of.
 *
 *   frame guard (main.tsx, before anything)      framed        → one sentence, stop
 *   base path                                    misconfigured → names the expected path
 *   probe  GET /api/status                       unreachable   → the probe's error, retry
 *     auth_required false → session token (W-23)
 *       GET {prefix}/  (the dashboard's bootstrap, dashboard-token.ts)
 *         no usable token                        needs_token (absent)   → the token prompt
 *       GET /api/profiles with it
 *         401                                    needs_token (rejected) → the token prompt
 *         other failure                          unreachable            → retry
 *         200                                    token_ready            → the session, nobody named
 *     auth_required true → cookie session
 *   identity  GET /api/auth/me
 *     401 / 403                                  needs_signin  → "Sign in again" (login bounce)
 *     other failure                              unreachable   → retry
 *     200                                        signed_in     → the session W-7a connects with
 *
 * The base path is derived synchronously by the caller first, because the
 * route stash and the storage namespace hang off it; this function takes the
 * resolved path and does the network half. A token the person typed into the
 * prompt goes through `bootWithToken`, the same check as the bootstrap's.
 */
import { GatewayError, type FetchLike, type ProbeResult } from '@hermie/gateway-client'

import { strings } from '../generated/strings'
import { webStrings } from '../i18n/web-strings'
import {
  checkToken,
  createCookieSession,
  createTokenSession,
  detectAuthMode,
  readIdentity,
  type CookieSession,
  type SignedInIdentity,
  type TokenSession
} from './auth-mode'
import type { ResolvedBasePath } from './base-path'
import { readDashboardToken } from './dashboard-token'

/**
 * Why the token prompt is shown: the dashboard's bootstrap gave no usable token
 * (`absent`), or the gateway refused the token it was given (`rejected`).
 */
export type NeedsTokenReason = 'absent' | 'rejected'

export type BootState =
  | { kind: 'unreachable'; basePath: ResolvedBasePath; error: GatewayError }
  | { kind: 'needs_token'; basePath: ResolvedBasePath; probe: ProbeResult; reason: NeedsTokenReason }
  | { kind: 'token_ready'; basePath: ResolvedBasePath; probe: ProbeResult; session: TokenSession }
  | { kind: 'needs_signin'; basePath: ResolvedBasePath; probe: ProbeResult; session: CookieSession }
  | ({ kind: 'signed_in'; basePath: ResolvedBasePath; probe: ProbeResult; session: CookieSession } & SignedInIdentity)

export interface BootOptions {
  fetchImpl?: FetchLike
}

const asError = (error: unknown): GatewayError =>
  error instanceof GatewayError
    ? error
    : new GatewayError('network', error instanceof Error ? error.message : String(error), { cause: error })

export async function boot(basePath: ResolvedBasePath, options: BootOptions = {}): Promise<BootState> {
  let mode

  try {
    mode = await detectAuthMode(basePath.baseUrl, options.fetchImpl)
  } catch (error) {
    return { kind: 'unreachable', basePath, error: asError(error) }
  }

  if (mode.kind === 'token') {
    const token = await readDashboardToken(basePath.baseUrl, options.fetchImpl)

    return token === null
      ? { kind: 'needs_token', basePath, probe: mode.probe, reason: 'absent' }
      : bootWithToken(basePath, mode.probe, token, options)
  }

  const session = createCookieSession(basePath.baseUrl, options.fetchImpl)

  try {
    const identity = await readIdentity(session.http)

    return identity.kind === 'needs_signin'
      ? { kind: 'needs_signin', basePath, probe: mode.probe, session }
      : { kind: 'signed_in', basePath, probe: mode.probe, session, ...identity.signedIn }
  } catch (error) {
    return { kind: 'unreachable', basePath, error: asError(error) }
  }
}

/** The token-mode states `bootWithToken` ends in. */
export type TokenBootState = Extract<BootState, { kind: 'token_ready' | 'needs_token' | 'unreachable' }>

/**
 * Check `token` against the gateway and make the session on it: `token_ready`
 * when it is taken, `needs_token` (`rejected`) on a 401, `unreachable` for any
 * other failure. The token is held by the session's credentials only.
 */
export async function bootWithToken(
  basePath: ResolvedBasePath,
  probe: ProbeResult,
  token: string,
  options: BootOptions = {}
): Promise<TokenBootState> {
  const session = createTokenSession(basePath.baseUrl, token, options.fetchImpl)

  try {
    const check = await checkToken(session.http)

    return check.kind === 'accepted'
      ? { kind: 'token_ready', basePath, probe, session }
      : { kind: 'needs_token', basePath, probe, reason: 'rejected' }
  } catch (error) {
    return { kind: 'unreachable', basePath, error: asError(error) }
  }
}

/**
 * One sentence for a failed boot, from the catalogue's existing error copy.
 * Read when called, never at import, so it is in the language in use.
 */
export function describeBootFailure(error: GatewayError, baseUrl: string): string {
  const host = new URL(baseUrl).host
  const errors = strings.app.errors

  switch (error.kind) {
    case 'network':
      return errors.network({ host })
    case 'timeout':
      return errors.timeout({ host })
    case 'tls':
      return errors.tls({ host })
    case 'server':
      return errors.server({ status: error.status ?? 500 })
    case 'not_hermes':
    case 'protocol':
      return errors.notHermes({ host })
    case 'redirect':
      return errors.redirected({ from: host, to: error.redirectedTo ?? '?' })
    case 'auth':
      // Here `auth` is a refusal that no sign-in answers: a 401/403 on the public
      // `/api/status`, or a 403 on `/api/auth/me` (a 401 there is a lapsed session
      // and never gets this far). Something in front of the gateway said it. The
      // catalogue's own sentence sends the reader to "Advanced", which this client
      // does not have.
      return webStrings.boot.refusedInFront({ status: error.status ?? 403 })
    case 'incompatible':
      return errors.incompatible
    default:
      return errors.unknown
  }
}
