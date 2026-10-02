/**
 * Cryptographically strong random values. Ported from the Expo app's
 * `src/platform/random.web.ts`.
 *
 * `crypto.getRandomValues` is the Web Crypto CSPRNG and works outside a secure
 * context too (only `crypto.subtle` is gated on one). A browser without it is a
 * browser this client cannot run in, so the missing case throws rather than
 * degrading to `Math.random`.
 */
import type { RandomBytes } from '@hermie/gateway-client'

export type { RandomBytes } from '@hermie/gateway-client'

/** The part of `Crypto` this file uses, so a test can hand in its own. */
export type RandomSource = Pick<Crypto, 'getRandomValues'>

const pageCrypto = (): RandomSource | null =>
  typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function' ? null : crypto

/** `null` means "this browser has none": every call throws. */
export function createRandomBytes(source: RandomSource | null = pageCrypto()): RandomBytes {
  return length => {
    if (!source) {
      throw new Error('This browser has no crypto.getRandomValues, so Hermie cannot generate a secure random value.')
    }

    const bytes = new Uint8Array(length)
    source.getRandomValues(bytes)

    return bytes
  }
}

export const randomBytes: RandomBytes = createRandomBytes()

/** `bytes` random bytes as lowercase hex: an installation id, a request id. */
export function randomHex(bytes = 16, random: RandomBytes = randomBytes): string {
  return Array.from(random(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
