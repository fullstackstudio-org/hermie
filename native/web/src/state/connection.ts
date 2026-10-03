/**
 * Connection state as a store rather than as component state, so a deeply
 * nested row can subscribe to `status` without everything else re-rendering on
 * an unrelated change. The `GatewayConnection` itself stays out of here: it is
 * a mutable long-lived object, not state.
 *
 * Ported from the Expo app's `src/gateway/store.ts` (`useConnectionStore`).
 * Deliberate differences:
 *
 *  - A vanilla zustand store (`connectionStore`, and `createConnectionStore`
 *    for tests) instead of a hook: `state/` is React-free.
 *  - No `config` and no `frontDoor`. A page has exactly one gateway, its own
 *    origin, which `boot/base-path.ts` derives on every load; there is no
 *    stored configuration to show. A browser cannot add headers to a socket
 *    upgrade, and the page shares its origin with the gateway, so there is no
 *    header-based front door to describe either.
 *  - The auth timeline is memory only. The Expo app persisted it per gateway so
 *    it survived a relaunch; a page that reloads signs in again through the
 *    gateway's own `/login`, and the ring is developer material that has no
 *    business in `localStorage` (plan W5: nothing auth-shaped is stored).
 */
import type { AuthTimelineSnapshot, ConnectionStatus, GatewayError } from '@hermie/gateway-client'
import { createStore, type StoreApi } from 'zustand/vanilla'

import { pushRpcFailure, type RpcFailure } from '../core/rpc-failures'

export interface ConnectionStoreState {
  status: ConnectionStatus
  /** The most recent failure, kept while reconnecting so a banner can explain it. */
  lastError: GatewayError | null
  /**
   * The auth ring as the timeline last published it: the developer screen reads
   * the events, the signed-out card reads the reason.
   */
  authTimeline: AuthTimelineSnapshot
  /**
   * Gateway calls whose failure a screen decided to absorb, oldest first.
   *
   * Separate from `authTimeline` on purpose: that ring's whole design is a
   * closed set of names with no message text, so it can be pasted into an issue
   * without a judgement call. This one carries the gateway's words, which is the
   * only thing that makes a protocol mismatch readable.
   */
  rpcFailures: RpcFailure[]
  setStatus: (status: ConnectionStatus, error: GatewayError | null) => void
  setAuthTimeline: (snapshot: AuthTimelineSnapshot) => void
  noteRpcFailure: (failure: RpcFailure) => void
  reset: () => void
}

/**
 * What a teardown puts back.
 *
 * `authTimeline` is deliberately absent: `reset()` runs on sign-out, which is the
 * one moment the ring is worth the most, and `set` merges rather than replaces.
 */
const INITIAL = {
  status: 'disconnected' as ConnectionStatus,
  lastError: null
}

export function createConnectionStore(): StoreApi<ConnectionStoreState> {
  return createStore<ConnectionStoreState>(set => ({
    ...INITIAL,
    authTimeline: { events: [], lastSignOut: null },
    rpcFailures: [],
    setStatus: (status, error) => set({ status, lastError: error }),
    setAuthTimeline: authTimeline => set({ authTimeline }),
    noteRpcFailure: failure => set(state => ({ rpcFailures: pushRpcFailure(state.rpcFailures, failure) })),
    reset: () => set(INITIAL)
  }))
}

/** The page's store. */
export const connectionStore: StoreApi<ConnectionStoreState> = createConnectionStore()
