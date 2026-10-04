import { randomBytes } from 'node:crypto'

import { b64u } from './encoding'
import type { PasskeyGateway } from './gateway'
import { GrantInvalid, reauthSecretHash, type Grant, type GrantClient, type GrantFailure } from './store'

/**
 * Re-authentication grants for passkey self-enrolment, at the gateway level: who may start a sign-in for a
 * grant, and what the sign-in that comes back does to it. The real gateway's `passkeys/reauth.py`, minus the
 * identity provider: the fake plays the provider, so the sign-in is *simulated* and a test scripts what it
 * reports (`SignInScript`, `POST /__fake/passkey/reauth`).
 *
 * The rules are the contract's (§7.2): the binding (a web grant needs the browser's `__Host-hermes_reauth`
 * cookie from the start of the sign-in, a native grant the PKCE verifier), the same person on the same
 * provider, and `auth_time >= created_at - 120`. The script only chooses the facts the provider reports; the
 * rule that judges them is the store's, the same one the contract's `reauth_freshness_vectors` run through.
 */

/** The binding cookie of a web grant: always this shape, whatever the proxy prefix or the scheme. */
export const REAUTH_COOKIE = '__Host-hermes_reauth'

/** The page a browser gets for a dead, foreign or unbound grant at `/auth/login` (400, never a redirect). */
export const EXPIRED_TEXT = 'This passkey set-up has expired or was not started here; go back and start again.'

/** The one sign-in provider of the fake: it names every account's `<provider>:<user id>`. */
export const PROVIDER = 'self-hosted'

/** A grant id as the store mints it: 16 random bytes, base64url without padding. */
const GRANT_ID = /^[A-Za-z0-9_-]{22}$/u

export const isGrantId = (value: unknown): value is string => typeof value === 'string' && GRANT_ID.test(value)

/** A web grant's cookie secret: 32 random bytes, base64url. */
export const newReauthSecret = (): string => b64u(randomBytes(32))

/**
 * What the next simulated sign-in reports, set with `POST /__fake/passkey/reauth`. Nothing set: the person who
 * opened the grant signs in again, on the grant's provider, authenticated now: a fresh sign-in.
 *
 * - `fail` names a reason the sign-in must fail with, and sets the facts that produce it (`provider_mismatch`:
 *   another provider; `user_mismatch`: another person; `auth_time_missing`: no `auth_time`; `auth_not_fresh`:
 *   an hour before the grant was opened).
 * - `authTime` (Unix seconds; `null` or 0: none) overrides the reported time; `user` and `provider` override
 *   who signed in. They combine with `fail` (an explicit value wins).
 * - `sticky`: apply to every sign-in until cleared; otherwise to the next one only.
 */
export interface SignInScript {
  fail?: GrantFailure
  authTime?: number | null
  user?: string
  provider?: string
  sticky: boolean
}

/** What a sign-in reports about the person who just authenticated. */
export interface SignInFacts {
  /** `<provider>:<user id>`. */
  user: string
  provider: string
  /** Unix seconds; 0: the provider did not say. */
  authTime: number
}

/** How a sign-in left a grant (the `reauth` object of the native token route's answer). */
export interface Outcome {
  grantId: string
  state: 'fresh' | 'failed'
  reason: string
  expiresAt: number
  useSecret: string
  /** The facts the (simulated) provider reported; `null` when the grant could not be completed at all. */
  facts: SignInFacts | null
}

export const outcomeBody = (outcome: Outcome): Record<string, unknown> => ({
  grant_id: outcome.grantId,
  state: outcome.state,
  expires_at: outcome.expiresAt,
  ...(outcome.reason ? { reason: outcome.reason } : {}),
  ...(outcome.useSecret ? { use_secret: outcome.useSecret } : {})
})

/** Why this person cannot add a passkey by signing in again (`''` when they can): the status route's `reason`. */
export function selfEnrolReason(gw: PasskeyGateway): '' | 'disabled' | 'provider_no_reauth' {
  if (!gw.settings.selfEnrol.enabled) {
    return 'disabled'
  }

  return gw.settings.providerReauth ? '' : 'provider_no_reauth'
}

