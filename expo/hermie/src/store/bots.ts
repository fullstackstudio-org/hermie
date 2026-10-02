/**
 * The bot roster.
 *
 * A bot is a Hermes profile. Everything the list shows is derived rather than
 * stored twice: `running` comes from `session.active_list` — whose rows the
 * controller has to attribute to a bot by session id, because that call answers
 * for the whole gateway process and its rows carry no profile — unread from the
 * canonical chat's `last_active` against a per-bot watermark, and "needs input"
 * from the open requests the chat store is already holding. The roster itself
 * is cached so the list paints on launch instead of after a round trip.
 */
import type { ProfileRow } from '@hermes/shared/gateway-contract'
import { create } from 'zustand'

import type { GatewayNamespace } from '../gateway/namespace'
import { keyValueStore } from '../platform/key-value-store'

export interface BotCanonicalSession {
  /** The durable registry id. Resume on this, persist this, never the runtime id. */
  id: string
  /** The compression-lineage tip. REST transcript rows are read under this one. */
  resolvedId: string
  preview: string
  lastActive: number
  messageCount: number
}

export interface Bot {
  name: string
  displayName: string
  description: string
  model: string
  provider: string
  isDefault: boolean
  hasAvatar: boolean
  /** The bot's shared Bot Chat — the group chat — and nothing else. */
  canonical?: BotCanonicalSession
  /**
   * The reader's own chat this bot's key is bound to, when it is on one; absent
   * means the group chat (`canonical`).
   *
   * Beside `canonical` rather than a pin on it, so the canonical always names the
   * Bot Chat: the roster keeps reporting the group chat's `last_active` while the
   * reader is parked elsewhere, and a cron delivery landing there still badges.
   * Never read from the roster — `profiles.list` knows nothing about readers —
   * so `setBots` carries it across every roster answer (see `currentSessions`).
   */
  current?: BotCanonicalSession
  /**
   * Highest of the profile's `ui_meta_revisions`. Avatars are cached against
   * `name + revision`, so a changed avatar invalidates itself.
   */
  uiMetaRevision: number
}

/**
 * The read watermarks, per gateway.
 *
 * Namespaced because it is keyed by BOT NAME, and bot names are a gateway's
 * own: two gateways can both have a `researcher`, and one list's watermark
 * silently marking the other's chat as read is a message somebody never sees.
 */
export const BOT_LAST_SEEN_KEY = 'hermie.bots.last_seen'

/**
 * How many messages each of the reader's own chats held when they last read it,
 * per gateway, keyed by conversation key (`bot#<storedId>`).
 *
 * A second watermark beside `lastSeen` because a listing row carries no
 * last-activity time — `session.list` answers `message_count` and `started_at`
 * and nothing else — so a chat that is not open can only be called unread by
 * counting.
 */
export const BOT_SEEN_COUNTS_KEY = 'hermie.bots.seen_counts'

/**
 * When each of the reader's own chats was last opened or sent to ON THIS DEVICE,
 * per gateway, keyed by stored session id; unix seconds.
 *
 * The own-chat list sorts by it (most recently used first) and falls back to the
 * creation time for a chat never opened here. Deliberately never synced: it is
 * this device's habit, and a phone's list reordering because a desktop was used
 * is the list moving under somebody's thumb.
 */
export const BOT_LAST_OPENED_KEY = 'hermie.bots.last_opened'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Project one `profiles.list` row onto the roster model. */
export function botFromProfileRow(row: ProfileRow): Bot {
  const canonical = row.canonical_session
  const revisions = Object.values(row.ui_meta_revisions ?? {}).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )

  const name = str(row.name)

  return {
    name,
    displayName: str(row.display_name) || name,
    description: str(row.description),
    model: str(row.model),
    provider: str(row.provider),
    isDefault: row.is_default === true,
    hasAvatar: row.has_avatar === true,
    ...(canonical?.id
      ? {
          canonical: {
            id: canonical.id,
            resolvedId: canonical.resolved_id || canonical.id,
            preview: str(canonical.preview),
            lastActive: num(canonical.last_active),
            messageCount: num(canonical.message_count)
          }
        }
      : {}),
    uiMetaRevision: revisions.length ? Math.max(...revisions) : 0
  }
}

