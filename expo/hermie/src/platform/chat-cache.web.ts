/**
 * The chat cache in a browser: IndexedDB, with the same contract the SQLite
 * one answers.
 *
 * IndexedDB rather than `localStorage` because a cached transcript is a JSON
 * blob per bot and `localStorage` is a synchronous 5 MB drawer shared with
 * everything else on the origin — one long chat would evict the preferences
 * sitting next to it. IndexedDB is asynchronous, has a real quota, and stores
 * structured values without a stringify round trip.
 *
 * Deliberately a hand-written wrapper of about eighty lines rather than a
 * dependency: two object stores with a string key each is the whole schema, and
 * the app already carries every byte of its bundle over the network.
 *
 * What is NOT the same as on a phone: a browser may throw the moment the
 * database is opened (private windows, "block all cookies", a storage bucket
 * the user cleared mid-session). `FallbackChatCache` already treats that as a
 * downgrade to memory, so the failure costs a cold paint, never a chat.
 */
import {
  cacheRowKey,
  cacheRowName,
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache
} from './chat-cache-core'
import { ServiceChatCache } from './service-chat-cache.web'

export {
  cacheRowKey,
  cacheRowName,
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache,
  MemoryChatCache
} from './chat-cache-core'

/**
 * A stored record, which is a row plus the gateway it belongs to.
 *
 * The object store's key path is unchanged — `bot` and `name` still hold the
 * key — and what changed is what goes IN them: `<gateway id>:<bot>`. So no
 * version bump and no `onupgradeneeded` branch, which matters because a browser
 * runs the upgrade with every other tab blocked and this buys nothing for it.
 * `ns` rides alongside so a scan can pick one gateway's rows out without
 * splitting strings.
 */
type Stored<T> = T & { ns?: string }

const DATABASE_NAME = 'hermie-chats'
const DATABASE_VERSION = 1
const TRANSCRIPTS = 'transcripts'
const BOTS = 'bots'

/** Promisify one IDB request. Every call in this file goes through it. */
function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

/**
 * Wait for the TRANSACTION rather than for the last request on it.
 *
 * A write that resolves its own request has not been committed yet; the tab can
 * still be closed between the two. `oncomplete` is the only event that means
 * the bytes are down.
 */
function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })
}

export class IndexedDbChatCache implements ChatCache {
  private opening: Promise<IDBDatabase> | null = null

  /** Which gateway's rows this instance reads and writes. */
  constructor(private readonly ns: string) {}

  private key(bot: string): string {
    return cacheRowKey(this.ns, bot)
  }

  private db(): Promise<IDBDatabase> {
    if (!this.opening) {
      this.opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('This browser has no IndexedDB.'))

          return
        }

        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

