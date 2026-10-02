/**
 * Empty the platform's HTTP cache.
 *
 * One caller, one reason, and the reason is a measured one. `URLCache` on iOS
 * is keyed by bundle identifier and OUTLIVES the app: deleting Hermie and
 * installing it again leaves it in place. A gateway that moved from one domain
 * to another left a 301 in it, and months later a fresh install's very first
 * onboarding probe was answered out of that cache — it reached the host the
 * owner had moved away from and reported "that is not a Hermes gateway" about
 * the address they had correctly typed.
 *
 * Two things came out of that and both are needed. Every request this app makes
 * now goes out with `no-store`, which stops a new one being stored; this empties
 * what is already there, at the one moment the reader has said that this gateway
 * is not the one they want.
 *
 * `requireOptionalNativeModule` rather than the throwing form, for the reason
 * `runs-on-mac.ts` gives: the module is Apple-only, and on Android and in the
 * test renderer the honest answer is "there was nothing to empty".
 */
import { requireOptionalNativeModule } from 'expo'

type UrlCacheModule = { clearUrlCache?: () => boolean }

/** True when a cache was actually emptied. False is not a failure. */
export function clearUrlCache(): boolean {
  try {
    return requireOptionalNativeModule<UrlCacheModule>('HermieMac')?.clearUrlCache?.() === true
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}
