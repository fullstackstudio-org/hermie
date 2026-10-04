/**
 * A clock that only runs forward: milliseconds on one origin (the page's), unaffected by the system clock being
 * set back or forward (a manual change, an NTP step, a wake from sleep).
 *
 * For comparing moments this page itself observed (when a request first arrived against when a list of open
 * requests was asked for). A moment the gateway names (a request's deadline) is epoch time and stays on
 * `Date.now()`; the two are never compared.
 */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}
