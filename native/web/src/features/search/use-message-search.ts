/**
 * The chats field, searching messages as well as names.
 *
 * Names are matched on this device and answer instantly (`ChatList`); messages
 * are a fan-out over the gateway (`message-search.ts`), so they arrive behind a
 * debounce and below the rows they belong under.
 *
 * Three rules, all of them about not lying to the reader while they type:
 *
 *  - a query that has been superseded is ABANDONED, signal and all, so a slow
 *    profile cannot paint its answer over a newer query's;
 *  - `searching` is true only while a search for the CURRENT query is in
 *    flight, so the status line belongs to what is in the field;
 *  - an emptied field clears the results at once rather than after a round
 *    trip, because there is nothing left to be searching for.
 *
 * Ported from the Expo app's `src/features/search/useMessageSearch.ts`.
 * Deliberate differences: the REST client is the page's chat runtime's
 * `sessionSearch` (absent: nothing is searched) rather than `useGateway`, and
 * the results are keyed on the query they answer, so an emptied or changed
 * field reads as "nothing yet" in the same render instead of after an effect.
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'

import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { useChatRuntime } from '../chat/chat-runtime'
import { type MessageMatch, SEARCH_DEBOUNCE_MS, searchBotChats } from './message-search'

export interface MessageSearchState {
  /** The query these results answer; empty while nothing has been searched. */
  query: string
  matches: MessageMatch[]
  searching: boolean
}

const EMPTY: MessageSearchState = { matches: [], query: '', searching: false }

export function useMessageSearch(query: string): MessageSearchState {
  const http = useChatRuntime()?.sessionSearch ?? null
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const bots = useStore(botsStore, state => state.bots)
  const [state, setState] = useState<{ asked: string; result: MessageSearchState }>({ asked: '', result: EMPTY })
  const trimmed = query.trim()
  const active = trimmed !== '' && http !== null && ready && bots.length > 0

  useEffect(() => {
    if (!active || !http) {
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setState({ asked: trimmed, result: { matches: [], query: '', searching: true } })

      void searchBotChats({ bots, http, query: trimmed, signal: controller.signal })
        .then(matches => {
          if (!controller.signal.aborted) {
            setState({ asked: trimmed, result: { matches, query: trimmed, searching: false } })
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            // Every per-bot failure is already swallowed one level down, so
            // reaching here means the fan-out itself failed. An empty section
            // is the honest answer; an error banner over a chats list is not.
            setState({ asked: trimmed, result: { matches: [], query: trimmed, searching: false } })
          }
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, bots, http, trimmed])

  // What the state holds answers another query (or none): nothing has been found for this one yet.
  return active && state.asked === trimmed ? state.result : EMPTY
}
