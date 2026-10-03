/**
 * The page's half of ADR-0016: the stores, mirrored onto `ui_meta` and back.
 *
 * `@hermie/gateway-client/ui-meta`'s `UiMetaSync` owns the protocol: the
 * revision table, the per-key compare-and-swap, the one retry after a re-read,
 * the dates that decide whose app section is newer, the one-time inheritance of
 * the anonymous `hermie-app`, the per-person key (`hermie-app:<user id>`) and,
 * on a gateway whose plugin does not advertise `ui_meta.per_user`, the push rows
 * kept on the bare `hermie-app` where its notifier looks. It knows nothing about
 * stores. This is the adapter, and it does four things:
 *
 *  1. **Holds the sections RAW** (`UiMetaDocuments`, the Swift app's
 *     `UIMetaDocuments`). Every field this build does not understand, every
 *     value it cannot read (a newer build's text size, a colour it has no
 *     swatch for) and every row another device wrote is carried through
 *     untouched; an edit changes only the fields it names. `read` hands
 *     `UiMetaSync` these documents, so what goes out is the gateway's last copy
 *     with this page's changes in it, never a section rebuilt from the stores.
 *  2. **Notices.** Rather than marking every setter dirty by hand, it SUBSCRIBES
 *     to the stores and diffs a projection of each field it owns (`APP_FIELDS`,
 *     `archived` and `colour` per bot). A field whose projection moved is
 *     written into the documents and its section marked, whoever changed it.
 *  3. **Dates a choice, not a chore.** A change somebody made moves the app
 *     section's `updatedAt` (`state/app-stamp.ts`); the roster folded into the
 *     list and the sweep of lapsed mutes are the layout store's `chores` and are
 *     sent undated (`markApp('chore')`), so they never outrank a choice made on
 *     another device, and never win over a section the gateway holds at all:
 *     `UiMetaSync` drops an unsent change made only of chores when the gateway
 *     has a section, and the roster is folded in again on top of what it took.
 *  4. **Waits.** A drag across a long list is many writes in a second, so the
 *     send is debounced (`UI_META_DEBOUNCE_MS`).
 *
 * **Taking a gateway's copy** (`takeApp`, the Swift app's `UIMetaDocuments.take`):
 *
 *  - The bot sections are the snapshot's, whole. A bot it has no section for has
 *    nothing archived and no colour. A bot this page still holds a change for is
 *    the gateway's section as the roster had it, with this page's `archived` and
 *    `colour` written in (`apply`), so a section carrying fields this page does
 *    not own is never sent as `null`.
 *  - The app section mirrors the arriving one: every field it carries is taken
 *    as it came (unknown ones included), and a field it no longer carries is
 *    gone, so any client can remove one. Only `KEPT_WHEN_ABSENT` keeps the held
 *    value when the arriving section is silent about it: a section written
 *    before such a field existed says nothing about it, and reading "absent" as
 *    "empty" would unpin, un-name or un-mute everything the moment an older
 *    device wrote. The stores follow the same rule (`applyToStores`).
 *  - `updatedAt` is adopted as it arrived, absent included, so the comparison
 *    stays transitive.
 *  - `push` comes from where the notifier looks (`pushHome`, else the gateway's
 *    own app section), never from this page's copy: the rows are other devices'.
 *  - Retired fields are dropped and so travel no further: `context` (HERM-119)
 *    and the availability stamp Hermie Web's daemon wrote into `push`
 *    (`RETIRED_PUSH_FIELDS`, plan W-20a: "the advert is the signal").
 *
 * **One departure from the Swift app, and why.** When this page's app section
 * wins (it holds a newer choice) the Swift app sends its own copy whole, so a
 * field another build added to the gateway's copy since this page last read it
 * is lost. Here every field this build does not project (`APP_FIELDS`) is the
 * gateway's even then, taken when it has one and gone when it does not: this
 * build cannot have chosen anything about a field it does not know, so the
 * gateway's value is the newest one there is. The same holds for a bot section
 * this page holds a change for: only `archived` and `colour` are its own. The
 * fields it does project follow last-writer-wins exactly as the Swift app and the
 * Expo app do; nothing about the dates, the conflict retry or the tombstones
 * (a bot section left with nothing at all but `v` is sent as `null`, which
 * removes it) differs.
 *
 * Ported from the Expo app's `src/store/ui-meta-bridge.ts`. Deliberate
 * differences:
 *
 *  - **Raw documents** (point 1) instead of a snapshot projected from the
 *    stores on every read: the plan asks for unknown fields to be carried
 *    forward, and the Swift app is the reference for how.
 *  - **No push, no plugin, no settings store.** This client has no push rows yet
 *    (W-25), so the push map is carried as it came (minus the retired stamp);
 *    the plugin advert is applied by the roster read (`core/gateway-client.ts`),
 *    not here; the verbosity defaults, the name order and the theme have no store
 *    on this client (W11: theming is a device-local scheme and tint), so they are
 *    carried raw like any unknown field. `Platform.OS` is not needed: it named the
 *    push row's platform, and this page writes no push row.
 *  - **Stores are injected** (`stores`), the page's own by default, so two pages'
 *    worth of stores can run against one gateway in a test.
 *  - **Pending bot edits survive a reload** (`UI_META_PENDING_KEY`), with their
 *    sections raw, as in the Swift app: the dirty bit lives in `UiMetaSync` and
 *    does not outlive the page, and the app section's date covers only the app
 *    section.
 *  - **`reconcileSoon`** coalesces reconciles (one running, at most one more), as
 *    the Swift app's `GatewayMetaBridge` does, for the `sessions.changed` sweeps.
 *  - **A change of person** drops the previous person's app section and their
 *    arrangement (`layout.forgetPerson`), as the Swift app does, rather than
 *    carrying it under the new name.
 */
