/**
 * The Shortcuts queue, and the system's search index.
 *
 * Thin for the reason every seam in this folder is thin: what a request MEANS
 * is decided in `features/intents/queue.ts`, which is pure and tested, and this
 * knows only how to get bytes in and out of the place the App Intents can see.
 *
 * `requireOptionalNativeModule` rather than the throwing form, for the reason
 * `runs-on-mac.ts` gives: Android, the web and the Jest environment have no such
 * module, and there the honest answer is "nothing was asked", not an error.
 *
 * Every call answers a value, including the failures. A Shortcut that could not
 * be answered is a Shortcut that reports a timeout; it is not a reason for the
 * launch that found it to throw.
 */
import { requireOptionalNativeModule } from 'expo'

import type { IntentQueue } from './platform-contracts'

export type { IntentQueue } from './platform-contracts'

interface HermieIntentsModule {
  listIntents(): Promise<{ id: string; payload: string }[]>
  completeIntent(id: string, result: string): Promise<boolean>
  indexBots(bots: { name: string; label: string; subtitle: string }[]): Promise<boolean>
}

function native(): HermieIntentsModule | null {
  try {
    return requireOptionalNativeModule<HermieIntentsModule>('HermieIntents')
  } catch {
    // No Expo module host at all — a unit test renderer.
    return null
  }
}

const module_ = native()

export const intentQueue: IntentQueue = {
  available: module_ !== null,

  async list() {
    try {
      return (await module_?.listIntents()) ?? []
    } catch {
      return []
    }
  },

  async complete(id, result) {
    try {
      return (await module_?.completeIntent(id, result)) === true
    } catch {
      return false
    }
  },

  async indexBots(bots) {
    try {
      return (await module_?.indexBots([...bots])) === true
    } catch {
      return false
    }
  }
}