export interface BotsState {
  bots: Bot[]
  byName: Record<string, Bot>
  /** name → data URL. Avatars are small and the gateway ships them base64 already. */
  avatars: Record<string, string>
  /** `name + ':' + revision` for every avatar fetch already attempted, hit or miss. */
  avatarsFetched: Record<string, true>
  /** Bots the last `session.active_list` poll could place a busy session on. */
  running: Record<string, true>
  /**
   * Conversation key → the `last_active` the user has already looked at.
   *
   * The key is the bot's name for its group chat — the meaning it has always
   * had — and `bot#<storedId>` for one of the reader's own chats, so reading a
   * sub-chat never marks the group chat read.
   */
  lastSeen: Record<string, number>
  /** Conversation key → the `message_count` last read. See `BOT_SEEN_COUNTS_KEY`. */
  seenCounts: Record<string, number>
  /** Stored session id → when it was last opened here. See `BOT_LAST_OPENED_KEY`. */
  lastOpened: Record<string, number>
  /**
   * Bot name → the own chat that bot is on, carried across roster answers.
   *
   * The roster is replaced wholesale on every `profiles.list`, and that call
   * knows nothing about which conversation THIS reader is in; so the choice is
   * held here and put back onto each bot `setBots` places. Kept for a bot the
   * answer does not mention, as a pin is.
   */
  currentSessions: Record<string, BotCanonicalSession>
  /**
   * Canonical chats this app switched a bot onto, until the roster catches up.
   *
   * `setBots` overwrites every bot wholesale from `profiles.list`, and that call
   * resolves the canonical chat by TITLE server-side. Between `/new` renaming the
   * old conversation and the gateway persisting the new one there is a window in
   * which a poll — very possibly one that left before the switch — answers with
   * the OLD id, or with no canonical at all because the new session has no
   * database row yet. Either one would silently put the chat back on the
   * conversation the owner just put away.
   *
   * So a switch pins the id it switched to. While a pin stands, a roster row
   * naming anything else is ignored for that bot; the pin clears the moment the
   * roster agrees, which is the gateway confirming the switch landed.
   */
  canonicalPins: Record<string, BotCanonicalSession>
  loading: boolean
  error: string | null
  /** `Date.now()` of the last successful roster read; null while only the cache is painted. */
  refreshedAt: number | null

  setBots: (bots: Bot[], options?: { fromCache?: boolean }) => void
  /** Point a bot at a different canonical chat and hold it there — see `canonicalPins`. */
  setCanonical: (name: string, canonical: BotCanonicalSession) => void
  /**
   * Bind a bot to one of the reader's own chats, or back to its group chat with
   * `null`. Leaves `canonical` and its pins alone.
   */
  setCurrent: (name: string, session: BotCanonicalSession | null) => void
  setAvatar: (name: string, revision: number, dataUrl: string | null) => void
  setRunning: (names: readonly string[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  /** The gateway these watermarks belong to; null before the first read. */
  namespace: GatewayNamespace | null
  /** Read this gateway's watermarks: `lastSeen`, `seenCounts` and `lastOpened`. */
  hydrateLastSeen: (ns: GatewayNamespace) => Promise<void>
  /**
   * Move a conversation's read watermark forward. `key` is a conversation key —
   * the bot's name for its group chat, `bot#<storedId>` for an own chat.
   */
  markSeen: (key: string, lastActive?: number) => void
  /** Record how many messages an own chat held when it was read. */
  markSeenCount: (key: string, count: number) => void
  /** Stamp an own chat as opened (or sent to) now, on this device. */
  markOpened: (storedId: string, at?: number) => void
  /** Drop every watermark a deleted own chat left behind. */
  forgetConversation: (key: string, storedId: string) => void
  reset: () => void
}

const INITIAL = {
  namespace: null as GatewayNamespace | null,
  bots: [] as Bot[],
  byName: {} as Record<string, Bot>,
  avatars: {} as Record<string, string>,
  avatarsFetched: {} as Record<string, true>,
  running: {} as Record<string, true>,
  lastSeen: {} as Record<string, number>,
  seenCounts: {} as Record<string, number>,
  lastOpened: {} as Record<string, number>,
  currentSessions: {} as Record<string, BotCanonicalSession>,
  canonicalPins: {} as Record<string, BotCanonicalSession>,
  loading: false,
  error: null as string | null,
  refreshedAt: null as number | null
}

let lastSeenQueue: Promise<void> = Promise.resolve()

/** One queue for all three maps, so writes land in the order they were made. */
function persistMap(ns: GatewayNamespace, key: string, map: Record<string, number>): void {
  lastSeenQueue = lastSeenQueue
    .then(() => keyValueStore.setJson(ns.key(key), map))
    .catch(() => {
      // A lost watermark shows one chat as unread again; not worth an error.
    })
}

/** A stored map of finite numbers, read defensively: an older build may have written anything. */
async function readMap(ns: GatewayNamespace, key: string): Promise<Record<string, number>> {
  const stored = await keyValueStore.getJson<Record<string, unknown>>(ns.key(key))
  const out: Record<string, number> = {}

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return out
  }

  for (const [name, value] of Object.entries(stored)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[name] = value
    }
  }