import {
  APP_UPDATED_AT,
  appStampOf,
  HERMIE_APP_SECTION_VERSION,
  HERMIE_KEY,
  HERMIE_SECTION_VERSION,
  type HermieAppSection,
  type HermieBotSection,
  type UiMetaGateway,
  type UiMetaMode,
  type UiMetaSnapshot,
  readSection,
  UiMetaSync
} from '@hermie/gateway-client/ui-meta'
import type { StoreApi } from 'zustand/vanilla'

import type { KeyValueStore, WebKeyValueStore } from '../platform/key-value-store'
import { type VisibilityWatcher, visibilityWatcher } from '../platform/visibility'
import { type AppStampState, appStampStore } from '../state/app-stamp'
import type { BotsState } from '../state/bots'
import type { ConnectionStoreState } from '../state/connection'
import { type AccentName, asAccentName, readArrangement } from '../state/folders'
import { type ChatLayoutState, layoutStore } from '../state/layout'
import { mutesOf } from '../state/mute'
import { type TextSizeState, textSizeStore } from '../state/text-size'
import type { ChatGateway } from './link'

/** How long the reader has to stop moving before their arrangement goes out. */
export const UI_META_DEBOUNCE_MS = 600

/**
 * Identity-bound: the bots whose sections had not reached the gateway when the
 * page last wrote this, each with its section RAW (`null` for a section this
 * page removed), as the Swift app's `UIMetaStoredCopy` keeps them. A reload
 * marks them again from these bytes rather than rebuilding them from the
 * stores, which hold neither the fields this build does not own nor a colour it
 * cannot draw.
 */
export const UI_META_PENDING_KEY = 'ui-meta.pending'

/** What `UI_META_PENDING_KEY` holds. */
export interface StoredPending {
  v: 1
  bots: Record<string, JsonObject | null>
}

/** A JSON object as it came off the wire. */
export type JsonObject = Record<string, unknown>

/** This page's copy of its `ui_meta` sections, raw (the Swift app's `UIMetaDocuments`). */
export interface UiMetaDocuments {
  /** The app-wide section (`hermie-app:<user id>`), or `null` while there is none. */
  app: JsonObject | null
  /** Bot name → its `hermie` section. A bot with no section is absent. */
  bots: Record<string, JsonObject>
}

/** The app-section fields this page projects from its stores, and nothing else. */
export const APP_FIELDS = ['entries', 'folders', 'pinned', 'myChats', 'current', 'labels', 'mutes', 'textSize'] as const

export type AppField = (typeof APP_FIELDS)[number]

const PROJECTED: ReadonlySet<string> = new Set(APP_FIELDS)

/**
 * The fields an arriving section that is silent about them leaves alone (the
 * Swift app's `UIMetaDocuments.keptWhenAbsent`, the Expo app's `applySnapshot`).
 */
export const KEPT_WHEN_ABSENT: ReadonlySet<string> = new Set([
  'entries',
  'folders',
  'pinned',
  'myChats',
  'current',
  'labels',
  'mutes',
  'defaults',
  'botNameOrder',
  'textSize',
  'themeChoice',
  'themes'
])

/** App fields no build writes any more: dropped from the copy, so the next write removes them. */
export const RETIRED_APP_FIELDS: ReadonlySet<string> = new Set(['context'])

/** The push map. Its rows are other devices'; this page only carries it. */
export const PUSH_FIELD = 'push'

/**
 * The availability stamp Hermie Web's push daemon wrote into the app-owned
 * `push` (`packages/hermie-web/src/push/announce.ts`): retired with Hermie Web,
 * because the plugin's advert says the same under the plugin's own key.
 */