        request.onupgradeneeded = () => {
          const database = request.result

          if (!database.objectStoreNames.contains(TRANSCRIPTS)) {
            database.createObjectStore(TRANSCRIPTS, { keyPath: 'bot' })
          }

          if (!database.objectStoreNames.contains(BOTS)) {
            database.createObjectStore(BOTS, { keyPath: 'name' })
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open.'))
        // A private window answers neither event; without this the first cached
        // read would hang for the life of the tab instead of downgrading.
        request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'))
      }).catch((error: unknown) => {
        // A failed open must not poison every later call with the same rejected
        // promise; the next call gets a fresh attempt.
        this.opening = null

        throw error
      })
    }

    return this.opening
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<[IDBObjectStore, IDBTransaction]> {
    const transaction = (await this.db()).transaction(name, mode)

    return [transaction.objectStore(name), transaction]
  }

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    const [store] = await this.store(TRANSCRIPTS, 'readonly')
    const row = (await promise<Stored<CachedTranscriptRow> | undefined>(store.get(this.key(bot)))) ?? null

    return row ? { ...row, bot: cacheRowName(row.bot) } : null
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    const [store, transaction] = await this.store(TRANSCRIPTS, 'readwrite')
    store.put({ ...snapshot, bot: this.key(snapshot.bot), ns: this.ns })

    await settled(transaction)
  }

  async forget(bot: string): Promise<void> {
    const [store, transaction] = await this.store(TRANSCRIPTS, 'readwrite')
    store.delete(this.key(bot))

    await settled(transaction)
  }

  async readBots(): Promise<CachedBotRow[]> {
    const [store] = await this.store(BOTS, 'readonly')
    const rows = await promise<Stored<CachedBotRow>[]>(store.getAll() as IDBRequest<Stored<CachedBotRow>[]>)

    // A scan rather than an index: a roster is a dozen rows, and an index would
    // have cost the version bump this whole shape exists to avoid.
    return rows
      .filter(row => row.ns === this.ns)
      .map(row => ({ ...row, name: cacheRowName(row.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The roster is replaced wholesale rather than upserted row by row: a bot the
   * gateway no longer lists has to disappear from the cached list too, or the
   * next cold start paints a bot that is gone.
   */
  async writeBots(rows: CachedBotRow[]): Promise<void> {
    // Read in a transaction of its own, then write in one that issues nothing
    // but synchronous requests. A readwrite transaction that awaits a read
    // halfway through is one that may have auto-committed by the time the
    // writes are issued, and the writes then throw.
    const mine = await this.keysOf(BOTS, 'name')
    const [store, transaction] = await this.store(BOTS, 'readwrite')

    // This gateway's roster only. `store.clear()` would empty every other
    // gateway's cached list on the way past.
    for (const key of mine) {
      store.delete(key)
    }

    for (const row of rows) {
      store.put({ ...row, name: this.key(row.name), ns: this.ns })
    }

    await settled(transaction)
  }

  async clear(): Promise<void> {
    const [transcripts, bots] = await Promise.all([this.keysOf(TRANSCRIPTS, 'bot'), this.keysOf(BOTS, 'name')])
    const database = await this.db()
    const transaction = database.transaction([TRANSCRIPTS, BOTS], 'readwrite')

    for (const key of transcripts) {
      transaction.objectStore(TRANSCRIPTS).delete(key)
    }

    for (const key of bots) {
      transaction.objectStore(BOTS).delete(key)
    }

    await settled(transaction)
  }

  /** Every stored key in one store that belongs to this gateway. */
  private async keysOf(name: string, keyPath: 'bot' | 'name'): Promise<string[]> {
    const [store] = await this.store(name, 'readonly')
    const rows = await promise<Stored<Record<string, unknown>>[]>(
      store.getAll() as IDBRequest<Stored<Record<string, unknown>>[]>
    )

    return rows.filter(row => row.ns === this.ns && typeof row[keyPath] === 'string').map(row => row[keyPath] as string)
  }

  /** The open database, for the one-time move below. */
  open(): Promise<IDBDatabase> {
    return this.db()
  }
}

/**
 * Fill in the namespace for rows written before there was one.
 *
 * Only ever called with the id the single configured gateway was given, and
 * only on the launch that gave it one: rows with no `ns` at all can have
 * belonged to no other gateway, because there was no other gateway. Never
 * throws — a browser that refuses IndexedDB is a cache that starts cold, which
 * costs one paint and no conversation.
 */
export async function migrateChatCacheNamespace(gatewayId: string): Promise<void> {
  try {
    const database = await new IndexedDbChatCache(gatewayId).open()
    // Both reads first, then one write transaction that issues nothing but
    // synchronous requests. See `writeBots` for why the two are not mixed.
    const orphans = await Promise.all([readOrphans(database, TRANSCRIPTS), readOrphans(database, BOTS)])
    const transaction = database.transaction([TRANSCRIPTS, BOTS], 'readwrite')

    for (const [index, store] of [TRANSCRIPTS, BOTS].entries()) {
      const keyPath = store === TRANSCRIPTS ? 'bot' : 'name'

      for (const row of orphans[index] ?? []) {
        const key = row[keyPath] as string

        transaction.objectStore(store).delete(key)
        transaction.objectStore(store).put({ ...row, [keyPath]: cacheRowKey(gatewayId, key), ns: gatewayId })
      }
    }

    await settled(transaction)
  } catch {
    // See above.
  }
}

/** Rows written before the cache had namespaces: no `ns` at all. */
async function readOrphans(database: IDBDatabase, name: string): Promise<Stored<Record<string, unknown>>[]> {
  const keyPath = name === TRANSCRIPTS ? 'bot' : 'name'
  const store = database.transaction(name, 'readonly').objectStore(name)
  const rows = await promise<Stored<Record<string, unknown>>[]>(
    store.getAll() as IDBRequest<Stored<Record<string, unknown>>[]>
  )

  return rows.filter(row => row.ns === undefined && typeof row[keyPath] === 'string')
}

/**
 * The app's cache for one gateway. Memoised, so the two controllers that ask
 * for the same gateway share one instance and therefore one database handle.
 *
 * Two stores, in this order: the browser's own, and then Hermie Web's
 * ([ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 * IndexedDB is per browser and per device, so it has nothing at all on a first
 * visit, on a new laptop, in a private window or after site data is cleared —
 * which is exactly when a chat used to open on a spinner. The service's copy
 * covers precisely that gap and nothing else; `service-chat-cache.web.ts` says
 * why it is consulted second rather than first.
 *
 * The fallback wrapper goes INSIDE. A browser that refuses IndexedDB should
 * still be able to read the service's copy, and a `FallbackChatCache` wrapped
 * around the pair would downgrade both on the first local failure.
 */
const caches = new Map<string, ChatCache>()

export function chatCacheFor(gatewayId: string): ChatCache {
  const existing = caches.get(gatewayId)

  if (existing) {
    return existing
  }

  const cache = new ServiceChatCache(new FallbackChatCache(new IndexedDbChatCache(gatewayId)))
  caches.set(gatewayId, cache)

  return cache
}
