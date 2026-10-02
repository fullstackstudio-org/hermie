/**
 * Everything the bot roster needs from the gateway.
 *
 * The store next door holds the state; this holds the round trips, so the store
 * stays a pure reducer and this stays drivable from a test with a hand-written
 * `ChatGateway`.
 *
 * The one piece of real logic here is canonical-chat resolution, and it is the
 * piece most worth reading: a bot has exactly ONE forever-chat, the session on
 * its profile titled exactly `Bot Chat`, and every way of getting that wrong
 * ends with the bot apparently losing its memory.
 */
import type { ProfileRow, SessionActiveItem, SessionListRow } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'
import type { CachedBotRow, ChatCache } from '../../platform/chat-cache'
import { type Bot, type BotCanonicalSession, botFromProfileRow, type BotsState } from '../../store/bots'

/** The canonical Bot Chat title. `(profile, title)` is the bot's chat identity. */
export const CANONICAL_CHAT_TITLE = 'Bot Chat'

/** Upper bound on the per-profile `session.list` scan, matching the desktop's. */
export const PROFILE_SESSION_LIST_LIMIT = 200

/** Terminal width the gateway renders transcripts at; the desktop uses the same. */
export const SESSION_COLUMNS = 96

/** How often the roster re-reads running state while the list is on screen. */
export const ACTIVE_LIST_POLL_MS = 10_000

/**
 * `LiveSessionStatus` values that mean the bot is doing something. `waiting` is
 * in: a bot parked on an approval is working, and showing it as idle is how a
 * question goes unanswered for an hour.
 */
const BUSY_SESSION_STATUS: ReadonlySet<string> = new Set(['starting', 'waiting', 'working', 'streaming', 'resuming'])

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

/** The three session ids a chat is known under; `ChatState` satisfies it. */
export interface ChatSessionIds {
  storedSessionId?: string | undefined
  resolvedSessionId?: string | undefined
  runtimeSessionId?: string | undefined
}

/** Read-only view of the chat store, for `refreshRunning`'s attribution. */
export type ChatSessionIdSource = {
  getState: () => { chats: Readonly<Record<string, ChatSessionIds>> }
}

/**
 * The private-chat half of the roster, as the one method this controller needs.
 *
 * A narrow interface rather than the class itself, so `features/user-chats`
 * depends on the roster and never the other way round — and so a test can hand
 * in two lines instead of a directory.
 */
export interface UserChatSource {
  /** Is this bot's chosen chat the reader's own? */
  chose(botName: string): boolean
  /** What was resolved for this bot already, if anything. */
  cached(botName: string): BotCanonicalSession | null
  /** Resolve it, minting it if this reader has never had one. */
  resolve(bot: Bot): Promise<BotCanonicalSession>
  /**
   * Sub-chats: where the reader's memory puts this bot — a stored id, `null`
   * for a legacy entry, `undefined` for the group chat. Optional: a source
   * without it is the two-position switch and nothing else.
   */
  target?(botName: string): string | null | undefined
  /** Find what `target` names, lookup-only. Throws when the listing failed. */
  resolveTarget?(bot: Bot): Promise<CurrentResolution>
  /**
   * Change that memory. `{ chore: true }` for the app's own corrections — a
   * stale id forgotten, a legacy entry resolved to its id — which are synced but
   * never outrank a choice somebody made on another device.
   */
  rememberCurrent?(botName: string, storedId: string | null, options?: { chore?: boolean }): void
}

/**
 * Where a bot's remembered conversation turned out to be, lookup-only.
 *
 *  - `group`: the reader's memory names no own chat for this bot;
 *  - `own`: it does, and the listing still holds it. `legacy` says it was found
 *    by the bare lead's title rather than by id, so the caller can remember the
 *    id it now knows;
 *  - `missing`: it does and the listing does not hold it. For an id that means
 *    the chat is gone and the memory should go with it; for a legacy entry it
 *    means the bare-lead chat was never persisted: the entry is cleared and
 *    NOTHING is minted.
 */
export type CurrentResolution =
  | { kind: 'group' }
  | { kind: 'own'; session: BotCanonicalSession; legacy: boolean }
  | { kind: 'missing'; legacy: boolean }

