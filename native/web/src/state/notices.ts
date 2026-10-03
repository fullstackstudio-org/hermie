/**
 * The gateway's out-of-band notices (`notification.show` / `notification.clear`):
 * a credits line, "still starting the agent", and the like. Not part of any
 * transcript, and never a request: a notice asks nothing, so it is drawn as a
 * dismissible line over the page (`features/notices/GatewayNotices.tsx`).
 *
 * Written by the notices model (`core/notices.ts`) and nothing else. The text
 * held here is the gateway's, cleaned and bounded for display: it is relayed from
 * the agent, so it is shown as plain text, never as Markdown or a link.
 *
 * The native apps' `GatewayNoticesModel.notices`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

/** `notification.show`'s `level`; anything else the gateway sends is read as `info`. */
export type NoticeLevel = 'info' | 'warn' | 'error' | 'success'

/** One notice, as the page shows it. */
export interface GatewayNotice {
  /** The notice's `key` (else its `id`): a second notice with the same one replaces it, a clear names it. */
  id: string
  /** Plain text, cleaned and bounded (`core/notices.ts`, `noticeText`). */
  text: string
  level: NoticeLevel
  /** The chat whose session carried it, when one the page holds is on that session. */
  chat: string | undefined
  /** Bumped on every show, so the same notice shown again is announced again. */
  serial: number
}

export interface NoticesState {
  /** Oldest first, at most `MAX_NOTICES`. */
  notices: readonly GatewayNotice[]
  reset(): void
}

const EMPTY: readonly GatewayNotice[] = []

export function createNoticesStore(): StoreApi<NoticesState> {
  return createStore<NoticesState>(set => ({
    notices: EMPTY,
    reset: () => set({ notices: EMPTY })
  }))
}

/** The page's store. */
export const noticesStore: StoreApi<NoticesState> = createNoticesStore()
