/**
 * "Ask me about a new conversation with this bot": what the keyboard shortcut hands the Conversations page besides
 * the route (`features/shell/use-shortcuts.ts`).
 *
 * A new conversation puts the group chat away for everybody on the gateway, so the page asks before it does it, and a
 * shortcut does not get to skip the question: it opens the page with the question already open. The address cannot
 * carry that (a route is a place, and an address is shared and bookmarked), so the shortcut writes the request here and
 * the page of that bot takes it, on mount or at once when the page is already open.
 *
 * One request at a time, and taking it is what ends it.
 */
import { useSyncExternalStore } from 'react'

let pending: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    listener()
  }
}

/** Ask the Conversations page of `bot` to open its new-conversation question. */
export function askAboutNewConversation(bot: string): void {
  pending = bot
  notify()
}

/** Whether the page of `bot` was asked, and the end of the request: a second look finds nothing. */
export function takeNewConversationRequest(bot: string): boolean {
  if (pending !== bot) {
    return false
  }

  pending = null
  notify()

  return true
}

/** Whether a request for `bot` is waiting, as a hook. */
export function useNewConversationRequested(bot: string): boolean {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    () => pending === bot,
    () => false
  )
}