  return out
}

/** `bot` with its current own chat put back, or as it came when it has none. */
const withCurrent = (bot: Bot, current: BotCanonicalSession | undefined): Bot => {
  if (current) {
    return { ...bot, current }
  }

  if (!bot.current) {
    return bot
  }

  const rest = { ...bot }

  delete rest.current

  return rest
}

export const useBotsStore = create<BotsState>((set, get) => ({
  ...INITIAL,

  setBots(bots, options = {}) {
    const pins = get().canonicalPins
    const currents = get().currentSessions
    const keptPins: Record<string, BotCanonicalSession> = {}
    const byName: Record<string, Bot> = {}
    const placed: Bot[] = []

    for (const row of bots) {
      const pinned = pins[row.name]
      // A pin whose id the roster now reports has done its job: the gateway has
      // resolved the canonical title to the chat we switched to, so the answer
      // and the pin say the same thing and the pin is dropped.
      const stale = pinned !== undefined && row.canonical?.id !== pinned.id
      const bot = withCurrent(stale && pinned ? { ...row, canonical: pinned } : row, currents[row.name])

      if (stale && pinned) {
        keptPins[row.name] = pinned
      }

      byName[bot.name] = bot
      placed.push(bot)
    }

    // A pin whose bot is missing from this answer is kept: the bot did not stop
    // existing, this list simply did not mention it.
    for (const [name, pinned] of Object.entries(pins)) {
      if (!(name in byName)) {
        keptPins[name] = pinned
      }
    }

    set({
      bots: placed,
      byName,
      canonicalPins: keptPins,
      ...(options.fromCache ? {} : { refreshedAt: Date.now(), error: null })
    })
  },

  setCanonical(name, canonical) {
    const current = get().byName[name]

    if (!current) {
      return
    }

    const bot: Bot = { ...current, canonical }

    set(state => ({
      bots: state.bots.map(entry => (entry.name === name ? bot : entry)),
      byName: { ...state.byName, [name]: bot },
      canonicalPins: { ...state.canonicalPins, [name]: canonical }
    }))
  },

  setCurrent(name, session) {
    const currentSessions = { ...get().currentSessions }

    if (session) {
      currentSessions[name] = session
    } else if (name in currentSessions) {
      delete currentSessions[name]
    } else if (!get().byName[name]?.current) {
      return
    }

    const existing = get().byName[name]

    if (!existing) {
      // No row yet: the choice is held and put onto the bot when the roster
      // places it, the way a pin is.
      set({ currentSessions })

      return
    }

    const bot = withCurrent(existing, session ?? undefined)

    set(state => ({
      currentSessions,
      bots: state.bots.map(entry => (entry.name === name ? bot : entry)),
      byName: { ...state.byName, [name]: bot }
    }))
  },

  setAvatar(name, revision, dataUrl) {
    set(state => ({
      avatarsFetched: { ...state.avatarsFetched, [`${name}:${revision}`]: true },
      ...(dataUrl ? { avatars: { ...state.avatars, [name]: dataUrl } } : {})
    }))
  },

  setRunning(names) {
    const running: Record<string, true> = {}

    for (const name of names) {
      running[name] = true
    }

    set({ running })
  },

  setLoading(loading) {
    set({ loading })
  },

  setError(error) {
    set({ error })
  },

  async hydrateLastSeen(ns) {
    const [lastSeen, seenCounts, lastOpened] = await Promise.all([
      readMap(ns, BOT_LAST_SEEN_KEY),
      readMap(ns, BOT_SEEN_COUNTS_KEY),
      readMap(ns, BOT_LAST_OPENED_KEY)
    ])

    set({ namespace: ns, lastSeen, seenCounts, lastOpened })
  },

  markSeen(key, lastActive) {
    // A bare bot name is the group chat and defaults to the roster's own
    // `last_active` for it; an own chat's key (`bot#id`) names no roster row,
    // so it falls through to the clock.
    const bot = get().byName[key]
    const at = lastActive ?? bot?.canonical?.lastActive ?? Math.floor(Date.now() / 1000)
    const current = get().lastSeen[key] ?? 0

    if (at <= current) {
      return
    }

    const lastSeen = { ...get().lastSeen, [key]: at }
    const ns = get().namespace

    set({ lastSeen })

    // Nothing is written before the gateway is known. A watermark under a key
    // nobody owns is one the next launch cannot find anyway.
    if (ns) {
      persistMap(ns, BOT_LAST_SEEN_KEY, lastSeen)
    }
  },

  markSeenCount(key, count) {
    if (!Number.isFinite(count) || count < 0 || get().seenCounts[key] === count) {
      return
    }

    // Set, not raised: unlike a timestamp a count can go DOWN — a compressed
    // session reports fewer messages than it did — and a watermark held at the
    // old high would hide every new message until the count climbed past it.
    const seenCounts = { ...get().seenCounts, [key]: count }
    const ns = get().namespace

    set({ seenCounts })

    if (ns) {
      persistMap(ns, BOT_SEEN_COUNTS_KEY, seenCounts)
    }
  },

  markOpened(storedId, at = Math.floor(Date.now() / 1000)) {
    if (!storedId || (get().lastOpened[storedId] ?? 0) >= at) {
      return
    }

    const lastOpened = { ...get().lastOpened, [storedId]: at }
    const ns = get().namespace

    set({ lastOpened })

    if (ns) {
      persistMap(ns, BOT_LAST_OPENED_KEY, lastOpened)
    }
  },

  forgetConversation(key, storedId) {
    const { lastSeen, seenCounts, lastOpened, namespace: ns } = get()
    const drop = (map: Record<string, number>, name: string): Record<string, number> | null => {
      if (!(name in map)) {
        return null
      }

      const next = { ...map }

      delete next[name]

      return next
    }
    const nextSeen = drop(lastSeen, key)
    const nextCounts = drop(seenCounts, key)
    const nextOpened = drop(lastOpened, storedId)

    set({
      ...(nextSeen ? { lastSeen: nextSeen } : {}),
      ...(nextCounts ? { seenCounts: nextCounts } : {}),
      ...(nextOpened ? { lastOpened: nextOpened } : {})
    })

    if (ns) {
      if (nextSeen) {
        persistMap(ns, BOT_LAST_SEEN_KEY, nextSeen)
      }

      if (nextCounts) {
        persistMap(ns, BOT_SEEN_COUNTS_KEY, nextCounts)
      }

      if (nextOpened) {
        persistMap(ns, BOT_LAST_OPENED_KEY, nextOpened)
      }
    }
  },

  reset() {
    // The namespace survives, and it is the one field that has to. `reset` runs
    // when a connection goes — a sign-out, a reconnect — and the gateway those
    // watermarks belong to has not changed; clearing it would leave `markSeen`
    // with nowhere to write until something re-hydrated the store, which on a
    // sign-in to the same gateway nothing does.
    set({ ...INITIAL, namespace: get().namespace })
  }
}))

