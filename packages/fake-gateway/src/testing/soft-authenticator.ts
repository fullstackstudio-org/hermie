import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject
} from 'node:crypto'

import { hostOf, originOf } from '../passkey/base-url'
import { challenge, requestDigest, textDigest, userHandle, type ConfirmField, type Purpose } from '../passkey/challenge'
import { b64u } from '../passkey/encoding'

/**
 * A software WebAuthn authenticator for tests (ES256, attestation `none`).
 *
 * It builds exactly what a platform authenticator and its client return for a registration and an
 * assertion under the confirm-passkey construction (`contract/confirm-passkey/README.md`), so the fake
 * gateway, a browser client's own tests and a verifier can be driven end to end without a device. It is a
 * test double: the private key lives in memory and is generated per instance. Nothing here is secret.
 *
 * ```ts
 * const phone = SoftAuthenticator.native()
 * const begin = await post('/api/auth/passkeys/register/begin', { rp_id: phone.rpId, base_url, name })
 * const body = phone.register({ ...registrationOf(begin), baseUrl: base_url }, code)
 * ```
 */

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

/** The native RP of the official build, the default of `confirm.passkey.native_rps`. */
export const NATIVE_RP_ID = 'confirm.hermie.dev'
export const NATIVE_ORIGIN = 'https://confirm.hermie.dev'

// ── a CBOR encoder for exactly what an attestation needs ───────────────────────────────────────

type CborIn = number | string | boolean | Uint8Array | CborIn[] | Map<number | string, CborIn>

function head(major: number, n: number): Buffer {
  if (n < 24) {
    return Buffer.from([(major << 5) | n])
  }

  if (n < 0x100) {
    return Buffer.from([(major << 5) | 24, n])
  }

  if (n < 0x10000) {
    const out = Buffer.alloc(3)

    out[0] = (major << 5) | 25
    out.writeUInt16BE(n, 1)

    return out
  }

  const out = Buffer.alloc(5)

  out[0] = (major << 5) | 26
  out.writeUInt32BE(n, 1)

  return out
}

/** Definite-length CBOR for the values a COSE key and an attestation object hold. */
export function cbor(value: CborIn): Buffer {
  if (typeof value === 'boolean') {
    return Buffer.from([value ? 0xf5 : 0xf4])
  }

  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }

  if (typeof value === 'string') {
    const raw = Buffer.from(value, 'utf8')

    return Buffer.concat([head(3, raw.length), raw])
  }

  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), value])
  }

  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(cbor)])
  }

  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────

/** What `register/begin` answers, as far as the authenticator needs it. */
export interface RegistrationInput {
  registrationId: string
  /** The base URL this registration is for (`register/begin`'s `base_url`, the one the client dialed). */
  baseUrl: string
  gatewayId: Uint8Array
  userId: string
  /** The credential name the client asked for (`register/begin`'s `user.name`). */
  name: string
  nonce: Uint8Array
}

/** What the gateway commits an assertion to (`contract/confirm-passkey/README.md` §5). */
export interface AssertionInput {
  /** The base URL the client dialed. */
  baseUrl: string
  gatewayId: Uint8Array
  userId: string
  /** `confirm`: the frame's `params.session_id`. Step-ups: `""`. */
  sessionId?: string
  /** `confirm`: the frame's JSON-RPC `id`. Step-ups: the step-up id. */
  requestId: string
  nonce: Uint8Array
  /** The text the client SHOWS. Step-ups: title `""`, summary the subject, detail `""`. */
  title: string
  summary: string
  detail?: string | null
  /**
   * The frame's structured fields, in the frame's order (README §4.1). Non-empty makes it a version-2
   * assertion: the challenge commits to `text_digest_v2` and the answer says `v: 2`.
   */
  fields?: readonly ConfirmField[]
  purpose?: Purpose
  /** `GET /api/auth/passkeys`'s `user.handle`; sent as `user_handle` when given. */
  userHandle?: Uint8Array | string
}

/** The `passkey` object of an answer, and of a step-up's `assertion`. */
export interface PasskeyAssertion {
  v: 1 | 2
  rp_id: string
  base_url: string
  credential_id: string
  authenticator_data: string
  client_data_json: string
  signature: string
  user_handle?: string
}

export interface ConfirmAnswer {
  decision: 'confirmed'
  method: 'passkey'
  passkey: PasskeyAssertion
}

export interface RegisterBody {
  registration_id: string
  base_url: string
  code: string
  credential: { id: string; client_data_json: string; attestation_object: string; transports: string[] }
}

