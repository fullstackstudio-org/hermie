import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  enrolmentCodeDisplay,
  enrolmentCodeHash,
  GATEWAY_ID_BYTES,
  HANDLE_KEY_BYTES,
  NONCE_BYTES,
  textDigest
} from './challenge'
import { b64u } from './encoding'
import type { AssertionOk, PendingRegistration, RegistrationOk, StoredCredential } from './webauthn'

/**
 * The passkey store, in memory: this gateway's identity, credentials per `<provider>:<user id>`, the
 * enrolment codes (SHA-256 of the canonical code only), the open registrations and step-ups, and the
 * receipts of verified answers (digests and signed bytes, never the confirmed text).
 *
 * It keeps the rules of the real store (`hermes_cli/dashboard_auth/passkeys/store.py`), which are what
 * the routes and the confirm path lean on:
 *
 * - a code is redeemed at most once, by the user it is bound to, before it expires, and only together
 *   with the credential it enrols (a failed enrolment leaves the code and the registration unused);
 * - a registration or step-up id is taken at most once, by its user, before it expires, and only by the
 *   verified result made for exactly it (same id and nonce);
 * - an assertion commit re-reads the credential (revoked meanwhile, another user's, another key: refused),
 *   re-applies the counter rule to the value stored NOW, writes the new count and a receipt, and a second
 *   commit of one request or nonce is refused.
 *
 * A re-authentication grant (self-enrolment without a code) is a third enrolment authority next to the two
 * kinds of code, with the real store's rules: a session opens it (`open`), a sign-in of the same person that
 * the provider reports as fresh completes it once (`fresh` or `failed`), and the enrolment it authorises
 * spends it in the credential insert's own step (`spent`): one grant, at most one credential, never after
 * `GRANT_TTL`. The binding holds until the spend: a web grant is bound to the browser that opened it by a
 * secret only its cookie holds, a native grant hands the app a `use_secret` when it completes fresh; both
 * are kept as SHA-256 only, and without its binding a grant is `unknown` whatever its state.
 *
 * A credential enrolled with a cooling-off period (`usableFrom` in the future) is listed by `credentials`
 * and can be revoked, but it is in no `snapshot` and an assertion with it is never committed.
 *
 * It never returns a revoked credential as active and never deletes one: a revoked credential id stays
 * taken. Time is whole Unix seconds from the `clock` given to it. Nothing is persisted: a restart of the
 * fake is a new gateway with a new identity, which is also what a reset store is.
 */

export const OPERATOR = 'operator'
export const CODE_TTL = 15 * 60
export const OPERATOR_CODE_TTL_MAX = 24 * 60 * 60
export const REGISTRATION_TTL = 300
export const STEPUP_TTL = 120
export const STEPUP_PURPOSES = ['invite', 'revoke'] as const
/** A grant lives as long as the PKCE cookie it rides in. */
export const GRANT_TTL = 600
/** A sign-in counts as fresh when `auth_time >= grant.created_at - REAUTH_SKEW`. */
export const REAUTH_SKEW = 120
export const GRANT_CLIENTS = ['web', 'native'] as const
export const GRANT_FAILURES = ['provider_mismatch', 'user_mismatch', 'auth_time_missing', 'auth_not_fresh'] as const

export type GrantClient = (typeof GRANT_CLIENTS)[number]
export type GrantFailure = (typeof GRANT_FAILURES)[number]
export type GrantState = 'open' | 'fresh' | 'failed' | 'spent'

/** What the store keeps of a grant's binding secret (a web grant's cookie, a native grant's `use_secret`). */
export const reauthSecretHash = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest()

const COMMIT_PURPOSES = ['confirm', ...STEPUP_PURPOSES]
const PENDING_KINDS = ['register', ...STEPUP_PURPOSES]

export class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

/** One answer for an unknown, expired, used or wrong-user enrolment code. */
export class CodeInvalid extends StoreError {}
/** The registration or step-up id is unknown, expired, used, of another kind or of another user. */
export class PendingInvalid extends StoreError {}
/** The credential id is already stored (active or revoked). */
export class CredentialExists extends StoreError {}

