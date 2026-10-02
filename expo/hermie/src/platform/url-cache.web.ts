/**
 * The browser's answer to `url-cache.ts`.
 *
 * A page cannot empty the HTTP cache, and it does not need to: the gateway is
 * the origin serving the page (ADR-0015), so there is no other host a stale
 * redirect could point at, and every request already goes out with `no-store`.
 * Answering false says "there was nothing to empty" rather than pretending.
 */
export function clearUrlCache(): boolean {
  return false
}