/** Knobs for building something a verifier must refuse. */
export interface Tampering {
  /** Replace the authenticator data flags byte. */
  flags?: number
  /** Replace the signCount written into the authenticator data. */
  signCount?: number
  /** Replace the `origin` the client reports in `clientDataJSON`. */
  clientOrigin?: string
  /** Replace the `type` the client reports in `clientDataJSON`. */
  clientType?: string
  /** Replace the RP id hashed into the authenticator data (the answer still names `rpId`). */
  rpIdHashOf?: string
  /** Replace the `base_url` named in the answer, leaving the challenge as made for `baseUrl`. */
  claimBaseUrl?: string
  /** Entries of the COSE key to replace (registration). */
  coseFields?: Map<number, CborIn>
  /** Sign with this key instead of the authenticator's own. */
  signWith?: SoftAuthenticator
  /** Leave `user_handle` out although a handle was given. */
  omitUserHandle?: boolean
  /** Replace the `v` the answer repeats (the request's `passkey.v`). */
  v?: number
  /** Sign the version-1 text (without the fields) although the request has fields; `v` stays what it is. */
  signWithoutFields?: boolean
}

export interface SoftAuthenticatorOptions {
  /** The RP id the credential is scoped to. */
  rpId: string
  /** The `clientDataJSON.origin` this authenticator's client reports. */
  clientOrigin: string
  /** A synced passkey (BE and BS set, counter stays 0) or a device-bound one (counter increases). */
  synced?: boolean
  signCount?: number
  credentialId?: Uint8Array
  /** An existing key pair (to enrol "the same passkey" twice); generated otherwise. */
  privateKey?: KeyObject
  aaguid?: Uint8Array
  transports?: string[]
}

export class SoftAuthenticator {
  readonly rpId: string
  readonly clientOrigin: string
  readonly synced: boolean
  signCount: number
  readonly credentialId: Buffer
  readonly privateKey: KeyObject
  readonly aaguid: Buffer
  readonly transports: string[]

  constructor(options: SoftAuthenticatorOptions) {
    this.rpId = options.rpId
    this.clientOrigin = options.clientOrigin
    this.synced = options.synced ?? true
    this.signCount = options.signCount ?? 0
    this.credentialId = Buffer.from(options.credentialId ?? randomBytes(32))
    this.privateKey = options.privateKey ?? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    this.aaguid = Buffer.from(options.aaguid ?? Buffer.alloc(16))
    this.transports = options.transports ?? ['internal']
  }

  /** The native app under the official RP (`confirm.hermie.dev`). */
  static native(options: Partial<SoftAuthenticatorOptions> = {}): SoftAuthenticator {
    return new SoftAuthenticator({ rpId: NATIVE_RP_ID, clientOrigin: NATIVE_ORIGIN, ...options })
  }

  /** A browser on `baseUrl`: RP id is its host, client origin its origin. Device-bound unless said otherwise. */
  static web(baseUrl: string, options: Partial<SoftAuthenticatorOptions> = {}): SoftAuthenticator {
    return new SoftAuthenticator({ rpId: hostOf(baseUrl), clientOrigin: originOf(baseUrl), synced: false, ...options })
  }

  /** The credential id as the wire spells it. */
  get id(): string {
    return b64u(this.credentialId)
  }

  /** The public key as COSE coordinates. */
  get publicKey(): { x: Buffer; y: Buffer } {
    const jwk = this.privateKey.export({ format: 'jwk' })

    return { x: Buffer.from(jwk.x as string, 'base64url'), y: Buffer.from(jwk.y as string, 'base64url') }
  }

  get flags(): number {
    return FLAG_UP | FLAG_UV | (this.synced ? FLAG_BE | FLAG_BS : 0)
  }

  /** The same passkey again: same key pair and id, for "this passkey is already enrolled". */
  clone(options: Partial<SoftAuthenticatorOptions> = {}): SoftAuthenticator {
    return new SoftAuthenticator({
      rpId: this.rpId,
      clientOrigin: this.clientOrigin,
      synced: this.synced,
      signCount: this.signCount,
      credentialId: this.credentialId,
      privateKey: this.privateKey,
      aaguid: this.aaguid,
      transports: this.transports,
      ...options
    })
  }