export interface BotsControllerOptions {
  gateway: ChatGateway
  store: StoreApi<BotsState>
  cache?: ChatCache | null
  now?: () => number
  /**
   * Where the reader's own chats live (ADR-0007, amended).
   *
   * Optional, and absent is the whole of the old behaviour: no private chats,
   * no switch, every bot resolved to its shared canonical chat.
   */
  userChats?: UserChatSource | null
  /**
   * The chat store. Only its session ids are read, and only to attribute a busy
   * session to a bot — see `refreshRunning`. Optional so the roster still works
   * before any chat is open; a bot with no ids simply cannot be attributed.
   */
  chats?: ChatSessionIdSource | null
}

/** What `session.create` handed back for a freshly minted canonical chat. */
export interface CreatedCanonicalSession {
  canonical: BotCanonicalSession
  /**
   * The RUNTIME id of the new session, which is the id every session-scoped RPC
   * takes. A caller that wants to address the chat before resuming it — to write
   * its title, say — needs this one and not the durable id beside it.
   */
  runtimeSessionId: string
}

export interface CreateCanonicalOptions {
  /**
   * The stored id of the conversation this one succeeds.
   *
   * Upstream keeps it on the row (`methods_session.py::session.create`), which
   * is what lets a session list nest the new chat under the one it replaced
   * instead of showing two unrelated rows.
   */
  parentSessionId?: string
}

/**
 * Mint a bot's canonical chat.
 *
 * One copy of the create, because there are now two callers and they must agree
 * on every flag: the roster resolving a bot that has none
 * (`BotsController.runResolution`) and `/new` retiring one conversation for the
 * next (`ChatController.startNewConversation`). A chat minted with a different
 * `title`, `hidden` or `follow_profile_config` is not the same kind of object,
 * and the difference would only show up weeks later as a bot that lost its
 * memory or a chat pinned to a dead provider.
 */
export async function createCanonicalSession(
  gateway: ChatGateway,
  profile: string,
  options: CreateCanonicalOptions = {}
): Promise<CreatedCanonicalSession> {
  const created = await gateway.request('session.create', {
    profile,
    title: CANONICAL_CHAT_TITLE,
    hidden: true,
    source: 'hermie',
    cols: SESSION_COLUMNS,
    // The chat follows the profile's current model, never a pin stored on an
    // old row; without this a profile switch leaves DMs on a dead provider.
    follow_profile_config: true,
    ...(options.parentSessionId ? { parent_session_id: options.parentSessionId } : {})
  })

  const storedId = created?.stored_session_id || created?.session_id || ''

  if (!storedId) {
    throw new Error(`The gateway created a chat for ${profile} without returning its id.`)
  }

  return {
    canonical: { id: storedId, resolvedId: storedId, preview: '', lastActive: 0, messageCount: 0 },
    runtimeSessionId: typeof created?.session_id === 'string' ? created.session_id : ''
  }
}

/**
 * Index every session id the app can attribute to a bot, id → bot name.
 *
 * `SessionActiveItem` has no `profile` field, so this index is the ONLY way to
 * tell whose session a busy row is. Four ids per bot, because a session is
 * addressed by a different one depending on how it was reached:
 *
 *  - the roster's `canonical.id` (the durable stored id) and `canonical.resolvedId`
 *    (the compression-lineage tip), known without opening the chat at all;
 *  - the open chat's own copies of those two, which are refreshed on resume;
 *  - the chat's `runtimeSessionId`, which is what a row's `id` carries.
 *
 * A bot never appears twice, so the first claim on an id wins: that keeps a
 * stale runtime id from stealing a row from the bot that actually holds it.
 */
export function sessionOwnerIndex(
  bots: readonly Bot[],
  chats: Readonly<Record<string, ChatSessionIds>> = {}
): Map<string, string> {
  const owners = new Map<string, string>()

  const claim = (id: string | undefined, name: string): void => {
    if (id && !owners.has(id)) {
      owners.set(id, name)
    }
  }

  for (const bot of bots) {
    const chat = chats[bot.name]

    claim(bot.canonical?.id, bot.name)
    claim(bot.canonical?.resolvedId, bot.name)
    claim(chat?.storedSessionId, bot.name)
    claim(chat?.resolvedSessionId, bot.name)
    claim(chat?.runtimeSessionId, bot.name)
  }

  return owners
}

