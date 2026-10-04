/**
 * Leaving for the gateway's sign-in page and coming back, and leaving for good.
 *
 * The client has no sign-in form (plan W5): signing in happens on the
 * gateway's own `/login`, which then goes to `next`. Two things do not survive
 * that trip and are handled here:
 *
 *  - **The route.** It lives in the fragment (plan W4), and `/login` drops it.
 *    `signIn` stashes it in `sessionStorage` (this tab only, gone with it) and
 *    `restoreRoute` puts it back once, on the boot that follows.
 *  - **Who was signed in.** The cache and the identity-bound settings belong to
 *    one person. `signOut` clears them; `claimForOwner` clears them when the
 *    person now signed in is not the one they were written for, because a
 *    session that lapses and is signed back into as somebody else never passes
 *    through `signOut`.
 *
 * On a gateway without sign-in there is no `/login` to go to: `forgetToken` is
 * the sign-out's local half, and the caller drops the token and shows the
 * token prompt itself. It is also what a tab does when another tab on the same
 * gateway signed out or forgot the token (`platform/tab-channel.ts`).
 *
 * A third trip is the same bounce with a purpose: adding a passkey by signing in
 * again (`reauthSignIn`, contract §7.2). The grant the gateway opened for it
 * survives the trip in `sessionStorage` (`createEnrolStash`: its id and its
 * deadline, nothing else), and the passkey model finishes the enrolment when the
 * page is back.
 *
 * Nothing stored here is a credential: a route, an author id
 * (`<provider>:<user id>`), which the gateway stamps on every message anyway, and
 * a grant's id and deadline (the grant's secret is an HttpOnly cookie this code
 * never sees; the id alone authorises nothing).
 */
import type { CredentialProvider } from '@hermie/gateway-client'

import type { ResolvedBasePath } from './base-path'
import type { ChatCache } from '../platform/chat-cache'
import type { WebKeyValueStore } from '../platform/key-value-store'

/** The part of `Storage` the stash uses. */
export type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The part of `Location` and `History` a bounce uses, so a test can hand in its own. */
export interface BounceEnvironment {
  location: { readonly hash: string; readonly pathname: string; readonly search: string; assign(url: string): void }
  history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void }
  /** `sessionStorage`, or null when the browser refuses it. */
  sessionStorage: SessionStorageLike | null
}

function pageSessionStorage(): SessionStorageLike | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export const pageBounceEnvironment = (): BounceEnvironment => ({
  location: window.location,
  history: window.history,
  sessionStorage: pageSessionStorage()
})

/** Where the stashed fragment lives in `sessionStorage`. */
export const routeStashKey = (basePath: Pick<ResolvedBasePath, 'namespace'>): string =>
  `hermie:${basePath.namespace}:route`

/** Where the open self-enrolment grant lives in `sessionStorage`, next to the route stash. */
export const enrolStashKey = (basePath: Pick<ResolvedBasePath, 'namespace'>): string =>
  `hermie:${basePath.namespace}:passkey-enrol`

/** The identity-bound key that names whose state this browser holds. */
export const OWNER_KEY = 'session.owner'

/** The longest fragment worth carrying across a sign-in. */
const MAX_ROUTE_LENGTH = 2048

/** Only a route of ours is carried: `#/…`, printable ASCII, bounded. */
export const isCarriableRoute = (hash: string): boolean =>
  hash.length > 2 && hash.length <= MAX_ROUTE_LENGTH && hash.startsWith('#/') && /^[\x21-\x7e]+$/u.test(hash)

/** `<prefix>/login?next=<the page's own path>`. */
export const loginUrl = (basePath: Pick<ResolvedBasePath, 'prefix' | 'appPath'>): string =>
  `${basePath.prefix}/login?next=${encodeURIComponent(basePath.appPath)}`

function writeStash(environment: BounceEnvironment, key: string, value: string | null): void {
  try {
    if (value === null) {
      environment.sessionStorage?.removeItem(key)
    } else {
      environment.sessionStorage?.setItem(key, value)
    }
  } catch {
    // A refused stash costs the route, not the sign-in.
  }
}

