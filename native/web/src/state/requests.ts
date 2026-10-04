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
 * Request kinds the engine does not know are handled beside the engine and join
 * this queue as entries of their own kind. A `confirm` at level `passkey` is the
 * first (`ConfirmRequest`): the passkey model holds it (`state/passkeys.ts`), and
 * it is on the queue while the model shows it (open, or finished and not closed
 * yet). A secret, a sudo password and a vault prompt are the second
 * (`SecureRequest`): the secure input model holds them (`state/secure-input.ts`,
 * which never holds an answer), and they are on the queue while they are open on
 * a chat the page holds. A form, a file request and a draft to review are the
 * third (`InteractiveRequestEntry`): the interactive model holds them
 * (`state/interactive.ts`, which never holds an answer) and they are on the queue
 * while they are open on a chat the page holds. A connector authorisation is the
 * fourth (`ConnectionRequest`): the connections model holds the card
 * (`state/connections.ts`), and it is on the queue while it is open.
 *
 * A vanilla zustand store (`requestsStore`, `createRequestsStore` for tests),
 * fed by `bindRequests` once the chats exist (`features/shell/session.ts`).
 */
import type { ApprovalItem, ChatState, ClarifyItem } from '@hermie/transcript'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { ChatsState } from './chats'
import type { ConnectionsState } from './connections'
import type { InteractiveState } from './interactive'
import { type PasskeysState, visibleConfirmations } from './passkeys'
import type { SecureInputState } from './secure-input'

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

/** A `confirm` at level `passkey`: the passkey model holds it; the layer reads it there by id. */
export interface ConfirmRequest {
  kind: 'confirm'
  /** Unique across chats and kinds. */
  key: string
  /** The bot whose chat it was raised in, when a chat the page holds is on that session. */
  bot: string | undefined
  /** The server request's id (`PasskeyConfirmation.id`). */
  id: string
  /** The confirmation's version: it moves on every change of phase. */
  version: number
}

/**
 * A one-string prompt (`secret`, `sudo`, `vault.*`): the secure input model holds what it asks; the layer
 * reads it there by id. What is typed into its sheet is never held anywhere (`core/requests/secure-input.ts`).
 */
export interface SecureRequest {
  kind: 'secure'
  /** Unique across chats and kinds. */
  key: string
  /** The chat it is on: a prompt is on the queue only once a chat the page holds is on its session. */
  bot: string
  /** The server request's id (`SecurePrompt.id`). */
  id: string
  /** The prompt's method, so the layer picks its sheet without a second read. */
  method: string
}

/**
 * An interactive request (`input.form`, `input.file`, `review.draft`): the interactive model holds what it asks; the
 * layer reads it there by id. What is typed, picked or edited in its sheet is never held anywhere
 * (`core/requests/interactive.ts`).
 */
export interface InteractiveRequestEntry {
  kind: 'interactive'
  /** Unique across chats and kinds. */
  key: string
  /** The chat it is on: a request is on the queue only once a chat the page holds is on its session. */
  bot: string
  /** The server request's id (`InteractiveRequest.id`). */
  id: string
  /** The request's method, so the layer picks its sheet without a second read. */
  method: string
  /** The request's version: it moves on every change a sheet would draw differently. */
  version: number
}

/** A connector authorisation a bot waits on: the connections model holds the card; the layer reads it there by chat. */
export interface ConnectionRequest {
  kind: 'connection'
  /** Unique across chats and kinds. */
  key: string
  /** The chat whose agent waits on it. */
  bot: string
  /** The operation's id (`ConnectionCard.opId`). */
  opId: string
  /** The card's version: it moves on every change. */
  version: number
}

/** Everything the layer can draw. */
export type OpenRequest = EngineRequest | ConfirmRequest | SecureRequest | InteractiveRequestEntry | ConnectionRequest

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

const versionOf = (entry: OpenRequest | undefined): number | undefined =>
  entry === undefined
    ? undefined
    : entry.kind === 'engine'
      ? entry.item.version
      : entry.kind === 'confirm' || entry.kind === 'connection' || entry.kind === 'interactive'
        ? entry.version
        : 0

const sameQueue = (a: readonly OpenRequest[], b: readonly OpenRequest[]): boolean =>
  a.length === b.length &&
  a.every(
    (entry, index) =>
      entry.key === b[index]?.key && versionOf(entry) === versionOf(b[index]) && entry.bot === b[index]?.bot
  )

/** The key of a confirm entry. */
export const confirmKey = (requestId: string): string => `confirm\u0000${requestId}`

/** The key of a secure prompt's entry. */
export const secureKey = (requestId: string): string => `secure\u0000${requestId}`

/** The key of an interactive request's entry. */
export const interactiveKey = (requestId: string): string => `interactive\u0000${requestId}`

/** The key of a connection card's entry. */
export const connectionKey = (chat: string, opId: string): string => `connection\u0000${chat}\u0000${opId}`

