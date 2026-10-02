/**
 * Naming the screen for the window it is in: on a phone, on a tablet and on a
 * Mac, nothing does.
 *
 * iOS and Android have no document to title, and a Mac window's title is drawn
 * by the app's own chrome rather than read from here. The hook exists on this
 * side so the shells can call it unconditionally instead of branching, which is
 * the same bargain `haptics.ts` makes.
 */

export function usePageTitle(_screen: string | undefined): void {
  // Nothing to name.
}
