/**
 * The memory page's one seam onto the app.
 *
 * `useCron.ts` next door is the model: a hook that builds a controller from the
 * live connection, starts it, and tears it down when the connection or the
 * subject changes. What this one adds is the capability read, because the
 * memory routes are a PLUGIN's and not core's — so "which gateway" is not
 * enough to know whether the page can exist at all.
 *
 * The three answers are deliberately distinguishable and the store that holds
 * them already makes them so: `unknown` until a roster has arrived, then
 * `installed` or `absent`. A page that drew "not installed" while it had simply
 * not looked yet would send somebody to install a plugin they already have.
 */
import { hasPluginCapability, PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { useEffect, useState } from 'react'

import { useGateway } from '../../gateway'
import { pluginPresence, usePluginStore } from '../../store/plugin'
import { useMemoryStore } from '../../store/memory'
import { MemoryController } from './memory-controller'

/** What the page has to decide between before it draws anything. */
export type MemoryAvailability = 'unknown' | 'missing' | 'readOnly' | 'editable'

export function useMemoryAvailability(): MemoryAvailability {
  const advert = usePluginStore(state => state.advert)
  const read = usePluginStore(state => state.read)

  if (pluginPresence({ advert, read }) === 'unknown') {
    return 'unknown'
  }

  if (!hasPluginCapability(advert, PLUGIN_CAPABILITIES.memoryBrowse)) {
    return 'missing'
  }

  return hasPluginCapability(advert, PLUGIN_CAPABILITIES.memoryEdit) ? 'editable' : 'readOnly'
}

/**
 * A controller for one bot's memory, or null while there is nothing to ask.
 *
 * Keyed on the profile as well as on the connection: the wide layout can move
 * from one bot's page to another's without unmounting, and a controller that
 * kept pointing at the first would refetch the wrong file after every write.
 */
export function useMemoryController(profile: string): MemoryController | null {
  const { http } = useGateway()
  const availability = useMemoryAvailability()
  const [controller, setController] = useState<MemoryController | null>(null)

  useEffect(() => {
    if (!http || (availability !== 'editable' && availability !== 'readOnly')) {
      useMemoryStore.getState().reset()
      setController(null)

      return
    }

    const next = new MemoryController({
      http,
      store: useMemoryStore,
      profile,
      readOnly: availability === 'readOnly'
    })

    next.start()
    setController(next)

    return () => {
      next.stop()
      setController(null)
    }
  }, [availability, http, profile])

  return controller
}
