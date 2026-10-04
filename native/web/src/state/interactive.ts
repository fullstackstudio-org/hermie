/**
 * The interactive requests a bot is waiting on (`input.form`, `input.file`,
 * `review.draft`), and the notices a chat shows about one that ended without the
 * reader's answer or that this page declined.
 *
 * **What was asked, never what is answered.** Nothing in this store, or anywhere
 * else the page keeps state, ever holds a value a person typed into one of these
 * sheets: the sheet reads its own fields when Send is pressed and hands the answer
 * straight to `InteractiveModel.answer`, which puts it into the `request.answer`
 * call and forgets it (`core/requests/interactive.ts`). What is held here is the
 * request's own words, read and cleaned by `interactive-types.ts`.
 *
 * Written by the interactive model and nothing else; read by the request queue
 * (`state/requests.ts`), the request layer and the chat screen (the notice). The
 * kinds of notice are the secure input model's, plus the one for a request this page
 * said it cannot show.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { InteractiveAsk, InteractiveMethod } from '../core/requests/interactive-types'

/** One open request, on a chat the page holds. */
export interface InteractiveRequest {
  /** The server request's id (`srq-...`). */
  id: string
  method: InteractiveMethod
  /**
   * Moves on every change a sheet would draw differently: it opened again after an answer was lost, moved to another
   * chat, or the gateway refused an answer. The queue entry carries it.
   */
  version: number
  /** What it asks, as the contract describes it, every text cleaned. */
  ask: InteractiveAsk
  /** The chat it belongs to: the key of the chat whose runtime session asked. */
  bot: string
  /** The runtime session the request names. */
  sessionId: string
  /**
   * When the gateway stops waiting, in epoch milliseconds, from the request's own `expires_at`; the sheet hides at
   * that time (the model ends the request on the page's clock too).
   */
  deadline: number
  /**
   * The gateway asks again because an answer (`'answer'`) or a Skip (`'skip'`) sent from here never reached it: the
   * sheet says so. `null` for anything else.
   */
  earlierLost: 'answer' | 'skip' | null
  /**
   * Why the gateway refused the last answer (`4034 data.reason`, cleaned: `field:<id>:<problem>`, `files:too_many`, ...),
   * for the sheet to show beside the input. The request stays open. `null` until one was refused, and again after the
   * next answer is taken for a try.
   */
  refusal: string | null
  /** The order requests were first seen in, across chats. */
  seq: number
}

/** Why a chat shows a line about a request. */
export type InteractiveNoticeKind =
  /** The deadline passed (the gateway's `request.cancel timeout`, or this page's clock): nothing was sent. */
  | { kind: 'expired' }
  /** The bot stopped asking (`request.cancel`, too many refused answers, or the chat let go of the session). */
  | { kind: 'withdrawn' }
  /** Another device answered it (`request.cancel {reason: resolved}` while no answer from here was on its way). */
  | { kind: 'answered_elsewhere' }
  /** It ended while the connection was down (a reconnect's `open_requests` no longer lists it): nothing was sent. */
  | { kind: 'lapsed' }
  /**
   * An answer went out from here and the request ended without the gateway saying it took that answer: the two
   * crossed, or the call failed without the gateway's word before it ended. It may not have arrived.
   */
  | { kind: 'may_not_have_arrived' }
  /** This page declined it (`4041`): `reason` is the machine reason the gateway was told, `method` the request's. */
  | { kind: 'cannot_show'; method: string; reason: string }

export interface InteractiveNotice {
  /** A serial: the same notice twice is shown twice. */
  id: number
  /** The request it is about. */
  requestId: string
  notice: InteractiveNoticeKind
}

export interface InteractiveState {
  /** The gateway as a person knows it (its host), for the sheet's chrome. */
  gateway: string
  /** Every open request on a chat the page holds, oldest first. */
  requests: readonly InteractiveRequest[]
  /** The last notice per chat key. */
  notices: Readonly<Record<string, InteractiveNotice>>
  reset(): void
}

const INITIAL = {
  gateway: '',
  requests: [] as readonly InteractiveRequest[],
  notices: {} as Readonly<Record<string, InteractiveNotice>>
}

export function createInteractiveStore(): StoreApi<InteractiveState> {
  return createStore<InteractiveState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const interactiveStore: StoreApi<InteractiveState> = createInteractiveStore()
