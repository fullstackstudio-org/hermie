/**
 * There are no home-screen widgets in a browser, and there is no shared
 * container to write one a file in.
 *
 * A no-op rather than an absent module: `widget-sync.ts` is built from the same
 * stores on every platform, and a seam that answers "nowhere to write" honestly
 * is one branch fewer there than an import that has to be guarded.
 */
import type { WidgetBridge } from './platform-contracts'

export type { WidgetBridge } from './platform-contracts'

export const widgetBridge: WidgetBridge = {
  available: false,
  async writeSnapshot() {
    return false
  },
  async writeAvatar() {
    return false
  },
  async pruneAvatars() {
    return 0
  }
}
