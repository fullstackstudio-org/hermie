/**
 * A chat opened from a search hit, scrolled to the row the words are in.
 *
 * The gateway names the conversation and never the message (see
 * `@hermie/gateway-client`'s `session-search.ts`), so the row is found again
 * here from the words the reader typed (`find-in-chat.ts`), in three cases:
 *
 *  - **found**: the list scrolls to it, a little below the top, holds the
 *    reader there and marks it; a polite status says so;
 *  - **not found yet, and the chat is still arriving**: a miss against a
 *    half-loaded transcript is not a miss, so nothing happens until it is live;
 *  - **not found, and the chat is live**: older history is loaded, the list
 *    goes to its oldest row (where the page lands, as when the reader scrolls up
 *    for it) and the rows are looked at again once the page has come in. That is
 *    a loop without being written as one, and it walks back a page at a time.
 *
 * The walk is BOUNDED, and the bound is not timidity. The gateway's index is
 * built over the JSON-encoded message and this searches the projected item, so a
 * hit on a tool's arguments can never be found here however far back it reads;
 * an unbounded walk on that query would page to the start of a thousand-turn
 * conversation and then apologise anyway. "Not in the visible text of this chat"
 * is the sentence for both ways of stopping, because they are the same fact to
 * the reader. Scrolling to the bottom with no explanation is how a working
 * search reads as a broken one.
 *
 * Ported from the Expo app's `ChatScreen` find effect (`findText`), with the same
 * page limit. A difference: the request is a `FindRequest` (`find-request.ts`)
 * with an id, settled once it has been dealt with, rather than a navigation
 * parameter remembered by its text.
 */
import type { VisibleItem } from '@hermie/transcript'
import { type RefObject, useEffect, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { webStrings } from '../../i18n/web-strings'
import type { TranscriptListHandle } from '../chat/TranscriptList'
import { findMatchingItem } from './find-in-chat'
import { type FindRequest, findRequests, type FindRequests } from './find-request'

/** How many pages of older history a search may walk back through before it says the words are not there. */
export const FIND_PAGE_LIMIT = 200

export interface UseFindInChatOptions {
  /** The request for this chat, or `null`. */
  request: FindRequest | null
  /** The rows on screen, oldest first. */
  rows: readonly VisibleItem[]
  /** The chat is loaded (`live` or `stale`): a miss now is a miss. */
  loaded: boolean
  list: RefObject<TranscriptListHandle | null>
  /** One more page of older history. */
  loadOlder: () => Promise<'grew' | 'start' | 'unavailable'>
  requests?: FindRequests
}

export interface FindInChat {
  /** What to say about the last request, for a polite status line; empty when there is nothing to say. */
  status: string
  /** The words were not found: say so where it can be read, not only announced. */
  missed: boolean
}

export function useFindInChat({
  request,
  rows,
  loaded,
  list,
  loadOlder,
  requests = findRequests
}: UseFindInChatOptions): FindInChat {
  const [outcome, setOutcome] = useState<{ id: number; status: string; missed: boolean } | null>(null)
  const walked = useRef<{ id: number; pages: number }>({ id: 0, pages: 0 })
  const loading = useRef(false)
  // Moves when a page came in while the walk was waiting for it, so those rows are looked at too.
  const [pagesLoaded, setPagesLoaded] = useState(0)
  // The rows of the last render, for the answer of a load that resolves after they changed.
  const latestRows = useRef(rows)

  latestRows.current = rows

  useEffect(() => {
    if (!request || loading.current) {
      return
    }

    const settle = (missed: boolean): void => {
      setOutcome({
        id: request.id,
        status: missed
          ? strings.app.chat.findExhausted({ query: request.query })
          : webStrings.search.found({ query: request.query }),
        missed
      })
      requests.settle(request.id)
    }

    const found = findMatchingItem(rows, request.query)

    if (found) {
      if (list.current?.revealRow(found)) {
        settle(false)
      }

      return
    }

    // Still arriving: a miss against a half-loaded transcript is not a miss.
    if (!loaded) {
      return
    }

    const pages = walked.current.id === request.id ? walked.current.pages : 0

    if (pages >= FIND_PAGE_LIMIT) {
      settle(true)

      return
    }

    walked.current = { id: request.id, pages: pages + 1 }
    loading.current = true

    const before = rows
    const page = loadOlder()

    /*
      Then to the oldest row held, so the page lands beside what is drawn, as it
      does when the reader scrolls up for it. A page put in far above a reader
      at the bottom lands among chunks the browser has not laid out yet, and
      WebKit reports the sizes it then settles on as a resize loop. After the
      load has started, so the list's own "older history" call that the top
      makes joins this one rather than answering for it.
    */
    list.current?.showOldest()

    void page
      .catch(() => 'unavailable' as const)
      .then(result => {
        loading.current = false

        if (result !== 'grew') {
          settle(true)
        } else if (latestRows.current !== before) {
          // The page was drawn while this waited, and that render found the walk busy: look now.
          setPagesLoaded(count => count + 1)
        }
        // Otherwise the page is drawn after this, and that render looks again.
      })
  }, [list, loadOlder, loaded, pagesLoaded, request, requests, rows])

  return { status: outcome?.status ?? '', missed: outcome?.missed ?? false }
}
