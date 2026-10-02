/**
 * The browser tab's name, which is the one piece of window chrome the app owns
 * and the only label a visitor sees when the tab is not the front one.
 *
 * What it replaces is worth writing down, because it was not "nothing". The
 * compact shell mounts a `NavigationContainer`, and `@react-navigation/native`
 * runs `useDocumentTitle` on the web whether or not it was asked to, defaulting
 * to `options.title ?? route.name`. Two screens set no title, so the tab read
 * `Bots` — a route name from the source, for a screen whose header says Chats —
 * and `Chat`. The regular shell has no navigator at all, so it never moved off
 * the exported document's `Hermie`; and because the two shells swap on window
 * width, a narrow window that was widened kept whichever name the navigator had
 * set on its way out.
 *
 * So the navigator's own titling is switched off at the container and both
 * shells call this instead, which keeps one answer for a name that used to have
 * three.
 */
import { useEffect } from 'react'

import { formatPageTitle } from './platform-contracts'

export function usePageTitle(screen: string | undefined): void {
  useEffect(() => {
    // A unit test renderer has no document, and neither does a server render.
    if (typeof document === 'undefined') {
      return
    }

    document.title = formatPageTitle(screen)
  }, [screen])
}