export const RETIRED_PUSH_FIELDS: readonly string[] = [
  'daemonVersion',
  'endpoint',
  'vapidPublicKey',
  'version',
  'capabilities',
  'relayOrigins',
  'at'
]

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const present = (value: unknown): boolean => value !== undefined && value !== null

/** A projection as one string, so a diff is one comparison. */
const fingerprint = (value: unknown): string => JSON.stringify(value ?? null)

/** A deep copy of a JSON value: what is held must not alias what a caller holds. */
const copyOf = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))

/** What each owned app field looks like in the stores right now. */
export function projectApp(layout: ChatLayoutState, text: TextSizeState): Record<AppField, unknown> {
  return {
    entries: layout.entries,
    folders: layout.folders,
    // Always written, empty included: a reader who unpins their last chat has to
    // be able to say so, and an omitted key reads as "this build knows nothing
    // about pins" rather than as "there are none". The same holds for every map
    // and list below.
    pinned: Object.keys(layout.pinned),
    myChats: Object.keys(layout.myChats),
    current: layout.current,
    labels: layout.labels,
    mutes: layout.mutes,
    textSize: text.textSize
  }
}

/** What each bot's owned fields look like in the layout store right now. */
export function projectBots(layout: ChatLayoutState): Record<string, { archived?: true; colour?: string }> {
  const bots: Record<string, { archived?: true; colour?: string }> = {}

  for (const name of Object.keys(layout.archived)) {
    bots[name] = { archived: true }
  }

  for (const [name, accent] of Object.entries(layout.accents)) {
    bots[name] = { ...bots[name], colour: accent }
  }

  return bots
}

/**
 * One bot's section with this page's projection written into it.
 *
 * Everything else the section carries stays. A colour this build cannot draw
 * (a newer build's swatch) is kept while the reader has not picked one here,
 * because the store could not hold it and its absence there is not a choice.
 * `null` when nothing is left but the version: a bot that is not archived and
 * has no colour has nothing to say, and is removed rather than left empty.
 */
function botSectionWith(held: JsonObject | undefined, projected: { archived?: true; colour?: string } | undefined) {
  const section: JsonObject = { ...held }
  const heldColour = section.colour

  delete section.v
  delete section.archived
  delete section.colour

  if (projected?.archived) {
    section.archived = true
  }

  if (projected?.colour) {
    section.colour = projected.colour
  } else if (present(heldColour) && asAccentName(heldColour) === undefined) {
    section.colour = heldColour
  }

  return Object.keys(section).length ? { ...section, v: HERMIE_SECTION_VERSION } : null
}

/** The two fields of a bot section that are this page's to say, read off a section. */
function ownedOf(section: JsonObject | undefined): { archived?: true; colour?: string } {
  const colour = section?.colour

  return {
    ...(section?.archived === true ? { archived: true as const } : {}),
    ...(typeof colour === 'string' && colour && colour !== 'default' ? { colour } : {})
  }
}

/** A push map without the retired availability stamp; see `RETIRED_PUSH_FIELDS`. */
export function withoutRetiredStamp(push: unknown): unknown {
  if (!isObject(push) || !RETIRED_PUSH_FIELDS.some(field => field in push)) {
    return push
  }

  const kept: JsonObject = { ...push }

  for (const field of RETIRED_PUSH_FIELDS) {
    delete kept[field]
  }

  // An empty map rather than none, when the stamp was all there was: on a
  // gateway whose notifier reads the bare `hermie-app`, `UiMetaSync` writes the
  // push map into that section only when there is one, and a map that is not
  // there would leave the stamp standing in it.
  return kept
}

/**
 * The app section a gateway's copy leaves this page holding (see the top of
 * this file). Pure, so the rules can be read and tested as one function.
 */
