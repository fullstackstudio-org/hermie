import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

import { hasPathPrefix, hostOf, isPrivate, originOf } from './base-url'
import { challenge, requestDigest, textDigest, userHandle, type ConfirmField, type Purpose } from './challenge'
import { CborError, decode, decodeExactly, type CborValue } from './cbor'
import { b64uDecode, safeEqual } from './encoding'

/**
 * A strict, small WebAuthn verifier (ES256 only, `node:crypto`) for the confirm level `passkey`.
 *
 * It implements `contract/confirm-passkey/README.md` §9 (assertions) and §11 (registrations) in exactly
 * that step order; the first failing step names the refusal. Everything is a pure function of its inputs:
 * no I/O, no clock, no global state. Garbage never throws: every failure is a `Refusal`.
 *
 * What it does not do: decide whether a request is still open, whether an enrolment code is valid, whether
 * a credential id is already stored, or store anything. Those are the caller's.
 */

export const FLAG_UP = 0x01
export const FLAG_UV = 0x04
export const FLAG_BE = 0x08
export const FLAG_BS = 0x10
export const FLAG_AT = 0x40
export const FLAG_ED = 0x80
export const ALG_ES256 = -7

/** README §9 refusal reasons in order (`too_many_attempts` is the caller's: it counts refusals). */
export const ASSERTION_REASONS = [
  'bad_shape',
  'unknown_credential',
  'rp_not_accepted',
  'base_url_not_accepted',
  'rp_host_mismatch',
  'bad_client_data',
  'challenge_mismatch',
  'bad_authenticator_data',
  'uv_required',
  'backup_state_mismatch',
  'signature_invalid',
  'counter_regression'
] as const

/** README §11 refusal reasons in order. */
export const REGISTRATION_REASONS = [
  'bad_shape',
  'rp_not_accepted',
  'base_url_not_accepted',
  'rp_host_mismatch',
  'bad_client_data',
  'challenge_mismatch',
  'bad_attestation_object',
  'bad_authenticator_data',
  'uv_required',
  'unsupported_algorithm',
  'bad_public_key'
] as const

export type AssertionReason = (typeof ASSERTION_REASONS)[number]
export type RegistrationReason = (typeof REGISTRATION_REASONS)[number]

const ANSWER_KEYS = new Set(['decision', 'method', 'passkey'])
const PASSKEY_KEYS = ['v', 'rp_id', 'base_url', 'credential_id', 'authenticator_data', 'client_data_json', 'signature']
const PASSKEY_OPTIONAL = ['user_handle']

// ── the gateway's side ─────────────────────────────────────────────────────────────────────────

/**
 * What the verifier needs to know about this gateway (README §9 inputs).
 *
 * `baseUrls` are the operator's list for this level, already serialised (§3). `nativeRps` maps a native RP
 * id to the `clientDataJSON.origin` values allowed for it.
 */
export class GatewayContext {
  readonly acceptedBaseUrls: string[]
  readonly nativeRpIds: Set<string>
  readonly webRpIds: Set<string>

  constructor(
    readonly gatewayId: Buffer,
    readonly handleKey: Buffer,
    readonly baseUrls: readonly string[],
    readonly nativeRps: Readonly<Record<string, readonly string[]>>,
    readonly allowPrivateBaseUrls = false
  ) {
    this.acceptedBaseUrls = baseUrls.filter(url => allowPrivateBaseUrls || !isPrivate(url))
    this.nativeRpIds = new Set(this.acceptedBaseUrls.length ? Object.keys(nativeRps) : [])
    this.webRpIds = new Set(
      this.acceptedBaseUrls.filter(url => url.startsWith('https://') && !hasPathPrefix(url)).map(hostOf)
    )
  }

  /** The `confirm_passkey.reason` of the first `client.capabilities` result (README §8). */
  capabilityReason(options: { enabled?: boolean; identity?: boolean } = {}): string {
    if (options.enabled === false) {
      return 'disabled'
    }

    if (!this.baseUrls.length) {
      return 'no_base_url'
    }

    if (!this.acceptedBaseUrls.length) {
      return 'private_origin'
    }

    return options.identity === false ? 'no_identity' : ''
  }
}

