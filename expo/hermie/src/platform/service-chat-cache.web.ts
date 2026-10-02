/**
 * The service's copy of a chat, read before the socket answers.
 *
 * [ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md). The
 * browser's own cache is IndexedDB, which belongs to this browser on this
 * device. Hermie Web keeps one too — fed by the link it already holds for push
 * and by the transcript reads it already proxies — and that one belongs to the
 * deployment. So a chat opened on a laptop that has never seen it paints from
 * the server instead of spinning, which is the entire point.
 *
 * ## The order, and why it is this way round
 *
 * Local first, service second, gateway last.
 *
 * The local snapshot is what THIS browser painted the last time it had this
 * chat open, so repainting it is the stillest possible first frame — the items
 * are the ones already on screen a moment ago, with the ids the reconcile will
 * keep. The service's copy is a fallback for the case the local one cannot
 * cover at all: nothing stored yet. Preferring the service copy when both exist
 * would put a network round trip on the path of every chat open in exchange for
 * a paint that is no better.
 *
 * `chat-controller.ts` awaits this read before `session.resume`, so "before the
 * socket answers" is a property of the caller and this file only has to be
 * quick and unable to throw.
 *
 * ## Why the conversion is here and not on the server
 *
 * The service stores the gateway's ROWS, untransformed: it ships with no
 * `node_modules` and cannot import `@hermie/transcript`, and the item format is
 * the app's to change. So `rowsToItems` runs here, with the same shape argument
 * a live history read uses — and that is also what makes the ids line up, since
 * both paths project the same rows through the same function.
 *
 * The snapshot is built WITHOUT `lastSeqSessionId`, which makes
 * `stateFromCache` read it as cold: the chat paints, and the hydration that
 * follows adopts the gateway's watermark without replaying events the history
 * read already contains. The service's own watermark is not borrowed, because
 * the service's rows and its event counter are fed by two different paths and a
 * watermark ahead of its rows would silently drop a turn.
 */
import { CACHE_FORMAT, type CachedTranscript, type RowShape, rowsToItems, type TranscriptRow } from '@hermie/transcript'

import type { CachedTranscriptRow, ChatCache } from './chat-cache-core'

/** What `GET /hermie/cache/<id>` answers with. */
export interface ServiceCacheAnswer {
  sessionId: string
  bot: string
  storedId: string
  shape: RowShape
  updatedAt: number
  rows: TranscriptRow[]
}

/**
 * How long the service read may take before the chat is painted without it.
 *
 * It sits on the path of every cold chat open, and the thing it competes with
 * is `session.resume` over a socket that is already connected. A read that is
 * slower than the gateway's own answer has stopped being an optimisation.
 */
export const SERVICE_CACHE_TIMEOUT_MS = 1_500

export function snapshotFromServiceAnswer(answer: ServiceCacheAnswer): CachedTranscript {
  const items = rowsToItems(answer.rows, answer.shape)
  const lastRowId = items.reduce<number | undefined>(
    (last, item) => (item.rowId !== undefined ? item.rowId : last),
    undefined
  )

  return {
    format: CACHE_FORMAT,
    items,
    // The service stores rows, and a sub-agent is not one: its progress is
    // live state the gateway replays, never a transcript row to be read back.
    subagents: [],
    ...(lastRowId !== undefined ? { lastRowId } : {}),
    // Deliberately zero and with no session id beside it. See the note above.
    lastSeq: 0,
    updatedAt: answer.updatedAt * 1000
  }
}

/** Is this the answer we asked for, as far as anything here reads it? */
function answerOf(body: unknown): ServiceCacheAnswer | null {
  const bag = (body ?? {}) as Record<string, unknown>

  if (!Array.isArray(bag.rows) || !bag.rows.length) {
    return null
  }

  return {
    sessionId: typeof bag.sessionId === 'string' ? bag.sessionId : '',
    bot: typeof bag.bot === 'string' ? bag.bot : '',
    storedId: typeof bag.storedId === 'string' ? bag.storedId : '',
    shape: bag.shape === 'rpc' ? 'rpc' : 'rest',
    updatedAt: typeof bag.updatedAt === 'number' ? bag.updatedAt : 0,
    rows: bag.rows as TranscriptRow[]
  }
}

export interface ServiceChatCacheOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * A chat cache that falls through to the service when the local store has
 * nothing.
 *
 * Only `read` is different. Writes, the bot roster and `clear` all go to the
 * local store alone: the service's copy is the service's to fill, and a browser
 * writing back into it would be a client telling a server what a transcript
 * says.
 */
export class ServiceChatCache implements ChatCache {
  constructor(
    private readonly local: ChatCache,
    private readonly options: ServiceChatCacheOptions = {}
  ) {}

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    const local = await this.local.read(bot)

    if (local) {
      return local
    }

    return this.readFromService(bot)
  }

  /**
   * Ask the service for this bot's tail.
   *
   * Every failure is `null`, and there are several ordinary ones: no Hermie Web
   * in front of this page at all, a cache turned off with `--cache-max-mb 0`, a
   * 401 because the reader has not signed in yet, a 404 because nothing has
   * ever filled this chat. None of them is worth a line in the console, and
   * none of them costs anything but a cold paint.
   */
  private async readFromService(bot: string): Promise<CachedTranscriptRow | null> {
    const fetchImpl = this.options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)

    if (!fetchImpl) {
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? SERVICE_CACHE_TIMEOUT_MS)

    try {
      const response = await fetchImpl(`/hermie/cache/${encodeURIComponent(bot)}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: controller.signal
      })

      if (!response.ok) {
        return null
      }

      const answer = answerOf(await response.json())

      if (!answer) {
        return null
      }

      const snapshot = snapshotFromServiceAnswer(answer)

      return {
        bot,
        itemsJson: JSON.stringify(snapshot),
        lastRowId: snapshot.lastRowId ?? null,
        lastSeq: snapshot.lastSeq,
        epoch: null,
        updatedAt: snapshot.updatedAt
      }
    } catch {
      return null
    } finally {
      // The race is over either way, and a timer nobody is waiting for still
      // holds a test runner open long after the tab would have stopped caring.
      clearTimeout(timer)
    }
  }

  write(snapshot: CachedTranscriptRow): Promise<void> {
    return this.local.write(snapshot)
  }

  forget(bot: string): Promise<void> {
    return this.local.forget(bot)
  }

  readBots(): Promise<Parameters<ChatCache['writeBots']>[0]> {
    return this.local.readBots()
  }

  writeBots(rows: Parameters<ChatCache['writeBots']>[0]): Promise<void> {
    return this.local.writeBots(rows)
  }

  clear(): Promise<void> {
    return this.local.clear()
  }
}