/**
 * The sign-in page of a self-enrolment, built here from what the gateway's `login_path` says and nothing more: it is
 * parsed first (so dot-segments, encoded dots and doubled slashes are resolved before anything is judged), must land
 * on this origin at exactly `<prefix>/auth/login`, and only its `provider` and `reauth` are taken; `next` is the
 * page's own path. `null` for anything else: whatever the gateway answers, this page navigates nowhere else.
 * Returns a path on this origin.
 */
export function reauthLoginUrl(
  basePath: Pick<ResolvedBasePath, 'appPath' | 'baseUrl' | 'prefix'>,
  loginPath: string
): string | null {
  const origin = new URL(basePath.baseUrl).origin
  let parsed: URL

  try {
    parsed = new URL(loginPath, origin)
  } catch {
    return null
  }

  const reauth = parsed.searchParams.get('reauth')

  if (parsed.origin !== origin || parsed.pathname !== `${basePath.prefix}/auth/login` || !reauth) {
    return null
  }

  const query = new URLSearchParams()
  const provider = parsed.searchParams.get('provider')

  if (provider) {
    query.set('provider', provider)
  }

  query.set('reauth', reauth)
  query.set('next', basePath.appPath)

  return `${parsed.pathname}?${query}`
}

/**
 * Keep the route, then go to the gateway's sign-in page for a self-enrolment (`loginPath` from `reauth/begin`).
 * Returns false, and goes nowhere, when `loginPath` is not acceptable.
 */
export function reauthSignIn(
  basePath: ResolvedBasePath,
  loginPath: string,
  environment: BounceEnvironment = pageBounceEnvironment()
): boolean {
  const url = reauthLoginUrl(basePath, loginPath)

  if (url === null) {
    return false
  }

  const hash = environment.location.hash

  writeStash(environment, routeStashKey(basePath), isCarriableRoute(hash) ? hash : null)
  environment.location.assign(url)

  return true
}

/** What survives the sign-in of a self-enrolment: the grant and when the gateway stops taking it. */
export interface EnrolStashEntry {
  grantId: string
  /** Unix seconds. */
  expiresAt: number
}

/** The stash the passkey model reads and writes (`core/passkey/model.ts`, `selfEnrolment`). */
export interface EnrolStash {
  read(): EnrolStashEntry | null
  /** False when the browser refused to keep it (nothing could be read back): the trip would lose the grant. */
  write(entry: EnrolStashEntry): boolean
  clear(): void
}

/** A grant id as the gateway mints it (16 random bytes, base64url), with room for a longer one. */
const GRANT_ID = /^[A-Za-z0-9_-]{16,64}$/u

/**
 * The self-enrolment stash of this tab: `{"grant_id", "expires_at", "owner"}` under `hermie:<ns>:passkey-enrol`, gone
 * with the tab. `owner` is the author id of the person who started it (the same id the gateway stamps on every
 * message): somebody else signed in when the page is back does not find it, and it is removed. A value that is not
 * exactly that is not a stash and is removed.
 */
export function createEnrolStash(
  basePath: Pick<ResolvedBasePath, 'namespace'>,
  owner: string,
  environment: BounceEnvironment = pageBounceEnvironment()
): EnrolStash {
  const key = enrolStashKey(basePath)

  const read = (): EnrolStashEntry | null => {
    let raw: string | null = null

    try {
      raw = environment.sessionStorage?.getItem(key) ?? null
    } catch {
      return null
    }

    if (raw === null) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as { grant_id?: unknown; expires_at?: unknown; owner?: unknown } | null

      if (
        parsed &&
        parsed.owner === owner &&
        typeof parsed.grant_id === 'string' &&
        GRANT_ID.test(parsed.grant_id) &&
        typeof parsed.expires_at === 'number' &&
        Number.isFinite(parsed.expires_at)
      ) {
        return { grantId: parsed.grant_id, expiresAt: parsed.expires_at }
      }
    } catch {
      // Falls through: not ours.
    }

    writeStash(environment, key, null)

    return null
  }

  return {
    read,
    write(entry) {
      writeStash(environment, key, JSON.stringify({ grant_id: entry.grantId, expires_at: entry.expiresAt, owner }))

      const back = read()

      return back !== null && back.grantId === entry.grantId
    },
    clear() {
      writeStash(environment, key, null)
    }
  }
}

/** Keep the route, then go to the gateway's sign-in page. */
export function signIn(basePath: ResolvedBasePath, environment: BounceEnvironment = pageBounceEnvironment()): void {
  const hash = environment.location.hash

  writeStash(environment, routeStashKey(basePath), isCarriableRoute(hash) ? hash : null)
  environment.location.assign(loginUrl(basePath))
}

