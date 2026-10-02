/**
 * Reading what the system's share sheet left for the app.
 *
 * The mirror of `platform/widgets.ts`, and deliberately just as thin: that seam
 * puts bytes where another process can read them, this one picks up bytes
 * another process left. Neither knows what the bytes mean —
 * `features/share/outbox.ts` is the whole of that, it is pure, and it is tested
 * as a table.
 *
 * `requireOptionalNativeModule` rather than the throwing form, for the reason
 * `runs-on-mac.ts` gives: where there is no module the honest answer is "nothing
 * was shared", not an error. That covers the Jest environment, an Expo Go
 * client, and an older installed binary running a newer bundle.
 *
 * Every call answers a value, including the failures. A share that could not be
 * read is a share that is not delivered; it is not a reason for the launch that
 * found it to throw.
 */
import { requireOptionalNativeModule } from 'expo'

import type { ShareInbox } from './platform-contracts'

export type { ShareInbox } from './platform-contracts'

interface HermieShareModule {
  /**
   * Every waiting entry, as `[{ id, manifest, files }]`.
   *
   * `files` maps the manifest's own relative names to local URIs. It is built
   * natively because only that side knows which container the entry is in — an
   * App Group directory on Apple platforms, the app's files directory on
   * Android.
   *
   * `claim` is the entry's `claim.json`, when it has one — a share a previous
   * sender got as far as submitting. It rides beside the manifest rather than
   * inside `files` because it is bookkeeping and not something anybody shared.
   */
  listShares(): Promise<{ id: string; manifest: string; claim?: string; files: Record<string, string> }[]>
  clearShare(id: string): Promise<boolean>
  writeShareTargets(json: string): Promise<boolean>
}

function native(): HermieShareModule | null {
  try {
    return requireOptionalNativeModule<HermieShareModule>('HermieShare')
  } catch {
    // No Expo module host at all — a unit test renderer.
    return null
  }
}

const module_ = native()

export const shareInbox: ShareInbox = {
  available: module_ !== null,

  async list() {
    try {
      return (await module_?.listShares()) ?? []
    } catch {
      return []
    }
  },

  async clear(id) {
    try {
      return (await module_?.clearShare(id)) === true
    } catch {
      return false
    }
  },

  async writeTargets(json) {
    try {
      return (await module_?.writeShareTargets(json)) === true
    } catch {
      // A write that failed is a sheet that queues rather than sends, which is
      // the behaviour this whole feature had before ADR-0026. It is not a reason
      // to reject inside a store subscription.
      return false
    }
  }
}