/** One credential as the store holds it (a snapshot taken when the request opened). */
export interface StoredCredential {
  credentialId: Buffer
  userId: string
  rpId: string
  publicX: Buffer
  publicY: Buffer
  signCount: number
  backupEligible: boolean
  active: boolean
}

/**
 * What the assertion must commit to (README §5). For `confirm`: the frame's session id, JSON-RPC id, nonce
 * and text. For a step-up (`invite` / `revoke`): `sessionId` `""`, `requestId` the step-up id, title and
 * detail `""`, summary the subject.
 */
export interface AssertionRequest {
  userId: string
  requestId: string
  nonce: Buffer
  title: string
  summary: string
  detail: string | null
  sessionId: string
  purpose: Purpose
  /**
   * The frame's structured fields, in order (README §4.1). Present and non-empty makes this a version-2
   * request: the challenge commits to `text_digest_v2` and the answer's `passkey.v` must be 2.
   */
  fields?: readonly ConfirmField[]
}

/** The `passkey.v` of a request: 2 for one with structured fields, else 1. */
export const requestVersion = (request: { fields?: readonly ConfirmField[] }): 1 | 2 => (request.fields?.length ? 2 : 1)

export interface PendingRegistration {
  registrationId: string
  userId: string
  rpId: string
  baseUrl: string
  name: string
  nonce: Buffer
}

export interface Refusal {
  ok: false
  reason: string
}

export interface AssertionOk {
  ok: true
  credentialId: Buffer
  rpId: string
  baseUrl: string
  signCount: number
  backupEligible: boolean
  backedUp: boolean
  /** A synced credential's counter went down: audit, do not refuse (README §9 step 12). */
  counterWarning: boolean
  challenge: Buffer
  textDigest: Buffer
  authenticatorData: Buffer
  clientDataJson: Buffer
  signature: Buffer
  // The request the signature was checked against, so the store commits it to exactly that request.
  userId: string
  purpose: Purpose
  sessionId: string
  requestId: string
  nonce: Buffer
}

export interface RegistrationOk {
  ok: true
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
  // The open registration the attestation was checked against; the store takes exactly that one.
  registrationId: string
  userId: string
  nonce: Buffer
}

class Refuse extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const refusal = (reason: string): Refusal => ({ ok: false, reason })

// ── shared steps ───────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A JSON object, with duplicate keys refused at any level (`JSON.parse` keeps the last one silently, which
 * is how two verifiers read two different `origin`s out of one document).
 */
export function parseJsonObjectWithoutDuplicates(text: string): Record<string, unknown> {
  let at = 0

  const fail = (): never => {
    throw new SyntaxError('invalid JSON')
  }
  const skip = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at] as string)) {
      at += 1
    }
  }
  const string = (): string => {
    const start = at

    at += 1

    while (at < text.length) {
      const ch = text[at] as string

      if (ch === '\\') {
        at += 2
      } else if (ch === '"') {
        at += 1

        return JSON.parse(text.slice(start, at)) as string
      } else if (ch < ' ') {
        return fail()
      } else {
        at += 1
      }
    }

    return fail()
  }
  const value = (depth: number): unknown => {
    if (depth > 64) {
      return fail()
    }

    skip()

    const ch = text[at]

    if (ch === '{') {
      at += 1

      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>

      skip()

      if (text[at] === '}') {
        at += 1

        return out
      }

      for (;;) {
        skip()

        if (text[at] !== '"') {
          return fail()
        }

        const key = string()

        if (key in out) {
          return fail()
        }

        skip()

        if (text[at] !== ':') {
          return fail()
        }

        at += 1
        out[key] = value(depth + 1)
        skip()

        if (text[at] === ',') {
          at += 1

          continue
        }

        if (text[at] === '}') {
          at += 1

          return out
        }

        return fail()
      }
    }

    if (ch === '[') {
      at += 1

      const out: unknown[] = []

      skip()

      if (text[at] === ']') {
        at += 1

        return out
      }

      for (;;) {
        out.push(value(depth + 1))
        skip()

        if (text[at] === ',') {
          at += 1

          continue
        }

        if (text[at] === ']') {
          at += 1

          return out
        }

        return fail()
      }
    }

    if (ch === '"') {
      return string()
    }

    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(at))

    if (!literal) {
      return fail()
    }

    at += literal[0].length

    return JSON.parse(literal[0]) as unknown
  }

  const parsed = value(0)

  skip()

  if (at !== text.length || !isRecord(parsed)) {
    return fail()
  }

  return parsed
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Steps rp_not_accepted, base_url_not_accepted, rp_host_mismatch; `native` or `web`. */
function rpKind(ctx: GatewayContext, rpId: string, baseUrl: string): 'native' | 'web' {
  let kind: 'native' | 'web'

  if (ctx.nativeRpIds.has(rpId)) {
    kind = 'native'
  } else if (ctx.webRpIds.has(rpId)) {
    kind = 'web'
  } else {
    throw new Refuse('rp_not_accepted')
  }

  if (!ctx.acceptedBaseUrls.includes(baseUrl)) {
    throw new Refuse('base_url_not_accepted')
  }

  if (kind === 'web' && hostOf(baseUrl) !== rpId) {
    throw new Refuse('rp_host_mismatch')
  }

  return kind
}

