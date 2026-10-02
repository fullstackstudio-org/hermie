/**
 * The one import of `expo-glass-effect`, behind a seam.
 *
 * `expo-glass-effect` is an Apple-only module with no web implementation at
 * all — not a stub, not a no-op, nothing the bundler can resolve — so a browser
 * build cannot so much as name it. Everything that would reach for it goes
 * through this file, and `native-effect.web.tsx` answers the same three
 * questions without it.
 *
 * `isLiquidGlassAvailable()` says whether the app is built against the Liquid
 * Glass design at all; `isGlassEffectAPIAvailable()` exists because some iOS 26
 * betas ship the design without a working `UIGlassEffect` initialiser, and
 * constructing one there crashes. Both reach for a native module through
 * `requireNativeModule`, which THROWS when it is not linked — a test renderer,
 * or a bundle running against a binary built before the dependency was added —
 * so the throw is caught where it is read, in `material.ts`.
 */
export { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect'
