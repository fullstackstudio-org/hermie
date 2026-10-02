/**
 * Which material this build can actually draw, decided once.
 *
 * Three answers, in descending fidelity:
 *
 *  - `native`  — iOS 26 and newer, where `expo-glass-effect` gives us the real
 *    Liquid Glass material (`UIGlassEffect` behind a `UIVisualEffectView`).
 *  - `blur`    — older iOS, where `expo-blur` plus our own gradient, hairline
 *    and shadow layers get close enough.
 *  - `solid`   — Android and anywhere else. No blur view at all; the surface
 *    collapses to its rung of the elevation ladder, which is exactly what that
 *    ladder is defined for.
 *
 * The web gets `blur`, not `solid`: `expo-blur` there is `backdrop-filter`,
 * which really does blur what is behind the surface, and every browser this
 * bundle runs in has had it for years. `expo-glass-effect` has no web build at
 * all, which is why both probes come through `./native-effect` (see the note
 * there) rather than from the package.
 *
 * Two checks, not one. `isLiquidGlassAvailable()` answers whether the app is
 * built against the Liquid Glass design at all; `isGlassEffectAPIAvailable()`
 * exists because some iOS 26 betas ship the design without a working
 * `UIGlassEffect` initialiser, and constructing one there crashes. A build that
 * passes the first and fails the second must fall back rather than try.
 *
 * Both calls reach for a native module through `requireNativeModule`, which
 * THROWS when the module is not linked — a test renderer, or a JavaScript bundle
 * running against a binary built before the dependency was added. The throw is
 * caught here so that the app degrades to `blur` rather than failing to start.
 */
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from './native-effect'
import { Platform } from 'react-native'

export type GlassMaterial = 'native' | 'blur' | 'solid'

function detect(): GlassMaterial {
  if (Platform.OS === 'web') {
    return 'blur'
  }

  if (Platform.OS !== 'ios') {
    return 'solid'
  }

  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable() ? 'native' : 'blur'
  } catch {
    // The module is not in this binary. Blur is a dependency of the same age,
    // and it is the documented fallback for an iOS older than 26 anyway.
    return 'blur'
  }
}

export const GLASS_MATERIAL: GlassMaterial = detect()

/**
 * The two probes, as they answered, for the developer screen.
 *
 * `GLASS_MATERIAL` alone says which path is live but not WHY, and the two
 * failures look identical from the outside: an OS older than 26 and an iOS 26
 * beta whose `UIGlassEffect` initialiser does not work both come out as `blur`.
 * So do both on a binary built before the dependency was linked, where the calls
 * throw. `unavailable` is that third answer.
 *
 * Read on a device rather than reasoned about: the owner's requirement is that
 * the glass reaches the transparency of the Messages search field, and the first
 * question when it does not is which of these three is false.
 */
export const GLASS_PROBES: { liquidGlass: boolean | 'unavailable'; effectApi: boolean | 'unavailable' } = (() => {
  try {
    return { liquidGlass: isLiquidGlassAvailable(), effectApi: isGlassEffectAPIAvailable() }
  } catch {
    return { liquidGlass: 'unavailable', effectApi: 'unavailable' }
  }
})()

/** True where a blur of any kind is possible, before accessibility has its say. */
export const CAN_BLUR = GLASS_MATERIAL !== 'solid'