export function takeApp(held: JsonObject | null, snapshot: UiMetaSnapshot): JsonObject | null {
  const source = snapshot.pushHome ?? snapshot.remote
  const push = source && present(source[PUSH_FIELD]) ? withoutRetiredStamp(copyOf(source[PUSH_FIELD])) : undefined
  const arriving = snapshot.app as JsonObject | null

  const finish = (section: JsonObject): JsonObject => {
    for (const field of RETIRED_APP_FIELDS) {
      delete section[field]
    }

    if (push === undefined) {
      delete section[PUSH_FIELD]
    } else {
      section[PUSH_FIELD] = push
    }

    return section
  }

  if (!arriving) {
    // No section on the gateway: the held one stays (push rows aside), and
    // `UiMetaSync` sends it to the gateway that lacks it.
    return held ? finish({ ...held }) : null
  }

  const merged: JsonObject = {}

  for (const [key, value] of Object.entries(arriving)) {
    if (key !== APP_UPDATED_AT && key !== PUSH_FIELD && present(value)) {
      merged[key] = copyOf(value)
    }
  }

  const gateway = (snapshot.remote ?? null) as JsonObject | null

  // Silent about a field that predates it: the held value, or, when this page's
  // own copy won and never set the field, the gateway's.
  for (const key of KEPT_WHEN_ABSENT) {
    if (!present(merged[key])) {
      const value = held?.[key] ?? gateway?.[key]

      if (present(value)) {
        merged[key] = copyOf(value)
      }
    }
  }

  // The departure: this page's copy won, and every field it does not project is
  // the gateway's, which is the newest value of it there is: taken when the
  // gateway has it, and gone when the gateway no longer does (a field a section
  // can predate excepted, as above, when the gateway is silent about it).
  if (gateway && gateway !== arriving) {
    for (const key of Object.keys(merged)) {
      if (!PROJECTED.has(key) && !KEPT_WHEN_ABSENT.has(key) && key !== 'v' && !present(gateway[key])) {
        delete merged[key]
      }
    }

    for (const [key, value] of Object.entries(gateway)) {
      if (!PROJECTED.has(key) && key !== 'v' && key !== APP_UPDATED_AT && key !== PUSH_FIELD && present(value)) {
        merged[key] = copyOf(value)
      }
    }
  }

  if (present(arriving[APP_UPDATED_AT])) {
    merged[APP_UPDATED_AT] = arriving[APP_UPDATED_AT]
  }

  merged.v = HERMIE_APP_SECTION_VERSION

  return finish(merged)
}

/** The stores this bridge mirrors. The page's own unless a test hands in its own. */
export interface UiMetaStores {
  layout: StoreApi<ChatLayoutState>
  textSize: StoreApi<TextSizeState>
  appStamp: StoreApi<AppStampState>
}

/**
 * Put a gateway's copy into the stores (the Expo app's `applySnapshot`, for the
 * fields this client has a store for). Absent is not empty: a field the section
 * does not carry leaves the store's value alone. The arrival is persisted by the
 * stores like any other change and never sent back out (the bridge is deaf
 * while this runs).
 */
export function applyToStores(snapshot: UiMetaSnapshot, stores: UiMetaStores): void {
  const archived: string[] = []
  const accents: Record<string, AccentName> = {}

  for (const [name, section] of Object.entries(snapshot.bots)) {
    if (section.archived === true) {
      archived.push(name)
    }

    const accent = asAccentName(section.colour)

    if (accent && accent !== 'default') {
      accents[name] = accent
    }
  }

  const app = snapshot.app as JsonObject | null
  const names = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : undefined
  const pinned = names(app?.pinned)
  const myChats = names(app?.myChats)

  stores.layout.getState().applyRemote({
    // An absent list is not an empty one: a gateway that has never been written
    // to has no arrangement, and taking that as "no rows anywhere" would empty a
    // list the reader spent an afternoon on. `readArrangement` also migrates
    // the divider entries a section from before folders carries.
    ...(Array.isArray(app?.entries) ? { arrangement: readArrangement(app.entries, app.folders) } : {}),
    ...(isObject(app?.mutes) ? { mutes: mutesOf(app.mutes) } : {}),
    ...(pinned ? { pinned } : {}),
    ...(myChats ? { myChats } : {}),
    ...(isObject(app?.current) ? { current: app.current as Record<string, string> } : {}),
    ...(isObject(app?.labels) ? { labels: app.labels as Record<string, string> } : {}),
    archived,
    accents
  })

  if (app && present(app.textSize)) {
    stores.textSize.getState().applyRemote(app.textSize)
  }

  // The section's own date, adopted with the section, which is what makes the
  // comparison transitive. Skipped when there is no section at all: a gateway
  // nobody has written to says nothing about when anything was chosen.
  if (app) {
    stores.appStamp.getState().applyRemote(appStampOf(app as HermieAppSection))
  }
}

export interface UiMetaBridgeOptions {
  gateway: UiMetaGateway
  /** The page's own stores unless told otherwise. */
  stores?: Partial<UiMetaStores>
  /**
   * The stores' disk reads, awaited before anything is watched or compared.
   *
   * The app-wide section holds one person's settings and a reconcile decides
   * whose copy is newer, so it has to be asked of a page that holds its own copy:
   * a baseline taken from the stores' defaults would read the disk read itself
   * as somebody choosing something. Absent means "already in".
   */
  ready?: () => Promise<unknown>
  /** Where the pending bot edits are remembered across a reload; nowhere when omitted. */
  storage?: KeyValueStore | null
  /** Overridable so a test does not have to wait. */
  debounceMs?: number
  /** Wall-clock SECONDS, for dating a choice. */
  now?: () => number
  /** Re-sends of a conflicted section before it is left dirty (`UiMetaSync`). */
  retries?: number
}