/**
 * Unread is "the canonical chat moved since the user last looked at it". It is
 * deliberately a timestamp comparison rather than a counter: the gateway is the
 * only thing that knows how much happened, and it only reports `last_active`.
 */
export function isUnread(state: Pick<BotsState, 'byName' | 'lastSeen'>, name: string): boolean {
  const lastActive = state.byName[name]?.canonical?.lastActive ?? 0

  return lastActive > 0 && lastActive > (state.lastSeen[name] ?? 0)
}

/**
 * Is one of the reader's own chats unread, going by its listing row?
 *
 * A listing row carries a `message_count` and no activity time, so this counts:
 * more messages than when the chat was last read here. A chat never read on this
 * device counts from zero, which is what `isUnread` does for a group chat with no
 * watermark — both kinds of row answer the same question the same way. `key` is
 * the chat's conversation key (`bot#<storedId>`).
 */
export function isOwnUnread(state: Pick<BotsState, 'seenCounts'>, key: string, messageCount: number): boolean {
  return messageCount > 0 && messageCount > (state.seenCounts[key] ?? 0)
}

/**
 * What a bot is CALLED, from the handle the rest of the app passes around.
 *
 * A name is the gateway's identifier (`researcher`) and a display name is the
 * label a person reads (`Researcher`); the two are routinely different in case
 * alone, which is exactly the difference nobody notices until it is shown
 * somewhere prominent. Selecting the resolved string rather than the whole map
 * keeps a caller from re-rendering when an unrelated bot's presence moves.
 */
export function useBotDisplayName(name: string | undefined): string | undefined {
  return useBotsStore(state => (name === undefined ? undefined : (state.byName[name]?.displayName ?? name)))
}

/** The avatar cache key; exported so the loader and the cache agree on one spelling. */
export const avatarCacheKey = (name: string, revision: number): string => `${name}:${revision}`