/**
 * A re-authentication grant cannot be used or completed; nothing changed. Using one (`freshGrant`,
 * `addCredential`): `reason` is `unknown` (no such grant for this user, expired, or presented without its use
 * binding), `not_fresh` (still open), `spent` or `failed` (then `failure` is one of `GRANT_FAILURES`).
 * Completing one (`completeGrant`): `unknown` (no such grant, expired, the other kind of client, or a web grant
 * without its secret) or `not_open` (completed before; `state` says how).
 */
export class GrantInvalid extends StoreError {
  constructor(
    readonly reason: string,
    readonly failure = '',
    readonly state = ''
  ) {
    super(reason)
  }
}

/**
 * An assertion that verified cannot be committed. `reason`: `revoked` (also unknown, another user, another
 * key), `counter_regression` (against the value stored now), `stepup_invalid`, `purpose_invalid` or
 * `replayed` (this request or nonce was committed before).
 */
export class CommitRefused extends StoreError {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export interface CredentialRecord {
  row: number
  userId: string
  credentialId: Buffer
  rpId: string
  alg: number
  publicX: Buffer
  publicY: Buffer
  signCount: number
  backupEligible: boolean
  backedUp: boolean
  aaguid: Buffer
  transports: string[]
  name: string
  createdAt: number
  createdVia: string
  createdIp: string
  lastUsedAt: number | null
  revokedAt: number | null
  revokedBy: string | null
  /** A self-enrolled credential's cooling-off end; `null`: usable at once. */
  usableFrom: number | null
}

/** A re-authentication grant. The hashes of its web secret and native use secret stay in the store. */
export interface Grant {
  id: string
  /** `<provider>:<user id>` of the session that opened it. */
  userId: string
  provider: string
  client: GrantClient
  state: GrantState
  /** With `failed`: one of `GRANT_FAILURES`; `''` otherwise. */
  failure: string
  /** What the provider reported (0: nothing); `null` while the grant is open. */
  authTime: number | null
  authTimeAssumed: boolean
  createdAt: number
  expiresAt: number
  completedAt: number | null
  spentAt: number | null
  credentialRow: number | null
}

interface GrantRow extends Grant {
  secretHash: Buffer | null
  useSecretHash: Buffer | null
}

export interface Invite {
  /** The display form; shown once, never stored. */
  code: string
  userId: string | null
  expiresAt: number
}

export interface Pending {
  id: string
  kind: string
  userId: string
  nonce: Buffer
  rpId: string
  baseUrl: string
  /** The credential name (register), `invite`, or the credential id (revoke). */
  subject: string
  createdAt: number
  expiresAt: number
}

export interface Receipt {
  id: number
  at: number
  purpose: string
  userId: string
  credentialRow: number
  rpId: string
  baseUrl: string
  sessionId: string
  requestId: string
  nonce: Buffer
  textDigest: Buffer
  authenticatorData: Buffer
  clientDataJson: Buffer
  signature: Buffer
}

export interface Committed {
  credential: CredentialRecord
  receiptId: number
  counterWarning: boolean
}

interface InviteRow {
  userId: string | null
  mintedBy: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
}

export const isActive = (c: CredentialRecord): boolean => c.revokedAt === null

/** Active and past any cooling-off period: may answer a `confirm` or sign a step-up. */
export const isUsable = (c: CredentialRecord, now: number): boolean =>
  isActive(c) && (c.usableFrom === null || c.usableFrom <= now)

export const idOf = (c: CredentialRecord): string => b64u(c.credentialId)

export const stored = (c: CredentialRecord): StoredCredential => ({
  credentialId: c.credentialId,
  userId: c.userId,
  rpId: c.rpId,
  publicX: c.publicX,
  publicY: c.publicY,
  signCount: c.signCount,
  backupEligible: c.backupEligible,
  active: isActive(c)
})

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b)

export interface PasskeyStoreOptions {
  /** Milliseconds since the epoch. */
  clock?: () => number
  /** `n` random bytes. Replaced by a seeded source in tests that need stable ids. */
  random?: (n: number) => Buffer
}

export class PasskeyStore {
  readonly gatewayId: Buffer
  readonly handleKey: Buffer

