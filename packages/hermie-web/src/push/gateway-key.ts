/**
 * Which gateway a notification came from, as a string two programs agree on.
 *
 * This is a second implementation of `gatewayKeyOf` from
 * `@hermie/gateway-client`, and the duplication is deliberate.
 * [ADR-0015](../../../../docs/adr/0015-web-variant-on-its-own-port.md) makes
 * this package zero-runtime-dependency: it ships as a release zip and a Docker
 * image that run `dist/server` with nothing installed beside them, so it cannot
 * import a workspace package for ten lines of arithmetic.
 *
 * That is the same position the gateway PLUGIN is in — it is Python, and it
 * will write these ten lines a third time. Which is why the algorithm is
 * specified rather than implemented once: **FNV-1a, 64-bit, over the UTF-8
 * bytes of the origin, printed as 16 lowercase hex digits.** The vector in
 * `gateway-key.test.ts` is shared by every copy, and is how a copy proves it
 * agrees.
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

/** `scheme://host:port`, lowercased, or `''` when the address is not a URL. */
function originOf(address: string): string {
  try {
    return new URL(address).origin.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The key for one gateway address, or `''` when it is not an address.
 *
 * The ORIGIN and not the address: a path prefix in somebody's configuration is
 * the same gateway reached a different way, and a device should not stop
 * recognising its own notifications because of one. An opaque origin
 * (`localhost:9119` parses as the scheme `localhost:`) serialises as `"null"`
 * for every such address, so it names no gateway either.
 */
export function gatewayKeyOf(address: string): string {
  const origin = originOf(address)

  if (!origin || origin === 'null') {
    return ''
  }

  let hash = FNV_OFFSET

  for (const byte of new TextEncoder().encode(origin)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK
  }

  return hash.toString(16).padStart(16, '0')
}
