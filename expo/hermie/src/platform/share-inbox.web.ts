/**
 * A browser has no share sheet that can hand a file to this page.
 *
 * The Web Share Target API exists, and it needs an installed PWA with a service
 * worker and a manifest entry — none of which this build has, and all of which
 * are a piece of work rather than a seam. So the honest answer here is "nothing
 * was shared", the same shape the phones answer when their outbox is empty.
 *
 * A no-op rather than an absent module, for the reason `widgets.web.ts` gives:
 * the delivery flow above is built from the same ports on every platform, and a
 * seam that answers honestly is one branch fewer there than an import that has
 * to be guarded.
 */
import type { ShareInbox } from './platform-contracts'

export type { ShareInbox } from './platform-contracts'

export const shareInbox: ShareInbox = {
  available: false,
  async list() {
    return []
  },
  async clear() {
    return false
  },
  async writeTargets() {
    return false
  }
}
