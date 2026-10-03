/**
 * Whether the page is in front of the reader, through the visibility seam. A
 * chat on a tab in the background is open and is not being read.
 */
import { useSyncExternalStore } from 'react'

import { visibilityWatcher } from '../../platform/visibility'

const subscribe = (onChange: () => void): (() => void) => visibilityWatcher.subscribe(() => onChange())

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => visibilityWatcher.current() === 'visible',
    () => true
  )
}
