/**
 * Non-secret settings and state, in the browser's `localStorage`.
 *
 * The shape is the Expo app's `KeyValueStore` (asynchronous, JSON helpers,
 * `keys`, `deleteMany`), so the stores ported from it keep their calls. A
 * browser's store is synchronous underneath, so the `*Sync` variants are here
 * too for the few readers that run before anything can be awaited.
 *
 * Differences from the Expo source:
 *
 *  - **Namespaced.** Every key is written as `hermie:<base path>:<key>`. The
 *    origin also serves the dashboard and other dashboard plugins, and two
 *    gateways behind different path prefixes on one host share an origin, so
 *    a bare key would collide with somebody else's.
 *  - **Tolerant.** A browser may refuse the store outright (private windows,
 *    blocked site data: the `localStorage` getter itself throws) or refuse a
 *    write (quota). Neither is an error here: what could not be written is kept
 *    in memory for the life of the page and reads see it, so a setting holds
 *    until the tab closes instead of the client failing.
 *  - **Two kinds of key.** A key that starts with `device.` belongs to the
 *    browser profile (language, scheme, tint, text size, the installation id)
 *    and survives a sign-out. Every other key is identity-bound and
 *    `clearIdentityBound` removes it. The default is deliberately the one that
 *    forgets: a key somebody forgot to classify is cleared, not leaked to the
 *    next person who signs in on this browser.
 *
 * Nothing secret is ever written here (plan W5): other code on the origin can
 * read it.
 */

/** The Expo app's contract, unchanged. */
export type KeyValueStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  getJson<T>(key: string): Promise<T | null>
  setJson(key: string, value: unknown): Promise<void>
  /** Every key this store holds, without the namespace. */
  keys(): Promise<string[]>
  deleteMany(keys: readonly string[]): Promise<void>
}

/** The browser store: the Expo contract plus synchronous reads and the sign-out sweep. */
export interface WebKeyValueStore extends KeyValueStore {
  /** `hermie:<base path>:`, which every stored key starts with. */
  readonly prefix: string
  getSync(key: string): string | null
  setSync(key: string, value: string): void
  deleteSync(key: string): void
  /**
   * Remove every key that is not device-local (see `isDeviceLocalKey`).
   * Returns the keys it removed, without the namespace.
   */
  clearIdentityBound(): string[]
}

/** Keys under this prefix survive a sign-out. */
export const DEVICE_LOCAL_PREFIX = 'device.'

export const isDeviceLocalKey = (key: string): boolean => key.startsWith(DEVICE_LOCAL_PREFIX)

/** `hermie:<namespace>:`, the prefix of every key for one base path. */
export const keyValuePrefix = (namespace: string): string => `hermie:${namespace}:`

/** The part of `Storage` this file uses, so a test can hand in its own. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export interface KeyValueStoreOptions {
  /** The base-path namespace (`storageNamespace` in `boot/base-path.ts`). */
  namespace: string
  /**
   * Where the values go. Omitted means the page's own `localStorage`; `null`
   * means "no store at all", which is memory only.
   */
  storage?: StorageLike | null
}

/** `localStorage`, or null when this browser refuses it. Reading the property is what throws. */
function pageLocalStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function createKeyValueStore(options: KeyValueStoreOptions): WebKeyValueStore {
  const prefix = keyValuePrefix(options.namespace)
  const storage = options.storage === undefined ? pageLocalStorage() : options.storage
  /**
   * What the store refused, by key: a string is a value it would not take, null
   * a removal it would not do. Reads look here first.
   */
  const overlay = new Map<string, string | null>()
  let warned = false

  const refused = (error: unknown): void => {
    if (!warned) {
      warned = true
      console.warn('[hermie] the browser refused to store a setting; keeping it for this page only.', error)
    }
  }

  const getSync = (key: string): string | null => {
    if (overlay.has(key)) {
      return overlay.get(key) ?? null
    }

    try {
      return storage?.getItem(prefix + key) ?? null
    } catch {
      return null
    }
  }

  const setSync = (key: string, value: string): void => {
    if (!storage) {
      overlay.set(key, value)

      return
    }

    try {
      storage.setItem(prefix + key, value)
      overlay.delete(key)
    } catch (error) {
      overlay.set(key, value)
      refused(error)
    }
  }

  const deleteSync = (key: string): void => {
    if (!storage) {
      overlay.delete(key)

      return
    }

    try {
      storage.removeItem(prefix + key)
      overlay.delete(key)
    } catch (error) {
      overlay.set(key, null)
      refused(error)
    }
  }

  const keysSync = (): string[] => {
    const found = new Set<string>()

    try {
      for (let index = 0; storage && index < storage.length; index += 1) {
        const name = storage.key(index)

        if (name?.startsWith(prefix)) {
          found.add(name.slice(prefix.length))
        }
      }
    } catch {
      // A store that cannot be listed has nothing this page can see.
    }

    for (const [key, value] of overlay) {
      if (value === null) {
        found.delete(key)
      } else {
        found.add(key)
      }
    }

    return [...found].sort()
  }

  const getJsonSync = <T>(key: string): T | null => {
    const raw = getSync(key)

    if (raw === null) {
      return null
    }

    try {
      return JSON.parse(raw) as T
    } catch {
      // A value written by an older build is not worth failing over.
      deleteSync(key)

      return null
    }
  }

  return {
    prefix,
    getSync,
    setSync,
    deleteSync,
    clearIdentityBound() {
      const removed = keysSync().filter(key => !isDeviceLocalKey(key))

      for (const key of removed) {
        deleteSync(key)
      }

      return removed
    },
    async get(key) {
      return getSync(key)
    },
    async set(key, value) {
      setSync(key, value)
    },
    async delete(key) {
      deleteSync(key)
    },
    async getJson<T>(key: string) {
      return getJsonSync<T>(key)
    },
    async setJson(key, value) {
      setSync(key, JSON.stringify(value))
    },
    async keys() {
      return keysSync()
    },
    async deleteMany(keys) {
      for (const key of keys) {
        deleteSync(key)
      }
    }
  }
}
