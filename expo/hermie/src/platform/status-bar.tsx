/**
 * The system status bar's ink.
 *
 * A seam because a browser tab has no status bar to tint at all, and because
 * `expo-status-bar`'s own web module is a silent no-op that still pulls a
 * native-module shim into the bundle. Declaring the platform difference here
 * keeps it visible next to the other seams instead of hidden inside a
 * dependency.
 *
 * `background` is in the contract for the web sibling, which paints a document
 * rather than a status bar. Nothing on a phone has a use for it: the bar is
 * transparent over the app's own wallpaper.
 */
import { StatusBar } from 'expo-status-bar'

import type { SystemChromeProps } from './platform-contracts'

export type { StatusBarInk } from './platform-contracts'

export function SystemStatusBar({ ink }: SystemChromeProps) {
  return <StatusBar style={ink} />
}