/** The level and self-enrolment are on and the provider can authenticate again: a grant is usable. */
export const policyUsable = (gw: PasskeyGateway): boolean =>
  gw.settings.enabled && gw.settings.selfEnrol.enabled && gw.settings.providerReauth

// ── where a sign-in starts ───────────────────────────────────────────────────────────────────────

const refusalKey = (ip: string, grantId: string): string => `${ip}|${grantId}`

/**
 * One `reauth` check on a public sign-in route, holding a reserved slot in each refusal budget that applies.
 * `allowed: false`: answer 429 with `retryAfter` seconds, nothing was reserved. A check that found the grant
 * gives its slots back with `succeeded`; a refusal keeps them (it was counted). The real gateway's
 * `reauth.begin_attempt`: a wide ceiling per address (200 in 600 s, reserved first, so spraying random ids
 * ends in 429 instead of costing reads forever) and a narrow budget per address and grant id (20 in 600 s,
 * so one client behind a shared address retrying a dead grant does not use up the ceiling's room), both
 * reserved before anything is read. A malformed id is not counted in the second.
 */
export interface Attempt {
  allowed: boolean
  retryAfter: number
  succeeded(): void
}

export function beginAttempt(gw: PasskeyGateway, ip: string, grantId: string): Attempt {
  const { reauthRefusalsPerAddress: perAddress, reauthRefusalsPerGrant: perGrant } = gw.limiters
  const stamp = perAddress.reserve(ip)

  if (stamp === null) {
    return { allowed: false, retryAfter: perAddress.retryAfter(ip), succeeded: () => undefined }
  }

  const slots: { limiter: typeof perAddress; key: string; stamp: number }[] = [{ limiter: perAddress, key: ip, stamp }]

  if (isGrantId(grantId)) {
    const key = refusalKey(ip, grantId)
    const grantStamp = perGrant.reserve(key)

    if (grantStamp === null) {
      perAddress.release(ip, stamp)

      return { allowed: false, retryAfter: perGrant.retryAfter(key), succeeded: () => undefined }
    }

    slots.push({ limiter: perGrant, key, stamp: grantStamp })
  }

  return {
    allowed: true,
    retryAfter: 0,
    succeeded: () => {
      for (const slot of slots.splice(0)) {
        slot.limiter.release(slot.key, slot.stamp)
      }
    }
  }
}

function refused(gw: PasskeyGateway, grantId: string, reason: string, userId = ''): void {
  gw.note({ surface: 'reauth', reason, userId, requestId: isGrantId(grantId) ? grantId.slice(0, 8) : '' })
}

/**
 * The open, unexpired `client` grant a sign-in with `provider` may start for, or `undefined` (noted and counted
 * against the refusal budget). A web grant needs this browser's cookie `secret`; a native one is looked up
 * without a secret and must be a native grant.
 */
export function grantForLogin(
  gw: PasskeyGateway,
  options: { grantId: string; provider: string; client: GrantClient; secret: string | null }
): Grant | undefined {
  const { grantId, provider, client, secret } = options
  let reason = ''
  let grant: Grant | undefined

  if (!isGrantId(grantId)) {
    reason = 'malformed'
  } else if (!policyUsable(gw)) {
    reason = gw.settings.providerReauth ? 'unknown' : 'provider_no_reauth'
  } else if (provider !== PROVIDER) {
    reason = 'provider_no_reauth'
  } else if (client === 'web' && !secret) {
    reason = 'client_mismatch' // no binding cookie in this browser: the link attack ends here
  } else {
    grant = gw.store.grantForLogin(grantId, provider, client === 'web' ? secret : null)

    if (!grant) {
      reason = 'unknown'
    } else if (grant.client !== client) {
      grant = undefined
      reason = 'client_mismatch'
    }
  }

  if (!grant) {
    refused(gw, grantId, reason)
  }

  return grant
}

