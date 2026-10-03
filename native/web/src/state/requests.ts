/**
 * The questions a bot is waiting on, across every chat: what the request layer
 * (`features/requests`) draws one at a time.
 *
 * It holds no request of its own. An approval or a clarify reaches the engine as
 * an item of its chat (`@hermie/transcript`: a request raised on the socket, one
 * the gateway re-delivers from `open_requests` when a session is resumed, or the
 * pending approval a resume reports), and it is withdrawn the same way
 * (`request.cancel` turns the item's `state` to `cancelled`). This store is a
 * view over the chat store: the items that are still `open`, oldest first, with
 * the bot each belongs to. So there is one source of truth, a resume that
 * restores a request restores it here without any code of its own, and an answer
 * (`ChatController.respondApproval`, `respondClarify`, which mark the item
 * `answered` first) takes the request off this list in the same breath.
 *
 * **Oldest first** is the order they were first seen here, not the order of the
 * rows in their chats: a question raised in one chat while another is on screen
 * has no row order to the first. Requests that arrive in one commit (a resume
 * that restores two) are ordered by the time the gateway stamped on them.
 *
 * **Not tied to the open chat.** Every chat the controller holds counts, the
 * one on screen or not, because the bot that is asking may be one the reader is
 * not looking at; the layer names it.
 *
 * Request kinds the engine does not know (a secret, a sudo password, a vault
 * prompt, a confirm: W-14, W-15) are handled beside the engine and will join
 * this queue as entries of their own kind; the type is a union for that reason.
 *
 * A vanilla zustand store (`requestsStore`, `createRequestsStore` for tests),
 * fed by `bindRequests` once the chats exist (`features/shell/session.ts`).
 */
import type { ApprovalItem, ChatState, ClarifyItem } from '@hermie/transcript'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { ChatsState } from './chats'

/** The two kinds the transcript engine holds. */
export type EngineRequestItem = ApprovalItem | ClarifyItem

/** One open question and where to answer it. */
export interface EngineRequest {
  kind: 'engine'
  /** Unique across chats: the bot and the transport's request id. */
  key: string
  /** The chat's key in the chat store: the bot's name, which the controller answers under. */
  bot: string
  item: EngineRequestItem
}

/** Everything the layer can draw. W-14 adds the kinds that live beside the engine. */
export type OpenRequest = EngineRequest

export interface RequestsState {
  /** Oldest first. The layer draws the first and says how many wait behind it. */
  queue: readonly OpenRequest[]
  setQueue: (queue: readonly OpenRequest[]) => void
  reset: () => void
}

const EMPTY: readonly OpenRequest[] = []

export function createRequestsStore(): StoreApi<RequestsState> {
  return createStore<RequestsState>(set => ({
    queue: EMPTY,
    setQueue: queue => set({ queue }),
    reset: () => set({ queue: EMPTY })
  }))
}

/** The page's store. */
export const requestsStore: StoreApi<RequestsState> = createRequestsStore()

/** The key of a request: unique across chats, stable for as long as it is open. */
export const requestKey = (bot: string, requestId: string): string => `${bot}\u0000${requestId}`

const isOpenRequest = (item: unknown): item is EngineRequestItem => {
  const candidate = item as { kind?: string; state?: string } | undefined

  return (candidate?.kind === 'approval' || candidate?.kind === 'clarify') && candidate.state === 'open'
}

/** The open requests of one chat. A chat with no runtime session has nothing to answer on. */
function openIn(chat: ChatState): EngineRequestItem[] {
  if (chat.runtimeSessionId === undefined) {
    return []
  }

  // The request index is small (only requests are in it), where the rows can be thousands.
  const ids = new Set<string>([...Object.values(chat.byRequestId), ...Object.values(chat.byApprovalId)])
  const found: EngineRequestItem[] = []

  for (const id of ids) {
    const item = chat.items[id]

    if (isOpenRequest(item)) {
      found.push(item)
    }
  }

  return found
}

const sameQueue = (a: readonly OpenRequest[], b: readonly OpenRequest[]): boolean =>
  a.length === b.length &&
  a.every((entry, index) => entry.key === b[index]?.key && entry.item.version === b[index]?.item.version)

/**
 * Keep `store` equal to the open requests of `chats`, now and on every commit.
 * Returns the unsubscribe, which also empties the queue.
 */
export function bindRequests(
  chats: Pick<StoreApi<ChatsState>, 'getState' | 'subscribe'>,
  store: StoreApi<RequestsState> = requestsStore
): () => void {
  /** When each open request was first seen: its place in the queue. */
  const seen = new Map<string, number>()
  let counter = 0
  let lastChats: ChatsState['chats'] | undefined

  const collect = (): void => {
    const current = chats.getState().chats

    if (current === lastChats) {
      return
    }

    lastChats = current

    const open: EngineRequest[] = []

    for (const [bot, chat] of Object.entries(current)) {
      for (const item of openIn(chat)) {
        open.push({ kind: 'engine', key: requestKey(bot, item.requestId), bot, item })
      }
    }

    // Newly seen ones take the next places, by the gateway's own stamp, then by their row.
    const fresh = open
      .filter(entry => !seen.has(entry.key))
      .sort((a, b) => (a.item.ts ?? 0) - (b.item.ts ?? 0) || a.item.seq - b.item.seq)

    for (const entry of fresh) {
      counter += 1
      seen.set(entry.key, counter)
    }

    const live = new Set(open.map(entry => entry.key))

    for (const key of seen.keys()) {
      if (!live.has(key)) {
        seen.delete(key)
      }
    }

    open.sort((a, b) => (seen.get(a.key) ?? 0) - (seen.get(b.key) ?? 0))

    if (!sameQueue(store.getState().queue, open)) {
      store.getState().setQueue(open)
    }
  }

  collect()

  const unsubscribe = chats.subscribe(collect)

  return () => {
    unsubscribe()
    seen.clear()
    store.getState().reset()
  }
}
