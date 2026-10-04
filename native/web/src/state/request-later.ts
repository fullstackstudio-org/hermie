/**
 * The interactive requests whose sheet the person put away (Later) without answering: they still wait on the
 * gateway, the page is usable meanwhile, and the transcript's record of each offers Open to bring the sheet back.
 *
 * Only which requests, never what was typed: the sheet keeps its fields in its own component state, which the request
 * layer keeps alive while the sheet is away (`RequestLayer.tsx`). Keyed by the request's queue key
 * (`interactiveKey`, `state/requests.ts`), which is stable for as long as the request is open. Kept in memory only:
 * a reload asks again.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

export interface RequestLaterState {
  /** The queue keys of the requests put away, in the order they were. */
  away: readonly string[]
  /** Put a request's sheet away. */
  putAway(key: string): void
  /** Bring it back. */
  bringBack(key: string): void
  /** Forget every key that is not in `live` (the request ended). */
  prune(live: readonly string[]): void
  reset(): void
}

export function createRequestLaterStore(): StoreApi<RequestLaterState> {
  return createStore<RequestLaterState>(set => ({
    away: [],
    putAway: key => set(state => (state.away.includes(key) ? state : { away: [...state.away, key] })),
    bringBack: key =>
      set(state => (state.away.includes(key) ? { away: state.away.filter(entry => entry !== key) } : state)),
    prune: live =>
      set(state => {
        const kept = state.away.filter(key => live.includes(key))

        return kept.length === state.away.length ? state : { away: kept }
      }),
    reset: () => set({ away: [] })
  }))
}

/** The page's store. */
export const requestLaterStore: StoreApi<RequestLaterState> = createRequestLaterStore()
