/**
 * When this person last chose one of their app-wide settings.
 *
 * ADR-0016's app-wide section (the chat arrangement, the folders, the mutes, the
 * text size, the defaults) is one `ui_meta` key that travels whole, and "last
 * writer wins" was decided by whichever device flushed last. That is not the same
 * question as who chose last, and the difference is what two reports on the Expo
 * app turned out to be: a theme picked on a desktop went back to the phone's the
 * moment the phone was opened, and a set of folders with it.
 *
 * So the section carries a date (`updatedAt`, seconds), and this is where the
 * date lives. It is one store rather than a field on the layout store because the
 * section spans more than the layout, and a date on one half would say nothing
 * about the other.
 *
 * **Who moves it.** `core/ui-meta-bridge.ts`, from the same diff that decides
 * what to send: one place, every field. What the bridge does NOT date is the
 * arrival of a gateway's copy and the roster being folded into the list, neither
 * of which is anybody choosing anything.
 *
 * Ported from the Expo app's `src/store/app-stamp.ts`. Deliberate differences:
 *
 *  - **One gateway, so no namespace.** The page's key-value store is already
 *    keyed by its base path; the key is identity-bound (`app.chosen`), so a
 *    sign-out forgets the date with the person it belonged to.
 *  - `hydrate` takes the key-value store, and the writes go to it in order
 *    through one queue per store.
 *  - A vanilla zustand store (`appStampStore`, and `createAppStampStore` for
 *    tests).
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { KeyValueStore } from '../platform/key-value-store'

/** Identity-bound: a date is about one person's choices. */
export const APP_STAMP_KEY = 'app.chosen'

interface PersistedStamp {
  updatedAt?: number
}

export interface AppStampState {
  /** Seconds, or `0` while nothing on this device has ever been chosen. */
  updatedAt: number
  /** False until the first disk read finishes. */
  loaded: boolean
  storage: KeyValueStore | null
  hydrate: (storage: KeyValueStore) => Promise<void>
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
  /** The date the gateway's copy carried, adopted with that copy (`0` for an undated one). */
  applyRemote: (at: number) => void
  reset: () => void
}

const asStamp = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

export function createAppStampStore(): StoreApi<AppStampState> {
  let writeQueue: Promise<void> = Promise.resolve()

  const persist = (storage: KeyValueStore, updatedAt: number): void => {
    writeQueue = writeQueue
      .then(() => storage.setJson(APP_STAMP_KEY, { updatedAt }))
      .catch(() => {
        // A date that failed to persist costs this device an argument it would
        // have won on the next launch. It is not worth surfacing.
      })
  }

  return createStore<AppStampState>((set, get) => ({
    updatedAt: 0,
    loaded: false,
    storage: null,

    async hydrate(storage) {
      const stored = await storage.getJson<PersistedStamp>(APP_STAMP_KEY).catch(() => null)

      // A choice made while the disk was answering is newer than the disk.
      set({ storage, updatedAt: Math.max(get().updatedAt, asStamp(stored?.updatedAt)), loaded: true })
    },

    touch(at = Math.floor(Date.now() / 1000)) {
      const { storage, updatedAt } = get()
      const next = Math.max(asStamp(at), updatedAt + 1)

      set({ updatedAt: next })

      if (storage) {
        persist(storage, next)
      }
    },

    applyRemote(at) {
      const { storage, updatedAt } = get()
      const next = asStamp(at)

      // Only when it actually moved: a reconcile that changed nothing must not be
      // a disk write, and there is one of those on every reconnect.
      if (next === updatedAt) {
        return
      }

      set({ updatedAt: next })

      if (storage) {
        persist(storage, next)
      }
    },

    reset() {
      set({ updatedAt: 0, loaded: false, storage: null })
    }
  }))
}

/** The page's store. */
export const appStampStore: StoreApi<AppStampState> = createAppStampStore()