export class UiMetaBridge {
  readonly sync: UiMetaSync
  private readonly stores: UiMetaStores
  private readonly ready: (() => Promise<unknown>) | undefined
  private readonly storage: KeyValueStore | null
  private readonly debounceMs: number
  private readonly now: () => number
  private held: UiMetaDocuments = { app: null, bots: {} }
  private seenApp = new Map<string, string>()
  private seenBots = new Map<string, string>()
  private chores = 0
  private applying = false
  private watching = false
  private stopped = true
  private unsubscribe: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private started: Promise<void> = Promise.resolve()
  private user = ''
  /**
   * Each bot's `hermie` section as the gateway's last roster had it, raw, or
   * absent. A bot this page holds an unsent change for is sent as THIS plus its
   * own fields (`apply`): the rest of the section is the gateway's.
   */
  private remoteBots: Record<string, JsonObject> = {}
  /** How many gateway copies this bridge has taken; see `takes`. */
  private taken = 0
  private reconciling: Promise<unknown> | null = null
  private again = false
  private pendingWrites: Promise<void> = Promise.resolve()

  constructor(options: UiMetaBridgeOptions) {
    this.stores = {
      layout: options.stores?.layout ?? layoutStore,
      textSize: options.stores?.textSize ?? textSizeStore,
      appStamp: options.stores?.appStamp ?? appStampStore
    }
    this.ready = options.ready
    this.storage = options.storage ?? null
    this.debounceMs = options.debounceMs ?? UI_META_DEBOUNCE_MS
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    const gateway = options.gateway

    this.sync = new UiMetaSync({
      // The roster `UiMetaSync` reads is also where the gateway's own bot
      // sections are learnt, raw, before it hands over its snapshot.
      gateway: {
        request: async (method, params) => {
          const result = await gateway.request(method, params)

          if (method === 'profiles.list') {
            this.noteRoster(result)
          }

          return result
        }
      },
      read: () => this.read(),
      apply: snapshot => this.apply(snapshot),
      ...(options.retries === undefined ? {} : { retries: options.retries })
    })
  }

  /** `synced` once a roster has been read and no write has been refused since; `local` otherwise. */
  get mode(): UiMetaMode {
    return this.sync.mode
  }

  /** True while something changed here has not reached the gateway. */
  get pending(): boolean {
    return this.sync.pending
  }

  /** This person's app-wide key, or `null` while nobody has been named. */
  get appKey(): string | null {
    return this.sync.appKey
  }

  /**
   * How many gateway copies this page has taken: a roster that was actually
   * read and applied (a pull that failed takes nothing). The roster is folded
   * into the arrangement only after one, so a fold never lands on a copy that
   * has not seen the gateway's.
   */
  get takes(): number {
    return this.taken
  }

  /** A copy of the sections this page holds, raw. For diagnostics and tests. */
  get documents(): UiMetaDocuments {
    return copyOf(this.held)
  }

  /**
   * Say who the gateway named, before the first reconcile: the app-wide key
   * carries that person's name. Naming the first person keeps everything; a
   * DIFFERENT person drops the previous one's app section and arrangement (never
   * published under the new name), and starts from the defaults.
   */
  setUser(userId: string): void {
    const previous = this.user

    this.user = userId
    this.sync.setUser(userId)

    if (previous && previous !== userId) {
      this.quietly(() => {
        this.held.app = null
        this.stores.layout.getState().forgetPerson()
        this.stores.appStamp.getState().applyRemote(0)
      })

      if (this.watching) {
        this.baseline()
      }
    }
  }

  /**
   * Start watching the stores, once their disk reads are in. The returned
   * function stops (the same as `stop`).
   */
  start(): () => void {
    if (!this.stopped) {
      return () => this.stop()
    }

    this.stopped = false
    this.started = (async () => {
      await this.ready?.().catch(() => undefined)
      const stored = await this.storage?.getJson<unknown>(UI_META_PENDING_KEY).catch(() => null)

      // Torn down while the disk was answering: no live subscription is left.
      if (this.stopped) {
        return
      }

      this.restorePending(stored)
      this.baseline()
      this.watch()
    })()

    return () => this.stop()
  }