  private readonly clock: () => number
  private readonly random: (n: number) => Buffer
  private readonly records: CredentialRecord[] = []
  private readonly invites = new Map<string, InviteRow>()
  private readonly open = new Map<string, Pending>()
  private readonly grantRows = new Map<string, GrantRow>()
  private readonly receiptRows: Receipt[] = []
  private nextRow = 1
  private nextReceipt = 1

  constructor(options: PasskeyStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.random = options.random ?? randomBytes
    this.gatewayId = this.random(GATEWAY_ID_BYTES)
    this.handleKey = this.random(HANDLE_KEY_BYTES)
  }

  now(): number {
    return Math.floor(this.clock() / 1000)
  }

  // ── credentials ──────────────────────────────────────────────────────────────────────────────

  /**
   * Active credentials (with `includeRevoked`, revoked ones too), cooling-off ones included with their
   * `usableFrom`. `usableOnly`: only those that may answer or sign a step-up now (active and past any
   * cooling-off; it overrides `includeRevoked`).
   */
  credentials(userId?: string, includeRevoked = false, usableOnly = false): CredentialRecord[] {
    const now = this.now()

    return this.records
      .filter(
        c =>
          (userId === undefined || c.userId === userId) &&
          (usableOnly ? isUsable(c, now) : includeRevoked || isActive(c))
      )
      .map(c => ({ ...c }))
  }

  /**
   * `userId`'s usable credentials as the verifier takes them when a request opens (one in its cooling-off
   * period is not one: it is no `confirm` target and cannot sign a step-up).
   */
  snapshot(userId: string): StoredCredential[] {
    return this.credentials(userId, false, true).map(stored)
  }

  credential(credentialId: Uint8Array): CredentialRecord | undefined {
    const found = this.records.find(c => equal(c.credentialId, credentialId))

    return found ? { ...found } : undefined
  }

  /** Credentials whose base64url id starts with `prefix` (the operator's `revoke <prefix>`). */
  find(prefix: string, includeRevoked = false): CredentialRecord[] {
    return prefix ? this.credentials(undefined, includeRevoked).filter(c => idOf(c).startsWith(prefix)) : []
  }

  /**
   * Enrol: take the open registration `registration` was verified against, redeem the authority and store
   * the credential, all or nothing. `userId` is the signed-in caller.
   *
   * The authority is exactly one of `code` (an enrolment code; `createdVia` is `operator` or `passkey` by who
   * minted it) or `grantId` with its `grantSecret` (a `fresh` re-authentication grant of `userId` and its use
   * binding: the web cookie secret or the native `use_secret`, checked and spent here; `createdVia` is
   * `self`). `usableFrom` (Unix seconds, ignored unless in the future) starts a cooling-off period.
   *
   * Checked in this order: the registration, the authority, the credential id; on any refusal
   * (`PendingInvalid`, `CodeInvalid` / `GrantInvalid`, `CredentialExists`) nothing changes, so the person
   * can try again while the registration is open (and a refused grant is not spent).
   */
  addCredential(options: {
    userId: string
    registration: RegistrationOk
    code?: string
    grantId?: string
    grantSecret?: string | null
    usableFrom?: number | null
    createdIp?: string
  }): CredentialRecord {
    const { userId, registration } = options

    if ((options.code === undefined) === (options.grantId === undefined)) {
      throw new Error('exactly one of code or grantId')
    }

    const now = this.now()

    if (registration.userId !== userId) {
      throw new PendingInvalid('the registration belongs to another user')
    }

    const pending = this.checkPending(registration.registrationId, {
      kind: 'register',
      userId,
      now,
      nonce: registration.nonce
    })

    if (pending.rpId !== registration.rpId) {
      throw new PendingInvalid('the registration was opened for another RP')
    }

    let invite: InviteRow | undefined
    let grant: GrantRow | undefined

    if (options.grantId !== undefined) {
      grant = this.grantRows.get(String(options.grantId))

      const refusal = grantUnusable(grant, { userId, now, secret: options.grantSecret ?? null })

      if (refusal) {
        throw refusal
      }
    } else {
      const hash = enrolmentCodeHash(options.code as string)

      invite = hash ? this.invites.get(hash.toString('hex')) : undefined

      if (
        !invite ||
        invite.usedAt !== null ||
        invite.expiresAt <= now ||
        (invite.userId !== null && invite.userId !== userId)
      ) {
        throw new CodeInvalid('code_invalid')
      }
    }

    if (this.records.some(c => equal(c.credentialId, registration.credentialId))) {
      throw new CredentialExists('credential_exists')
    }

    // Everything checked: now change things.
    this.open.delete(pending.id)

    let createdVia = 'self'

    if (invite) {
      invite.usedAt = now
      invite.usedBy = userId
      createdVia = invite.mintedBy === OPERATOR ? OPERATOR : 'passkey'
    }

    const cooling = options.usableFrom !== undefined && options.usableFrom !== null && options.usableFrom > now

    const record: CredentialRecord = {
      row: this.nextRow++,
      userId,
      credentialId: registration.credentialId,
      rpId: registration.rpId,
      alg: registration.alg,
      publicX: registration.publicX,
      publicY: registration.publicY,
      signCount: registration.signCount,
      backupEligible: registration.backupEligible,
      backedUp: registration.backedUp,
      aaguid: registration.aaguid,
      transports: registration.transports,
      name: pending.subject,
      createdAt: now,
      createdVia,
      createdIp: options.createdIp ?? '',
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      usableFrom: cooling ? (options.usableFrom as number) : null
    }

    this.records.push(record)

    if (grant) {
      grant.state = 'spent'
      grant.spentAt = now
      grant.credentialRow = record.row
    }

    return { ...record }
  }

