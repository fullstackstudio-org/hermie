/**
 * "Open this chat at the words I searched for": the one thing a search hit
 * hands the chat screen besides the route.
 *
 * The Expo app passes it as a navigation parameter (`findText`). Here the route
 * is the address, and the words are not put in it: the address is shared,
 * bookmarked and carried across a sign-in, and a search query is none of those.
 * So a hit writes the request here as it is followed, and the chat screen of that
 * bot takes it: on mount when the link changed the route, or at once when the
 * chat was already open (a hit for the chat on screen changes no address).
 *
 * One request at a time, and each has an id: a second search for the same words
 * in the same chat is a new request and is looked for again.
 */
import { useCallback, useSyncExternalStore } from 'react'

export interface FindRequest {
  /** The bot whose chat is searched. */
  bot: string
  /** The words, as typed (trimmed). */
  query: string
  /** Different for every request, so the same words asked twice are looked for twice. */
  id: number
}

export interface FindRequests {
  /** Ask the chat of `bot` to show the newest row with these words. */
  request(bot: string, query: string): void
  /** The request waiting, if any. */
  current(): FindRequest | null
  /** The chat dealt with this request (found it, or said it could not). A newer one is left alone. */
  settle(id: number): void
  subscribe(listener: () => void): () => void
}

export function createFindRequests(): FindRequests {
  let current: FindRequest | null = null
  let next = 1
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    request(bot, query) {
      const trimmed = query.trim()

      current = trimmed ? { bot, query: trimmed, id: next++ } : null
      notify()
    },
    current: () => current,
    settle(id) {
      if (current?.id === id) {
        current = null
        notify()
      }
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

/** The page's requests. */
export const findRequests: FindRequests = createFindRequests()

/** The request waiting for this bot's chat, or `null`. */
export function useFindRequest(bot: string, requests: FindRequests = findRequests): FindRequest | null {
  const subscribe = useCallback((onChange: () => void) => requests.subscribe(onChange), [requests])
  const request = useSyncExternalStore(subscribe, requests.current, () => null)

  return request && request.bot === bot ? request : null
}
