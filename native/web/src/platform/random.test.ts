import { describe, expect, it } from 'vitest'

import { createRandomBytes, randomBytes, randomHex } from './random'

describe('random values', () => {
  it('fills the requested length from the page’s CSPRNG', () => {
    const bytes = randomBytes(32)

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(32)
    // 32 zero bytes from a working generator is a 2^-256 event.
    expect(bytes.some(byte => byte !== 0)).toBe(true)
  })

  it('reads as lowercase hex', () => {
    const fixed = createRandomBytes({
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
        ;(array as unknown as Uint8Array).fill(0xab)

        return array
      }
    } as Crypto)

    expect(randomHex(4, fixed)).toBe('abababab')
    expect(randomHex()).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('throws rather than fall back to Math.random', () => {
    expect(() => createRandomBytes(null)(8)).toThrow(/getRandomValues/u)
  })
})
