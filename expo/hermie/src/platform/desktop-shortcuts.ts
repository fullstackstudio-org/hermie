/**
 * The keyboard seam on the phones, the iPad and the Mac: `HermieMac`, or nothing.
 *
 * Everything that is not "where does the keystroke come from" lives in
 * `desktop-shortcuts.shared.ts` — the action table, the menu bar and the
 * double-fire rule — because the browser needs all of it and none of this.
 * Read that file first; it is where the reasoning is.
 *
 * `desktop-shortcuts.web.ts` is the other half of the seam. It exists because
 * this file degrades to "no keyboard" in a tab, which is the honest answer on a
 * phone and was a silent one in a browser: `requireOptionalNativeModule` returns
 * null there, so every shortcut in the app was dead on the web and nobody
 * noticed, because Escape comes down a different road.
 */

import {
  isAction,
  isDoubleFire,
  macShortcuts,
  type ShortcutAction,
  type ShortcutEvent
} from './desktop-shortcuts.shared'

export {
  DOUBLE_FIRE_MS,
  isDoubleFire,
  isMenuBarInstalled,
  setMenuBar,
  type MenuBarTitles,
  type ShortcutAction,
  type ShortcutEvent
} from './desktop-shortcuts.shared'

/**
 * Every shortcut, while the app is in front. Returns the unsubscribe.
 *
 * Callers should go through `useShortcut`, which keeps one native subscription and
 * decides which of several registered screens an action belongs to.
 *
 * One press is dispatched once, whichever of the Mac's two seams reports it —
 * see `isDoubleFire`.
 *
 * The handler's answer — whether a screen took the action — is read by the web
 * seam to decide about `preventDefault`, and is nothing here: a `UIKeyCommand`
 * and a GameController handler have both already happened by the time this runs.
 */
export function subscribeToShortcuts(handler: (event: ShortcutEvent) => boolean | void): () => void {
  let last: { action: ShortcutAction; at: number } | null = null

  const subscription = macShortcuts?.addListener?.('onShortcut', payload => {
    if (!isAction(payload?.action)) {
      return
    }

    const now = { action: payload.action, at: Date.now() }

    if (isDoubleFire(last, now)) {
      return
    }

    last = now
    handler({ action: payload.action, typing: payload?.typing === true })
  })

  return () => subscription?.remove()
}
