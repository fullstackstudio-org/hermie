/**
 * Base URL serialisation and the "private" rule: `contract/confirm-passkey/README.md` §3 and §10.
 *
 * A gateway is named by its base URL: `scheme://host[:port]` plus a normalised path prefix. Every side
 * (native app, browser, gateway) must compute the same string from what it dialed, or every answer is
 * refused as `challenge_mismatch`. The host is parsed by the WHATWG URL parser (non-transitional UTS #46,
 * so `ß` becomes `xn--strae-oqa`, never `ss`); the path is read from the RAW input, because that parser
 * would resolve `/a/../b` before it can be refused.
 */

/** The input is not an http(s) base URL. */
export class NotABaseUrl extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'NotABaseUrl'
  }
}

const AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/
const SEGMENT = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/** `scheme://host[:port][/prefix]`. Throws `NotABaseUrl`. */
export function serialiseBaseUrl(input: string): string {
  const match = AUTHORITY.exec(String(input))

  if (!match) {
    throw new NotABaseUrl('not an http(s) URL with a host')
  }

  const scheme = (match[1] as string).toLowerCase()
  const authority = match[2] as string
  const rawPath = match[3] as string

  if ((scheme !== 'http' && scheme !== 'https') || !authority) {
    throw new NotABaseUrl('not an http(s) URL with a host')
  }

  let parsed: URL

  try {
    parsed = new URL(`${scheme}://${authority}`)
  } catch {
    throw new NotABaseUrl('unparseable')
  }

  const host = parsed.hostname

  if (!host || host === '[]') {
    throw new NotABaseUrl('not an http(s) URL with a host')
  }

  if (!host.startsWith('[') && host.split('.').some(label => label === '')) {
    throw new NotABaseUrl('empty host label')
  }

  const origin = `${scheme}://${host}${parsed.port ? `:${parsed.port}` : ''}`
  const path = rawPath.replace(/\/+$/u, '')

  if (!path) {
    return origin
  }

  const segments = path.split('/').slice(1)

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !SEGMENT.test(segment))) {
    throw new NotABaseUrl('path prefix')
  }

  return `${origin}/${segments.map(segment => segment.replace(/%[0-9a-fA-F]{2}/gu, m => m.toUpperCase())).join('/')}`
}

/** The web origin of a serialised base URL. */
export function originOf(baseUrl: string): string {
  const url = new URL(baseUrl)

  return `${url.protocol}//${url.host}`
}

/** The host of a serialised base URL, IPv6 in brackets (it is the web RP id). */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname
}

export function hasPathPrefix(baseUrl: string): boolean {
  const path = new URL(baseUrl).pathname

  return path !== '' && path !== '/'
}

// ── private (README §10) ──────────────────────────────────────────────────────────────────────

const V4_PRIVATE: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 29],
  ['192.0.0.170', 31],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32]
]
const V4_NOT_GLOBAL_EXTRA: [string, number][] = [['100.64.0.0', 10]]
const V4_GLOBAL_EXCEPTIONS: [string, number][] = [
  ['192.0.0.9', 32],
  ['192.0.0.10', 32]
]
const V6_PRIVATE: [string, number][] = [
  ['::1', 128],
  ['::', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10]
]
const V6_GLOBAL_EXCEPTIONS: [string, number][] = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28]
]

function v4(text: string): bigint | null {
  const parts = text.split('.')

  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
    return null
  }

  return parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n)
}

function v6(text: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/u.test(text) || text.includes(':::')) {
    return null
  }

  const halves = text.split('::')

  if (halves.length > 2) {
    return null
  }

  const head = halves[0] ? (halves[0] as string).split(':') : []
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : []
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head

  if (groups.length !== 8 || !groups.every(group => /^[0-9a-fA-F]{1,4}$/u.test(group))) {
    return null
  }

  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n)
}

function within(value: bigint, bits: number, [network, prefix]: [string, number]): boolean {
  const base = bits === 32 ? v4(network) : v6(network)

  if (base === null) {
    return false
  }

  const shift = BigInt(bits - prefix)

  return value >> shift === base >> shift
}

/** Python's `ipaddress.ip_address(host).is_global`, for a canonical literal. `null`: not an IP literal. */
function isGlobalLiteral(host: string): boolean | null {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  const four = v4(bare)

  if (four !== null) {
    const private4 =
      V4_PRIVATE.some(net => within(four, 32, net)) && !V4_GLOBAL_EXCEPTIONS.some(net => within(four, 32, net))

    return !private4 && !V4_NOT_GLOBAL_EXTRA.some(net => within(four, 32, net))
  }

  const six = bare.includes(':') ? v6(bare) : null

  if (six !== null) {
    return !(V6_PRIVATE.some(net => within(six, 128, net)) && !V6_GLOBAL_EXCEPTIONS.some(net => within(six, 128, net)))
  }

  return null
}

/** README §10: a base URL that can name a different machine on another network. */
export function isPrivate(baseUrl: string): boolean {
  const url = new URL(baseUrl)

  if (url.protocol !== 'https:') {
    return true
  }

  const host = url.hostname
  const global = isGlobalLiteral(host)

  if (global !== null) {
    return !global
  }

  return host === 'localhost' || !host.includes('.') || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))
}
