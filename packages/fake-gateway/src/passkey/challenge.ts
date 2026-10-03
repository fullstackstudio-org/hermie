import { createHash, createHmac } from 'node:crypto'

import { LP, S } from './encoding'

/**
 * The confirm-passkey construction: `contract/confirm-passkey/README.md` §4 to §7. Pure functions.
 *
 * The client computes the challenge itself from what it dialed and what it shows; the gateway recomputes
 * it from its own records and never hands out an opaque one.
 */

export const CHALLENGE_TAG = 'hermie-confirm-v1'
export const TEXT_TAG = 'hermie-confirm-text-v1'
export const USER_HANDLE_TAG = 'user-handle-v1'
export const PURPOSES = ['confirm', 'register', 'invite', 'revoke'] as const

export type Purpose = (typeof PURPOSES)[number]

export const GATEWAY_ID_BYTES = 16
export const HANDLE_KEY_BYTES = 32
export const NONCE_BYTES = 32

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

/** README §4. `detail` absent, `null` and `""` give the same digest. */
export function textDigest(title: string, summary: string, detail?: string | null): Buffer {
  return sha256(Buffer.concat([S(TEXT_TAG), S(title), S(summary), S(detail ?? '')]))
}

export interface ChallengeFields {
  purpose: Purpose
  baseUrl: string
  gatewayId: Uint8Array
  userId: string
  sessionId: string
  requestId: string
  nonce: Uint8Array
  /** `textDigest(...)` of the text the client shows. */
  digest: Uint8Array
}

export function challengePreimage(fields: ChallengeFields): Buffer {
  if (!(PURPOSES as readonly string[]).includes(fields.purpose)) {
    throw new Error(`unknown purpose ${String(fields.purpose)}`)
  }

  return Buffer.concat([
    S(CHALLENGE_TAG),
    S(fields.purpose),
    S(fields.baseUrl),
    LP(fields.gatewayId),
    S(fields.userId),
    S(fields.sessionId),
    S(fields.requestId),
    LP(fields.nonce),
    LP(fields.digest)
  ])
}

/** README §5: SHA-256 of the preimage. These 32 bytes are the WebAuthn `challenge`. */
export function challenge(fields: ChallengeFields): Buffer {
  return sha256(challengePreimage(fields))
}

/** README §6: `HMAC-SHA-256(handle_key, "user-handle-v1" ‖ user_id)`, 32 bytes. */
export function userHandle(handleKey: Uint8Array, userId: string): Buffer {
  return createHmac('sha256', handleKey)
    .update(Buffer.concat([Buffer.from(USER_HANDLE_TAG, 'utf8'), Buffer.from(userId, 'utf8')]))
    .digest()
}

// ── enrolment codes (§7) ──────────────────────────────────────────────────────────────────────

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CROCKFORD_IN = new Map<string, string>([
  ...[...CROCKFORD].map((ch): [string, string] => [ch, ch]),
  ['O', '0'],
  ['I', '1'],
  ['L', '1']
])

/** The top 100 bits of `raw` (at least 13 bytes) as `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function enrolmentCodeDisplay(raw: Uint8Array): string {
  if (raw.length < 13) {
    throw new Error('need at least 100 bits')
  }

  const value = BigInt(`0x${Buffer.from(raw).toString('hex')}`) >> BigInt(raw.length * 8 - 100)
  let chars = ''

  for (let i = 0; i < 20; i += 1) {
    chars += CROCKFORD[Number((value >> BigInt(5 * (19 - i))) & 31n)]
  }

  return [0, 5, 10, 15].map(at => chars.slice(at, at + 5)).join('-')
}

/** Upper-case, drop `-` and spaces, map `O` to `0` and `I`, `L` to `1`; `null` unless exactly 20 symbols remain. */
export function enrolmentCodeCanonical(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 64) {
    return null
  }

  let out = ''

  for (const ch of text.toUpperCase()) {
    if (ch === '-' || ch === ' ') {
      continue
    }

    const mapped = CROCKFORD_IN.get(ch)

    if (mapped === undefined) {
      return null
    }

    out += mapped
  }

  return out.length === 20 ? out : null
}

/** `SHA-256(canonical ASCII)` of a code, or `null` when it is not a code. */
export function enrolmentCodeHash(text: unknown): Buffer | null {
  const canonical = enrolmentCodeCanonical(text)

  return canonical === null ? null : sha256(Buffer.from(canonical, 'ascii'))
}
