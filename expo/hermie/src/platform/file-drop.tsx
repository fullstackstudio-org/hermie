/**
 * Files dragged onto the window, from the Finder or from another app.
 *
 * React Native has no drop event on any platform it ships. `UIDropInteraction`
 * is UIKit's, and the local module in `expo/hermie/modules/hermie-drop` wraps it
 * as a host view — a view rather than a module function because a drop belongs
 * to a REGION: the chat takes a file, the sidebar beside it does not, and one
 * global event could not tell them apart.
 *
 * Probed by FUNCTION, like every other optional native surface in this folder:
 * `requireNativeView` throws for a view that is not registered, at module scope
 * where nothing can catch it usefully, and an older binary running a newer
 * bundle is exactly the case that would hit it.
 *
 * Nothing here is gated on the Mac. `UIDropInteraction` is the same interaction
 * on an iPad in Split View or Stage Manager, and on an iPhone there is no drag
 * session to receive — so the honest question is whether the view exists, not
 * which machine this is.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import type { ComponentType } from 'react'

import type { NativeDropViewProps } from './file-drop.shared'

export type { DroppedFile, NativeDropViewProps } from './file-drop.shared'
export { normaliseDroppedFiles } from './file-drop.shared'

type DropProbe = { supportsFileDrop?: () => boolean }

function probe(): boolean {
  try {
    return typeof requireOptionalNativeModule<DropProbe>('HermieDrop')?.supportsFileDrop === 'function'
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

/** Whether this build can accept a dropped file. */
export const HAS_NATIVE_FILE_DROP = probe()

let cached: ComponentType<NativeDropViewProps> | null = null

export function nativeDropView(): ComponentType<NativeDropViewProps> | null {
  if (!HAS_NATIVE_FILE_DROP) {
    return null
  }

  if (cached) {
    return cached
  }

  try {
    cached = requireNativeView<NativeDropViewProps>('HermieDrop', 'HermieDropView')
  } catch {
    return null
  }

  return cached
}