  /** Revoke one active credential (of `userId` when given). `undefined` when there was nothing to revoke. */
  revoke(credentialId: Uint8Array, options: { by: string; userId?: string }): CredentialRecord | undefined {
    const found = this.records.find(
      c =>
        equal(c.credentialId, credentialId) &&
        isActive(c) &&
        (options.userId === undefined || c.userId === options.userId)
    )

    if (!found) {
      return undefined
    }

    found.revokedAt = this.now()
    found.revokedBy = options.by

    return { ...found }
  }

  /** Revoke every active credential of `userId`; returns what was revoked. */
  revokeUser(userId: string, by: string): CredentialRecord[] {
    const now = this.now()

    return this.records
      .filter(c => c.userId === userId && isActive(c))
      .map(c => {
        c.revokedAt = now
        c.revokedBy = by

        return { ...c }
      })
  }

  // ── enrolment codes ──────────────────────────────────────────────────────────────────────────

  /**
   * A new single-use code. `by` is `OPERATOR` (optional user, `ttl` seconds up to 24 h) or the user id of a
   * person who passed an `invite` step-up (the code is then bound to them and lives `CODE_TTL`).
   */
  mintCode(options: { userId?: string | null; by?: string; ttl?: number } = {}): Invite {
    const by = options.by ?? OPERATOR
    let userId = options.userId ?? null
    let ttl = options.ttl

    if (by !== OPERATOR) {
      if (userId !== null && userId !== by) {
        throw new Error('a person can mint a code only for themselves')
      }

      userId = by
      ttl = CODE_TTL
    }

    ttl = ttl === undefined ? CODE_TTL : Math.floor(ttl)

    if (ttl < 60 || ttl > OPERATOR_CODE_TTL_MAX) {
      throw new Error(`ttl must be between 60 s and ${OPERATOR_CODE_TTL_MAX} s`)
    }

    if (userId !== null && !userId.trim()) {
      throw new Error('empty user id')
    }

    const now = this.now()
    const code = enrolmentCodeDisplay(this.random(13))

    this.invites.set((enrolmentCodeHash(code) as Buffer).toString('hex'), {
      userId,
      mintedBy: by,
      createdAt: now,
      expiresAt: now + ttl,
      usedAt: null,
      usedBy: null
    })

    return { code, userId, expiresAt: now + ttl }
  }

  openCodes(): number {
    const now = this.now()

    return [...this.invites.values()].filter(i => i.usedAt === null && i.expiresAt > now).length
  }

