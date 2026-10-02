import { render, waitFor } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context'

import { ThemeProvider } from '../../src/ui/theme'

// react-native-safe-area-context measures a real view, which a test renderer
// never lays out; these are an iPhone 17 Pro's numbers.
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 }
}

/**
 * The providers every screen assumes are above it.
 *
 * Exported separately because `rerender` replaces the WHOLE tree, providers
 * included: `view.rerender(<Thing />)` drops the safe-area provider on the
 * floor and the next render throws "No safe area value available".
 */
export function withProviders(ui: ReactElement) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{ui}</ThemeProvider>
    </SafeAreaProvider>
  )
}

/** Render a screen with the providers every screen assumes are above it. */
export function renderScreen(ui: ReactElement) {
  return render(withProviders(ui))
}

/**
 * Wait until `query` finds nothing: a sheet, panel or overlay has finished its
 * exit and unmounted.
 *
 * Not `waitFor(() => expect(query()).toBeNull())`. Every poll that still finds
 * the element fails that matcher, and a failing matcher pretty-prints what it
 * received — here a mounted panel or sheet, with its whole subtree. Measured,
 * that is close to half a second per poll on a fast machine, against a 16ms
 * exit animation; two or three polls on a slower CI runner used up the test's
 * five seconds. Checking for null directly costs a tree walk, and the failure
 * message still names what stayed.
 */
export function waitForGone(query: () => unknown, what: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    if (query() != null) {
      throw new Error(`Expected ${what} to be gone, but it is still on screen.`)
    }
  }, options)
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}
