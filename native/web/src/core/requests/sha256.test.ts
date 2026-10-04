/**
 * The SHA-256 an `input.file` answer quotes: the browser's digest and the plain one agree with the known vectors
 * and with each other, for every length around a block's edge.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sha256Hex, sha256Plain } from './sha256'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('the plain SHA-256', () => {
  it('matches the published vectors', () => {
    expect(sha256Plain(encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Plain(encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Plain(encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
  })

  it('agrees with the platform for every length around a block’s edge, and for a large input', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_value, index) => (index * 31 + 7) % 256)

      expect(sha256Plain(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
    }

    const big = Uint8Array.from({ length: 300_000 }, (_value, index) => index % 251)

    expect(sha256Plain(big)).toBe(createHash('sha256').update(big).digest('hex'))
  })
})

describe('the SHA-256 of a blob', () => {
  it('is lowercase hex, with or without the browser’s own digest', async () => {
    const blob = new Blob(['hello, gateway'])
    const expected = createHash('sha256').update('hello, gateway').digest('hex')

    expect(await sha256Hex(blob)).toBe(expected)

    const original = globalThis.crypto

    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })

    try {
      expect(await sha256Hex(blob)).toBe(expected)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})
