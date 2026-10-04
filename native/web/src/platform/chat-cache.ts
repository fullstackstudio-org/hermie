/**
 * The transcript and roster cache, in IndexedDB.
 *
 * Ported from the Expo app: `src/platform/chat-cache-core.ts` (the contract,
 * the memory cache, the downgrade wrapper) and `src/platform/chat-cache.web.ts`
 * (the IndexedDB store), with the same record shape: a transcript row holds the
 * `snapshotForCache` output of `@hermie/transcript` as JSON in `itemsJson`, so
 * the ported chat controller writes and reads it unchanged.
 *
 * Deliberate differences from the source:
 *
 *  - The database is `hermie-cache` (plan, "Browser storage"), a new name, so
 *    nothing written by the Expo web export is ever read as this client's.
 *  - The namespace is the base path (`storageNamespace`), not a gateway id: a
 *    page has exactly one gateway, its origin, but two gateways behind
 *    different path prefixes share that origin and its IndexedDB.
 *  - No Hermie Web service cache behind it and no one-time namespace migration:
 *    neither exists for this client.
 *  - `IDBFactory` is injected, so the tests run against their own.
 *
 * Plain transcripts sit here readable by the origin; `clear()` runs on
 * sign-out and when a different person signs in (`boot/login-bounce.ts`).
 */

/**
 * What separates the namespace from a bot name inside a stored key. The
 * namespace never contains a colon (`storageNamespace` replaces them), so the
 * FIRST colon is always the separator, however many a bot name carries.
 */
export const CACHE_NS_SEPARATOR = ':'

/** The stored key for one bot's row inside one namespace. */
export const cacheRowKey = (ns: string, name: string): string => `${ns}${CACHE_NS_SEPARATOR}${name}`

/** The bot name back out of a stored key. */
export function cacheRowName(key: string): string {
  const at = key.indexOf(CACHE_NS_SEPARATOR)

  return at === -1 ? key : key.slice(at + CACHE_NS_SEPARATOR.length)
}

export type CachedTranscriptRow = {
  bot: string
  itemsJson: string
  lastRowId: number | null
  lastSeq: number | null
  epoch: string | null
  updatedAt: number
}

export type CachedBotRow = {
  name: string
  json: string
  avatarRev: number
  updatedAt: number
}

export type ChatCache = {
  read(bot: string): Promise<CachedTranscriptRow | null>
  write(snapshot: CachedTranscriptRow): Promise<void>
  forget(bot: string): Promise<void>
  readBots(): Promise<CachedBotRow[]>
  writeBots(rows: CachedBotRow[]): Promise<void>
  clear(): Promise<void>
}

/** A cache that only remembers while the page lives. */
export class MemoryChatCache implements ChatCache {
  private readonly transcripts = new Map<string, CachedTranscriptRow>()
  private bots: CachedBotRow[] = []

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    return this.transcripts.get(bot) ?? null
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    this.transcripts.set(snapshot.bot, snapshot)
  }

  async forget(bot: string): Promise<void> {
    this.transcripts.delete(bot)
  }

  async readBots(): Promise<CachedBotRow[]> {
    return [...this.bots]
  }

  async writeBots(rows: CachedBotRow[]): Promise<void> {
    this.bots = [...rows]
  }

  async clear(): Promise<void> {
    this.transcripts.clear()
    this.bots = []
  }
}

/**
 * A cache that starts on a real store and gives up on it for good the first
 * time that store throws: a browser in a private window, with blocked site data
 * or with a storage bucket cleared mid-session must cost a cold paint, never a
 * chat.
 *
 * One exception to "memory from then on": `clear()` is also sent to the store
 * that failed, best effort. Sign-out has to remove what was written before the
 * failure, not just forget it in memory.
 */
export class FallbackChatCache implements ChatCache {
  private primary: ChatCache | null
  private readonly original: ChatCache
  private readonly fallback = new MemoryChatCache()

  constructor(primary: ChatCache) {
    this.primary = primary
    this.original = primary
  }

  /** True once the primary has thrown and the instance has downgraded. */
  get degraded(): boolean {
    return this.primary === null
  }

  private async run<T>(action: (cache: ChatCache) => Promise<T>): Promise<T> {
    const primary = this.primary

    if (!primary) {
      return action(this.fallback)
    }

    try {
      return await action(primary)
    } catch (error) {
      this.primary = null
      console.warn('[hermie] the chat cache database is unavailable; continuing in memory only.', error)

      return action(this.fallback)
    }
  }

  read(bot: string): Promise<CachedTranscriptRow | null> {
    return this.run(cache => cache.read(bot))
  }

  write(snapshot: CachedTranscriptRow): Promise<void> {
    return this.run(cache => cache.write(snapshot))
  }

  forget(bot: string): Promise<void> {
    return this.run(cache => cache.forget(bot))
  }

  readBots(): Promise<CachedBotRow[]> {
    return this.run(cache => cache.readBots())
  }

  writeBots(rows: CachedBotRow[]): Promise<void> {
    return this.run(cache => cache.writeBots(rows))
  }

