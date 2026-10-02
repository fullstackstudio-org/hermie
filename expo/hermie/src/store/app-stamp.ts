/**
 * When this person last chose one of their app-wide settings.
 *
 * ADR-0016's app-wide section — the chat arrangement, the folders, the theme,
 * the name order, the text size, the defaults — is one `ui_meta` key that
 * travels whole, and "last writer wins" was decided by whichever device flushed
 * last. That is not the same question as who chose last, and the difference is
 * what two reports turned out to be: a theme picked on a desktop went back to
 * the phone's the moment the phone was opened, and a set of folders with it.
 *
 * So the section carries a date, and this is where the date lives. It is one
 * store rather than a field on `settings` or `chat-layout` because the section
 * spans both of them and a date on one half would say nothing about the other.
 *
 * **Seconds, and a gateway of its own.** The value is per gateway, like the
 * settings it dates, so it is keyed through the namespace. Seconds because that
 * is what the section's neighbours already use (`context`'s own `updatedAt`),
 * and because nothing here has to tell two choices a hundred milliseconds apart
 * from each other.
 *
 * **Who moves it.** `store/ui-meta-bridge.ts`, from the same diff that decides
 * what to send — one place, every field, rather than a call in each of two dozen
 * setters with one forgotten next month. What the bridge does NOT date is the
 * arrival of a gateway's copy and the roster being folded into the list, neither
 * of which is anybody choosing anything; both are written down there.
 */
import { create } from 'zustand'

import type { GatewayNamespace } from '../gateway/namespace'
import { keyValueStore } from '../platform/key-value-store'

/** Namespaced per gateway: these are somebody's settings ON a gateway. */
export const APP_STAMP_KEY = 'hermie.app.chosen'

interface PersistedStamp {
  updatedAt?: number
}

export interface AppStampState {
  /** Seconds, or `0` while nothing on this device has ever been chosen. */
  updatedAt: number
  /** False until the first disk read finishes. */
  loaded: boolean
  namespace: GatewayNamespace | null
  hydrate: (ns: GatewayNamespace) => Promise<void>
  /**
   * A choice somebody just made.
   *
   * `at` is the wall clock in seconds, except that it is never allowed to be
   * older than the date this device already holds. Two devices do not share a
   * clock, and a phone a minute behind the desktop would otherwise date its
   * owner's newest choice into the past and lose to the one it just replaced.
   * A choice made here is newer than anything this device has seen, by
   * construction, which is the one claim that is true whatever the clocks say.
   */
  touch: (at?: number) => void
  /** The date the gateway's copy carried, adopted with that copy. */
  applyRemote: (at: number) => void
  reset: () => void
}

let writeQueue: Promise<void> = Promise.resolve()

function persist(ns: GatewayNamespace, updatedAt: number): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(ns.key(APP_STAMP_KEY), { updatedAt }))
    .catch(() => {
      // A date that failed to persist costs this device an argument it would have
      // won on the next launch. It is not worth surfacing.
    })
}

const asStamp = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

export const useAppStampStore = create<AppStampState>((set, get) => ({
  updatedAt: 0,
  loaded: false,
  namespace: null,

  async hydrate(ns) {
    const stored = await keyValueStore.getJson<PersistedStamp>(ns.key(APP_STAMP_KEY))

    set({ namespace: ns, updatedAt: asStamp(stored?.updatedAt), loaded: true })
  },

  touch(at = Math.floor(Date.now() / 1000)) {
    const { namespace: ns, updatedAt } = get()
    const next = Math.max(asStamp(at), updatedAt + 1)

    set({ updatedAt: next })

    if (ns) {
      persist(ns, next)
    }
  },

  applyRemote(at) {
    const { namespace: ns, updatedAt } = get()
    const next = asStamp(at)

    // Only when it actually moved: a reconcile that changed nothing must not be
    // a disk write, and there is one of those on every reconnect.
    if (next === updatedAt) {
      return
    }

    set({ updatedAt: next })

    if (ns) {
      persist(ns, next)
    }
  },

  reset() {
    set({ updatedAt: 0, loaded: false, namespace: null })
  }
}))