  /** Stop watching and cancel a scheduled send. What is held stays held. */
  stop(): void {
    this.stopped = true
    this.watching = false

    for (const off of this.unsubscribe) {
      off()
    }

    this.unsubscribe = []
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Read the gateway's copy, take it in, and send whatever this page is still
   * holding (`UiMetaSync.reconcile`). Waits for the stores' disk reads first.
   * `null` when the roster could not be read (the local-only path).
   */
  async reconcile(): Promise<UiMetaSnapshot | null> {
    await this.started

    const result = await this.sync.reconcile()

    this.persistPending()

    return result
  }

  /**
   * Reconcile now, or once more after the one running: a burst of
   * `sessions.changed` sweeps is one or two reads of the roster, never one each.
   */
  reconcileSoon(): Promise<unknown> {
    if (this.reconciling) {
      this.again = true

      return this.reconciling
    }

    const run = (async () => {
      do {
        this.again = false
        await this.reconcile().catch(() => null)
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.reconciling = null
    })

    this.reconciling = run

    return run
  }

  /** Send whatever is dirty now, rather than after the debounce. */
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.sync.flush()
    this.persistPending()
  }

  /**
   * Sign-out: forget the revisions, the person and their app section, and stop.
   * The bot sections stay (they are about the bots).
   */
  reset(): void {
    this.stop()
    this.sync.reset()
    this.user = ''
    this.held.app = null
    this.persistPending()
  }

  /** Every stored write this bridge made has landed. For tests. */
  settled(): Promise<void> {
    return this.pendingWrites
  }

  // MARK: - UiMetaSync's two callbacks

  /** What this page holds, with the date the stamp store keeps. */
  private read(): UiMetaSnapshot {
    const stamp = this.stores.appStamp.getState().updatedAt
    let app: JsonObject | null = null

    if (this.held.app) {
      app = { ...this.held.app, v: HERMIE_APP_SECTION_VERSION }

      // Omitted while this page has never seen a choice: an absent date is
      // honest about that, and a zero would read as a date at the epoch.
      if (stamp > 0) {
        app[APP_UPDATED_AT] = stamp
      } else {
        delete app[APP_UPDATED_AT]
      }
    }

    return { app: app as HermieAppSection | null, bots: this.held.bots as unknown as Record<string, HermieBotSection> }
  }

  /** Take a gateway's copy into the documents and the stores, deafly. */
  private apply(snapshot: UiMetaSnapshot): void {
    this.taken += 1
    this.quietly(() => {
      const bots: Record<string, JsonObject> = {}

      for (const [name, section] of Object.entries(snapshot.bots)) {
        if (isObject(section)) {
          bots[name] = copyOf(section) as JsonObject
        }
      }

      /*
        A bot this page still holds a change for arrives as this page's own
        section (`withPendingKept`). Only `archived` and `colour` are this page's
        to say; everything else in it is the gateway's, as it is now. So the
        section that goes out is the gateway's with those two written in: a field
        another client added meanwhile survives, and a section this page would
        have emptied but that carries fields it does not own is kept rather than
        sent as `null`.
      */
      for (const name of this.sync.pendingBots) {
        const section = botSectionWith(this.remoteBots[name], ownedOf(bots[name]))

        if (section) {
          bots[name] = section
        } else {
          delete bots[name]
        }
      }

      this.held = { app: takeApp(this.held.app, snapshot), bots }
      applyToStores({ ...snapshot, bots: bots as unknown as Record<string, HermieBotSection> }, this.stores)
    })
    this.persistPending()
  }

  /** The gateway's own bot sections, off a roster `UiMetaSync` just read. */
  private noteRoster(result: unknown): void {
    const rows = isObject(result) && Array.isArray(result.profiles) ? result.profiles : []
    const remote: Record<string, JsonObject> = {}

    for (const row of rows) {
      const name = isObject(row) && typeof row.name === 'string' ? row.name : ''
      const section = name ? readSection<HermieBotSection>(row.ui_meta, HERMIE_KEY, HERMIE_SECTION_VERSION) : null

      if (section) {
        remote[name] = copyOf(section) as unknown as JsonObject
      }
    }

    this.remoteBots = remote
  }

  /** Mark the stored pending bots again, from their stored raw sections. */
  private restorePending(stored: unknown): void {
    const bots = isObject(stored) && stored.v === 1 && isObject(stored.bots) ? stored.bots : {}

    for (const [name, section] of Object.entries(bots)) {
      if (!name) {
        continue
      }

      if (isObject(section)) {
        this.held.bots[name] = copyOf(section)
      } else if (section === null) {
        delete this.held.bots[name]
      } else {
        continue
      }

      this.sync.markBot(name)
    }
  }

  // MARK: - Watching the stores

  /** Run `change` with the watcher deaf, then take the stores as they are as the new baseline. */
  private quietly(change: () => void): void {
    this.applying = true

    try {
      change()
    } finally {
      this.applying = false
      this.remember()
    }
  }

  /**
   * What the stores hold, written into the documents where they say nothing:
   * this page's baseline (not a choice, not sent now, but what a gateway with no
   * section is seeded from). A value the documents already hold is kept, even
   * one this build cannot read.
   */
  private baseline(): void {
    const layout = this.stores.layout.getState()
    const projected = projectApp(layout, this.stores.textSize.getState())
    const app: JsonObject = { ...this.held.app }

    for (const field of APP_FIELDS) {
      if (!present(app[field])) {
        app[field] = copyOf(projected[field])
      }
    }

    app.v = HERMIE_APP_SECTION_VERSION
    this.held.app = app

    for (const [name, fields] of Object.entries(projectBots(layout))) {
      if (!this.held.bots[name]) {
        const section = botSectionWith(undefined, fields)

        if (section) {
          this.held.bots[name] = section
        }
      }
    }

    this.remember()
  }

  private watch(): void {
    this.watching = true
    this.remember()

    const watch = (): void => this.onStoreChanged()

    this.unsubscribe = [this.stores.layout.subscribe(watch), this.stores.textSize.subscribe(watch)]
  }

  /** Fingerprint every owned field as the stores hold it now. */
  private remember(): void {
    const layout = this.stores.layout.getState()
    const projected = projectApp(layout, this.stores.textSize.getState())

    this.chores = layout.chores
    this.seenApp = new Map(APP_FIELDS.map(field => [field, fingerprint(projected[field])]))
    this.seenBots = new Map(Object.entries(projectBots(layout)).map(([name, fields]) => [name, fingerprint(fields)]))
  }

  private onStoreChanged(): void {
    if (this.applying || !this.watching) {
      return
    }

    const layout = this.stores.layout.getState()
    // Whether what moved is the list's own housekeeping: the roster folded in,
    // lapsed mutes swept, a stale id forgotten. Read per notification, which is
    // what makes it exact: each chore is a `set` of its own.
    const chore = layout.chores > this.chores

    this.chores = layout.chores

    const projected = projectApp(layout, this.stores.textSize.getState())
    const app: JsonObject = { ...this.held.app }
    let appChanged = false

    for (const field of APP_FIELDS) {
      const print = fingerprint(projected[field])

      if (this.seenApp.get(field) !== print) {
        this.seenApp.set(field, print)
        app[field] = copyOf(projected[field])
        appChanged = true
      }
    }

    if (appChanged) {
      app.v = HERMIE_APP_SECTION_VERSION
      this.held.app = app

      // A CHOICE, dated, so the newest one wins wherever it was made. Never
      // earlier than the date already held (`AppStampState.touch`).
      if (!chore) {
        this.stores.appStamp.getState().touch(this.now())
      }

      // A chore is sent, but never wins over the gateway's copy (`UiMetaSync`).
      this.sync.markApp(chore ? 'chore' : 'choice')
    }

    const bots = projectBots(layout)
    let botsChanged = false

    // A bot whose projection went away (unarchived, colour back to Default) is a
    // change too, and the one a diff over the new projection alone would miss.
    for (const name of new Set([...this.seenBots.keys(), ...Object.keys(bots)])) {
      const print = fingerprint(bots[name])

      if (this.seenBots.get(name) === print) {
        continue
      }

      if (bots[name]) {
        this.seenBots.set(name, print)
      } else {
        this.seenBots.delete(name)
      }

      const section = botSectionWith(this.held.bots[name], bots[name])

      if (section) {
        this.held.bots[name] = section
      } else {
        delete this.held.bots[name]
      }

      this.markBot(name)
      botsChanged = true
    }

    if (!appChanged && !botsChanged) {
      return
    }

    if (botsChanged) {
      this.persistPending()
    }

    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => undefined)
    }, this.debounceMs)
  }

  private markBot(name: string): void {
    this.sync.markBot(name)
  }

  /** Remember which bots have not reached the gateway, with their raw sections; nothing once none is pending. */
  private persistPending(): void {
    const storage = this.storage

    if (!storage) {
      return
    }

    const bots: Record<string, JsonObject | null> = {}

    for (const name of this.sync.pendingBots) {
      bots[name] = this.held.bots[name] ? copyOf(this.held.bots[name]) : null
    }

    const stored: StoredPending = { v: 1, bots }

    this.pendingWrites = this.pendingWrites
      .then(() =>
        Object.keys(bots).length ? storage.setJson(UI_META_PENDING_KEY, stored) : storage.delete(UI_META_PENDING_KEY)
      )
      .catch(() => {
        // A lost list costs an offline archive its survival across a reload.
      })
  }
}

