/**
 * The SHA-256 an `input.file` answer quotes: the browser's digest and the plain one agree with the known vectors
 * and with each other, for every length around a block's edge.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { Sha256, sha256Chunked, sha256Hex, sha256Plain } from './sha256'

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

describe('the incremental SHA-256', () => {
  it('gives the same digest however the input is cut into pieces', () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_value, index) => (index * 13 + 5) % 256)
    const expected = createHash('sha256').update(bytes).digest('hex')

    for (const size of [1, 7, 63, 64, 65, 100, 1000, 5000]) {
      const hash = new Sha256()

      for (let start = 0; start < bytes.length; start += size) {
        hash.update(bytes.subarray(start, start + size))
      }

      expect(hash.hex(), `pieces of ${size}`).toBe(expected)
    }
  })

  it('hashes a blob a chunk at a time, never holding the whole of it, and hands the thread back between chunks', async () => {
    const body = Uint8Array.from({ length: 10_000 }, (_value, index) => index % 253)
    const blob = new Blob([body])
    const reads: number[] = []
    const original = blob.slice.bind(blob)

    blob.slice = (start?: number, end?: number, type?: string) => {
      reads.push((end ?? 0) - (start ?? 0))

      return original(start, end, type)
    }

    let yielded = 0
    const tick = setInterval(() => (yielded += 1), 0)

    try {
      expect(await sha256Chunked(blob, 1000)).toBe(createHash('sha256').update(body).digest('hex'))
    } finally {
      clearInterval(tick)
    }

    // Ten reads of a thousand bytes, never one of ten thousand; the page ran in between.
    expect(reads).toEqual(Array(10).fill(1000))
    expect(yielded).toBeGreaterThan(0)
  })

  it('hashes an empty blob', async () => {
    expect(await sha256Chunked(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