  /** Every open code ends now (a test of "the code expired"). */
  expireCodes(): number {
    const now = this.now()
    let ended = 0

    for (const invite of this.invites.values()) {
      if (invite.usedAt === null && invite.expiresAt > now) {
        invite.expiresAt = now
        ended += 1
      }
    }

    return ended
  }

  // ── registrations and step-ups ───────────────────────────────────────────────────────────────

  /** Open a registration (`register`, `REGISTRATION_TTL`) or a step-up (`invite` / `revoke`, `STEPUP_TTL`). */
  openPending(kind: string, options: { userId: string; rpId?: string; baseUrl?: string; subject?: string }): Pending {
    if (!PENDING_KINDS.includes(kind)) {
      throw new Error(`unknown kind ${kind}`)
    }

    const now = this.now()

    for (const [id, pending] of this.open) {
      if (pending.expiresAt <= now) {
        this.open.delete(id)
      }
    }

    const pending: Pending = {
      id: b64u(this.random(16)),
      kind,
      userId: options.userId,
      nonce: this.random(NONCE_BYTES),
      rpId: options.rpId ?? '',
      baseUrl: options.baseUrl ?? '',
      subject: options.subject ?? '',
      createdAt: now,
      expiresAt: now + (kind === 'register' ? REGISTRATION_TTL : STEPUP_TTL)
    }

    this.open.set(pending.id, pending)

    return { ...pending }
  }

  /** Look at an open registration or step-up without taking it (`undefined` when it is not usable). */
  pending(id: string, kind: string, userId: string): Pending | undefined {
    const row = this.open.get(String(id))

    if (!row || row.kind !== kind || row.userId !== userId || row.expiresAt <= this.now()) {
      return undefined
    }

    return { ...row }
  }

  /** Every open registration and step-up end now (a test of "the registration expired"). */
  expirePending(): number {
    const now = this.now()
    let ended = 0

    for (const pending of this.open.values()) {
      if (pending.expiresAt > now) {
        pending.expiresAt = now
        ended += 1
      }
    }

    return ended
  }

  private checkPending(
    id: string,
    options: { kind: string; userId: string; now: number; nonce?: Buffer; digest?: Buffer }
  ): Pending {
    const row = this.open.get(String(id))

    // Anything that does not match is refused without taking the row: nobody can burn someone else's
    // ceremony, and a result verified for another ceremony (another nonce) cannot spend this one.
    if (
      !row ||
      row.kind !== options.kind ||
      row.userId !== options.userId ||
      row.expiresAt <= options.now ||
      (options.nonce !== undefined && !equal(row.nonce, options.nonce)) ||
      (options.digest !== undefined && !equal(textDigest('', row.subject, ''), options.digest))
    ) {
      throw new PendingInvalid('pending_invalid')
    }

    return row
  }

  /** Take (consume) an open registration or step-up. Throws `PendingInvalid`. */
  takePending(id: string, kind: string, userId: string): Pending {
    const row = this.checkPending(id, { kind, userId, now: this.now() })

    this.open.delete(row.id)

    return { ...row }
  }

  // ── re-authentication grants ─────────────────────────────────────────────────────────────────

  /**
   * Open a grant for the signed-in `userId` (`<provider>:<user id>`) of `provider`, lifetime `GRANT_TTL`. A
   * `web` grant needs `secretHash` (`reauthSecretHash` of the cookie secret); a `native` grant has none.
   */
  openGrant(userId: string, provider: string, client: GrantClient, secretHash: Buffer | null = null): Grant {
    if (!GRANT_CLIENTS.includes(client)) {
      throw new Error(`unknown client ${client}`)
    }

    if (!userId.trim() || !provider.trim()) {
      throw new Error('empty user id or provider')
    }

    if (client === 'web' && !(secretHash && secretHash.length === 32)) {
      throw new Error('a web grant needs the 32-byte hash of its secret')
    }

    if (client === 'native' && secretHash !== null) {
      throw new Error('a native grant has no secret')
    }

    const now = this.now()
    const row: GrantRow = {
      id: b64u(this.random(16)),
      userId,
      provider,
      client,
      state: 'open',
      failure: '',
      authTime: null,
      authTimeAssumed: false,
      createdAt: now,
      expiresAt: now + GRANT_TTL,
      completedAt: null,
      spentAt: null,
      credentialRow: null,
      secretHash,
      useSecretHash: null
    }

    this.grantRows.set(row.id, row)

    return grantView(row)
  }

