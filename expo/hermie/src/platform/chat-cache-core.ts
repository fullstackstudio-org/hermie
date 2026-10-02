/**
 * The half of the chat cache that has no platform in it: what a snapshot is,
 * a cache that only remembers while the process lives, and the wrapper that
 * downgrades to it when the real store misbehaves.
 *
 * It sits in its own file because there are now two real stores — SQLite on the
 * phones and the Mac, IndexedDB in a browser — and both want the same contract,
 * the same memory fallback and the same "one failure and we stop trying"
 * policy. A `.web.ts` sibling can only replace a whole module, so anything both
 * platforms share has to live somewhere neither of them owns.
 *
 * What the rows hold is deliberately opaque here — `@hermie/transcript` owns
 * the item format and its `format` field, so a shape change there invalidates a
 * snapshot without this module needing to know why.
 */

/**
 * What separates a gateway id from a bot name inside a stored row key.
 *
 * A gateway id is hex (`newGatewayId`), so the FIRST colon is always the one
 * that separates the two halves however many colons a bot name carries. That
 * one sentence is why the key can be split back apart at all, and why the id
 * goes first.
 */
export const CACHE_NS_SEPARATOR = ':'

/** The stored key for one bot's row inside one gateway's namespace. */
export const cacheRowKey = (ns: string, name: string): string => `${ns}${CACHE_NS_SEPARATOR}${name}`

/** The bot name back out of a stored key. */
export function cacheRowName(key: string): string {
  const at = key.indexOf(CACHE_NS_SEPARATOR)

  // A key with no separator is a row from before the cache had namespaces. It
  // is only reachable if the one-time move did not finish, and reading it as
  // the whole name is what it meant when it was written.
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

/**
 * Non-persistent cache. It satisfies the contract without a database, which
 * keeps the app running where no storage engine is available and makes tests
 * independent of native storage.
 */
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
 * time that store throws.
 *
 * A native module that is present is not a native module that works — a full
 * disk, a corrupt database file, a sandbox that refuses the path, a browser in
 * private mode that refuses IndexedDB — and the app is not allowed to lose a
 * chat over a cache. So every call is tried against the primary once; the first
 * failure downgrades the whole instance to memory and logs one line, and the
 * chat carries on with a cache that simply forgets between launches.
 */
export class FallbackChatCache implements ChatCache {
  private primary: ChatCache | null
  private readonly fallback = new MemoryChatCache()

  constructor(primary: ChatCache) {
    this.primary = primary
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

  clear(): Promise<void> {
    return this.run(cache => cache.clear())
  }
}