/** Step bad_client_data. Fields are read by name; the bytes are never compared with a template. */
function clientData(
  raw: Buffer,
  options: { type: string; kind: 'native' | 'web'; rpId: string; baseUrl: string; ctx: GatewayContext }
): Record<string, unknown> {
  let cd: Record<string, unknown>

  try {
    cd = parseJsonObjectWithoutDuplicates(utf8Strict.decode(raw))
  } catch {
    throw new Refuse('bad_client_data')
  }

  if (cd.type !== options.type || typeof cd.challenge !== 'string') {
    throw new Refuse('bad_client_data')
  }

  if ('crossOrigin' in cd && cd.crossOrigin !== false) {
    throw new Refuse('bad_client_data')
  }

  if ('topOrigin' in cd) {
    throw new Refuse('bad_client_data')
  }

  const allowed = options.kind === 'native' ? (options.ctx.nativeRps[options.rpId] ?? []) : [originOf(options.baseUrl)]

  if (typeof cd.origin !== 'string' || !allowed.includes(cd.origin)) {
    throw new Refuse('bad_client_data')
  }

  return cd
}

function checkChallenge(cd: Record<string, unknown>, expected: Buffer): void {
  let got: Buffer

  try {
    got = b64uDecode(cd.challenge, 32, 32)
  } catch {
    throw new Refuse('challenge_mismatch')
  }

  if (!safeEqual(got, expected)) {
    throw new Refuse('challenge_mismatch')
  }
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

function rpIdHashOk(auth: Buffer, rpId: string): boolean {
  return auth.length >= 37 && safeEqual(auth.subarray(0, 32), sha256(Buffer.from(rpId, 'utf8')))
}

/** A P-256 public key from its coordinates; throws when the point is not on the curve. */
export function publicKeyOf(x: Buffer, y: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') },
    format: 'jwk'
  })
}

// ── assertions (README §9) ─────────────────────────────────────────────────────────────────────

/**
 * Verify one `confirm` answer (or a step-up assertion object wrapped the same way) against `request`.
 * `credentials` is the snapshot of the bound user's credentials (others are ignored).
 */
export function verifyAssertion(
  ctx: GatewayContext,
  request: AssertionRequest,
  credentials: readonly StoredCredential[],
  answer: unknown
): AssertionOk | Refusal {
  try {
    return doVerifyAssertion(ctx, request, credentials, answer)
  } catch (error) {
    if (error instanceof Refuse) {
      return refusal(error.reason)
    }

    throw error
  }
}