/**
 * Put a stashed route back, once. A fragment already in the address wins (a
 * link that was followed knows where it wanted to go), and the stash is removed
 * either way. Returns the fragment now in the address.
 */
export function restoreRoute(
  basePath: ResolvedBasePath,
  environment: BounceEnvironment = pageBounceEnvironment()
): string {
  const key = routeStashKey(basePath)
  let stashed: string | null = null

  try {
    stashed = environment.sessionStorage?.getItem(key) ?? null
  } catch {
    stashed = null
  }

  writeStash(environment, key, null)

  const current = environment.location.hash

  if (current && current !== '#') {
    return current
  }

  if (stashed === null || !isCarriableRoute(stashed)) {
    return current
  }

  // `replaceState` rather than assigning `hash`: no history entry, and no
  // `hashchange` before the router is listening.
  environment.history.replaceState(
    environment.history.state,
    '',
    `${environment.location.pathname}${environment.location.search}${stashed}`
  )

  return stashed
}

/** The state that belongs to whoever is signed in. */
export interface IdentityBoundState {
  cache: ChatCache
  store: WebKeyValueStore
}

/** Remove the transcript cache and every identity-bound setting. Device settings stay. */
export async function clearIdentityBoundState(state: IdentityBoundState): Promise<void> {
  state.store.clearIdentityBound()

  try {
    await state.cache.clear()
  } catch {
    // `FallbackChatCache` does not throw; a cache that does must not keep the
    // person on a page they asked to leave.
  }
}

/**
 * Make the stored state the signed-in person's: when it was written for
 * somebody else (or for nobody this client knows of), clear it first. Returns
 * whether anything was cleared.
 *
 * `ownerId` undefined means the gateway named no identity (`ownAuthorOf`
 * returned nothing); that is a person too, as far as the cache is concerned.
 */
export async function claimForOwner(state: IdentityBoundState, ownerId: string | undefined): Promise<boolean> {
  const owner = ownerId ?? ''
  const previous = state.store.getSync(OWNER_KEY)

  if (previous === owner) {
    return false
  }

  // A first visit (no owner recorded) clears too: anything already there was
  // not written by a client that knew whose it was.
  await clearIdentityBoundState(state)
  state.store.setSync(OWNER_KEY, owner)

  return true
}

export interface SignOutOptions extends IdentityBoundState {
  basePath: ResolvedBasePath
  credentials: Pick<CredentialProvider, 'signOut'>
  environment?: BounceEnvironment
}

/**
 * Sign out at the gateway (`POST /auth/logout`, which clears the cookie), clear
 * the cache and the identity-bound settings, and go to the sign-in page.
 *
 * The local half happens whatever the gateway answered: a sign-out the server
 * never heard about still has to leave nothing of the person behind here. The
 * stashed route goes too; the next person to sign in should not land in this
 * one's chat.
 */
export async function signOut(options: SignOutOptions): Promise<void> {
  const environment = options.environment ?? pageBounceEnvironment()

  try {
    await options.credentials.signOut()
  } catch {
    // `CookieSessionCredentials.signOut` swallows its own failures; this is for any other provider.
  }

  await clearIdentityBoundState(options)
  writeStash(environment, routeStashKey(options.basePath), null)
  writeStash(environment, enrolStashKey(options.basePath), null)
  environment.location.assign(loginUrl(options.basePath))
}

export interface ForgetTokenOptions extends IdentityBoundState {
  basePath: ResolvedBasePath
  environment?: BounceEnvironment
}

/**
 * The sign-out of a gateway without sign-in (plan W-23): clear the cache, the
 * identity-bound settings and the stashed route, as `signOut` does, and go
 * nowhere. The token itself was never stored: the caller forgets it by dropping
 * the session that holds it (stop the connection first). The gateway is not
 * told, because it has nothing to end: its token stays valid until it restarts.
 */
export async function forgetToken(options: ForgetTokenOptions): Promise<void> {
  const environment = options.environment ?? pageBounceEnvironment()

  await clearIdentityBoundState(options)
  writeStash(environment, routeStashKey(options.basePath), null)
  writeStash(environment, enrolStashKey(options.basePath), null)
}