  /** `userId`'s grant in whatever state, or `undefined` (unknown, another user's, or expired). */
  grant(grantId: string, userId: string): Grant | undefined {
    const row = this.grantRows.get(String(grantId))

    return row && row.userId === userId && row.expiresAt > this.now() ? grantView(row) : undefined
  }

  /**
   * A grant in whatever state, whoever's it is, or `undefined` when unknown or expired. Only for the fake's
   * simulated sign-in, which has to know whom the grant is for; a route never answers from it.
   */
  peekGrant(grantId: string): Grant | undefined {
    const row = this.grantRows.get(String(grantId))

    return row && row.expiresAt > this.now() ? grantView(row) : undefined
  }

  /** Every grant, oldest first, for the public view of the fake (never a secret). */
  grants(): Grant[] {
    return [...this.grantRows.values()].map(grantView)
  }

  /**
   * The grant when it can authorise an enrolment for `userId`, who presents its use binding `secret`, now
   * (`fresh`, unexpired, unspent); nothing is taken. Throws `GrantInvalid` with the reason otherwise
   * (`unknown` without the binding).
   */
  freshGrant(grantId: string, options: { userId: string; secret: string | null }): Grant {
    const row = this.grantRows.get(String(grantId))
    const refusal = grantUnusable(row, { ...options, now: this.now() })

    if (refusal || !row) {
      throw refusal ?? new GrantInvalid('unknown')
    }

    return grantView(row)
  }

  /**
   * The open, unexpired grant for a sign-in with `provider`, or `undefined`. The binding must hold: a `web`
   * grant needs its `secret` (the cookie), a `native` grant takes none (its binding is the PKCE round trip).
   * Nothing changes.
   */
  grantForLogin(grantId: string, provider: string, secret: string | null): Grant | undefined {
    const row = this.grantRows.get(String(grantId))

    if (
      !row ||
      row.state !== 'open' ||
      row.expiresAt <= this.now() ||
      row.provider !== provider ||
      !bindingHolds(row, secret)
    ) {
      return undefined
    }

    return grantView(row)
  }

  /**
   * The one transition out of `open`: the sign-in the grant asked for came back as `sessionUser`
   * (`<provider>:<user id>`) of `sessionProvider`, who authenticated at `authTime` (0 or `null`: the provider
   * did not say). `client` is how it came back (`web`: the callback, with the cookie `secret`, which stays the
   * grant's use binding; `native`: the token route, with `useSecretHash`, the hash of the `use_secret` handed
   * to the app with the answer, kept only when the grant turns fresh). Returns the grant, now `fresh` or
   * `failed` with its `failure`, in this order: `provider_mismatch`, `user_mismatch`, then
   * `auth_time_missing` (unless `acceptMissing`: then fresh with `authTimeAssumed`) or `auth_not_fresh`
   * (`authTime < createdAt - REAUTH_SKEW`).
   *
   * Throws `GrantInvalid` and changes nothing when there is no such unexpired grant, when it comes back
   * over the other kind of client or a web grant's `secret` does not match (whoever lacks the binding can
   * neither complete nor fail the grant: `unknown`), or when it was completed before (`not_open`).
   */
  completeGrant(
    grantId: string,
    options: {
      sessionUser: string
      sessionProvider: string
      authTime: number | null
      client: GrantClient
      secret?: string | null
      useSecretHash?: Buffer | null
      acceptMissing?: boolean
    }
  ): Grant {
    const { client } = options

    if (!GRANT_CLIENTS.includes(client)) {
      throw new Error(`unknown client ${client}`)
    }

    if (client === 'native' && !(options.useSecretHash && options.useSecretHash.length === 32)) {
      throw new Error('a native completion needs the 32-byte hash of the use secret it hands out')
    }

    const now = this.now()
    const row = this.grantRows.get(String(grantId))

    if (
      !row ||
      row.expiresAt <= now ||
      client !== row.client ||
      (row.client === 'web' && !bindingHolds(row, options.secret ?? null))
    ) {
      throw new GrantInvalid('unknown')
    }

    if (row.state !== 'open') {
      throw new GrantInvalid('not_open', '', row.state)
    }

    const authTime = options.authTime ? Math.floor(options.authTime) : 0
    let failure = ''
    let assumed = false

    if (options.sessionProvider !== row.provider) {
      failure = 'provider_mismatch'
    } else if (options.sessionUser !== row.userId) {
      failure = 'user_mismatch'
    } else if (authTime <= 0) {
      if (options.acceptMissing) {
        assumed = true
      } else {
        failure = 'auth_time_missing'
      }
    } else if (authTime < row.createdAt - REAUTH_SKEW) {
      failure = 'auth_not_fresh'
    }

    row.state = failure ? 'failed' : 'fresh'
    row.failure = failure
    row.authTime = Math.max(authTime, 0)
    row.authTimeAssumed = assumed
    row.completedAt = now
    row.useSecretHash = row.state === 'fresh' && client === 'native' ? (options.useSecretHash ?? null) : null

    return grantView(row)
  }

