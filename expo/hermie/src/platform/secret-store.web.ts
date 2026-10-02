/**
 * The secret store in a browser — and the honest name for it is "storage",
 * not "keychain".
 *
 * **There is no keychain on the web.** `expo-secure-store` has no web
 * implementation, and none of the browser APIs is an equivalent: everything a
 * page can write, a page can read back, so a token kept here is protected by
 * the origin and by nothing else. Concretely, compared with the phones:
 *
 *  - No hardware-backed key, no Secure Enclave, no biometric gate.
 *  - No "after first unlock" semantics — a locked screen is not a boundary.
 *  - Anything running in the page reads it. That is the same trust boundary the
 *    session cookie already has, which is why the browser build authenticates
 *    with the gateway's cookie flow (`CookieSessionCredentials`) and keeps no
 *    bearer token here at all: what this store actually holds in a Hermie Web
 *    install is the non-secret bookkeeping the shared code happens to route
 *    through the secret store, and the extra-headers blob.
 *  - Clearing site data signs the user out. There is no migration and no sync.
 *
 * IndexedDB rather than `localStorage`, for one reason that matters: values
 * written here must not be readable from a synchronous script that only got a
 * moment on the page, and IndexedDB at least makes every read asynchronous and
 * quota-managed. It is a speed bump, not a boundary. `localStorage` is the
 * fallback for browsers that refuse IndexedDB outright (private windows), and
 * an in-memory map is the last resort so that a session still works for as long
 * as the tab is open.
 *
 * Documented again in docs/platform-notes.md, under "Web".
 */
import type { SecretStore } from './platform-contracts'

export type { SecretStore } from './platform-contracts'

const DATABASE_NAME = 'hermie-secrets'
const DATABASE_VERSION = 1
const STORE = 'secrets'
const LOCAL_STORAGE_PREFIX = 'hermie.secret.'

function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })
}

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser has no IndexedDB.'))

        return
      }

      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result

        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE)
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open.'))
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'))
    }).catch((error: unknown) => {
      opening = null

      throw error
    })
  }

  return opening
}

/** Last resort, so one tab keeps working even where nothing persists. */
const memory = new Map<string, string>()

function localGet(key: string): string | null {
  try {
    return localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`)
  } catch {
    return memory.get(key) ?? null
  }
}

function localSet(key: string, value: string): void {
  try {
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, value)
  } catch {
    memory.set(key, value)
  }
}

function localDelete(key: string): void {
  try {
    localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`)
  } catch {
    // Nothing to do; the memory map below is the only copy that existed.
  }

  memory.delete(key)
}

export const secretStore: SecretStore = {
  async get(key) {
    try {
      const database = await open()
      const store = database.transaction(STORE, 'readonly').objectStore(STORE)
      const value = await promise<unknown>(store.get(key))

      return typeof value === 'string' ? value : null
    } catch {
      return localGet(key)
    }
  },
  async set(key, value) {
    try {
      const database = await open()
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(value, key)

      await settled(transaction)
    } catch {
      localSet(key, value)
    }
  },
  async delete(key) {
    try {
      const database = await open()
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).delete(key)

      await settled(transaction)
    } catch {
      // Fall through: the value may still be in the localStorage mirror.
    }

    localDelete(key)
  }
}
