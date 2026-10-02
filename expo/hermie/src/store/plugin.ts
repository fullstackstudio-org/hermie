/**
 * What the connected gateway says is installed next to it.
 *
 * The gateway-side plugin publishes a capability advert under its own
 * `hermie-plugin` `ui_meta` key, and `UiMetaSync` reads it out of the same
 * `profiles.list` the settings reconcile already makes. This store is where
 * that answer lives for the screens that have to decide what to offer.
 *
 * **Nothing here is persisted.** The advert is a fact about a gateway at a
 * moment, not a preference: a plugin can be disabled between two launches, and
 * a remembered "it was installed last week" would make Settings offer a button
 * that does nothing. It is also emptied whenever the connection goes, because
 * the next gateway is not this one.
 *
 * **The three states are deliberately distinguishable.** `read` is false until
 * a roster has actually arrived, so "we have not looked yet" is never drawn as
 * "not installed" — which is the difference between a screen that waits and a
 * screen that tells somebody to go and install something they already have.
 */
import { type PluginAdvert } from '@hermie/gateway-client/plugin'
import { create } from 'zustand'

export interface PluginState {
  /** The advert, or `null` when the roster carried none. */
  advert: PluginAdvert | null
  /** True once a roster has been read on this connection, whatever it said. */
  read: boolean

  apply: (advert: PluginAdvert | null) => void
  reset: () => void
}

export const usePluginStore = create<PluginState>(set => ({
  advert: null,
  read: false,

  apply(advert) {
    set({ advert, read: true })
  },

  reset() {
    set({ advert: null, read: false })
  }
}))

/** What a screen has to decide between. `unknown` is a reason to say nothing. */
export type PluginPresence = 'unknown' | 'installed' | 'absent'

export function pluginPresence(state: Pick<PluginState, 'advert' | 'read'>): PluginPresence {
  if (!state.read) {
    return 'unknown'
  }

  return state.advert ? 'installed' : 'absent'
}