/** The page's connection as `UiMetaSync` asks it: a method name and its params. */
export function uiMetaGatewayOf(gateway: Pick<ChatGateway, 'request'>): UiMetaGateway {
  const request = gateway.request as unknown as (method: string, params?: Record<string, unknown>) => Promise<unknown>

  return { request: (method, params) => request(method, params) }
}

export interface ConnectUiMetaOptions {
  /** The page's connection (`GatewayClient.gateway`). */
  gateway: Pick<ChatGateway, 'request' | 'on'>
  /** The connection's status (`GatewayClient.stores.connection`). */
  connection: StoreApi<ConnectionStoreState>
  /** The roster (`GatewayClient.stores.bots`), folded into the arrangement. */
  bots: StoreApi<BotsState>
  /** This page's key-value store: the stores read and write it, and the pending edits are kept in it. */
  storage: WebKeyValueStore
  /** Who the gateway named (`uiMetaUserIdOf`); empty is the local-only path. */
  userId: string
  /** The page's own unless a test hands in its own. */
  stores?: Partial<UiMetaStores>
  visibility?: VisibilityWatcher
  debounceMs?: number
  now?: () => number
}

export interface UiMetaRuntime {
  readonly bridge: UiMetaBridge
  /** Settles once the stores' disk reads are in. Never rejects. */
  readonly hydrated: Promise<void>
  /** Stop following the connection and stop the bridge. Idempotent. */
  stop(): void
}

