import { randomBytes, timingSafeEqual } from 'node:crypto'

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

  credentials(userId?: string, includeRevoked = false): CredentialRecord[] {
    return this.records
      .filter(c => (userId === undefined || c.userId === userId) && (includeRevoked || isActive(c)))
      .map(c => ({ ...c }))
  }

  /** `userId`'s active credentials as the verifier takes them when a request opens. */
  snapshot(userId: string): StoredCredential[] {
    return this.credentials(userId).map(stored)
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
   * Enrol: take the open registration `registration` was verified against, redeem the code and store the
   * credential, all or nothing. `userId` is the signed-in caller. Checked in this order: the registration,
   * the code, the credential id; on any refusal nothing changes.
   */
  addCredential(options: {
    userId: string
    code: string
    registration: RegistrationOk
    createdIp?: string
  }): CredentialRecord {
    const { userId, code, registration } = options
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

    const hash = enrolmentCodeHash(code)
    const invite = hash ? this.invites.get(hash.toString('hex')) : undefined

    if (
      !invite ||
      invite.usedAt !== null ||
      invite.expiresAt <= now ||
      (invite.userId !== null && invite.userId !== userId)
    ) {
      throw new CodeInvalid('code_invalid')
    }

    if (this.records.some(c => equal(c.credentialId, registration.credentialId))) {
      throw new CredentialExists('credential_exists')
    }

    // Everything checked: now change things.
    this.open.delete(pending.id)
    invite.usedAt = now
    invite.usedBy = userId

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
      createdVia: invite.mintedBy === OPERATOR ? OPERATOR : 'passkey',
      createdIp: options.createdIp ?? '',
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null
    }

    this.records.push(record)

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
      !isActive(current) ||
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

  counts(): { credentials: number; revoked: number; users: number; openCodes: number; receipts: number } {
    const active = this.records.filter(isActive)

    return {
      credentials: active.length,
      revoked: this.records.length - active.length,
      users: new Set(active.map(c => c.userId)).size,
      openCodes: this.openCodes(),
      receipts: this.receiptRows.length
    }
  }
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
