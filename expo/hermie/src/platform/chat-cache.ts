/**
 * Offline snapshot of the bot roster and of every Bot Chat, on SQLite.
 *
 * The cache exists so a chat paints before the gateway has said a word: the
 * stored items are handed straight to `stateFromCache`, drawn as
 * `hydration: 'cached'`, and then reconciled against the live transcript, which
 * keeps item ids stable and stops the thread from remounting under the user.
 *
 * The contract, the memory cache and the downgrade wrapper live in
 * `chat-cache-core.ts`; this file is the platform half and the web seam
 * (`chat-cache.web.ts`) replaces exactly it.
 */
import * as SQLite from 'expo-sqlite'

import {
  cacheRowKey,
  cacheRowName,
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache
} from './chat-cache-core'

export {
  cacheRowKey,
  cacheRowName,
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache,
  MemoryChatCache
} from './chat-cache-core'

const DATABASE_NAME = 'hermie-chats.db'

/**
 * One database, two columns per table that say which gateway a row belongs to.
 *
 * The KEY column holds `<gateway id>:<bot>` so the primary key stays one column
 * and no table has to be rebuilt, and `ns` holds the id on its own so that
 * "replace this gateway's roster" is an exact `DELETE ... WHERE ns = ?` rather
 * than a `LIKE` over a pattern somebody could get wrong.
 *
 * A database written before any of this has neither column. `ensureColumns`
 * adds them, and `migrateChatCacheNamespace` fills them in for the one gateway
 * those rows can have belonged to.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bots (
  name TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  avatar_rev INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  ns TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS transcripts (
  bot TEXT PRIMARY KEY NOT NULL,
  items_json TEXT NOT NULL,
  last_row_id INTEGER,
  last_seq INTEGER,
  epoch TEXT,
  updated_at INTEGER NOT NULL,
  ns TEXT NOT NULL DEFAULT ''
);
`

/** `ALTER TABLE` on a database that predates the column, and a no-op after that. */
async function ensureColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  for (const table of ['bots', 'transcripts']) {
    try {
      await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ns TEXT NOT NULL DEFAULT ''`)
    } catch {
      // Already there. SQLite has no `ADD COLUMN IF NOT EXISTS`, and reading
      // `PRAGMA table_info` first would be the same question asked twice.
    }
  }
}

interface TranscriptDbRow {
  bot: string
  items_json: string
  last_row_id: number | null
  last_seq: number | null
  epoch: string | null
  updated_at: number
}

interface BotDbRow {
  name: string
  json: string
  avatar_rev: number
  updated_at: number
}

/**
 * The persistent cache.
 *
 * Every method funnels through `db()`, a single-flight open that also creates
 * the schema. Opening lazily rather than in the constructor is what lets the
 * factory below fall back to memory on a platform where the native module links
 * but throws the first time it is actually used.
 */
export class SqliteChatCache implements ChatCache {
  private opening: Promise<SQLite.SQLiteDatabase> | null = null

  /** Which gateway's rows this instance reads and writes. */
  constructor(private readonly ns: string) {}

  private key(bot: string): string {
    return cacheRowKey(this.ns, bot)
  }

  private db(): Promise<SQLite.SQLiteDatabase> {
    if (!this.opening) {
      this.opening = SQLite.openDatabaseAsync(DATABASE_NAME)
        .then(async database => {
          await database.execAsync(SCHEMA)
          await ensureColumns(database)

          return database
        })
        .catch(error => {
          // A failed open must not poison every later call with the same
          // rejected promise; the next call gets a fresh attempt.
          this.opening = null

          throw error
        })
    }

    return this.opening
  }

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    const database = await this.db()
    const row = await database.getFirstAsync<TranscriptDbRow>('SELECT * FROM transcripts WHERE bot = ?', this.key(bot))

    if (!row) {
      return null
    }

    return {
      bot: cacheRowName(row.bot),
      itemsJson: row.items_json,
      lastRowId: row.last_row_id,
      lastSeq: row.last_seq,
      epoch: row.epoch,
      updatedAt: row.updated_at
    }
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    const database = await this.db()

    await database.runAsync(
      `INSERT INTO transcripts (bot, items_json, last_row_id, last_seq, epoch, updated_at, ns)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot) DO UPDATE SET
         items_json = excluded.items_json,
         last_row_id = excluded.last_row_id,
         last_seq = excluded.last_seq,
         epoch = excluded.epoch,
         updated_at = excluded.updated_at,
         ns = excluded.ns`,
      this.key(snapshot.bot),
      snapshot.itemsJson,
      snapshot.lastRowId,
      snapshot.lastSeq,
      snapshot.epoch,
      snapshot.updatedAt,
      this.ns
    )
  }

  async forget(bot: string): Promise<void> {
    const database = await this.db()

    await database.runAsync('DELETE FROM transcripts WHERE bot = ?', this.key(bot))
  }

  async readBots(): Promise<CachedBotRow[]> {
    const database = await this.db()
    const rows = await database.getAllAsync<BotDbRow>('SELECT * FROM bots WHERE ns = ? ORDER BY name', this.ns)

    return rows.map(row => ({
      name: cacheRowName(row.name),
      json: row.json,
      avatarRev: row.avatar_rev,
      updatedAt: row.updated_at
    }))
  }

  /**
   * The roster is replaced wholesale rather than upserted row by row: a bot the
   * gateway no longer lists has to disappear from the cached list too, or the
   * next cold start paints a bot that is gone.
   */
  async writeBots(rows: CachedBotRow[]): Promise<void> {
    const database = await this.db()

    await database.withTransactionAsync(async () => {
      // This gateway's roster only. `DELETE FROM bots` would empty every other
      // gateway's cached list on the way past.
      await database.runAsync('DELETE FROM bots WHERE ns = ?', this.ns)

      for (const row of rows) {
        await database.runAsync(
          'INSERT INTO bots (name, json, avatar_rev, updated_at, ns) VALUES (?, ?, ?, ?, ?)',
          this.key(row.name),
          row.json,
          row.avatarRev,
          row.updatedAt,
          this.ns
        )
      }
    })
  }

  async clear(): Promise<void> {
    const database = await this.db()

    await database.runAsync('DELETE FROM transcripts WHERE ns = ?', this.ns)
    await database.runAsync('DELETE FROM bots WHERE ns = ?', this.ns)
  }
}

/**
 * Fill in the namespace for rows written before there was one.
 *
 * Only ever called with the id the single configured gateway was given, and
 * only on the launch that gave it one: rows with an empty `ns` can have
 * belonged to no other gateway, because there was no other gateway. Never
 * throws — a cache that could not be moved is a cache that starts cold, which
 * costs one paint and no conversation.
 */
export async function migrateChatCacheNamespace(gatewayId: string): Promise<void> {
  const prefix = cacheRowKey(gatewayId, '')

  try {
    const database = await SQLite.openDatabaseAsync(DATABASE_NAME)

    await database.execAsync(SCHEMA)
    await ensureColumns(database)
    await database.runAsync("UPDATE transcripts SET bot = ? || bot, ns = ? WHERE ns = ''", prefix, gatewayId)
    await database.runAsync("UPDATE bots SET name = ? || name, ns = ? WHERE ns = ''", prefix, gatewayId)
  } catch {
    // See above.
  }
}

/**
 * The app's cache for one gateway. Memoised, so the two controllers that ask
 * for the same gateway share one instance and therefore one database handle.
 */
const caches = new Map<string, ChatCache>()

export function chatCacheFor(gatewayId: string): ChatCache {
  const existing = caches.get(gatewayId)

  if (existing) {
    return existing
  }

  const cache = new FallbackChatCache(new SqliteChatCache(gatewayId))
  caches.set(gatewayId, cache)

  return cache
}