  /** Every unexpired grant ends now (a test of "the grant expired"). */
  expireGrants(): number {
    const now = this.now()
    let ended = 0

    for (const row of this.grantRows.values()) {
      if (row.expiresAt > now) {
        row.expiresAt = now
        ended += 1
      }
    }

    return ended
  }

  // ── assertions ───────────────────────────────────────────────────────────────────────────────

  /**
   * The one side effect of a verified answer. `ok` names the request it was verified against (user,
   * purpose, session, request id, nonce); `userId` is the user the caller bound the request to.
   *
   * - The credential is re-read and must still be `snapshot`'s (same user, RP and key) and active.
   * - The purpose is `confirm`, `invite` or `revoke`. A step-up purpose needs `stepupId`, which must be
   *   the request id the answer was verified for; the open step-up with that id, kind, user, nonce and
   *   subject is taken. `confirm` must not name a step-up.
   * - The counter rule is applied to the value stored now; the new count and BS are written; a receipt is
   *   written (unique per nonce and per request).
   *
   * Throws `CommitRefused` and changes nothing when any of that fails.
   */
  commitAssertion(
    ok: AssertionOk,
    options: { userId: string; snapshot: StoredCredential; stepupId?: string }
  ): Committed {
    const now = this.now()
    const { userId, snapshot, stepupId } = options

    if (!COMMIT_PURPOSES.includes(ok.purpose)) {
      throw new CommitRefused('purpose_invalid')
    }

    const stepUp = (STEPUP_PURPOSES as readonly string[]).includes(ok.purpose)

    if (ok.userId !== userId) {
      throw new CommitRefused('revoked')
    }

    if (stepUp !== (stepupId !== undefined) || (stepUp && stepupId !== ok.requestId)) {
      throw new CommitRefused('stepup_invalid')
    }

    const current = this.records.find(c => equal(c.credentialId, ok.credentialId))

    if (
      !current ||
      !isUsable(current, now) ||
      current.userId !== userId ||
      !equal(snapshot.credentialId, ok.credentialId) ||
      current.rpId !== ok.rpId ||
      !equal(current.publicX, snapshot.publicX) ||
      !equal(current.publicY, snapshot.publicY)
    ) {
      throw new CommitRefused('revoked')
    }

    let step: Pending | undefined

    if (stepUp) {
      try {
        // The text the person approved must be this step-up's subject ("invite", or the credential id
        // being revoked), not some other summary signed under its id and nonce.
        step = this.checkPending(ok.requestId, {
          kind: ok.purpose,
          userId,
          now,
          nonce: ok.nonce,
          digest: ok.textDigest
        })
      } catch {
        throw new CommitRefused('stepup_invalid')
      }
    }

    const count = ok.signCount
    const regressed = !(count === 0 && current.signCount === 0) && count <= current.signCount

    if (regressed && !current.backupEligible) {
      throw new CommitRefused('counter_regression')
    }

    if (
      this.receiptRows.some(r => (r.purpose === ok.purpose && r.requestId === ok.requestId) || equal(r.nonce, ok.nonce))
    ) {
      throw new CommitRefused('replayed')
    }

    if (step) {
      this.open.delete(step.id)
    }

    current.signCount = count
    current.backedUp = ok.backedUp
    current.lastUsedAt = now

    const receipt: Receipt = {
      id: this.nextReceipt++,
      at: now,
      purpose: ok.purpose,
      userId,
      credentialRow: current.row,
      rpId: ok.rpId,
      baseUrl: ok.baseUrl,
      sessionId: ok.sessionId,
      requestId: ok.requestId,
      nonce: ok.nonce,
      textDigest: ok.textDigest,
      authenticatorData: ok.authenticatorData,
      clientDataJson: ok.clientDataJson,
      signature: ok.signature
    }

    this.receiptRows.push(receipt)

    return { credential: { ...current }, receiptId: receipt.id, counterWarning: regressed }
  }

