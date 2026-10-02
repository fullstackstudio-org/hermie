import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { SafeAreaProvider, useSafeAreaInsets as useWindowSafeAreaInsets } from 'react-native-safe-area-context'

import { RUNS_ON_MAC } from './runs-on-mac'

export function SafeArea({ children }: { children: ReactNode }) {
  return <SafeAreaProvider>{children}</SafeAreaProvider>
}

/**
 * The window's safe area, with the top inset dropped on a Mac.
 *
 * An iOS app running on a Mac is told it has an iPad's status bar: the window
 * reports a top inset of roughly 25pt that nothing occupies, because the
 * macOS title bar is outside the app's window entirely. Honouring it painted an
 * empty band between the title bar and Hermie's own header — visible on every
 * screen, since `Screen` turns this inset into `paddingTop`.
 *
 * Only `top` is dropped. The other three are either zero on a Mac or genuinely
 * describe the window, and a blanket zero would be a guess rather than a fix.
 */
export function useSafeAreaInsets() {
  const insets = useWindowSafeAreaInsets()

  // Memoised because the library's own value is stable across renders, and a
  // fresh object here would defeat every consumer that depends on that.
  return useMemo(() => (RUNS_ON_MAC ? { ...insets, top: 0 } : insets), [insets])
}