function doVerifyAssertion(
  ctx: GatewayContext,
  request: AssertionRequest,
  credentials: readonly StoredCredential[],
  answer: unknown
): AssertionOk {
  // 1 bad_shape: every size bound before any parsing
  let rpId: string
  let baseUrl: string
  let credentialId: Buffer
  let auth: Buffer
  let cdj: Buffer
  let signature: Buffer
  let handle: Buffer | null

  try {
    if (
      !isRecord(answer) ||
      Object.keys(answer).length !== ANSWER_KEYS.size ||
      !Object.keys(answer).every(k => ANSWER_KEYS.has(k))
    ) {
      throw new Refuse('bad_shape')
    }

    if (answer.decision !== 'confirmed' || answer.method !== 'passkey') {
      throw new Refuse('bad_shape')
    }

    const p = answer.passkey

    if (!isRecord(p)) {
      throw new Refuse('bad_shape')
    }

    const keys = Object.keys(p)

    if (
      !PASSKEY_KEYS.every(k => k in p) ||
      !keys.every(k => PASSKEY_KEYS.includes(k) || PASSKEY_OPTIONAL.includes(k))
    ) {
      throw new Refuse('bad_shape')
    }

    // `v` repeats the request's own version: 1, or 2 for a request with fields (README §4.1, §9 step 1).
    if (p.v !== requestVersion(request)) {
      throw new Refuse('bad_shape')
    }

    if (typeof p.rp_id !== 'string' || p.rp_id.length < 1 || p.rp_id.length > 253) {
      throw new Refuse('bad_shape')
    }

    if (typeof p.base_url !== 'string' || p.base_url.length < 1 || p.base_url.length > 512) {
      throw new Refuse('bad_shape')
    }

    rpId = p.rp_id
    baseUrl = p.base_url
    credentialId = b64uDecode(p.credential_id, 1, 1023)
    auth = b64uDecode(p.authenticator_data, 37, 1024)
    cdj = b64uDecode(p.client_data_json, 1, 4096)
    signature = b64uDecode(p.signature, 8, 72)
    handle = 'user_handle' in p ? b64uDecode(p.user_handle, 1, 64) : null
  } catch {
    throw new Refuse('bad_shape')
  }

  // 2 unknown_credential
  const cred = credentials.find(
    c => c.active && c.userId === request.userId && c.rpId === rpId && safeEqual(c.credentialId, credentialId)
  )

  if (!cred) {
    throw new Refuse('unknown_credential')
  }

  if (handle !== null && !safeEqual(handle, userHandle(ctx.handleKey, request.userId))) {
    throw new Refuse('unknown_credential')
  }

  // 3 rp_not_accepted, 4 base_url_not_accepted, 5 rp_host_mismatch
  const kind = rpKind(ctx, rpId, baseUrl)

  // 6 bad_client_data
  const cd = clientData(cdj, { type: 'webauthn.get', kind, rpId, baseUrl, ctx })

  // 7 challenge_mismatch
  const digest = requestDigest(request.title, request.summary, request.detail, request.fields)
  const expected = challenge({
    purpose: request.purpose,
    baseUrl,
    gatewayId: ctx.gatewayId,
    userId: request.userId,
    sessionId: request.sessionId,
    requestId: request.requestId,
    nonce: request.nonce,
    digest
  })

  checkChallenge(cd, expected)

  // 8 bad_authenticator_data
  const flags = auth[32] as number

  if (!rpIdHashOk(auth, rpId) || flags & FLAG_AT || (flags & FLAG_BS && !(flags & FLAG_BE))) {
    throw new Refuse('bad_authenticator_data')
  }

  if (flags & FLAG_ED) {
    try {
      const [extensions, end] = decode(auth, 37)

      if (!(extensions instanceof Map) || end !== auth.length) {
        throw new Refuse('bad_authenticator_data')
      }
    } catch (error) {
      if (error instanceof CborError) {
        throw new Refuse('bad_authenticator_data')
      }

      throw error
    }
  } else if (auth.length !== 37) {
    throw new Refuse('bad_authenticator_data')
  }

  // 9 uv_required
  if (!(flags & FLAG_UP && flags & FLAG_UV)) {
    throw new Refuse('uv_required')
  }

  // 10 backup_state_mismatch
  if (Boolean(flags & FLAG_BE) !== cred.backupEligible) {
    throw new Refuse('backup_state_mismatch')
  }

  // 11 signature_invalid: strict DER (OpenSSL refuses anything else); high S is valid
  let valid = false

  try {
    valid = cryptoVerify(
      'sha256',
      Buffer.concat([auth, sha256(cdj)]),
      { key: publicKeyOf(cred.publicX, cred.publicY), dsaEncoding: 'der' },
      signature
    )
  } catch {
    valid = false
  }

  if (!valid) {
    throw new Refuse('signature_invalid')
  }

  // 12 counter_regression: refused for a device-bound credential, audited for a synced one
  const count = auth.readUInt32BE(33)
  const regressed = !(count === 0 && cred.signCount === 0) && count <= cred.signCount

  if (regressed && !cred.backupEligible) {
    throw new Refuse('counter_regression')
  }

  return {
    ok: true,
    credentialId,
    rpId,
    baseUrl,
    signCount: count,
    backupEligible: Boolean(flags & FLAG_BE),
    backedUp: Boolean(flags & FLAG_BS),
    counterWarning: regressed,
    challenge: expected,
    textDigest: digest,
    authenticatorData: auth,
    clientDataJson: cdj,
    signature,
    userId: request.userId,
    purpose: request.purpose,
    sessionId: request.sessionId,
    requestId: request.requestId,
    nonce: request.nonce
  }
}