/**
 * The bots that own a busy row in one `session.active_list` answer.
 *
 * A busy session that maps to no known bot lights up NOBODY. The gateway hosts
 * sessions this app never opened — another client's TUI, a cron, a sub-agent —
 * and attributing one of those to a bot is exactly the bug this replaced.
 */
export function runningBotsIn(rows: readonly SessionActiveItem[], owners: ReadonlyMap<string, string>): string[] {
  const running = new Set<string>()

  for (const row of rows) {
    if (!BUSY_SESSION_STATUS.has(String(row?.status ?? ''))) {
      continue
    }

    // `id` is the runtime session id, `session_key` the stored/lineage one. A
    // row carries both and either may be the one this app knows.
    const owner = owners.get(String(row?.id ?? '')) ?? owners.get(String(row?.session_key ?? ''))

    if (owner) {
      running.add(owner)
    }
  }

  return [...running]
}

export class BotsController {
  private readonly gateway: ChatGateway
  private readonly store: StoreApi<BotsState>
  private readonly cache: ChatCache | null
  private readonly now: () => number
  private readonly chats: ChatSessionIdSource | null
  private readonly userChats: UserChatSource | null

  /** One canonical resolution per bot at a time; a double tap must not mint two chats. */
  private readonly resolutions = new Map<string, Promise<BotCanonicalSession>>()
  private refreshInFlight: Promise<Bot[]> | null = null
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private watchers = 0

