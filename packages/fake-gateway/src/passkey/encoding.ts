import { timingSafeEqual } from 'node:crypto'

/**
 * Encoding of `contract/confirm-passkey/README.md` §2.
 *
 * Binary values on the wire are base64url WITHOUT padding. The decoder is
 * strict: padding, characters outside the alphabet and non-canonical trailing
 * bits are all refused, because a verifier that is lenient here accepts two
 * spellings of one value and the challenge and the stored ids stop being
 * comparable as strings.
 */

/** A value that is not a canonical base64url string, or is outside the given length bounds. */
export class EncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncodingError'
  }
}

const B64U = /^[A-Za-z0-9_-]*$/

export function b64u(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

/**
 * Strict base64url. `low` and `high`, when given, bound the DECODED length in
 * bytes (both or neither, as the verifier uses them). Throws `EncodingError`
 * and nothing else.
 */
export function b64uDecode(text: unknown, low?: number, high?: number): Buffer {
  if (typeof text !== 'string' || text.length % 4 === 1 || !B64U.test(text)) {
    throw new EncodingError('not base64url')
  }

  if (high !== undefined && text.length > Math.floor((high * 4 + 2) / 3)) {
    throw new EncodingError('too long')
  }

  const raw = Buffer.from(text, 'base64url')

  if (raw.toString('base64url') !== text) {
    throw new EncodingError('non-canonical base64url')
  }

  if (low !== undefined && high !== undefined && (raw.length < low || raw.length > high)) {
    throw new EncodingError('length out of bounds')
  }

  return raw
}

/** `S(s)`: 4-byte big-endian length of the UTF-8 encoding, then those bytes. */
export function S(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)

  head.writeUInt32BE(raw.length)

  return Buffer.concat([head, raw])
}

/** `LP(b)`: 4-byte big-endian length, then the bytes. */
export function LP(data: Uint8Array): Buffer {
  const head = Buffer.alloc(4)

  head.writeUInt32BE(data.length)

  return Buffer.concat([head, data])
}

/** Constant-time equality for two byte strings of any length. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
