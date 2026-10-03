/**
 * Everything the built-in provider remembers, on the service's own disk.
 *
 * It sits beside `admin.json` and `push.json` and is held to the same standard:
 * one JSON file, `0600`, in a `0700` directory, written through a temp file and
 * a rename, and every read failure answering "nothing is enabled" rather than
 * taking the service down over a file it could ignore.
 *
 * **This file is the sharpest object in the state directory.** The push state
 * holds a credential for one gateway; this holds the SIGNING KEY of the issuer
 * that gateway trusts, which is the power to mint any identity on it. The
 * threat model in ADR-0025's amendment is about exactly this, and the reason
 * the whole feature is off by default.
 *
 * ## Why refresh tokens live here and authorization codes do not
 *
 * A refresh token is spent hours or weeks after it was issued, so it has to
 * survive a restart — the service login that push depends on is one. A code is
 * spent within seconds of being issued by a browser that is mid-redirect, so a
 * restart during one is a sign-in that failed, which is the correct outcome
 * anyway. Codes are therefore in memory (`provider.ts`) and refresh tokens are
 * here, as DIGESTS: a stolen state file should not hand over working tokens on
 * top of the key that could mint them.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { jsonWritesSettled, writeJsonAtomic } from '../fs/atomic-json'
import { prunedKeys, type StoredKey } from './keys'
import { OIDC_ROLES, type OidcRole, type OidcUser, type PasswordHash } from './users'

export const OIDC_STATE_VERSION = 1
export const OIDC_STATE_FILE = 'oidc.json'

/**
 * The gateway, registered as this issuer's one client.
 *
 * One client and not a registry, because there is exactly one relying party in
 * this design and a self-service client registration would be a second identity
 * surface to secure for nobody's benefit. `clientId` is generated once per
 * install so two deployments never share one.
 */
export interface OidcClient {
  clientId: string
  /**
   * Where an authorization response may be sent.
   *
   * Seeded with the gateway's own `/auth/callback` on the public URL, because
   * that is the only redirect URI upstream ever asks for — see the note in
   * `provider.ts` about why the native app's loopback URI is NOT here.
   */
  redirectUris: string[]
  postLogoutRedirectUris: string[]
}

/** One issued refresh token, as a digest and the facts needed to rotate it. */
export interface StoredRefresh {
  digest: string
  /**
   * The rotation family.
   *
   * Every token descended from one sign-in shares it. Presenting a token that
   * has already been rotated is the signature of a stolen copy being replayed,
   * and the answer is to revoke the whole family rather than just that token —
   * OAuth 2.0 Security BCP §4.14.2.
   */
  family: string
  sub: string
  clientId: string
  scope: string
  issuedAt: number
  expiresAt: number
  /** Set when this token has been exchanged. A used token revokes its family. */
  used: boolean
}

export interface OidcSettings {
  /**
   * How long an ID token is good for.
   *
   * It is the gateway's SESSION length, not a detail: upstream stores the ID
   * token in `Session.access_token` and re-verifies it on every request
   * (`verify_session`), refreshing only once it has expired. An hour is the
   * usual answer and what every IdP defaults to.
   */
  idTokenTtlSeconds: number
  accessTokenTtlSeconds: number
  /** How long a refresh token family may be renewed for. */
  refreshTokenTtlSeconds: number
  /** Refuse a sign-in by anybody who has not enrolled a second factor. */
  requireTotp: boolean
}

export interface OidcState {
  v: number
  /** Off until an operator turns it on, which is the whole default. */
  enabled: boolean
  /**
   * The issuer URL, captured from the origin `/admin` was reached on when the
   * provider was enabled.
   *
   * It cannot be derived per request: every token carries it as `iss` and
   * upstream pins the discovery document against it, so a value that changed
   * with the `Host` header would be a different issuer on every hop.
   */
  issuer: string
  keys: StoredKey[]
  client: OidcClient
  users: OidcUser[]
  refresh: StoredRefresh[]
  settings: OidcSettings
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry) : []

export const DEFAULT_OIDC_SETTINGS: OidcSettings = {
  idTokenTtlSeconds: 3600,
  accessTokenTtlSeconds: 3600,
  // Thirty days. Long enough that a push daemon signed in once keeps working
  // across an operator's holiday, short enough that an abandoned grant lapses.
  refreshTokenTtlSeconds: 30 * 24 * 3600,
  requireTotp: false
}

export function emptyOidcState(): OidcState {
  return {
    v: OIDC_STATE_VERSION,
    enabled: false,
    issuer: '',
    keys: [],
    client: { clientId: '', redirectUris: [], postLogoutRedirectUris: [] },
    users: [],
    refresh: [],
    settings: { ...DEFAULT_OIDC_SETTINGS }
  }
}

function passwordOf(raw: unknown): PasswordHash | undefined {
  const row = (raw ?? {}) as Record<string, unknown>

  if (!str(row.salt) || !str(row.hash)) {
    return undefined
  }

  return { salt: str(row.salt), hash: str(row.hash), n: num(row.n, 16_384), r: num(row.r, 8), p: num(row.p, 1) }
}

