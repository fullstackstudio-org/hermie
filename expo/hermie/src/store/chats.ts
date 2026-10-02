/**
 * Every open Bot Chat, keyed by bot name.
 *
 * The store is a thin, synchronous shell around `@hermie/transcript`: each
 * action is one reducer call and one `set`. Nothing here talks to the gateway —
 * that is the chat controller's job — which keeps the whole state machine
 * drivable from a test with three literal events.
 *
 * Two indices matter beyond the chats themselves:
 *
 * - `runtimeToBot` maps the gateway's runtime `session_id` onto a bot name.
 *   Events and server→client requests are addressed by runtime id, and that id
 *   changes every time the gateway rebuilds the session, so routing has to go
 *   through a map rather than through anything persisted.
 * - `live` marks the chats that have been opened at least once. They stay
 *   subscribed after the user leaves the screen, because a teammate bot writing
 *   into a chat nobody is looking at is exactly the traffic this app exists to
 *   show.
 */
import {
  applyEvent,
  applyResumeSnapshot,
  applyServerRequest,
  answerRequest,
  beginLocalTurn,
  beginSteer,
  type ChatState,
  confirmSubmit,
  createChatState,
  dropSteer,
  markInterrupted,
  type MessageAuthor,
  type ResumeSnapshot,
  prependHistory,
  reconcile,
  reconcileTail,
  type ServerRequest,
  type SubmitResult,
  type TranscriptEvent,
  type TranscriptItem
} from '@hermie/transcript'
import { create } from 'zustand'

export interface ChatIds {
  storedSessionId: string
  resolvedSessionId: string
}

/**
 * One message the reader sent while a turn was already running.
 *
 * It is held HERE rather than on the gateway, and that is the whole reason this
 * slice exists. `prompt.submit` will park a prompt for you — it answers
 * `queued` — but the gateway's queue is one opaque prompt with no way to read
 * it back, change it or take it out again, and the three things the reader
 * wants to do with a parked message are exactly Steer, Edit and Delete. So the
 * queue is ours until the turn ends, and only then does the message become a
 * `prompt.submit` like any other.
 *
 * The bytes of an attachment are NOT here. The controller keeps those, because
 * it is the only thing that will ever send them; this is what the transcript
 * draws.
 */
export interface QueuedMessage {
  /** Stable for the row's key and for the three actions. */
  id: string
  text: string
  /** Names only, for the bubble — the same references a sent message shows. */
  attachments?: string[]
}

export interface ChatsState {
  chats: Record<string, ChatState>
  /** Messages parked behind a running turn, oldest first, per bot. */
  queues: Record<string, QueuedMessage[]>
  /** Runtime `session_id` → bot name. */
  runtimeToBot: Record<string, string>
  /** Bots whose chat is attached and streaming; they survive leaving the screen. */
  live: Record<string, true>

  /** Create the chat if it does not exist yet, or refresh its durable ids. */
  ensure: (botName: string, ids: ChatIds) => void
  /** Replace a chat wholesale — a cache paint or a full re-hydration. */
  hydrate: (botName: string, state: ChatState) => void
  /** Run one reducer over a chat. A missing chat is a no-op, never a crash. */
  update: (botName: string, reducerFn: (state: ChatState) => ChatState) => void

  dispatchEvent: (botName: string, event: TranscriptEvent) => void
  dispatchServerRequest: (botName: string, request: ServerRequest) => void
  answer: (botName: string, requestId: string, answer: string | Record<string, string>) => void

  applySnapshot: (botName: string, snapshot: ResumeSnapshot) => void
  applyHistory: (botName: string, items: readonly TranscriptItem[]) => void
  /** A page of rows older than everything held, placed at the front. */
  prependHistory: (botName: string, items: readonly TranscriptItem[]) => void
  applyTail: (botName: string, items: readonly TranscriptItem[]) => void

  /**
   * `attachments` are `@file:` / `@image:` references — see `UserItem.attachments`.
   * `author` is the reader's own identity, when the caller has one — see
   * `beginLocalTurn` for why an optimistic bubble carries it at all.
   */
  beginTurn: (botName: string, text: string, attachments?: string[], author?: MessageAuthor) => void
  settleTurn: (botName: string, result: SubmitResult) => void
  /** Paint a steer into the turn already running; it starts no turn of its own. */
  beginSteer: (botName: string, text: string, attachments?: string[]) => void
  /** Take that bubble back: the gateway refused the steer and it is requeued. */
  dropSteer: (botName: string, text: string) => void
  interrupt: (botName: string) => void

  setDraft: (botName: string, draft: string) => void
  setHydration: (botName: string, hydration: ChatState['hydration']) => void

  bindRuntime: (botName: string, runtimeSessionId: string) => void
  /** `session.reclaimed`: the runtime id is gone, the transcript is not. */
  dropRuntime: (botName: string) => void
  botForRuntime: (runtimeSessionId: string) => string | undefined

  /** Park a message behind the running turn. */
  enqueue: (botName: string, entry: QueuedMessage) => void
  /** Take one back out — sent, edited or deleted; the caller knows which. */
  dropQueued: (botName: string, id: string) => void

  markLive: (botName: string) => void
  forget: (botName: string) => void
  reset: () => void
}

const INITIAL = { chats: {}, queues: {}, runtimeToBot: {}, live: {} }

