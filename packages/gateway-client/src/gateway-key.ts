/**
 * A name for a gateway that two programs can arrive at independently.
 *
 * The app keys everything it stores by a random local id (see the companion
 * app's `gateway/registry.ts`), and that id is exactly the wrong thing to put
 * in a push payload or a deep link: it is minted on one device, it means
 * nothing on another, and nothing outside the app has ever seen it. The
 * notifier — the gateway plugin (earlier also `hermie-web --push`) — knows
 * its own ADDRESS and nothing else about the devices it sends to.
 *
 * So the wire carries a key derived from the address, and the app maps it back
 * to whichever local entry has that origin. A device that does not recognise
 * the key simply does not switch, which is the same behaviour every entry point
 * in this project already has for a payload it cannot resolve.
 *
 * **It is not a secret and it is not a security boundary.** Anything that can
 * reach a device's push token already knows which gateway it came from; the key
 * only has to be stable and to not collide. A tap that arrives with a forged
 * key selects a gateway the owner has already configured and opens a chat on
 * it, which is the whole of what a link may do — see `platform/deep-link.ts`.
 *
 * **The algorithm is FNV-1a, 64-bit, over the UTF-8 bytes of the origin**,
 * printed as 16 lowercase hex digits. It is written down here as a
 * specification rather than as an implementation detail, because the notifier
 * that has to produce the same string may be written in another language:
 *
 * ```python
 * def gateway_key(origin: str) -> str:
 *     h = 0xCBF29CE484222325
 *     for byte in origin.encode("utf-8"):
 *         h = ((h ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
 *     return f"{h:016x}"
 * ```
 *
 * The ORIGIN and not the address: `https://gateway.example.com:8443/hermes` and
 * `https://gateway.example.com:8443` are one gateway reached two ways, and a
 * path prefix somebody added to a configuration should not make a device stop
 * recognising its own notifications.
 */
import { originOf } from './front-door'

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

/** FNV-1a over the UTF-8 bytes, as 16 lowercase hex digits. */
function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let hash = FNV_OFFSET

  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK
  }

  return hash.toString(16).padStart(16, '0')
}

/**
 * What `URL.origin` serialises an opaque origin as: `mailto:`, `file:`, and
 * `example.com:9119`, which parses as the scheme `example.com:`.
 */
const OPAQUE_ORIGIN = 'null'

/**
 * The key for one gateway address, or `''` when it is not an address.
 *
 * An empty answer is deliberate and is what every caller checks: a payload
 * carrying no key, or a configuration whose address will not parse, must read
 * as "this does not name a gateway" rather than as a key that happens to match
 * every other unparseable one. An opaque origin is the same case: it parses,
 * but every such address shares the origin `"null"`, so it names no gateway.
 */
export function gatewayKeyOf(address: string): string {
  const origin = originOf(address)

  return origin && origin !== OPAQUE_ORIGIN ? fnv1a64(origin) : ''
}

/** True for a string this function could have produced. Keys arrive from the wire. */
export const isGatewayKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/u.test(value)