/** A native authorize request named no provider: the grant names it. */
export function nativeGrantForLogin(gw: PasskeyGateway, grantId: string): Grant | undefined {
  if (isGrantId(grantId) && policyUsable(gw)) {
    const grant = gw.store.grantForLogin(grantId, PROVIDER, null)

    if (grant && grant.client === 'native') {
      return grant
    }
  }

  refused(gw, grantId, isGrantId(grantId) ? 'unknown' : 'malformed')

  return undefined
}

// ── completing ───────────────────────────────────────────────────────────────────────────────────

/** The facts the simulated provider reports for a sign-in that completes `grant`, per the script. */
export function signInFacts(gw: PasskeyGateway, grant: Grant, script: SignInScript | null): SignInFacts {
  const fail = script?.fail
  const provider = script?.provider ?? (fail === 'provider_mismatch' ? 'basic' : grant.provider)
  const user =
    script?.user ??
    (fail === 'user_mismatch' || fail === 'provider_mismatch'
      ? `${provider}:someone-else@example.invalid`
      : grant.userId)
  let authTime = gw.store.now()

  if (script && script.authTime !== undefined) {
    authTime = script.authTime ?? 0
  } else if (fail === 'auth_time_missing') {
    authTime = 0
  } else if (fail === 'auth_not_fresh') {
    authTime = grant.createdAt - 3600
  }

  return { user, provider, authTime }
}

/** The script the next completion uses, and its consumption (a script that is not `sticky` serves once). */
export function takeScript(gw: PasskeyGateway): SignInScript | null {
  const script = gw.signInScript

  if (script && !script.sticky) {
    gw.signInScript = null
  }

  return script
}

/**
 * Complete `grantId` with the sign-in that just came back (`web`: with the browser's cookie `secret`;
 * `native`: at the token route, no secret). Never throws, and never undoes the sign-in. A web completion
 * without the cookie, or with another grant's, leaves the grant as it was and answers `client_mismatch`.
 */
export function complete(
  gw: PasskeyGateway,
  grantId: string,
  options: { client: GrantClient; secret: string | null }
): Outcome {
  const { client, secret } = options
  const failed = (reason: string, expiresAt = 0, facts: SignInFacts | null = null): Outcome => ({
    grantId,
    state: 'failed',
    reason,
    expiresAt,
    useSecret: '',
    facts
  })
  const peeked = isGrantId(grantId) ? gw.store.peekGrant(grantId) : undefined

  if (!peeked || !policyUsable(gw)) {
    refused(gw, grantId, 'unknown')

    return failed('unknown')
  }

  if (client === 'web' && !secret) {
    refused(gw, grantId, 'client_mismatch', peeked.userId)

    return failed('client_mismatch')
  }

  const facts = signInFacts(gw, peeked, takeScript(gw))
  const useSecret = client === 'native' ? newReauthSecret() : ''

  try {
    const grant = gw.store.completeGrant(grantId, {
      sessionUser: facts.user,
      sessionProvider: facts.provider,
      authTime: facts.authTime,
      client,
      secret: client === 'web' ? secret : null,
      useSecretHash: useSecret ? reauthSecretHash(useSecret) : null,
      acceptMissing: gw.settings.selfEnrol.acceptMissingAuthTime
    })

    if (grant.state === 'fresh') {
      return { grantId: grant.id, state: 'fresh', reason: '', expiresAt: grant.expiresAt, useSecret, facts }
    }

    refused(gw, grantId, grant.failure, facts.user)

    return failed(grant.failure, grant.expiresAt, facts)
  } catch (error) {
    if (!(error instanceof GrantInvalid)) {
      throw error
    }

    // "unknown" to the store also covers a grant of the other kind of client and a web secret that does not
    // match: for a web sign-in the binding failed. Nothing changed either way.
    const reason = client === 'web' && error.reason === 'unknown' ? 'client_mismatch' : error.reason

    refused(gw, grantId, reason, facts.user)

    return failed(reason, 0, facts)
  }
}
