/**
 * The system status bar in a browser: there is none — but the DOCUMENT around
 * the app still has two colours only this side can set.
 *
 * `index.html` paints both of them before the bundle runs, from
 * `prefers-color-scheme` and the default preset, because a first paint happens
 * long before any of this exists and a white flash on a dark theme is the most
 * visible defect the browser build has. What it cannot know is which theme
 * WON: the app lets a visitor pin Light or Dark against the system, and pick a
 * preset whose background is a different colour again. So the static answer is
 * the opening bid and this is the correction.
 *
 * Two things are written, and they are not the same thing:
 *
 *  - `theme-color`, which tints browser chrome AROUND the page — the address
 *    bar on Android, the title bar of an installed window. Both of the
 *    template's media-scoped tags are removed first, because a `media` that
 *    still matches outranks a later unscoped tag and the pinned choice would
 *    lose to the system's.
 *  - `--hermie-background` on the root element, which is what `html`/`body`
 *    are painted with. That is the colour of the overscroll gutter a rubber-band
 *    scroll exposes, and of the strip beside the app in an installed window.
 *
 * `ink` is not used here. A tab's chrome is the browser's, and it picks its own
 * ink from the colour it was handed.
 */
import { useEffect } from 'react'

import type { SystemChromeProps } from './platform-contracts'

export type { StatusBarInk } from './platform-contracts'

/** The id the template's own pair of tags carries, so they can be found again. */
const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]'

export function SystemStatusBar({ background, focus }: SystemChromeProps) {
  useEffect(() => {
    // A unit test renderer has no document, and neither does a server render.
    if (typeof document === 'undefined') {
      return
    }

    document.querySelectorAll(`${THEME_COLOR_SELECTOR}[media]`).forEach(tag => tag.remove())

    let meta = document.querySelector(THEME_COLOR_SELECTOR)

    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.append(meta)
    }

    meta.setAttribute('content', background)
    document.documentElement.style.setProperty('--hermie-background', background)
    document.documentElement.style.setProperty('--hermie-focus', focus)
  }, [background, focus])

  return null
}