  async clear(): Promise<void> {
    await this.fallback.clear()

    if (this.primary) {
      return this.run(cache => cache.clear())
    }

    try {
      await this.original.clear()
    } catch {
      // Still refused. Nothing more a page can do about it.
    }
  }
}

/**
 * A cache the reader can switch off (Settings › Chats): while `enabled()` says no, nothing is read from the
 * inner cache and nothing is written to it, so a chat opens from the gateway as it does on a first visit and
 * nothing of it stays in the browser. `forget` and `clear` always reach the inner cache, because leaving
 * something behind is the one thing a switched-off cache must not do.
 *
 * It asks on every call rather than once, so a switch takes effect between two writes without a reload.
 */
export class GatedChatCache implements ChatCache {
  constructor(
    private readonly inner: ChatCache,
    private readonly enabled: () => boolean
  ) {}

  read(bot: string): Promise<CachedTranscriptRow | null> {
    return this.enabled() ? this.inner.read(bot) : Promise.resolve(null)
  }

  write(snapshot: CachedTranscriptRow): Promise<void> {
    return this.enabled() ? this.inner.write(snapshot) : Promise.resolve()
  }

  forget(bot: string): Promise<void> {
    return this.inner.forget(bot)
  }

  readBots(): Promise<CachedBotRow[]> {
    return this.enabled() ? this.inner.readBots() : Promise.resolve([])
  }

  writeBots(rows: CachedBotRow[]): Promise<void> {
    return this.enabled() ? this.inner.writeBots(rows) : Promise.resolve()
  }

  clear(): Promise<void> {
    return this.inner.clear()
  }
}

/** A stored record: a row plus the namespace it belongs to. */
type Stored<T> = T & { ns?: string }

export const CHAT_CACHE_DATABASE = 'hermie-cache'
const DATABASE_VERSION = 1
const TRANSCRIPTS = 'transcripts'
const BOTS = 'bots'

/** Promisify one IDB request. */
function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

/**
 * Wait for the TRANSACTION rather than for the last request on it: only
 * `oncomplete` means the bytes are down.
 */
function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })
}

/** The page's IndexedDB, or null when this browser has none or refuses it. */
function pageIndexedDb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null
  } catch {
    return null
  }
}

export class IndexedDbChatCache implements ChatCache {
  private opening: Promise<IDBDatabase> | null = null

  constructor(
    /** Which base path's rows this instance reads and writes. */
    private readonly ns: string,
    /** `null` means "this browser has none": every call rejects, and `FallbackChatCache` downgrades. */
    private readonly factory: IDBFactory | null = pageIndexedDb()
  ) {}

  private key(bot: string): string {
    return cacheRowKey(this.ns, bot)
  }

  private db(): Promise<IDBDatabase> {
    if (!this.opening) {
      this.opening = new Promise<IDBDatabase>((resolve, reject) => {
        const factory = this.factory

        if (!factory) {
          reject(new Error('This browser has no IndexedDB.'))

          return
        }

        const request = factory.open(CHAT_CACHE_DATABASE, DATABASE_VERSION)

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
        // A private window may answer neither event; without this the first
        // cached read would hang for the life of the tab instead of downgrading.
        request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'))
      }).catch((error: unknown) => {
        // A failed open must not poison every later call; the next one retries.
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

    if (!row) {
      return null
    }

    const { ns: _ns, ...rest } = row

    return { ...rest, bot: cacheRowName(row.bot) }
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

    // A scan rather than an index: a roster is a dozen rows.
    return rows
      .filter(row => row.ns === this.ns)
      .map(({ ns: _ns, ...row }) => ({ ...row, name: cacheRowName(row.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The roster is replaced wholesale: a bot the gateway no longer lists has to
   * disappear from the cached list too.
   */
  async writeBots(rows: CachedBotRow[]): Promise<void> {
    // Read in a transaction of its own, then write in one that issues nothing
    // but synchronous requests: a readwrite transaction that awaits halfway
    // may have auto-committed by the time the writes are issued.
    const mine = await this.keysOf(BOTS, 'name')
    const [store, transaction] = await this.store(BOTS, 'readwrite')

    for (const key of mine) {
      store.delete(key)
    }

    for (const row of rows) {
      store.put({ ...row, name: this.key(row.name), ns: this.ns })
    }

    await settled(transaction)
  }

  /** This namespace's rows only; another base path's cache on the same origin stays. */
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

  /** Every stored key in one store that belongs to this namespace. */
  private async keysOf(name: string, keyPath: 'bot' | 'name'): Promise<string[]> {
    const [store] = await this.store(name, 'readonly')
    const rows = await promise<Stored<Record<string, unknown>>[]>(
      store.getAll() as IDBRequest<Stored<Record<string, unknown>>[]>
    )

    return rows.filter(row => row.ns === this.ns && typeof row[keyPath] === 'string').map(row => row[keyPath] as string)
  }
}

const caches = new Map<string, ChatCache>()

/**
 * The page's cache for one namespace. Memoised, so every controller that asks
 * shares one instance and one database handle.
 */
export function chatCacheFor(ns: string): ChatCache {
  const existing = caches.get(ns)

  if (existing) {
    return existing
  }

  const cache = new FallbackChatCache(new IndexedDbChatCache(ns))
  caches.set(ns, cache)

  return cache
}
