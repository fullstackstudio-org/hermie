/**
 * Is the host the user gave us one where a cleartext path stays inside a
 * network somebody controls?
 *
 * Plain `http://` is not a defect by itself. Over Tailscale or Headscale the
 * WireGuard tunnel has already encrypted the path, and on loopback there is no
 * path at all; on the open internet the same address is readable by every hop
 * in between. The app therefore needs to tell those two apart to pick a TONE,
 * and nothing more — this decides what a sentence says, never whether a
 * connection is allowed. The user's own judgement about their own network wins,
 * which is why nothing here refuses anything.
 *
 * Nothing in this module resolves a name. A `.ts.net` suffix is read as the
 * intent it states; a tailnet name that resolves somewhere else is a DNS
 * problem, and lying to this function buys an attacker a friendlier sentence
 * and no access.
 */

/** Tailscale hands every node an address out of the CGNAT block. */
const CGNAT_SECOND_OCTET = { min: 64, max: 127 } as const

/** Tailscale's IPv6 range, a /48 inside the ULA space. */
const TAILSCALE_ULA_PREFIX = [0xfd7a, 0x115c, 0xa1e0] as const

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export type HostPrivacy =
  /** `127.0.0.0/8`, `::1`, `localhost` — the gateway is on this machine. */
  | 'loopback'
  /** RFC 1918, or an IPv6 unique local address (`fc00::/7`). */
  | 'private'
  /** `169.254.0.0/16` or `fe80::/10`. */
  | 'link_local'
  /** `100.64.0.0/10` — shared address space, and the range Tailscale allots from. */
  | 'cgnat'
  /** A `.ts.net` MagicDNS name, or Tailscale's own `fd7a:115c:a1e0::/48`. */
  | 'tailnet'
  /**
   * A `.local` or `.internal` name, or a name with no dots in it: resolvable on
   * one network only.
   */
  | 'local_name'
  /** Anything else. A name the public DNS can answer, or a routable address. */
  | 'public'

export interface HostClassification {
  /** The bare host: lowercased, no port, no brackets, no trailing dot. */
  host: string
  privacy: HostPrivacy
  /**
   * True for everything but `public`. Cleartext to such a host is reasonable
   * to state calmly; cleartext to a public one is worth a warning.
   */
  isPrivate: boolean
}

/**
 * Split a host out of a URL, an authority, or a bare host.
 *
 * A port cannot simply be cut at the last colon, because an unbracketed IPv6
 * literal is mostly colons. Two colons or more and no brackets means the whole
 * string is the address.
 */
export function hostOfAddress(address: string): string {
  // The URL parser removes every ASCII tab and newline before it reads
  // anything, so `http://10.0.0.1\n.example.com` is the host
  // `10.0.0.1.example.com` to whatever loads it. Reading it any other way
  // here would classify a host nobody will ever connect to.
  let rest = address.trim().replace(/[\t\n\r]/g, '')

  const schemeEnd = rest.indexOf('://')

  if (schemeEnd >= 0) {
    rest = rest.slice(schemeEnd + 3)
  }

  // The authority ends at the first path, query or fragment, and only an `@`
  // inside it separates credentials from the host. Cutting at the last `@`
  // first would read `http://example.com/x@10.0.0.1` as host `10.0.0.1`.
  //
  // `\` ends it too: the URL standard reads it as `/` for http, https, ws and
  // wss, which is every address this module is ever given. Without it,
  // `http://public.example\@10.0.0.1` read as `10.0.0.1` here — a private
  // address, stated calmly — while the request went to `public.example`.
  const end = rest.search(/[/?#\\]/)

  if (end >= 0) {
    rest = rest.slice(0, end)
  }

  const at = rest.lastIndexOf('@')

  if (at >= 0) {
    rest = rest.slice(at + 1)
  }

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')

    rest = close >= 0 ? rest.slice(1, close) : rest.slice(1)
  } else if (rest.split(':').length === 2) {
    rest = rest.slice(0, rest.indexOf(':'))
  }

  // A fully qualified name may end in the root dot; `a.ts.net.` is `a.ts.net`.
  return rest.replace(/\.+$/, '').toLowerCase()
}

function classifyIpv4(host: string): HostPrivacy | null {
  const match = IPV4_RE.exec(host)

  if (!match) {
    return null
  }

  const octets = match.slice(1, 5).map(Number)

  if (octets.some(octet => octet > 255)) {
    return null
  }

  const [first, second] = octets as [number, number, number, number]

  if (first === 127) {
    return 'loopback'
  }

  if (first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31)) {
    return 'private'
  }

  if (first === 169 && second === 254) {
    return 'link_local'
  }

  if (first === 100 && second >= CGNAT_SECOND_OCTET.min && second <= CGNAT_SECOND_OCTET.max) {
    return 'cgnat'
  }

  return 'public'
}

