/**
 * Reading a gateway's session token again after the gateway refused it while
 * the page was open (plan W-23, review).
 *
 * The fork mints a fresh session token for every server process, so each
 * gateway restart leaves an open page on a token it no longer takes: the socket
 * is refused (4401) and the connection stops at `needs_signin`. The dashboard
 * reloads once by itself; this is the client's equivalent, run once per
 * started app by `main.tsx`:
 *
 *  - probe again: a gateway that turned sign-in on meanwhile is the cookie flow
 *    (`restart` with the boot's own outcome, `signed_in` or `needs_signin`);
 *  - otherwise read the dashboard's bootstrap again (`dashboard-token.ts`): no
 *    token, or the same one the page already holds, is `unchanged` / `failed`,
 *    and the connection line's "Read it from the dashboard again" stays as the
 *    fallback;
 *  - a different token is checked like any other (`bootWithToken`) and, taken,
 *    is `restart` with the new session.
 *
 * Nothing here logs or stores a token; the comparison reads the old one back
 * from its credentials and lets it go.
 */
import { SESSION_TOKEN_HEADER, type SessionTokenCredentials } from '@hermie/gateway-client'

import { detectAuthMode } from './auth-mode'
import type { ResolvedBasePath } from './base-path'
import { boot, type BootOptions, type BootState, bootWithToken } from './boot'
import { readDashboardToken } from './dashboard-token'

export type TokenReread =
  /** The page carries the token the gateway just refused: nothing to gain from reloading. */
  | { kind: 'unchanged' }
  /** No token could be read or checked: the probe, the page or the check failed, or the new one was refused. */
  | { kind: 'failed' }
  /** Start over on this: a new session token that was taken, or the cookie flow of a gateway now gated. */
  | { kind: 'restart'; state: BootState }

const holds = async (credentials: SessionTokenCredentials, token: string): Promise<boolean> =>
  (await credentials.httpAuthHeaders())[SESSION_TOKEN_HEADER] === token

export async function rereadToken(
  basePath: ResolvedBasePath,
  current: SessionTokenCredentials,
  options: BootOptions = {}
): Promise<TokenReread> {
  let mode

  try {
    mode = await detectAuthMode(basePath.baseUrl, options.fetchImpl)
  } catch {
    return { kind: 'failed' }
  }

  if (mode.kind === 'cookie') {
    const state = await boot(basePath, options)

    return state.kind === 'unreachable' ? { kind: 'failed' } : { kind: 'restart', state }
  }

  const token = await readDashboardToken(basePath.baseUrl, options.fetchImpl)

  if (token === null) {
    return { kind: 'failed' }
  }

  if (await holds(current, token)) {
    return { kind: 'unchanged' }
  }

  const next = await bootWithToken(basePath, mode.probe, token, options)

  return next.kind === 'token_ready' ? { kind: 'restart', state: next } : { kind: 'failed' }
}
