/**
 * Searching what the bots have said, from the one field the chats list already
 * has.
 *
 * The gateway's `GET /api/sessions/search` decides the shape of this, and it is
 * narrower than it sounds — see `packages/gateway-client/src/session-search.ts`
 * for the three properties and where they were read from. Two of them land here:
 *
 *  - **One request per bot.** The route searches a single profile's `state.db`,
 *    so a roster search is a fan-out. It is bounded (`SEARCH_CONCURRENCY`) so a
 *    forty-bot gateway does not get forty sockets' worth of requests per
 *    keystroke, and one bot's failure — a 404 for a profile the gateway has
 *    dropped, a timeout — costs that bot's row and nothing else.
 *  - **One hit per conversation.** A bot appears at most once in the results,
 *    carrying the best-ranked snippet, and no amount of grouping will make it
 *    appear twice. The list says "1 match" rather than promising a count it
 *    cannot produce.
 *
 * A hit that is not this bot's canonical Bot Chat is DROPPED. A profile holds
 * sessions Hermie does not show — a cron run, somebody's CLI session, a branch —
 * and opening the forever-chat on the strength of a match in one of those would
 * land the reader in a conversation that does not contain what they searched
 * for. That is the same rule `runningBotsIn` applies to a busy session it cannot
 * place, for the same reason.
 */
import { type SessionSearchHit, searchSessions, type SessionSearchHttp } from '@hermie/gateway-client'

import type { Bot } from '../../store/bots'

/** How long the field stays still before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 300

/** How many profiles are searched at once. */
export const SEARCH_CONCURRENCY = 4

/** Hits per profile. One conversation can only produce one, so this is a ceiling on bots. */
export const SEARCH_LIMIT_PER_BOT = 5

/** A shorter window than a REST call's default: a search nobody waits for is noise. */
export const SEARCH_TIMEOUT_MS = 8_000

export interface MessageMatch {
  /** The bot whose chat matched. Known by construction: we asked that profile. */
  bot: string
  sessionId: string
  /** The gateway's snippet, markers and all. */
  snippet: string
  /** Seconds since the epoch, when the hit carried one. */
  at?: number
  role?: string
}

export interface MessageSearchOptions {
  http: SessionSearchHttp
  bots: readonly Bot[]
  query: string
  signal?: AbortSignal
  limitPerBot?: number
  concurrency?: number
  timeoutMs?: number
}

/**
 * Whether a hit is the bot's forever-chat.
 *
 * The roster knows that chat under two ids — the durable stored one and the
 * compression-lineage tip — and the search answers with the tip plus the root it
 * came from. Any of those four agreeing is the same conversation; nothing else
 * is.
 */
export function hitIsCanonical(bot: Bot, hit: SessionSearchHit): boolean {
  const known = new Set([bot.canonical?.id, bot.canonical?.resolvedId].filter(Boolean))

  return known.has(hit.sessionId) || (hit.lineageRoot !== undefined && known.has(hit.lineageRoot))
}

/** Newest first, then by name so an order never depends on which request landed first. */
export function orderMatches(matches: readonly MessageMatch[]): MessageMatch[] {
  return [...matches].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.bot.localeCompare(b.bot))
}

/** Run `work` over `items`, at most `width` at a time, keeping every answer. */
async function pooled<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = []
  let next = 0

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = next

      next += 1

      const item = items[index]

      if (item === undefined) {
        return
      }

      const result = await work(item)

      if (result !== null) {
        out.push(result)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, runner))

  return out
}

/**
 * Search every bot's chat for one query.
 *
 * Resolves with whatever came back. An aborted search resolves empty rather than
 * rejecting: the only caller is a field the reader is still typing into, and a
 * superseded query is not an error anybody wants to read about.
 */
export async function searchBotChats(options: MessageSearchOptions): Promise<MessageMatch[]> {
  const query = options.query.trim()

  if (!query || !options.bots.length) {
    return []
  }

  const matches = await pooled(options.bots, options.concurrency ?? SEARCH_CONCURRENCY, async bot => {
    if (options.signal?.aborted) {
      return null
    }

    let hits: SessionSearchHit[]

    try {
      hits = await searchSessions(options.http, {
        limit: options.limitPerBot ?? SEARCH_LIMIT_PER_BOT,
        profile: bot.name,
        query,
        timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {})
      })
    } catch {
      // One bot's gateway error is one missing row. A roster search that fails
      // whole because a profile was renamed under it is worse than a short list.
      return null
    }

    const hit = hits.find(candidate => hitIsCanonical(bot, candidate))

    if (!hit) {
      return null
    }

    return {
      bot: bot.name,
      sessionId: hit.sessionId,
      snippet: hit.snippet,
      ...(hit.at === undefined ? {} : { at: hit.at }),
      ...(hit.role === undefined ? {} : { role: hit.role })
    } satisfies MessageMatch
  })

  return options.signal?.aborted ? [] : orderMatches(matches)
}