function userOf(raw: Record<string, unknown>): OidcUser | null {
  const sub = str(raw.sub)
  const username = str(raw.username)

  // A row with no subject or no name is not an account. Dropped rather than
  // repaired: a `sub` invented here would be a different person to the one the
  // gateway already knows.
  if (!sub || !username) {
    return null
  }

  const role = str(raw.role)
  const invite = (raw.invite ?? {}) as Record<string, unknown>
  const password = passwordOf(raw.password)

  return {
    sub,
    username,
    email: str(raw.email),
    displayName: str(raw.displayName),
    role: (OIDC_ROLES as readonly string[]).includes(role) ? (role as OidcRole) : 'user',
    // Only meaningful beside the role it explains; a hand-edited `user` role
    // with the flag left on is just a `user`.
    ...(raw.roleFromEnv === true && role === 'admin' ? { roleFromEnv: true as const } : {}),
    ...(password ? { password } : {}),
    totpSecret: str(raw.totpSecret),
    recoveryCodes: strings(raw.recoveryCodes),
    disabled: bool(raw.disabled, false),
    createdAt: num(raw.createdAt),
    lastSignInAt: num(raw.lastSignInAt),
    ...(str(invite.digest) ? { invite: { digest: str(invite.digest), expiresAt: num(invite.expiresAt) } } : {})
  }
}

function keyOf(raw: Record<string, unknown>): StoredKey | null {
  const jwk = (raw.publicJwk ?? {}) as Record<string, unknown>
  const kid = str(raw.kid)

  if (!kid || !str(raw.privatePem) || !str(jwk.n) || !str(jwk.e)) {
    return null
  }

  return {
    kid,
    privatePem: str(raw.privatePem),
    publicJwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: str(jwk.n), e: str(jwk.e) },
    createdAt: num(raw.createdAt),
    retireBefore: num(raw.retireBefore)
  }
}

/** Read the file defensively — an operator may have edited it by hand. */
export function oidcStateOf(parsed: unknown, now: number = Math.floor(Date.now() / 1000)): OidcState {
  const raw = (parsed ?? {}) as Record<string, unknown>

  if (num(raw.v) !== OIDC_STATE_VERSION) {
    return emptyOidcState()
  }

  const client = (raw.client ?? {}) as Record<string, unknown>
  const settings = (raw.settings ?? {}) as Record<string, unknown>
  const base = DEFAULT_OIDC_SETTINGS
  const keys = Array.isArray(raw.keys)
    ? raw.keys
        .map(entry => keyOf((entry ?? {}) as Record<string, unknown>))
        .filter((key): key is StoredKey => key !== null)
    : []

  return {
    v: OIDC_STATE_VERSION,
    // Enabled with no key and no issuer is not enabled, whatever the flag says:
    // it is a file somebody truncated, and answering discovery from it would
    // publish an issuer that can sign nothing.
    enabled: bool(raw.enabled, false) && keys.length > 0 && !!str(raw.issuer),
    issuer: str(raw.issuer).replace(/\/+$/, ''),
    keys: keys.length ? prunedKeys(keys, now) : [],
    client: {
      clientId: str(client.clientId),
      redirectUris: strings(client.redirectUris),
      postLogoutRedirectUris: strings(client.postLogoutRedirectUris)
    },
    users: Array.isArray(raw.users)
      ? raw.users
          .map(entry => userOf((entry ?? {}) as Record<string, unknown>))
          .filter((user): user is OidcUser => user !== null)
      : [],
    // A refresh token that has lapsed is dropped on read rather than kept and
    // checked for ever, so the file does not grow without limit.
    refresh: Array.isArray(raw.refresh)
      ? raw.refresh
          .map(entry => {
            const row = (entry ?? {}) as Record<string, unknown>

            return {
              digest: str(row.digest),
              family: str(row.family),
              sub: str(row.sub),
              clientId: str(row.clientId),
              scope: str(row.scope),
              issuedAt: num(row.issuedAt),
              expiresAt: num(row.expiresAt),
              used: bool(row.used, false)
            }
          })
          .filter(row => row.digest && row.expiresAt > now)
      : [],
    settings: {
      idTokenTtlSeconds: Math.max(60, num(settings.idTokenTtlSeconds, base.idTokenTtlSeconds)),
      accessTokenTtlSeconds: Math.max(60, num(settings.accessTokenTtlSeconds, base.accessTokenTtlSeconds)),
      refreshTokenTtlSeconds: Math.max(300, num(settings.refreshTokenTtlSeconds, base.refreshTokenTtlSeconds)),
      requireTotp: bool(settings.requireTotp, false)
    }
  }
}

export function oidcStatePath(stateDir: string): string {
  return path.join(stateDir, OIDC_STATE_FILE)
}

export async function loadOidcState(stateDir: string): Promise<OidcState> {
  try {
    return oidcStateOf(JSON.parse(await readFile(oidcStatePath(stateDir), 'utf8')))
  } catch {
    // No file, an unreadable one, or one from a version this build does not
    // know. All three are the same answer: the provider is off.
    return emptyOidcState()
  }
}

/**
 * Write the whole state, after every write of the same file asked for before it.
 *
 * Joins the same per-file chain `admin.json` uses (`fs/atomic-json.ts`): writes
 * land in call order, each through a temp file of its own and an atomic rename,
 * so an older snapshot can never land last and undo a newer one (a refresh
 * token just rotated, a key just added). The state is serialised at the call;
 * the returned promise rejects if THIS write failed, and the chain carries on.
 */
export function saveOidcState(stateDir: string, state: OidcState): Promise<void> {
  return writeJsonAtomic(oidcStatePath(stateDir), state)
}

/**
 * Resolves once every write of this state file asked for so far has finished,
 * whether it succeeded or not.
 */
export function oidcStateSettled(stateDir: string): Promise<void> {
  return jsonWritesSettled(oidcStatePath(stateDir))
}