/**
 * A validator bound to one open request and its credential snapshot, remembering its last `size` verdicts
 * by the answer's canonical JSON: the answer path runs it more than once for one answer and an ECDSA
 * verification is not free. Pure: the cache holds verdicts only.
 */
export function memoisedAssertionValidator(
  ctx: GatewayContext,
  request: AssertionRequest,
  credentials: readonly StoredCredential[],
  size = 16
): (answer: unknown) => AssertionOk | Refusal {
  const snapshot = [...credentials]
  const cache = new Map<string, AssertionOk | Refusal>()

  return answer => {
    let key: string | undefined

    try {
      key = JSON.stringify(answer)
    } catch {
      key = undefined
    }

    if (key === undefined) {
      return verifyAssertion(ctx, request, snapshot, answer)
    }

    const hit = cache.get(key)

    if (hit) {
      cache.delete(key)
      cache.set(key, hit)

      return hit
    }

    const verdict = verifyAssertion(ctx, request, snapshot, answer)

    cache.set(key, verdict)

    while (cache.size > size) {
      cache.delete(cache.keys().next().value as string)
    }

    return verdict
  }
}

// ── registrations (README §11) ─────────────────────────────────────────────────────────────────

/**
 * Verify a `register/finish` body for `pending`. The enrolment code and "credential already stored" are
 * the route's to check.
 */
export function verifyRegistration(
  ctx: GatewayContext,
  pending: PendingRegistration,
  finish: unknown
): RegistrationOk | Refusal {
  try {
    return doVerifyRegistration(ctx, pending, finish)
  } catch (error) {
    if (error instanceof Refuse) {
      return refusal(error.reason)
    }

    throw error
  }
}