/** Expand an IPv6 literal to its eight hextets, or null if it is not one. */
function hextets(host: string): number[] | null {
  if (!host.includes(':')) {
    return null
  }

  const [head, tail, ...extra] = host.split('::')

  if (extra.length > 0 || head === undefined) {
    return null
  }

  const parse = (part: string): number[] | null => {
    if (!part) {
      return []
    }

    const out: number[] = []

    for (const group of part.split(':')) {
      // A trailing IPv4 part (`::ffff:192.168.0.1`) is two hextets.
      const asIpv4 = IPV4_RE.exec(group)

      if (asIpv4) {
        const octets = asIpv4.slice(1, 5).map(Number)

        if (octets.some(octet => octet > 255)) {
          return null
        }

        const [a, b, c, d] = octets as [number, number, number, number]

        out.push((a << 8) | b, (c << 8) | d)

        continue
      }

      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null
      }

      out.push(Number.parseInt(group, 16))
    }

    return out
  }

  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)

  if (!left || !right) {
    return null
  }

  if (tail === undefined) {
    return left.length === 8 ? left : null
  }

  const gap = 8 - left.length - right.length

  if (gap < 1) {
    return null
  }

  return [...left, ...Array.from({ length: gap }, () => 0), ...right]
}

function classifyIpv6(host: string): HostPrivacy | null {
  const groups = hextets(host)

  if (!groups) {
    return null
  }

  // An IPv4-mapped address is an IPv4 address wearing a hat: `::ffff:10.0.0.1`
  // reaches the same machine `10.0.0.1` does, so it is classified as one.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const [, , , , , , seventh = 0, eighth = 0] = groups

    return classifyIpv4(
      [seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff].map(octet => String(octet)).join('.')
    )
  }

  if (groups.every(group => group === 0)) {
    return 'public'
  }

  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) {
    return 'loopback'
  }

  const [first = 0] = groups

  if ((first & 0xffc0) === 0xfe80) {
    return 'link_local'
  }

  if (TAILSCALE_ULA_PREFIX.every((hextet, index) => groups[index] === hextet)) {
    return 'tailnet'
  }

  if ((first & 0xfe00) === 0xfc00) {
    return 'private'
  }

  return 'public'
}

function classifyName(host: string): HostPrivacy {
  // A colon that survived the IPv6 parser is a malformed literal, not a name
  // with no dots in it. Every unreadable host reads as public, so a typo buys a
  // warning rather than a reassurance.
  if (host.includes(':')) {
    return 'public'
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'loopback'
  }

  if (host.endsWith('.ts.net')) {
    return 'tailnet'
  }

  /*
   * `.internal` is reserved for private use and will never be delegated in the
   * public root, so a name under it cannot be one anybody outside the network
   * that defines it can resolve — the same property `.local` has. It is the
   * suffix a Headscale operator reaches for when they want names of their own,
   * and calling it public produced the worst sentence this module can produce:
   * a gateway on a WireGuard tunnel warned about as readable by every hop, with
   * `Use https instead` next to it. Measured on iOS 27 against the owner's
   * gateway — see the 2026-09-20 tailnet section of docs/platform-notes.md.
   */
  if (host.endsWith('.local') || host === 'internal' || host.endsWith('.internal')) {
    return 'local_name'
  }

  if (host.length > 0 && !host.includes('.')) {
    return 'local_name'
  }

  return 'public'
}

/**
 * Classify whatever the user typed. Accepts a full URL, an authority with a
 * port, or a bare host.
 */
export function classifyHost(address: string): HostClassification {
  const host = hostOfAddress(address)

  const privacy = classifyIpv4(host) ?? classifyIpv6(host) ?? classifyName(host)

  return { host, privacy, isPrivate: privacy !== 'public' }
}

/** True when this address is reached in the clear over a network anyone can be on. */
export function isExposedCleartext(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith('http://') && !classifyHost(baseUrl).isPrivate
}