export const useChatsStore = create<ChatsState>((set, get) => {
  /** Apply `reducerFn` to one chat and publish the result if it actually changed. */
  const patch = (botName: string, reducerFn: (state: ChatState) => ChatState): void => {
    const current = get().chats[botName]

    if (!current) {
      return
    }

    const next = reducerFn(current)

    if (next === current) {
      return
    }

    set(state => ({ chats: { ...state.chats, [botName]: next } }))
  }

  return {
    ...INITIAL,

    ensure(botName, ids) {
      const current = get().chats[botName]

      if (!current) {
        set(state => ({
          chats: {
            ...state.chats,
            [botName]: createChatState(botName, ids.storedSessionId, ids.resolvedSessionId)
          }
        }))

        return
      }

      if (current.storedSessionId === ids.storedSessionId && current.resolvedSessionId === ids.resolvedSessionId) {
        return
      }

      set(state => ({
        chats: {
          ...state.chats,
          [botName]: {
            ...current,
            storedSessionId: ids.storedSessionId,
            resolvedSessionId: ids.resolvedSessionId
          }
        }
      }))
    },

    hydrate(botName, state) {
      set(current => ({ chats: { ...current.chats, [botName]: state } }))
    },

    update: patch,

    dispatchEvent(botName, event) {
      patch(botName, state => applyEvent(state, event))
    },

    dispatchServerRequest(botName, request) {
      patch(botName, state => applyServerRequest(state, request))
    },

    answer(botName, requestId, value) {
      patch(botName, state => answerRequest(state, requestId, value))
    },

    applySnapshot(botName, snapshot) {
      patch(botName, state => applyResumeSnapshot(state, snapshot))
    },

    applyHistory(botName, items) {
      patch(botName, state => reconcile(state, items))
    },

    prependHistory(botName, items) {
      patch(botName, state => prependHistory(state, items))
    },

    applyTail(botName, items) {
      patch(botName, state => reconcileTail(state, items))
    },

    beginTurn(botName, text, attachments, author) {
      patch(botName, state => beginLocalTurn(state, text, attachments, undefined, author))
    },

    settleTurn(botName, result) {
      patch(botName, state => confirmSubmit(state, result))
    },

    beginSteer(botName, text, attachments) {
      patch(botName, state => beginSteer(state, text, attachments))
    },

    dropSteer(botName, text) {
      patch(botName, state => dropSteer(state, text))
    },

    interrupt(botName) {
      patch(botName, state => markInterrupted(state))
    },

    setDraft(botName, draft) {
      patch(botName, state => (state.draft === draft ? state : { ...state, draft }))
    },

    setHydration(botName, hydration) {
      patch(botName, state => (state.hydration === hydration ? state : { ...state, hydration }))
    },

    bindRuntime(botName, runtimeSessionId) {
      const chat = get().chats[botName]

      if (!chat) {
        return
      }

      // The gateway numbers events per runtime session and starts each one at
      // 1, so a watermark from the previous session is a number from another
      // counter. Carrying it over makes the reducer's `seq <= lastSeq` guard
      // drop the whole of the new session instead of the replay it is for.
      const sameSession = chat.lastSeqSessionId === runtimeSessionId
      const watermark = sameSession ? {} : { lastSeq: 0, lastSeqSessionId: runtimeSessionId, epoch: undefined }

      set(state => {
        const runtimeToBot = { ...state.runtimeToBot }

        // Drop the previous binding first: the gateway hands out a new runtime
        // id on every rebuild, and a stale entry would keep routing a dead id.
        for (const [id, name] of Object.entries(runtimeToBot)) {
          if (name === botName && id !== runtimeSessionId) {
            delete runtimeToBot[id]
          }
        }

        runtimeToBot[runtimeSessionId] = botName

        return {
          runtimeToBot,
          chats: { ...state.chats, [botName]: { ...chat, runtimeSessionId, ...watermark } }
        }
      })
    },

    dropRuntime(botName) {
      const chat = get().chats[botName]

      set(state => {
        const runtimeToBot = { ...state.runtimeToBot }

        for (const [id, name] of Object.entries(runtimeToBot)) {
          if (name === botName) {
            delete runtimeToBot[id]
          }
        }

        return {
          runtimeToBot,
          ...(chat ? { chats: { ...state.chats, [botName]: { ...chat, runtimeSessionId: undefined } } } : {})
        }
      })
    },

    botForRuntime(runtimeSessionId) {
      return get().runtimeToBot[runtimeSessionId]
    },

    enqueue(botName, entry) {
      set(state => ({ queues: { ...state.queues, [botName]: [...(state.queues[botName] ?? []), entry] } }))
    },

    dropQueued(botName, id) {
      set(state => {
        const queue = state.queues[botName]

        if (!queue?.some(entry => entry.id === id)) {
          return state
        }

        return { queues: { ...state.queues, [botName]: queue.filter(entry => entry.id !== id) } }
      })
    },

    markLive(botName) {
      if (get().live[botName]) {
        return
      }

      set(state => ({ live: { ...state.live, [botName]: true } }))
    },

    forget(botName) {
      set(state => {
        const chats = { ...state.chats }
        const live = { ...state.live }
        const queues = { ...state.queues }
        const runtimeToBot = { ...state.runtimeToBot }

        delete chats[botName]
        delete live[botName]
        delete queues[botName]

        for (const [id, name] of Object.entries(runtimeToBot)) {
          if (name === botName) {
            delete runtimeToBot[id]
          }
        }

        return { chats, live, queues, runtimeToBot }
      })
    },

    reset() {
      set(INITIAL)
    }
  }
})

/** The chats a `sessions.changed` sweep has to reconcile. */
export function liveChatNames(state: ChatsState): string[] {
  return Object.keys(state.live).filter(name => Boolean(state.chats[name]))
}
