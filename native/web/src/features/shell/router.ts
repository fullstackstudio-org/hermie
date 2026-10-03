/**
 * Routes (plan W4): one URL, and the route in the fragment.
 *
 * ```
 * #/                          home: the chat list, and nothing open
 * #/chat/<bot>                a bot's chat
 * #/chat/<bot>/s/<session>    one of its conversations
 * #/chat/<bot>/conversations  the list of its conversations (W-22)
 * #/settings                  settings
 * #/settings/<section>        one section of it
 * ```
 *
 * Anything else is unknown, and an unknown route is sent to `#/` by rewriting
 * the address in place (no history entry, so Back does not return to a route
 * that does not exist). A bot name or session id is one path segment,
 * percent-encoded: the gateway's names can hold anything a profile can be
 * called.
 *
 * `parseRoute` and `formatRoute` are pure and are inverses of each other for
 * every route; `useRoute` is the one hook that follows the address. The
 * address itself is `platform/hash-router.ts`'s.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { type HashRouter, pageHashRouter } from '../../platform/hash-router'

export type Route =
  | { name: 'home' }
  | { name: 'chat'; bot: string; session?: string }
  | { name: 'conversations'; bot: string }
  | { name: 'settings'; section?: string }

export const HOME: Route = { name: 'home' }

/** The fragment of the home route. */
export const HOME_HASH = '#/'

/** The longest segment a route carries; a longer one is not a name of ours. */
const MAX_SEGMENT = 256

/** A settings section: a lower-case word, with dashes. */
const SECTION = /^[a-z][a-z0-9-]*$/u

/** One path segment, decoded; `null` when it is empty, over-long or not valid percent-encoding. */
function segment(raw: string | undefined): string | null {
  if (!raw || raw.length > MAX_SEGMENT * 3) {
    return null
  }

  try {
    const value = decodeURIComponent(raw)

    return value.length > 0 && value.length <= MAX_SEGMENT ? value : null
  } catch {
    return null
  }
}

/** The route a fragment names, or `null` when it names none of ours. */
export function parseRoute(hash: string): Route | null {
  if (hash === '' || hash === '#' || hash === '#/') {
    return HOME
  }

  if (!hash.startsWith('#/')) {
    return null
  }

  // One trailing slash is not a different place.
  const path = hash.length > 2 && hash.endsWith('/') ? hash.slice(1, -1) : hash.slice(1)
  const parts = path.split('/')

  // parts[0] is the empty string before the leading slash.
  switch (parts[1]) {
    case 'chat': {
      const bot = segment(parts[2])

      if (bot === null) {
        return null
      }

      if (parts.length === 3) {
        return { name: 'chat', bot }
      }

      if (parts.length === 4 && parts[3] === 'conversations') {
        return { name: 'conversations', bot }
      }

      const session = segment(parts[4])

      return parts.length === 5 && parts[3] === 's' && session !== null ? { name: 'chat', bot, session } : null
    }

    case 'settings': {
      if (parts.length === 2) {
        return { name: 'settings' }
      }

      const section = parts[2]

      return parts.length === 3 && section !== undefined && SECTION.test(section) ? { name: 'settings', section } : null
    }

    default:
      return null
  }
}

/** The fragment of a route. `parseRoute(formatRoute(route))` is `route`. */
export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home':
      return HOME_HASH
    case 'chat':
      return route.session === undefined
        ? `#/chat/${encodeURIComponent(route.bot)}`
        : `#/chat/${encodeURIComponent(route.bot)}/s/${encodeURIComponent(route.session)}`
    case 'conversations':
      return `#/chat/${encodeURIComponent(route.bot)}/conversations`
    case 'settings':
      return route.section === undefined ? '#/settings' : `#/settings/${route.section}`
  }
}

/** The fragment of a bot's chat, for a link. */
export const chatHref = (bot: string): string => formatRoute({ name: 'chat', bot })

/** The fragment of one of a bot's conversations that is not its chat (the read-only viewer). */
export const conversationHref = (bot: string, session: string): string => formatRoute({ name: 'chat', bot, session })

/** The fragment of the list of a bot's conversations. */
export const conversationsHref = (bot: string): string => formatRoute({ name: 'conversations', bot })

/**
 * The route the address names. An unknown one reads as home at once and is
 * rewritten to `#/` right after, so nothing is ever drawn for a route that does
 * not exist.
 */
export function useRoute(router: HashRouter = pageHashRouter): Route {
  const subscribe = useCallback((onChange: () => void) => router.subscribe(() => onChange()), [router])
  const hash = useSyncExternalStore(subscribe, router.current, () => '')
  const route = useMemo(() => parseRoute(hash), [hash])
  const unknown = route === null

  useEffect(() => {
    if (unknown) {
      router.replace(HOME_HASH)
    }
  }, [unknown, router])

  return route ?? HOME
}