/**
 * Wire the bridge to the page (the Expo app's `ChatRuntime`, the Swift app's
 * `GatewayMetaBridge`): read the stores' disks, name the person, and reconcile
 *
 *  - on every rise to `ready` (a reconnect can be another gateway process),
 *  - on every `sessions.changed` (another client writing its section is a
 *    profile change, and there is no event that means "the settings moved"),
 *  - whenever the page is shown again,
 *
 * never two at once (`reconcileSoon`). The live roster is folded into the
 * arrangement (`layout.reconcile`, a chore) only while the connection is usable
 * and a reconcile has actually taken the gateway's copy since it came up
 * (`UiMetaBridge.takes`; a pull that failed takes nothing), and again after
 * every such take: a fold made before it would be folded into an arrangement
 * this page had not read yet, and a fold that lost with the section it rode in
 * is simply made again.
 */
export function connectUiMeta(options: ConnectUiMetaOptions): UiMetaRuntime {
  const stores: UiMetaStores = {
    layout: options.stores?.layout ?? layoutStore,
    textSize: options.stores?.textSize ?? textSizeStore,
    appStamp: options.stores?.appStamp ?? appStampStore
  }
  const storage = options.storage
  const hydrated = (async () => {
    stores.textSize.getState().hydrate(storage)
    await Promise.all([stores.layout.getState().load(storage), stores.appStamp.getState().hydrate(storage)])
  })().catch(() => undefined)
  const bridge = new UiMetaBridge({
    gateway: uiMetaGatewayOf(options.gateway),
    stores,
    ready: () => hydrated,
    storage,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.now ? { now: options.now } : {})
  })
  const visibility = options.visibility ?? visibilityWatcher

  bridge.setUser(options.userId)
  bridge.start()

  let stopped = false
  /** The bridge's take count when the connection last became usable: folds wait for a take after it. */
  let takesAtReady = 0

  /** The live roster's names, or null while only the cached roster is painted. */
  const liveNames = (): string[] | null => {
    const state = options.bots.getState()

    return state.refreshedAt === null ? null : state.bots.map(bot => bot.name)
  }

  const fold = (): void => {
    const names = liveNames()

    // Only onto a copy that has taken the gateway's since the connection came
    // up: a fold made on anything else (a first pull that failed, a reconnect
    // whose roster arrived first) is folded into an arrangement this page has not
    // read, and would be sent as one.
    if (ready && bridge.takes > takesAtReady && names && !stopped) {
      stores.layout.getState().reconcile(names)
    }
  }

  const reconcile = (): void => {
    if (stopped || options.connection.getState().status !== 'ready') {
      return
    }

    void bridge.reconcileSoon().then(fold)
  }

  let ready = options.connection.getState().status === 'ready'
  const stopStatus = options.connection.subscribe(state => {
    const now = state.status === 'ready'
    const rose = now && !ready

    ready = now

    if (rose) {
      takesAtReady = bridge.takes
      reconcile()
    }
  })
  const stopChanged = options.gateway.on('sessions.changed', reconcile)
  const stopVisibility = visibility.subscribe(next => {
    if (next === 'visible') {
      reconcile()
    }
  })
  const stopBots = options.bots.subscribe((state, previous) => {
    if (state.bots !== previous.bots || state.refreshedAt !== previous.refreshedAt) {
      fold()
    }
  })

  if (ready) {
    takesAtReady = bridge.takes
    reconcile()
  }

  return {
    bridge,
    hydrated,
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      stopStatus()
      stopChanged()
      stopVisibility()
      stopBots()
      bridge.stop()
    }
  }
}
