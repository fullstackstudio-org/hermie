/**
 * The CBOR subset WebAuthn needs: `contract/confirm-passkey/README.md` §12. Decoding only.
 *
 * Accepted: major types 0 and 1 (integers up to 64 bits), 2 (byte string), 3 (UTF-8 text), 4 (array),
 * 5 (map), and the simple values false, true, null. Definite lengths only; no tags, floats, `undefined`
 * or other simple values; nesting depth at most 4; map keys are integers or text and never repeat. The
 * decoder never reads past the buffer, reports how many bytes it consumed, and throws only `CborError`.
 * Non-shortest integer encodings are accepted.
 *
 * Integers are JS numbers while they are safe, bigints beyond. A map is a `Map` so an integer key and the
 * text key of the same digits stay different keys.
 */

export const MAX_DEPTH = 4

export class CborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CborError'
  }
}

export type CborKey = number | bigint | string
export type CborValue = number | bigint | string | boolean | null | Buffer | CborValue[] | Map<CborKey, CborValue>

const normalise = (value: bigint): number | bigint =>
  value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** One item at `pos`: `[value, end]`. */
export function decode(buf: Uint8Array, pos = 0, depth = 1): [CborValue, number] {
  if (depth > MAX_DEPTH) {
    throw new CborError('nesting too deep')
  }

  if (pos >= buf.length) {
    throw new CborError('truncated')
  }

  const initial = buf[pos] as number
  const major = initial >> 5
  const info = initial & 31
  let at = pos + 1
  let value: bigint

  if (info < 24) {
    value = BigInt(info)
  } else if (info <= 27) {
    const size = 1 << (info - 24)

    if (at + size > buf.length) {
      throw new CborError('truncated')
    }

    value = BigInt(`0x${Buffer.from(buf.subarray(at, at + size)).toString('hex')}`)
    at += size
  } else {
    throw new CborError('indefinite or reserved length')
  }

  if (major === 0) {
    return [normalise(value), at]
  }

  if (major === 1) {
    return [normalise(-1n - value), at]
  }

  if (major === 2 || major === 3) {
    if (value > BigInt(buf.length - at)) {
      throw new CborError('truncated')
    }

    const length = Number(value)
    const raw = Buffer.from(buf.subarray(at, at + length))

    if (major === 2) {
      return [raw, at + length]
    }

    try {
      return [utf8.decode(raw), at + length]
    } catch {
      throw new CborError('text is not UTF-8')
    }
  }

  if (major === 4) {
    if (value > BigInt(buf.length - at)) {
      throw new CborError('truncated')
    }

    const items: CborValue[] = []

    for (let i = 0; i < Number(value); i += 1) {
      const [item, next] = decode(buf, at, depth + 1)

      items.push(item)
      at = next
    }

    return [items, at]
  }

  if (major === 5) {
    if (value > BigInt(Math.floor((buf.length - at) / 2))) {
      throw new CborError('truncated')
    }

    const out = new Map<CborKey, CborValue>()

    for (let i = 0; i < Number(value); i += 1) {
      const [key, afterKey] = decode(buf, at, depth + 1)

      if (typeof key !== 'number' && typeof key !== 'bigint' && typeof key !== 'string') {
        throw new CborError('map key is not an integer or text')
      }

      if (out.has(key)) {
        throw new CborError('duplicate map key')
      }

      const [item, afterValue] = decode(buf, afterKey, depth + 1)

      out.set(key, item)
      at = afterValue
    }

    return [out, at]
  }

  if (major === 6) {
    throw new CborError('tags are not accepted')
  }

  if (info === 20) {
    return [false, at]
  }

  if (info === 21) {
    return [true, at]
  }

  if (info === 22) {
    return [null, at]
  }

  throw new CborError('simple value or float not accepted')
}

/** One item that consumes the whole buffer. */
export function decodeExactly(buf: Uint8Array): CborValue {
  const [value, end] = decode(buf)

  if (end !== buf.length) {
    throw new CborError('trailing bytes')
  }

  return value
}
