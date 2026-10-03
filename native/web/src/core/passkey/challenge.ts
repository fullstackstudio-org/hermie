/**
 * The confirm-passkey construction of `contract/confirm-passkey/README.md`, for
 * the browser: base64url (§2), the base URL (§3), the text digest (§4), the
 * challenge (§5) and the enrolment code's canonical form (§7).
 *
 * Every hash goes through a `Sha256` the caller hands in (the page's
 * `crypto.subtle`, through `platform/webauthn.ts`; Node's `webcrypto` in a
 * test), so nothing here touches a browser global. The functions are pure
 * otherwise and byte-for-byte with the contract's vectors
 * (`challenge.test.ts`).
 *
 * The rule that matters most is §4's last sentence: the digest is taken over the
 * values the sheet displays, never over a second copy. `ConfirmText` is that
 * value: the confirm sheet renders one and the model computes the challenge from
 * the same object.
 */

/** SHA-256 of `data`. Asynchronous because `crypto.subtle` is. */
export type Sha256 = (data: Uint8Array) => Promise<Uint8Array>

/** What a challenge is for (§5). */
export type ChallengePurpose = 'confirm' | 'register' | 'invite' | 'revoke'

/** The text a challenge commits to: exactly what the sheet shows. */
export interface ConfirmText {
  readonly title: string
  readonly summary: string
  /** Absent, `null` and `""` give the same digest (§4). */
  readonly detail?: string | null
}

/** Everything else a challenge commits to (§5's table). */
export interface ChallengeBinding {
  purpose: ChallengePurpose
  /** The base URL the client dialed (§3). */
  baseUrl: string
  /** 16 bytes. */
  gatewayId: Uint8Array
  /** `<provider>:<user id>`. */
  userId: string
  /** `confirm`: the frame's `params.session_id`; `""` otherwise. */
  sessionId: string
  /** `confirm`: the frame's JSON-RPC id; the registration or step-up id otherwise. */
  requestId: string
  /** 32 bytes. */
  nonce: Uint8Array
}

const TEXT_TAG = 'hermie-confirm-text-v1'
const CHALLENGE_TAG = 'hermie-confirm-v1'

const utf8 = new TextEncoder()

// ── base64url (§2) ──────────────────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP = new Map([...ALPHABET].map((ch, index) => [ch, index]))

/** base64url without padding. */
export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let index = 0

  for (; index + 2 < bytes.length; index += 3) {
    const n = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8) | (bytes[index + 2] as number)

    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63)
  }

  const left = bytes.length - index

  if (left === 1) {
    const n = (bytes[index] as number) << 16

    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
  } else if (left === 2) {
    const n = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8)

    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63)
  }

  return out
}

/**
 * Strict base64url: no padding, nothing outside the alphabet, canonical trailing
 * bits (re-encoding gives the input back). `null` for anything else, and for a
 * length outside `[min, max]` bytes when they are given.
 */
export function b64uDecode(text: string, min = 0, max = Number.POSITIVE_INFINITY): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1) {
    return null
  }

  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let at = 0

  for (const ch of text) {
    const value = LOOKUP.get(ch)

    if (value === undefined) {
      return null
    }

    buffer = (buffer << 6) | value
    bits += 6

    if (bits >= 8) {
      bits -= 8
      out[at++] = (buffer >> bits) & 0xff
    }

    buffer &= (1 << bits) - 1
  }

  // Leftover bits must be zero, or two strings would decode to the same bytes.
  if (buffer !== 0 || out.length < min || out.length > max) {
    return null
  }

  return out
}

// ── length-prefixed fields (§2) ─────────────────────────────────────────────────────────────────

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length)

  new DataView(out.buffer).setUint32(0, bytes.length)
  out.set(bytes, 4)

  return out
}

/** `S(s)`: 4-byte big-endian length, then the UTF-8 bytes. No normalisation of any kind. */
const S = (text: string): Uint8Array => lengthPrefixed(utf8.encode(text))

/** `LP(b)`. */
const LP = (bytes: Uint8Array): Uint8Array => lengthPrefixed(bytes)

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

