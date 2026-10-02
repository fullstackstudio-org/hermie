/**
 * The chats field, searching messages as well as names.
 *
 * Names are matched on this device and answer instantly; messages are a fan-out
 * over the gateway (see `message-search.ts`), so they arrive behind a debounce
 * and below the rows they belong under.
 *
 * Three rules, all of them about not lying to the reader while they type:
 *
 *  - a query that has been superseded is ABANDONED, signal and all, so a slow
 *    profile cannot paint its answer over a newer query's;
 *  - `loading` is true only while a search for the CURRENT query is in flight,
 *    so the spinner belongs to what is in the field;
 *  - an emptied field clears the results in the same tick rather than after a
 *    round trip, because there is nothing left to be searching for.
 */
import { useEffect, useRef, useState } from 'react'

import { useGateway } from '../../gateway'
import { useBotsStore } from '../../store'
import { type MessageMatch, SEARCH_DEBOUNCE_MS, searchBotChats } from './message-search'

export interface MessageSearchState {
  /** The query these results answer; empty while nothing has been searched. */
  query: string
  matches: MessageMatch[]
  searching: boolean
}

const EMPTY: MessageSearchState = { matches: [], query: '', searching: false }

export function useMessageSearch(query: string): MessageSearchState {
  const { http, status } = useGateway()
  const bots = useBotsStore(state => state.bots)
  const [state, setState] = useState<MessageSearchState>(EMPTY)
  const current = useRef('')

  useEffect(() => {
    const trimmed = query.trim()

    current.current = trimmed

    if (!trimmed || !http || status !== 'ready' || !bots.length) {
      setState(EMPTY)

      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setState(previous => ({ ...previous, searching: true }))

      void searchBotChats({ bots, http, query: trimmed, signal: controller.signal })
        .then(matches => {
          if (!controller.signal.aborted && current.current === trimmed) {
            setState({ matches, query: trimmed, searching: false })
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && current.current === trimmed) {
            // Every per-bot failure is already swallowed one level down, so
            // reaching here means the fan-out itself failed. An empty section
            // is the honest answer; an error banner over a chats list is not.
            setState({ matches: [], query: trimmed, searching: false })
          }
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [bots, http, query, status])

  return state
}