function doVerifyRegistration(ctx: GatewayContext, pending: PendingRegistration, finish: unknown): RegistrationOk {
  // 1 bad_shape
  let credentialId: Buffer
  let cdj: Buffer
  let att: Buffer
  let transports: string[]

  try {
    if (!isRecord(finish) || !isRecord(finish.credential)) {
      throw new Refuse('bad_shape')
    }

    const credential = finish.credential

    credentialId = b64uDecode(credential.id, 1, 1023)
    cdj = b64uDecode(credential.client_data_json, 1, 4096)
    att = b64uDecode(credential.attestation_object, 1, 16384)

    if (finish.registration_id !== pending.registrationId || finish.base_url !== pending.baseUrl) {
      throw new Refuse('bad_shape')
    }

    const given = 'transports' in credential ? credential.transports : []

    if (
      !Array.isArray(given) ||
      given.length > 8 ||
      !given.every(t => typeof t === 'string' && t.length > 0 && t.length <= 32)
    ) {
      throw new Refuse('bad_shape')
    }

    transports = given as string[]
  } catch {
    throw new Refuse('bad_shape')
  }

  // 2, 3, 4
  const kind = rpKind(ctx, pending.rpId, pending.baseUrl)

  // 5 bad_client_data
  const cd = clientData(cdj, { type: 'webauthn.create', kind, rpId: pending.rpId, baseUrl: pending.baseUrl, ctx })

  // 6 challenge_mismatch
  checkChallenge(
    cd,
    challenge({
      purpose: 'register',
      baseUrl: pending.baseUrl,
      gatewayId: ctx.gatewayId,
      userId: pending.userId,
      sessionId: '',
      requestId: pending.registrationId,
      nonce: pending.nonce,
      digest: textDigest('', pending.name, '')
    })
  )

  // 7 bad_attestation_object
  let obj: CborValue

  try {
    obj = decodeExactly(att)
  } catch {
    throw new Refuse('bad_attestation_object')
  }

  if (
    !(obj instanceof Map) ||
    obj.size !== 3 ||
    typeof obj.get('fmt') !== 'string' ||
    !(obj.get('attStmt') instanceof Map) ||
    !Buffer.isBuffer(obj.get('authData'))
  ) {
    throw new Refuse('bad_attestation_object')
  }

  const auth = obj.get('authData') as Buffer

  // 8 bad_authenticator_data
  if (auth.length < 55 || auth.length > 16384 || !rpIdHashOk(auth, pending.rpId)) {
    throw new Refuse('bad_authenticator_data')
  }

  const flags = auth[32] as number

  if (!(flags & FLAG_AT) || (flags & FLAG_BS && !(flags & FLAG_BE))) {
    throw new Refuse('bad_authenticator_data')
  }

  const idLength = auth.readUInt16BE(53)

  if (55 + idLength > auth.length || !safeEqual(auth.subarray(55, 55 + idLength), credentialId)) {
    throw new Refuse('bad_authenticator_data')
  }

  let cose: Map<unknown, unknown>

  try {
    const [key, afterKey] = decode(auth, 55 + idLength)
    let pos = afterKey

    if (!(key instanceof Map)) {
      throw new CborError('COSE key is not a map')
    }

    cose = key

    if (flags & FLAG_ED) {
      const [extensions, afterExtensions] = decode(auth, pos)

      if (!(extensions instanceof Map)) {
        throw new CborError('extensions are not a map')
      }

      pos = afterExtensions
    }

    if (pos !== auth.length) {
      throw new CborError('trailing bytes')
    }
  } catch (error) {
    if (error instanceof CborError) {
      throw new Refuse('bad_authenticator_data')
    }

    throw error
  }

  // 9 uv_required
  if (!(flags & FLAG_UP && flags & FLAG_UV)) {
    throw new Refuse('uv_required')
  }

  // 10 unsupported_algorithm: `typeof number`, because CBOR `true` must not pass for 1
  if (
    [1, 3, -1].some(k => typeof cose.get(k) !== 'number') ||
    cose.get(1) !== 2 ||
    cose.get(3) !== ALG_ES256 ||
    cose.get(-1) !== 1
  ) {
    throw new Refuse('unsupported_algorithm')
  }

  // 11 bad_public_key
  const x = cose.get(-2)
  const y = cose.get(-3)

  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new Refuse('bad_public_key')
  }

  try {
    publicKeyOf(x, y)
  } catch {
    throw new Refuse('bad_public_key')
  }

  return {
    ok: true,
    credentialId,
    rpId: pending.rpId,
    alg: ALG_ES256,
    publicX: x,
    publicY: y,
    signCount: auth.readUInt32BE(33),
    backupEligible: Boolean(flags & FLAG_BE),
    backedUp: Boolean(flags & FLAG_BS),
    aaguid: auth.subarray(37, 53),
    transports,
    registrationId: pending.registrationId,
    userId: pending.userId,
    nonce: pending.nonce
  }
}