// ── digest and challenge (§4, §5) ───────────────────────────────────────────────────────────────

/** The bytes §4 hashes. */
export function textDigestPreimage(text: ConfirmText): Uint8Array {
  return concat([S(TEXT_TAG), S(text.title), S(text.summary), S(text.detail ?? '')])
}

export async function textDigest(sha256: Sha256, text: ConfirmText): Promise<Uint8Array> {
  return sha256(textDigestPreimage(text))
}

/** The bytes §5 hashes, for a digest already taken. */
export function challengePreimage(binding: ChallengeBinding, digest: Uint8Array): Uint8Array {
  return concat([
    S(CHALLENGE_TAG),
    S(binding.purpose),
    S(binding.baseUrl),
    LP(binding.gatewayId),
    S(binding.userId),
    S(binding.sessionId),
    S(binding.requestId),
    LP(binding.nonce),
    LP(digest)
  ])
}

/** The 32 bytes WebAuthn signs: §5 over `binding` and the digest of `text`. */
export async function challenge(sha256: Sha256, binding: ChallengeBinding, text: ConfirmText): Promise<Uint8Array> {
  return sha256(challengePreimage(binding, await textDigest(sha256, text)))
}

/** The text of a step-up or a registration: `("", subject, "")` (§5's table). */
export const subjectText = (subject: string): ConfirmText => ({ title: '', summary: subject, detail: '' })

// ── base URL (§3) ───────────────────────────────────────────────────────────────────────────────

/** RFC 3986 `pchar`: unreserved, sub-delims, `:` and `@`, or a percent-encoded triplet. */
const PCHAR = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*$/u

/**
 * The serialised base URL of `input` (§3), or `null` when it is not one: an
 * `http` or `https` URL whose path has no empty, `.` or `..` segment and only
 * `pchar` characters. The host is serialised by the platform's WHATWG URL parser
 * (lower case, A-labels by UTS #46 non-transitional processing, IPv6 compressed,
 * default port dropped); the path is checked on the text as written, because the
 * parser would quietly resolve a `..` the contract refuses.
 */
export function serialiseBaseUrl(input: string): string | null {
  const raw = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/[^/?#]*([^?#]*)/u.exec(input)

  if (!raw) {
    return null
  }

  let url: URL

  try {
    url = new URL(input)
  } catch {
    return null
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return null
  }

  const path = (raw[2] ?? '').replace(/\/+$/u, '')
  const segments = path === '' ? [] : path.slice(1).split('/')

  if (path !== '' && !path.startsWith('/')) {
    return null
  }

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || !PCHAR.test(segment)) {
      return null
    }
  }

  const prefix = segments.length ? `/${segments.join('/').replace(/%[0-9a-f]{2}/giu, m => m.toUpperCase())}` : ''

  return `${url.protocol}//${url.host}${prefix}`
}

/** The origin of a serialised base URL: its scheme and authority. */
export function originOfBaseUrl(baseUrl: string): string {
  const match = /^[a-z]+:\/\/[^/]*/u.exec(baseUrl)

  return match ? match[0] : ''
}

/** True when a serialised base URL has a path prefix (a browser is never offered the level there, §10). */
export const hasPathPrefix = (baseUrl: string): boolean => originOfBaseUrl(baseUrl) !== baseUrl

// ── enrolment codes (§7) ────────────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The canonical form of an enrolment code, or `null` for one that is not: upper
 * case, `-` and spaces dropped, `O` read as `0` and `I`, `L` as `1`, then exactly
 * 20 symbols of the Crockford alphabet.
 */
export function canonicalEnrolmentCode(input: string): string | null {
  const canonical = input.toUpperCase().replace(/[- ]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1')

  if (canonical.length !== 20 || [...canonical].some(ch => !CROCKFORD.includes(ch))) {
    return null
  }

  return canonical
}

/** The code as people read it: `XXXXX-XXXXX-XXXXX-XXXXX`. Anything not canonical is returned as it came. */
export function displayEnrolmentCode(code: string): string {
  const canonical = canonicalEnrolmentCode(code)

  return canonical ? (canonical.match(/.{5}/gu) ?? []).join('-') : code
}
