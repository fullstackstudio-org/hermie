/**
 * What the connected gateway says is installed next to it.
 *
 * The gateway-side plugin publishes a capability advert under its own
 * `hermie-plugin` `ui_meta` key, which arrives on the same `profiles.list` the
 * roster is read from. This store is where that answer lives for the screens
 * that have to decide what to offer.
 *
 * **Nothing here is persisted.** The advert is a fact about a gateway at a
 * moment, not a preference: a plugin can be disabled between two loads, and a
 * remembered "it was installed last week" would make Settings offer a button
 * that does nothing. It is also emptied when the connection is stopped.
 *
 * **The three states are deliberately distinguishable.** `read` is false until
 * a roster has actually arrived, so "we have not looked yet" is never drawn as
 * "not installed" — which is the difference between a screen that waits and a
 * screen that tells somebody to go and install something they already have.
 *
 * Ported from the Expo app's `src/store/plugin.ts`. Deliberate differences:
 *
 *  - A vanilla zustand store (`pluginStore`, and `createPluginStore` for
 *    tests) instead of the `usePluginStore` hook: `state/` is React-free, and
 *    `features/` subscribes through `useStore`.
 *  - The advert is a `WebPluginAdvert` (`core/advert.ts`): the shared reading
 *    plus the `web` and `webPush` blocks. It is assignable to `PluginAdvert`,
 *    so every package reader still takes it.
 *  - The roster read (`core/gateway-client.ts`) applies it, rather than the
 *    `ui_meta` bridge, which this client does not have yet. Emptied on
 *    `stop`, not on every dropped socket: a page has one gateway, and the advert
 *    a reconnect finds is that gateway's again.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebPluginAdvert } from '../core/advert'

export interface PluginState {
  /** The advert, or `null` when the roster carried none. */
  advert: WebPluginAdvert | null
  /** True once a roster has been read on this connection, whatever it said. */
  read: boolean

  apply: (advert: WebPluginAdvert | null) => void
  reset: () => void
}

export function createPluginStore(): StoreApi<PluginState> {
  return createStore<PluginState>(set => ({
    advert: null,
    read: false,

    apply(advert) {
      set({ advert, read: true })
    },

    reset() {
      set({ advert: null, read: false })
    }
  }))
}

/** The page's store. */
export const pluginStore: StoreApi<PluginState> = createPluginStore()

/** What a screen has to decide between. `unknown` is a reason to say nothing. */
export type PluginPresence = 'unknown' | 'installed' | 'absent'

export function pluginPresence(state: Pick<PluginState, 'advert' | 'read'>): PluginPresence {
  if (!state.read) {
    return 'unknown'
  }

  return state.advert ? 'installed' : 'absent'
}
