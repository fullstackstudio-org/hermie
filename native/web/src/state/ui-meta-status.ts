/**
 * Whether this page's settings are reaching the gateway, for a screen to say so.
 *
 * The arrangement, the mutes and the text size follow the person through the
 * gateway's `ui_meta` (`core/ui-meta-bridge.ts`), which is a chunk of its own,
 * loaded once the session has started. This store is what a screen reads to be
 * honest about it, and it lives outside that chunk so it can say so even when
 * the chunk never arrives:
 *
 *  - `starting`: the bridge is loading, or has not finished its first reconcile;
 *  - `synced`: a roster was read and no write has been refused since;
 *  - `local`: the gateway could not be read or refused a write; the device's own
 *    copy is still correct and the next reconcile tries again (`UiMetaMode`);
 *  - `unavailable`: the bridge's chunk failed to load, twice. Nothing reaches the
 *    gateway for the rest of this page's life; a reload is the way back.
 *
 * `settingsSynced` is the one question a "settings not synced" line asks.
 * A vanilla zustand store (`uiMetaStatusStore`, and `createUiMetaStatusStore`
 * for tests); nothing in it is persisted.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

export type UiMetaSyncState = 'starting' | 'synced' | 'local' | 'unavailable'

export interface UiMetaStatusState {
  state: UiMetaSyncState
  set: (state: UiMetaSyncState) => void
  reset: () => void
}

export function createUiMetaStatusStore(): StoreApi<UiMetaStatusState> {
  return createStore<UiMetaStatusState>(set => ({
    state: 'starting',
    set(state) {
      set({ state })
    },
    reset() {
      set({ state: 'starting' })
    }
  }))
}

/** The page's store. */
export const uiMetaStatusStore: StoreApi<UiMetaStatusState> = createUiMetaStatusStore()

/** True only while the settings are known to reach the gateway. */
export const settingsSynced = (state: Pick<UiMetaStatusState, 'state'>): boolean => state.state === 'synced'
