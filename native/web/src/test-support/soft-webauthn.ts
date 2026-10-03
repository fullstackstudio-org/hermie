/**
 * A software stand-in for the browser's passkey ceremonies (`WebAuthnSeam`),
 * for tests in Node: ES256, attestation `none`, a device-bound counter.
 *
 * What a browser does with the 32 bytes the model hands it, done with
 * `node:crypto`: `clientDataJSON` names the page's origin and the challenge as
 * given, the authenticator data hashes the RP id, and the signature covers both.
 * The CBOR encoder is the fake gateway's own test authenticator's
 * (`@hermie/fake-gateway/testing/soft-authenticator`), so the two speak the same
 * bytes; the challenge is the model's, never recomputed here, which is the point:
 * a model that commits to the wrong thing is refused by the gateway.
 *
 * Knobs for what a verifier must refuse and for what a person does:
 * `next` decides how the next ceremony ends (`cancelled` as if the sheet was
 * closed, or any `CeremonyProblem`), and `swapKey` signs with a key the gateway
 * never saw.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

import { cbor } from '@hermie/fake-gateway/testing/soft-authenticator'

import { b64uEncode, type Sha256 } from '../core/passkey/challenge'
import {
  type AssertionCeremony,
  type AssertionResult,
  type CeremonyProblem,
  CeremonyError,
  type RegistrationCeremony,
  type RegistrationResult,
  type WebAuthnSeam
} from '../platform/webauthn'

/** What the fake gateway's CBOR encoder takes. */
type CborValue = Parameters<typeof cbor>[0]

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

interface Held {
  id: Uint8Array
  rpId: string
  key: KeyObject
  userHandle: Uint8Array
  signCount: number
}

export interface SoftWebAuthn extends WebAuthnSeam {
  /** The credentials this "browser" holds. */
  readonly held: Held[]
  /** How the next ceremony ends instead of succeeding. */
  next: CeremonyProblem | null
  /** Every challenge it was asked to sign, in order (base64url). */
  readonly challenges: string[]
  /** Sign with a fresh key from now on: the gateway's stored public key no longer matches. */
  swapKey(): void
  /** How many times `cancel()` was called. */
  readonly cancelled: number
}

const sha = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

export function softWebAuthn(origin: string, options: { available?: boolean } = {}): SoftWebAuthn {
  const rpId = new URL(origin).hostname
  const held: Held[] = []
  const challenges: string[] = []
  let cancelled = 0

  const sha256: Sha256 = async data => new Uint8Array(sha(data))

  const clientData = (type: string, challenge: Uint8Array): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge: b64uEncode(challenge), origin, crossOrigin: false }), 'utf8')

  const failIfAsked = (seam: SoftWebAuthn): void => {
    const problem = seam.next

    if (problem) {
      seam.next = null

      throw new CeremonyError(problem)
    }
  }

  const seam: SoftWebAuthn = {
    available: options.available ?? true,
    rpId,
    sha256,
    held,
    next: null,
    challenges,
    get cancelled() {
      return cancelled
    },

    swapKey() {
      for (const credential of held) {
        credential.key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      }
    },

    async create(request: RegistrationCeremony): Promise<RegistrationResult> {
      challenges.push(b64uEncode(request.challenge))
      failIfAsked(seam)

      if (held.some(credential => request.excludeCredentialIds.some(id => Buffer.from(id).equals(credential.id)))) {
        throw new CeremonyError({ kind: 'exists' })
      }

      const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      const jwk = key.export({ format: 'jwk' })
      const id = new Uint8Array(randomBytes(32))
      const idLength = Buffer.alloc(2)

      idLength.writeUInt16BE(id.length)

      const authData = Buffer.concat([
        sha(Buffer.from(request.rpId, 'utf8')),
        Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        idLength,
        id,
        cbor(
          new Map<number | string, CborValue>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x as string, 'base64url')],
            [-3, Buffer.from(jwk.y as string, 'base64url')]
          ])
        )
      ])

      held.push({ id, rpId: request.rpId, key, userHandle: request.userHandle, signCount: 0 })

      return {
        credentialId: id,
        clientDataJSON: new Uint8Array(clientData('webauthn.create', request.challenge)),
        attestationObject: new Uint8Array(
          cbor(
            new Map<number | string, CborValue>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData]
            ])
          )
        ),
        transports: ['internal']
      }
    },

    async get(request: AssertionCeremony): Promise<AssertionResult> {
      challenges.push(b64uEncode(request.challenge))
      failIfAsked(seam)

      const credential = held.find(
        candidate =>
          candidate.rpId === request.rpId && request.allowCredentialIds.some(id => Buffer.from(id).equals(candidate.id))
      )

      if (!credential) {
        // A browser says nothing more than "not allowed" when it holds none of them.
        throw new CeremonyError({ kind: 'cancelled' })
      }

      credential.signCount += 1

      const counter = Buffer.alloc(4)

      counter.writeUInt32BE(credential.signCount)

      const authData = Buffer.concat([
        sha(Buffer.from(request.rpId, 'utf8')),
        Buffer.from([FLAG_UP | FLAG_UV]),
        counter
      ])
      const cdj = clientData('webauthn.get', request.challenge)

      return {
        credentialId: credential.id,
        authenticatorData: new Uint8Array(authData),
        clientDataJSON: new Uint8Array(cdj),
        signature: new Uint8Array(
          sign('sha256', Buffer.concat([authData, sha(cdj)]), { key: credential.key, dsaEncoding: 'der' })
        ),
        userHandle: credential.userHandle
      }
    },

    cancel() {
      cancelled += 1
    }
  }

  return seam
}