  // ── receipts ─────────────────────────────────────────────────────────────────────────────────

  receipts(options: { userId?: string; since?: number; limit?: number } = {}): Receipt[] {
    const rows = this.receiptRows
      .filter(
        r =>
          (options.userId === undefined || r.userId === options.userId) &&
          (options.since === undefined || r.at >= options.since)
      )
      .reverse()

    return (options.limit === undefined ? rows : rows.slice(0, options.limit)).map(r => ({ ...r }))
  }

  counts(): {
    credentials: number
    revoked: number
    users: number
    openCodes: number
    receipts: number
    openGrants: number
    coolingOff: number
  } {
    const active = this.records.filter(isActive)
    const now = this.now()

    return {
      credentials: active.length,
      revoked: this.records.length - active.length,
      users: new Set(active.map(c => c.userId)).size,
      openCodes: this.openCodes(),
      receipts: this.receiptRows.length,
      openGrants: [...this.grantRows.values()].filter(g => g.state === 'open' && g.expiresAt > now).length,
      coolingOff: active.filter(c => !isUsable(c, now)).length
    }
  }
}

const grantView = (row: GrantRow): Grant => {
  const { secretHash: _secret, useSecretHash: _use, ...grant } = row

  return { ...grant }
}

/**
 * Whether `secret` is the grant's use binding: a web grant's cookie secret, or the `use_secret` a native grant
 * was given when it was completed fresh (none before that).
 */
const spendBindingHolds = (row: GrantRow, secret: string | null): boolean => {
  const kept = row.client === 'web' ? row.secretHash : row.useSecretHash

  return typeof secret === 'string' && secret !== '' && kept !== null && equal(kept, reauthSecretHash(secret))
}

/** The binding at a sign-in's start: a web grant needs its cookie secret, a native grant takes none. */
const bindingHolds = (row: GrantRow, secret: string | null): boolean =>
  row.client === 'native'
    ? secret === null
    : typeof secret === 'string' && row.secretHash !== null && equal(row.secretHash, reauthSecretHash(secret))

/**
 * Why `row` cannot authorise an enrolment for `userId`, who presents `secret`, now (`undefined` when it can).
 * Without the binding the answer is `unknown` whatever the state: the grant id alone proves nothing and
 * reveals nothing.
 */
function grantUnusable(
  row: GrantRow | undefined,
  options: { userId: string; now: number; secret: string | null }
): GrantInvalid | undefined {
  if (
    !row ||
    row.userId !== options.userId ||
    row.expiresAt <= options.now ||
    !spendBindingHolds(row, options.secret)
  ) {
    return new GrantInvalid('unknown') // one answer: nobody learns whether another user's grant exists
  }

  if (row.state === 'open') {
    return new GrantInvalid('not_fresh')
  }

  if (row.state === 'spent') {
    return new GrantInvalid('spent')
  }

  if (row.state !== 'fresh') {
    return new GrantInvalid('failed', row.failure)
  }

  return undefined
}

/** The registration a verifier checks, from an open `register` pending. */
export const registrationOf = (pending: Pending): PendingRegistration => {
  if (pending.kind !== 'register') {
    throw new Error('not a registration')
  }

  return {
    registrationId: pending.id,
    userId: pending.userId,
    rpId: pending.rpId,
    baseUrl: pending.baseUrl,
    name: pending.subject,
    nonce: pending.nonce
  }
}