/**
 * Keep `store` equal to the open requests of `chats` (and the confirmations
 * `passkeys` shows, the prompts `secureInput` holds and the requests `interactive` holds), now and on every commit.
 * Returns the unsubscribe, which also empties the queue.
 */
export function bindRequests(
  chats: Pick<StoreApi<ChatsState>, 'getState' | 'subscribe'>,
  store: StoreApi<RequestsState> = requestsStore,
  passkeys?: Pick<StoreApi<PasskeysState>, 'getState' | 'subscribe'>,
  secureInput?: Pick<StoreApi<SecureInputState>, 'getState' | 'subscribe'>,
  connections?: Pick<StoreApi<ConnectionsState>, 'getState' | 'subscribe'>,
  interactive?: Pick<StoreApi<InteractiveState>, 'getState' | 'subscribe'>
): () => void {
  /** When each open request was first seen: its place in the queue. */
  const seen = new Map<string, number>()
  let counter = 0
  let lastChats: ChatsState['chats'] | undefined
  let lastRuntime: ChatsState['runtimeToBot'] | undefined
  let lastConfirmations: PasskeysState['confirmations'] | undefined
  let lastPrompts: SecureInputState['prompts'] | undefined
  let lastCards: ConnectionsState['cards'] | undefined
  let lastInteractive: InteractiveState['requests'] | undefined

  const collect = (): void => {
    const state = chats.getState()
    const current = state.chats
    const confirmations = passkeys?.getState().confirmations
    const prompts = secureInput?.getState().prompts
    const cards = connections?.getState().cards
    const asked = interactive?.getState().requests

    if (
      current === lastChats &&
      confirmations === lastConfirmations &&
      prompts === lastPrompts &&
      cards === lastCards &&
      asked === lastInteractive &&
      state.runtimeToBot === lastRuntime
    ) {
      return
    }

    lastChats = current
    lastRuntime = state.runtimeToBot
    lastConfirmations = confirmations
    lastPrompts = prompts
    lastCards = cards
    lastInteractive = asked

    const engine: EngineRequest[] = []

    for (const [bot, chat] of Object.entries(current)) {
      for (const item of openIn(chat)) {
        engine.push({ kind: 'engine', key: requestKey(bot, item.requestId), bot, item })
      }
    }

    const confirms: ConfirmRequest[] = passkeys
      ? visibleConfirmations(passkeys.getState()).map(confirmation => ({
          kind: 'confirm',
          key: confirmKey(confirmation.id),
          bot: state.runtimeToBot[confirmation.sessionId],
          id: confirmation.id,
          version: confirmation.version
        }))
      : []

    const secure: SecureRequest[] = [...(prompts ?? [])]
      .sort((a, b) => a.seq - b.seq)
      .map(prompt => ({
        kind: 'secure',
        key: secureKey(prompt.id),
        bot: prompt.bot,
        id: prompt.id,
        method: prompt.method
      }))

    const interactiveEntries: InteractiveRequestEntry[] = [...(asked ?? [])]
      .sort((a, b) => a.seq - b.seq)
      .map(request => ({
        kind: 'interactive',
        key: interactiveKey(request.id),
        bot: request.bot,
        id: request.id,
        method: request.method,
        version: request.version
      }))

    const connecting: ConnectionRequest[] = Object.values(cards ?? {})
      .sort((a, b) => a.seq0 - b.seq0)
      .map(card => ({
        kind: 'connection',
        key: connectionKey(card.chat, card.opId),
        bot: card.chat,
        opId: card.opId,
        version: card.version
      }))

    // Newly seen ones take the next places: an engine request by the gateway's own stamp, then by its
    // row; a confirmation in the order the passkey model received them, after those; a prompt in the order
    // the secure input model placed them, after those.
    const fresh: OpenRequest[] = [
      ...engine
        .filter(entry => !seen.has(entry.key))
        .sort((a, b) => (a.item.ts ?? 0) - (b.item.ts ?? 0) || a.item.seq - b.item.seq),
      ...confirms.filter(entry => !seen.has(entry.key)),
      ...secure.filter(entry => !seen.has(entry.key)),
      ...interactiveEntries.filter(entry => !seen.has(entry.key)),
      ...connecting.filter(entry => !seen.has(entry.key))
    ]
    const open: OpenRequest[] = [...engine, ...confirms, ...secure, ...interactiveEntries, ...connecting]

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
  const unsubscribePasskeys = passkeys?.subscribe(collect)
  const unsubscribeSecure = secureInput?.subscribe(collect)
  const unsubscribeInteractive = interactive?.subscribe(collect)
  const unsubscribeConnections = connections?.subscribe(collect)

  return () => {
    unsubscribe()
    unsubscribePasskeys?.()
    unsubscribeSecure?.()
    unsubscribeInteractive?.()
    unsubscribeConnections?.()
    seen.clear()
    store.getState().reset()
  }
}
