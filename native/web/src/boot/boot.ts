/**
 * From document load to "we know the gateway, the auth mode and who is signed
 * in" (plan, "Runtime flow", steps 1 to 3), as one React-free function that
 * `main.tsx` renders the outcome of.
 *
 *   frame guard (main.tsx, before anything)      framed        → one sentence, stop
 *   base path                                    misconfigured → names the expected path
 *   probe  GET /api/status                       unreachable   → the probe's error, retry
 *     auth_required false                        token_mode    → open it in the native app (until W-23)
 *     auth_required true → cookie session
 *   identity  GET /api/auth/me
 *     401 / 403                                  needs_signin  → "Sign in again" (login bounce)
 *     other failure                              unreachable   → retry
 *     200                                        signed_in     → the session W-7a connects with
 *
 * The base path is derived synchronously by the caller first, because the
 * route stash and the storage namespace hang off it; this function takes the
 * resolved path and does the network half.
 */
import { GatewayError, type FetchLike, type ProbeResult } from '@hermie/gateway-client'

import { strings } from '../generated/strings'
import {
  createCookieSession,
  detectAuthMode,
  readIdentity,
  type CookieSession,
  type SignedInIdentity
} from './auth-mode'
import type { ResolvedBasePath } from './base-path'

export type BootState =
  | { kind: 'unreachable'; basePath: ResolvedBasePath; error: GatewayError }
  | { kind: 'token_mode'; basePath: ResolvedBasePath; probe: ProbeResult }
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
    return { kind: 'token_mode', basePath, probe: mode.probe }
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
      // `probeGateway` says `auth` only for a 401/403 on the public
      // `/api/status`: something in front of the gateway refused.
      return errors.authProxy({ status: error.status ?? 401 })
    case 'incompatible':
      return errors.incompatible
    default:
      return errors.unknown
  }
}
