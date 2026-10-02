/**
 * The app's half of the home-screen widgets: write the file, ask for a redraw.
 *
 * Deliberately thin. Everything about WHAT a widget shows is decided in
 * `src/features/widgets/snapshot.ts`, which is pure and tested; this seam knows
 * only how to get bytes into a place another process can read them from, and it
 * is the same three calls on both platforms so the sync above it has no branch
 * in it.
 *
 * `requireOptionalNativeModule` rather than the throwing form, for the reason
 * `runs-on-mac.ts` gives: the honest answer where there is no module is "there
 * is no container", and asking for it should not be an error. That covers the
 * Jest environment, an Expo Go client, and an older installed binary running a
 * newer bundle.
 */
import { requireOptionalNativeModule } from 'expo'

import type { WidgetBridge } from './platform-contracts'

export type { WidgetBridge } from './platform-contracts'

interface HermieWidgetsModule {
  writeSnapshot(json: string): Promise<boolean>
  writeAvatar(botName: string, base64: string): Promise<boolean>
  pruneAvatars(keep: readonly string[]): Promise<number>
}

function native(): HermieWidgetsModule | null {
  try {
    return requireOptionalNativeModule<HermieWidgetsModule>('HermieWidgets')
  } catch {
    // No Expo module host at all — a unit test renderer.
    return null
  }
}

const module_ = native()

export const widgetBridge: WidgetBridge = {
  available: module_ !== null,

  async writeSnapshot(json) {
    // Every call is wrapped rather than only the ones that look risky: a native
    // promise that rejects here would reject inside a store subscription, where
    // there is nobody to catch it and the failure surfaces as an unhandled
    // rejection warning about a widget nobody is looking at.
    try {
      return (await module_?.writeSnapshot(json)) === true
    } catch {
      return false
    }
  },

  async writeAvatar(botName, base64) {
    try {
      return (await module_?.writeAvatar(botName, base64)) === true
    } catch {
      return false
    }
  },

  async pruneAvatars(keep) {
    try {
      return (await module_?.pruneAvatars(keep)) ?? 0
    } catch {
      return 0
    }
  }
}
