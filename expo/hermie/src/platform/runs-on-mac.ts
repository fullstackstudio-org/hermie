/**
 * Is this the iOS app running on an Apple Silicon Mac?
 *
 * Since ADR-0011 the Mac version of Hermie is the iOS build running as
 * "Designed for iPad". It is the same binary and the same `Platform.OS === 'ios'`
 * as an iPhone, so the handful of places that genuinely have to know — a bare
 * Enter sends, there is no status bar to inset past — need an answer React
 * Native does not give. `Platform.isMacCatalyst` is a DIFFERENT question: it
 * reads the compile-time `TARGET_OS_MACCATALYST` flag, which is false here,
 * because a "Designed for iPad" app is an unmodified iOS binary. The only real
 * answer is `ProcessInfo.processInfo.isiOSAppOnMac`, and it comes from the local
 * module in `expo/hermie/modules/hermie-mac`.
 *
 * `requireOptionalNativeModule` rather than the throwing form, because the
 * module is deliberately Apple-only: on Android, and in the Jest environment,
 * the honest answer is `false` and asking for it should not be an error.
 *
 * A constant, not a hook. The value cannot change while the process lives, and
 * the first render already needs it.
 */
import { requireOptionalNativeModule } from 'expo'

type HermieMacModule = { isMac?: boolean }

function detect(): boolean {
  try {
    return requireOptionalNativeModule<HermieMacModule>('HermieMac')?.isMac === true
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

export const RUNS_ON_MAC = detect()
