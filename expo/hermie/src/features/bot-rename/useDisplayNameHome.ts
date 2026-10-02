/**
 * Where a display name typed on this connection will end up.
 *
 * The capability read, kept out of the sheet for the reason
 * `features/memory/useMemory.ts` gives about its own: the routes behind it are a
 * PLUGIN's and not core's, so "which gateway" is not enough to know what the
 * field can do.
 *
 * Three answers rather than two, and the third is the point. `null` means no
 * roster has arrived yet — so the sheet says nothing about where the name goes
 * instead of telling somebody their plugin is too old before it has looked.
 */
import { hasPluginCapability, PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'

import { pluginPresence, usePluginStore } from '../../store/plugin'
import type { DisplayNameHome } from './display-name-controller'

export function useDisplayNameHome(): DisplayNameHome | null {
  const advert = usePluginStore(state => state.advert)
  const read = usePluginStore(state => state.read)

  if (pluginPresence({ advert, read }) === 'unknown') {
    return null
  }

  return hasPluginCapability(advert, PLUGIN_CAPABILITIES.profilesDisplayName) ? 'gateway' : 'app'
}
