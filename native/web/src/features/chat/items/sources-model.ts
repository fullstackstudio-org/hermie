/**
 * What the sources of a reply (`contract/sources/`) are drawn from: the host a person reads beside a title, the
 * monogram that stands in for an icon, and the two tiers.
 *
 * Nothing here loads anything. A source is a link the person may follow, and the one thing a title must never do is
 * hide where it goes, so the host is taken from the address itself and shown whole.
 */
import type { Source } from '@hermie/transcript'

import { openableHref } from '../../../markdown/links'

/** The authority of an `http(s)` address, as it is written: `host`, `host:port`, `[v6]:port`. */
const AUTHORITY_RE = /^https?:\/\/([^\s@/?#]+)/iu

/** Whether a string holds anything beyond ASCII. */
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\u0000-\u007f]/u

/**
 * The host to show beside a source: the authority exactly as the gateway stored it (it stores ASCII, punycode for a
 * name that is not), port included, because a port is part of where a link goes. An authority that is not ASCII
 * (a gateway that did not convert it) is shown as the browser would send it, punycode, so a name that only looks like
 * another cannot pass for it. `''` for an address with no authority, which the reader of the list never lets through.
 */
export function displayHost(url: string): string {
  const authority = AUTHORITY_RE.exec(url)?.[1]

  if (!authority) {
    return ''
  }

  if (!NON_ASCII_RE.test(authority)) {
    return authority
  }

  try {
    return new URL(url).host
  } catch {
    return authority
  }
}

/** The host without a port, a leading `www.`, and the brackets of an IPv6 literal, in lower case: what a monogram is made from. */
function bareHost(host: string): string {
  const withoutPort = host.startsWith('[') ? host : host.replace(/:\d*$/u, '')

  return withoutPort
    .replace(/^www\./iu, '')
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
}

/** How many colours the monograms have: a bucket per 30 degrees of hue, drawn by `sources.css`. */
export const MONOGRAM_HUES = 12

/** A small, stable string hash (FNV-1a), so the same host is the same colour on every device and every visit. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5

  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash
}

/**
 * The glyph standing in for a source's icon: the first letter or digit of the host (after `www.`), upper case, and a
 * colour bucket from a hash of that host. No image, no request. A host with neither a letter nor a digit gets `#`.
 */
export function monogramOf(url: string): { letter: string; hue: number } {
  const host = bareHost(displayHost(url))
  const letter = Array.from(host).find(char => /[\p{L}\p{N}]/u.test(char))

  return { letter: letter ? letter.toUpperCase() : '#', hue: hashOf(host) % MONOGRAM_HUES }
}

/** One source as a row shows it. */
export interface SourceRow {
  source: Source
  host: string
  /** The address to put on an anchor, or `null` when it may not be one (shown as text). */
  href: string | null
}

export function rowOf(source: Source): SourceRow {
  return { source, host: displayHost(source.url), href: openableHref(source.url) }
}

/** The two tiers, in the order the gateway lists them, each only when it has entries. */
export function tiersOf(sources: readonly Source[]): { via: Source['via']; rows: SourceRow[] }[] {
  const tiers: { via: Source['via']; rows: SourceRow[] }[] = []

  for (const via of ['read', 'found'] as const) {
    const rows = sources.filter(source => source.via === via).map(rowOf)

    if (rows.length) {
      tiers.push({ via, rows })
    }
  }

  return tiers
}