  private clientData(type: string, challengeBytes: Uint8Array, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge: b64u(challengeBytes), origin, crossOrigin: false }), 'utf8')
  }

  /**
   * The `register/finish` body for an open registration, with `code` the enrolment code (empty when not
   * given). The attestation is `fmt: "none"`.
   */
  register(input: RegistrationInput, code = '', tamper: Tampering = {}): RegisterBody {
    const chal = challenge({
      purpose: 'register',
      baseUrl: input.baseUrl,
      gatewayId: input.gatewayId,
      userId: input.userId,
      sessionId: '',
      requestId: input.registrationId,
      nonce: input.nonce,
      digest: textDigest('', input.name, '')
    })
    const { x, y } = this.publicKey
    const cose = new Map<number, CborIn>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
      ...(tamper.coseFields ?? new Map<number, CborIn>())
    ])
    const idLength = Buffer.alloc(2)

    idLength.writeUInt16BE(this.credentialId.length)

    const counter = Buffer.alloc(4)

    counter.writeUInt32BE(tamper.signCount ?? this.signCount)

    const auth = Buffer.concat([
      sha256(Buffer.from(tamper.rpIdHashOf ?? this.rpId, 'utf8')),
      Buffer.from([tamper.flags ?? this.flags | FLAG_AT]),
      counter,
      this.aaguid,
      idLength,
      this.credentialId,
      cbor(cose as Map<number | string, CborIn>)
    ])
    const attestation = cbor(
      new Map<number | string, CborIn>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', auth]
      ])
    )

    return {
      registration_id: input.registrationId,
      base_url: input.baseUrl,
      code,
      credential: {
        id: b64u(this.credentialId),
        client_data_json: b64u(
          this.clientData(tamper.clientType ?? 'webauthn.create', chal, tamper.clientOrigin ?? this.clientOrigin)
        ),
        attestation_object: b64u(attestation),
        transports: [...this.transports]
      }
    }
  }

  /** The `confirm` answer (and a step-up's `assertion` is its `passkey`) for what the gateway asked. */
  assert(input: AssertionInput, tamper: Tampering = {}): ConfirmAnswer {
    const signCount = tamper.signCount ?? (this.synced ? this.signCount : (this.signCount += 1))
    const chal = challenge({
      purpose: input.purpose ?? 'confirm',
      baseUrl: input.baseUrl,
      gatewayId: input.gatewayId,
      userId: input.userId,
      sessionId: input.sessionId ?? '',
      requestId: input.requestId,
      nonce: input.nonce,
      digest: tamper.signWithoutFields
        ? textDigest(input.title, input.summary, input.detail)
        : requestDigest(input.title, input.summary, input.detail, input.fields)
    })
    const cdj = this.clientData(tamper.clientType ?? 'webauthn.get', chal, tamper.clientOrigin ?? this.clientOrigin)
    const counter = Buffer.alloc(4)

    counter.writeUInt32BE(signCount)

    const auth = Buffer.concat([
      sha256(Buffer.from(tamper.rpIdHashOf ?? this.rpId, 'utf8')),
      Buffer.from([tamper.flags ?? this.flags]),
      counter
    ])
    const signer = tamper.signWith ?? this
    const signature = cryptoSign('sha256', Buffer.concat([auth, sha256(cdj)]), {
      key: signer.privateKey,
      dsaEncoding: 'der'
    })
    const passkey: PasskeyAssertion = {
      v: (tamper.v ?? (input.fields?.length ? 2 : 1)) as 1 | 2,
      rp_id: this.rpId,
      base_url: tamper.claimBaseUrl ?? input.baseUrl,
      credential_id: b64u(this.credentialId),
      authenticator_data: b64u(auth),
      client_data_json: b64u(cdj),
      signature: b64u(signature)
    }

    if (input.userHandle !== undefined && !tamper.omitUserHandle) {
      passkey.user_handle = typeof input.userHandle === 'string' ? input.userHandle : b64u(input.userHandle)
    }

    return { decision: 'confirmed', method: 'passkey', passkey }
  }

  /**
   * The answer to a `confirm` frame at level `passkey`, computed from the frame the way a client does:
   * the text it shows is the text in the frame, the base URL is the one it dialed.
   */
  answer(
    frame: { id: string | number; params: ConfirmFrameParams },
    options: { baseUrl: string; userHandle?: Uint8Array | string },
    tamper: Tampering = {}
  ): ConfirmAnswer {
    const { params } = frame

    return this.assert(
      {
        baseUrl: options.baseUrl,
        gatewayId: Buffer.from(params.passkey.gateway_id, 'base64url'),
        userId: params.passkey.user.id,
        sessionId: params.session_id,
        requestId: String(frame.id),
        nonce: Buffer.from(params.passkey.nonce, 'base64url'),
        title: params.title,
        summary: params.summary,
        detail: params.detail ?? null,
        ...(params.fields?.length ? { fields: params.fields } : {}),
        ...(options.userHandle === undefined ? {} : { userHandle: options.userHandle })
      },
      tamper
    )
  }
}

/** The part of a `confirm` frame's params an authenticator reads. */
export interface ConfirmFrameParams {
  session_id: string
  title: string
  summary: string
  detail?: string | null
  level: string
  /** A version-2 frame's structured fields, in order. */
  fields?: ConfirmField[]
  passkey: {
    v: number
    nonce: string
    gateway_id: string
    base_url: string
    expires_at: number
    user: { id: string; name: string }
    credentials: { rp_id: string; ids: string[] }[]
  }
}

/** The exact decline an app sends (no assertion, `verified` stays false). */
export const DECLINE = { decision: 'declined', method: 'tap' } as const

/** The user handle a gateway derives (README §6); a test that holds the handle key can compute it. */
export function expectedUserHandle(handleKey: Uint8Array, userId: string): string {
  return b64u(userHandle(handleKey, userId))
}

/** A private key from its raw scalar (`vectors.json` → `keys`), for a test that replays a fixed key. */
export function privateKeyFromScalar(scalar: Uint8Array, x: Uint8Array, y: Uint8Array): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: Buffer.from(scalar).toString('base64url'),
      x: Buffer.from(x).toString('base64url'),
      y: Buffer.from(y).toString('base64url')
    },
    format: 'jwk'
  })
}