  constructor(options: BotsControllerOptions) {
    this.gateway = options.gateway
    this.store = options.store
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => Date.now())
    this.chats = options.chats ?? null
    this.userChats = options.userChats ?? null
  }

  /** Paint the roster from disk. Safe to call before the socket is up. */
  async paintFromCache(): Promise<void> {
    if (!this.cache || this.store.getState().bots.length) {
      return
    }

    let rows: CachedBotRow[] = []

    try {
      rows = await this.cache.readBots()
    } catch {
      return
    }

    const bots: Bot[] = []

    for (const row of rows) {
      try {
        bots.push(JSON.parse(row.json) as Bot)
      } catch {
        // One unreadable row does not invalidate the rest of the list.
      }
    }

    if (bots.length && !this.store.getState().bots.length) {
      this.store.getState().setBots(bots, { fromCache: true })
    }
  }

  /**
   * Re-read the roster. Concurrent callers (pull to refresh landing on top of a
   * `sessions.changed` sweep) share one round trip.
   */
  refresh(): Promise<Bot[]> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const run = this.load().finally(() => {
      this.refreshInFlight = null
    })

    this.refreshInFlight = run

    return run
  }

  private async load(): Promise<Bot[]> {
    const state = this.store.getState()
    state.setLoading(true)

    try {
      const result = await this.gateway.request('profiles.list', { include_sessions: true })
      const rows: ProfileRow[] = Array.isArray(result?.profiles) ? result.profiles : []
      // The name is this bot's identity everywhere — the store key, the chat
      // key, the `profile` every RPC carries. A row without one is not a bot
      // this app can address, and a blank entry in the roster is worse than a
      // missing one.
      const bots = rows.map(botFromProfileRow).filter(bot => Boolean(bot.name))

      this.store.getState().setBots(bots)
      // What the STORE settled on, not what the wire said: a bot whose canonical
      // chat this app just switched keeps the pinned one (see `canonicalPins`),
      // and caching the roster's stale answer would put the old conversation
      // back on the next cold launch.
      const placed = this.store.getState().bots

      void this.persist(placed)
      void this.loadAvatars(placed)
      void this.placeUserChats(placed)

      return placed
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setLoading(false)
    }
  }

  private async persist(bots: Bot[]): Promise<void> {
    if (!this.cache) {
      return
    }

    const updatedAt = this.now()

    try {
      await this.cache.writeBots(
        bots.map(bot => ({
          name: bot.name,
          json: JSON.stringify(bot),
          avatarRev: bot.uiMetaRevision,
          updatedAt
        }))
      )
    } catch {
      // The roster is a convenience on disk; losing it costs one round trip.
    }
  }

  /**
   * Fetch the avatars this roster has not fetched yet.
   *
   * Keyed on `name + ui_meta_revision`: the gateway bumps that revision when the
   * asset changes, so a hit is valid forever and a miss is never retried on
   * every paint.
   */
  async loadAvatars(bots: readonly Bot[]): Promise<void> {
    const state = this.store.getState()
    const pending = bots.filter(bot => bot.hasAvatar && !state.avatarsFetched[`${bot.name}:${bot.uiMetaRevision}`])

    await Promise.all(
      pending.map(async bot => {
        try {
          const asset = await this.gateway.request('profiles.get_asset', { name: bot.name, asset: 'avatar' })

          this.store.getState().setAvatar(bot.name, bot.uiMetaRevision, asset?.found ? (asset.data ?? null) : null)
        } catch {
          // An avatar is decoration. A failed fetch is not recorded, so the
          // next roster refresh tries again.
        }
      })
    )
  }

  /**
   * Point every bot the reader chose at their OWN chat, on the roster.
   *
   * The roster answers with the profile's `canonical_session`, which is the
   * SHARED chat and nothing else — the gateway has no idea this reader has one
   * of their own. Left alone, a bot whose switch says "My chat" would show the
   * shared conversation's preview, count its unread, and only open the right
   * one once it was tapped.
   *
   * So the chosen ones are resolved and pinned, through the same
   * `setCanonical` the canonical swap uses: the pin survives the next roster
   * read (see `canonicalPins`), which is exactly what it is for.
   *
   * Best effort and never awaited by the load. A private chat that could not be
   * resolved leaves that row showing the shared one, which is wrong but legible;
   * a roster that refused to paint until every private chat answered would be a
   * home screen held up by a bot that is merely slow.
   *
   * Public because the load is not the only caller. Who this is and which bots
   * they chose both arrive AFTER the first roster read — `/api/auth/me` and the
   * `ui_meta` reconcile, in that order — so `ChatRuntime` runs this again once
   * both are in, rather than spending a second `profiles.list` to do it.
   */
  async placeUserChats(bots: readonly Bot[] = this.store.getState().bots): Promise<void> {
    // With sub-chats this is `placeCurrentChats` under its old name (kept until
    // the switch goes): the pin below is exactly what sub-chats replaced.
    if (this.tracksCurrent) {
      return this.placeCurrentChats(bots)
    }

    const directory = this.userChats

    if (!directory) {
      return
    }

    await Promise.all(
      bots
        .filter(bot => directory.chose(bot.name))
        .map(async bot => {
          try {
            const session = await directory.resolve(bot)

            // The roster may have been replaced while this was in the air —
            // another gateway, a sign-out. Only place it if the bot is still
            // here and still chosen.
            if (directory.chose(bot.name) && this.store.getState().byName[bot.name]) {
              this.store.getState().setCanonical(bot.name, session)
            }
          } catch {
            // See above: the row keeps the shared chat until the reader opens
            // it, at which point the same resolution runs and reports.
          }
        })
    )
  }

  /** Whether the reader's own chats are tracked per bot (sub-chats) rather than by the switch. */
  get tracksCurrent(): boolean {
    return Boolean(this.userChats?.target && this.userChats.resolveTarget)
  }

  /**
   * Put each bot's remembered conversation on the roster (sub-chats).
   *
   * For every bot, what the reader's memory names is looked up — an id in the
   * profile's listing, a legacy entry by the bare lead's title — and set as
   * `Bot.current`, or cleared for the group chat. Lookup only: a remembered id
   * the listing no longer holds is forgotten (the bot opens its group chat), a
   * legacy entry that finds nothing is cleared too (after that one lookup), and
   * nothing is ever minted. Only "New chat" creates.
   *
   * A bot whose chat is bound on this device is skipped. Its key is on the
   * conversation the reader has in front of them, and a choice made on another
   * device must not pull that transcript out from under them (Owner Decision
   * 4); `ChatController.openChat` applies the memory on the next open.
   *
   * Best effort per bot, and never awaited by a roster load, for the reason
   * `placeUserChats` gives.
   */
  async placeCurrentChats(bots: readonly Bot[] = this.store.getState().bots): Promise<void> {
    if (!this.tracksCurrent) {
      return
    }

    await Promise.all(
      bots
        .filter(bot => !this.isBound(bot.name))
        .map(async bot => {
          try {
            const session = await this.settleCurrent(bot)

            // The roster may have been replaced, or the chat opened, while this
            // was in the air.
            if (this.store.getState().byName[bot.name] && !this.isBound(bot.name)) {
              this.store.getState().setCurrent(bot.name, session)
            }
          } catch {
            // The row keeps what it had until the next placement or open.
          }
        })
    )
  }

  /**
   * Which of the reader's own chats this bot's key belongs on, by the reader's
   * memory — or `null` for the group chat. Lookup only; the store is NOT
   * touched, because the caller decides whether a bound chat may move.
   *
   * The memory's own corrections happen here: a legacy entry that resolved is
   * remembered by the id it now has, and an id the listing no longer holds is
   * forgotten. Both as chores. A failed listing throws and forgets nothing.
   */
  async settleCurrent(bot: Bot): Promise<BotCanonicalSession | null> {
    const source = this.userChats

    if (!source?.target || !source.resolveTarget) {
      return bot.current ?? null
    }

    const target = source.target(bot.name)

    if (target === undefined) {
      return null
    }

    const known = this.store.getState().byName[bot.name]?.current ?? bot.current

    if (typeof target === 'string' && known?.id === target) {
      return known
    }

    const outcome = await source.resolveTarget(bot)

    if (source.target(bot.name) !== target) {
      // The memory moved while the listing was in the air — a pick on this
      // device, or another device's arriving. Answer for what it says now.
      return this.settleCurrent(bot)
    }

    if (outcome.kind === 'own') {
      if (outcome.legacy) {
        source.rememberCurrent?.(bot.name, outcome.session.id, { chore: true })
      }

      return outcome.session
    }

    if (outcome.kind === 'missing') {
      // A gone id, or a legacy entry whose bare-lead chat was never persisted:
      // either way the bot is on its group chat, and the memory says so, as a
      // chore, rather than costing a listing on every open.
      source.rememberCurrent?.(bot.name, null, { chore: true })
    }

    return null
  }

  /**
   * The conversation this bot's key opens on: its current own chat, else the
   * group chat, resolved as `resolveCanonical` resolves it.
   */
  resolveCurrent(bot: Bot): Promise<BotCanonicalSession> {
    return bot.current ? Promise.resolve(bot.current) : this.resolveCanonical(bot)
  }

  /** Whether a chat is bound under this bot's key on this device right now. */
  private isBound(botName: string): boolean {
    return Boolean(this.chats?.getState().chats[botName])
  }

  /**
   * Refresh running state for every bot, in ONE round trip.
   *
   * `session.active_list` is NOT profile-scoped, however much its parameters
   * suggest otherwise. Upstream it is a plain method that returns every live
   * session in the gateway PROCESS and never reads the `profile` it accepts
   * (`tui_gateway/methods_session.py`, `session.active_list`). This used to call
   * it once per bot with that profile and mark the bot running if any returned
   * row was busy — so one busy session painted the working bead on every row in
   * the list, which is precisely what it looked like, and it spent N identical
   * round trips per poll to do it.
   *
   * Attribution therefore cannot come from the answer; it comes from the ids
   * this app already holds. See `sessionOwnerIndex` for the four per bot and
   * `runningBotsIn` for the matching. A busy session this app cannot place
   * lights up nobody.
   *
   * No `profile` is sent, because sending one would document a scoping that does
   * not exist. If upstream ever does scope the method, this under-reports rather
   * than over-reports — and a bot the user is talking to still shows as working
   * off its own streaming `turn.active`, which is the other half of the signal.
   *
   * A failed call is reported as nothing running rather than as an error: a
   * spinner that will not go away is worse than a missing one.
   */
  async refreshRunning(): Promise<void> {
    const bots = this.store.getState().bots

    if (!bots.length) {
      this.store.getState().setRunning([])

      return
    }

    let rows: SessionActiveItem[] = []

    try {
      const result = await this.gateway.request('session.active_list', {})

      rows = Array.isArray(result?.sessions) ? result.sessions : []
    } catch {
      this.store.getState().setRunning([])

      return
    }

    this.store.getState().setRunning(runningBotsIn(rows, sessionOwnerIndex(bots, this.chats?.getState().chats)))
  }

  /**
   * Start polling running state; the returned function stops it. Reference
   * counted, so two mounted lists share one interval.
   */
  watchRunning(): () => void {
    this.watchers += 1

    if (this.watchers === 1) {
      void this.refreshRunning()
      this.pollTimer = setInterval(() => void this.refreshRunning(), ACTIVE_LIST_POLL_MS)
    }

    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.watchers -= 1

      if (this.watchers === 0 && this.pollTimer !== undefined) {
        clearInterval(this.pollTimer)
        this.pollTimer = undefined
      }
    }
  }

  /**
   * The bot's forever-chat, resolved the way the desktop resolves it.
   *
   * Three steps, in this order and no other:
   *
   * 1. The roster's own `canonical_session`, which the gateway resolved by
   *    title server-side. No round trip.
   * 2. `session.list {title:'Bot Chat', include_hidden:true, profile}` — an
   *    indexed exact-title lookup, not a recency window, because a busy profile
   *    can push the forever-chat out of any window. Canonical chats are always
   *    hidden, so `include_hidden` is not optional.
   * 3. Only then `session.create`, and only after step 2 has run again: a
   *    backend that was still warming up can answer step 2 with an empty list
   *    rather than an error, and minting on that answer forks the chat.
   *
   * A failed lookup throws. It must never read as "this bot has no chat".
   */
  resolveCanonical(bot: Bot): Promise<BotCanonicalSession> {
    const existing = this.resolutions.get(bot.name)

    if (existing) {
      return existing
    }

    const run = this.runResolution(bot).finally(() => {
      this.resolutions.delete(bot.name)
    })

    this.resolutions.set(bot.name, run)

    return run
  }

  private async runResolution(bot: Bot): Promise<BotCanonicalSession> {
    /*
      The reader's own chat wins BEFORE the roster's answer is trusted.

      `bot.canonical` still names the shared chat until `placeUserChats` has
      pinned the private one, so a short-circuit on it here would open the
      shared transcript for a bot whose switch says otherwise — once, on the
      first tap after a cold launch, which is the hardest kind of wrong to
      notice. The directory memoises, so this costs nothing after the first.

      With sub-chats this is skipped: the canonical always names the group
      chat, and the reader's own chat is `Bot.current`, which `resolveCurrent`
      reads. Resolution there never mints an own chat.
    */
    if (!this.tracksCurrent && this.userChats?.chose(bot.name)) {
      return this.userChats.resolve(bot)
    }

    if (bot.canonical?.id) {
      return bot.canonical
    }

    return this.resolveShared(bot)
  }

  /**
   * The bot's SHARED canonical chat, whatever the reader chose.
   *
   * The three steps `resolveCanonical` documents, with the private-chat branch
   * and the roster short-circuit both taken out: the switch coming back to
   * "Shared Bot Chat" has to find the shared one even while `bot.canonical` is
   * still pinned to the reader's own.
   */
  async resolveShared(bot: Bot): Promise<BotCanonicalSession> {
    const found = await this.lookupCanonical(bot)

    if (found) {
      return found
    }

    // Re-run the lookup before minting. Between the first lookup and here the
    // bot may have answered a teammate's DM, which creates the chat server-side.
    const second = await this.lookupCanonical(bot)

    if (second) {
      return second
    }

    return (await createCanonicalSession(this.gateway, bot.name)).canonical
  }

  private async lookupCanonical(bot: Bot): Promise<BotCanonicalSession | null> {
    let rows: SessionListRow[]

    try {
      const result = await this.gateway.request('session.list', {
        profile: bot.name,
        title: CANONICAL_CHAT_TITLE,
        limit: PROFILE_SESSION_LIST_LIMIT,
        include_hidden: true
      })

      rows = result?.sessions ?? []
    } catch (error) {
      // FAIL CLOSED. A lookup that errored is not a bot without a chat, and
      // treating it as one is the one remaining way to fork a forever-chat.
      throw new Error(`Could not check ${bot.name}'s chat registry (${messageOf(error)}) — not starting a new chat.`)
    }

    const match = rows.find(row => String(row.title ?? '').trim() === CANONICAL_CHAT_TITLE) ?? rows[0]

    if (!match?.id) {
      return null
    }

    return {
      id: match.id,
      resolvedId: match.resolved_id || match.id,
      preview: typeof match.preview === 'string' ? match.preview : '',
      lastActive: 0,
      messageCount: typeof match.message_count === 'number' ? match.message_count : 0
    }
  }

  /** Stop every timer this controller owns. */
  dispose(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }

    this.watchers = 0
    this.resolutions.clear()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
