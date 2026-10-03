/**
 * `contract/confirm-passkey/vectors.json`, byte for byte, in the client's own
 * test runner (jsdom, with Node's `webcrypto` standing in for the page's
 * `crypto.subtle`): base64url, the base URL, the text digest, the challenge of
 * every purpose with its preimage, and the enrolment code's canonical form.
 */
import { webcrypto } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import vectorsSource from '../../../../../contract/confirm-passkey/vectors.json?raw'

import {
  b64uDecode,
  b64uEncode,
  canonicalEnrolmentCode,
  challenge,
  type ChallengePurpose,
  challengePreimage,
  displayEnrolmentCode,
  hasPathPrefix,
  originOfBaseUrl,
  serialiseBaseUrl,
  type Sha256,
  textDigest
} from './challenge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are JSON
type Json = Record<string, any>

const vectors = JSON.parse(vectorsSource) as Json

const sha256: Sha256 = async data => new Uint8Array(await webcrypto.subtle.digest('SHA-256', data))

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

const bytes = (text: string): Uint8Array => {
  const decoded = b64uDecode(text)

  if (!decoded) {
    throw new Error(`not base64url: ${text}`)
  }

  return decoded
}

describe('base64url (§2)', () => {
  it('round-trips every length', () => {
    for (let length = 0; length < 40; length += 1) {
      const data = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff)

      expect(b64uDecode(b64uEncode(data))).toEqual(data)
      expect(b64uEncode(data)).toBe(Buffer.from(data).toString('base64url'))
    }
  })

  it('refuses padding, foreign characters and non-canonical trailing bits', () => {
    expect(b64uDecode('AA==')).toBeNull()
    expect(b64uDecode('A+B/')).toBeNull()
    expect(b64uDecode('AB')).toBeNull() // "AA" is the canonical form of that byte
    expect(b64uDecode('A')).toBeNull()
    expect(b64uDecode('AA')).toEqual(new Uint8Array([0]))
  })

  it('bounds the length when asked', () => {
    expect(b64uDecode('AAAA', 3, 3)).toEqual(new Uint8Array(3))
    expect(b64uDecode('AAAA', 4)).toBeNull()
    expect(b64uDecode('AAAA', 0, 2)).toBeNull()
  })
})

describe('base URL serialisation (§3)', () => {
  for (const vector of vectors.base_url_vectors as Json[]) {
    it(vector.name, () => {
      const baseUrl = serialiseBaseUrl(vector.input)

      if (vector.error) {
        expect(baseUrl).toBeNull()

        return
      }

      expect(baseUrl).toBe(vector.base_url)
      expect(originOfBaseUrl(baseUrl as string)).toBe(vector.origin)
      expect(hasPathPrefix(baseUrl as string)).toBe(vector.base_url !== vector.origin)
    })
  }

  it('gives what a browser calls the origin for every base URL without a prefix', () => {
    for (const vector of vectors.base_url_vectors as Json[]) {
      if (!vector.error && vector.base_url === vector.origin) {
        expect(new URL(vector.input).origin).toBe(vector.origin)
      }
    }
  })
})

describe('text digest (§4)', () => {
  for (const vector of vectors.text_digest_vectors as Json[]) {
    it(vector.name, async () => {
      const digest = await textDigest(sha256, { title: vector.title, summary: vector.summary, detail: vector.detail })

      expect(b64uEncode(digest)).toBe(vector.text_digest)
    })
  }
})

describe('challenge (§5)', () => {
  for (const vector of vectors.challenge_vectors as Json[]) {
    it(vector.name, async () => {
      const binding = {
        purpose: vector.purpose as ChallengePurpose,
        baseUrl: vector.base_url as string,
        gatewayId: bytes(vector.gateway_id),
        userId: vector.user_id as string,
        sessionId: vector.session_id as string,
        requestId: vector.request_id as string,
        nonce: bytes(vector.nonce)
      }
      const text = { title: vector.title, summary: vector.summary, detail: vector.detail }
      const digest = await textDigest(sha256, text)

      expect(b64uEncode(digest)).toBe(vector.text_digest)
      expect(hex(challengePreimage(binding, digest))).toBe(vector.preimage_hex)
      expect(b64uEncode(await challenge(sha256, binding, text))).toBe(vector.challenge)
    })
  }
})

describe('enrolment codes (§7)', () => {
  for (const vector of vectors.enrolment_code_vectors as Json[]) {
    it(vector.name, async () => {
      const canonical = canonicalEnrolmentCode(vector.input)

      expect(canonical).toBe(vector.canonical)

      if (canonical) {
        expect(b64uEncode(await sha256(new TextEncoder().encode(canonical)))).toBe(vector.code_hash)
      }
    })
  }

  it('is shown in groups of five', () => {
    expect(displayEnrolmentCode('m67b1pk0qjbtjwrqssb2')).toBe('M67B1-PK0QJ-BTJWR-QSSB2')
    expect(displayEnrolmentCode('nonsense')).toBe('nonsense')
  })
})
