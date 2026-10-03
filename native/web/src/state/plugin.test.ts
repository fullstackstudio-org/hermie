/**
 * Whether the gateway has a Hermie plugin. Ported from "the three states" in
 * the Expo app's `__tests__/plugin-advert.test.tsx`; the install-screen half of
 * that file is UI this client does not have yet.
 *
 * Differences from the source: the advert reaches the store through `apply`
 * (the roster read calls it, `core/gateway-client.ts`) rather than through the
 * `ui_meta` bridge's `applySnapshot`, so the "a snapshot the app produced
 * itself" case has no counterpart here: nothing but a roster answer applies.
 */
import { PLUGIN_ADVERT } from '@hermie/fake-gateway'
import { hasPluginCapability } from '@hermie/gateway-client/plugin'
import { beforeEach, describe, expect, it } from 'vitest'

import { webPluginAdvertOf } from '../core/advert'
import { createPluginStore, pluginPresence } from './plugin'

const ADVERT = webPluginAdvertOf(PLUGIN_ADVERT)

let store = createPluginStore()

beforeEach(() => {
  store = createPluginStore()
})

describe('the three states', () => {
  it('says nothing before a roster has arrived', () => {
    expect(pluginPresence(store.getState())).toBe('unknown')
  })

  it('takes the advert off a roster', () => {
    store.getState().apply(ADVERT)

    expect(pluginPresence(store.getState())).toBe('installed')
    expect(store.getState().advert?.version).toBe('0.2.0')
    expect(store.getState().advert?.web?.path).toBe('/dashboard-plugins/hermie/app/index.html')
    // The package's readers take the web advert as they are.
    expect(hasPluginCapability(store.getState().advert, 'push.webpush')).toBe(true)
  })

  it('reads a gateway that carried no advert as not installed', () => {
    store.getState().apply(null)

    expect(pluginPresence(store.getState())).toBe('absent')
  })

  it('goes back to unknown on reset, which stopping the connection runs', () => {
    store.getState().apply(ADVERT)
    store.getState().reset()

    expect(pluginPresence(store.getState())).toBe('unknown')
    expect(store.getState().advert).toBeNull()
  })
})
