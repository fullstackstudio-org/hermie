/**
 * How the chat list is arranged — and that is ALL it is.
 *
 * The order of the rows, the FOLDERS they are grouped into, which bots are
 * archived, what colour each chat carries and whether the list is showing at all
 * on the wide layout are the owner's arrangement of their own list.
 *
 * The arrangement itself — the top-level order, the folders and the one-folder
 * invariant — lives in `store/folders.ts` as a value and the functions that move
 * it. This file is what gives it a lifetime, a disk and a gateway.
 *
 * ADR-0012 kept all of it on the device, because the only gateway scope then in
 * view was `config.set` — global settings that Hermes Desktop and the TUI read
 * too, so a divider called "Finance" created on a phone would have rearranged
 * both. ADR-0016 found the scope that does fit: `ui_meta`, per profile, per
 * top-level key, read by nothing but Hermie. So this store is still the thing
 * the UI paints from and still the thing that works with no gateway at all —
 * and `store/ui-meta-bridge.ts` mirrors it, without this file knowing. The one
 * field that stays purely local is `sidebarCollapsed`; see `applyRemote`.
 *
 * Two consequences worth stating, because they are the ones a reader will hit:
 *
 *  - The layout is keyed by GATEWAY. "Change gateway" therefore starts with an
 *    empty arrangement — a different machine's bots are a different list — and
 *    "Sign out" keeps it, because the address survives and so does the list it
 *    described. Neither case needs any clean-up code; the key does the work.
 *  - The roster is the source of truth for WHICH bots exist. The layout only
 *    ever says where they sit, so a bot that disappears from the gateway is
 *    dropped from the arrangement lazily, on the next reconcile, without
 *    disturbing anything around it.
 */
import { create } from 'zustand'

import { keyValueStore } from '../platform/key-value-store'
import { ACCENTS, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH, type AccentName } from '../ui/tokens'
import {
  addFolder,
  botsInOrder,
  moveBotTo,
  moveBotToFolder,
  moveFolderTo,
  newFolderId,
  readArrangement,
  reconcileBots,
  removeFolder,
  renameFolder,
  setFolderColour,
  type Arrangement,
  type Folder,
  type LayoutEntry
} from './folders'
import { accentOrBrand } from '../features/branding/branding'
import { isMuted, mutesOf, withoutExpired, type Mutes } from './mute'

export const CHAT_LAYOUT_KEY = 'hermie.chats.layout'

export type { Arrangement, Folder, LayoutEntry } from './folders'

export interface PersistedLayout {
  /** The top level, in order: folders by id and loose chats. */
  entries: LayoutEntry[]
  /** Each folder's name, colour and contents. */
  folders?: Folder[]
  /**
   * Folder ids the reader has closed, on THIS device.
   *
   * Local like `sidebarCollapsed`, and for the same reason: which groups are
   * open is about the window in front of somebody, not about how their list is
   * arranged. A Mac with everything folded away must not fold a phone's list,
   * and the phone has the room to keep them open.
   */
  collapsed?: string[]
  archived: string[]
  /**
   * Chats held at the top of whatever container they sit in.
   *
   * A list rather than a map, like `archived` beside it and for the same reason:
   * the value is always "yes", so a map would be a set of keys pointing at
   * `true` and cost a byte a chat to say nothing.
   */
  pinned?: string[]
  /**
   * Chats the reader opens as their OWN conversation rather than the shared
   * Bot Chat (ADR-0007, amended). A list of bot names, like `archived` and
   * `pinned` beside it, because the value is always "yes".
   */
  myChats?: string[]
  /**
   * Which of the reader's own chats each bot is on, by STORED session id
   * (sub-chats; ADR-0016's amendment of 2026-09-22). Absent for a bot on its
   * group chat, which is most of them.
   *
   * `myChats` above is kept beside it as a projection for builds that predate
   * this field: every bot named here is named there too. A bot named there and
   * NOT here is a legacy entry — "the bare-lead chat", found by title — that no
   * build has resolved to an id yet.
   */
  current?: Record<string, string>
  accents: Record<string, AccentName>
  /**
   * The name THIS READER gave a bot, by handle. Absent for a bot they have not
   * named, which is most of them.
   *
   * It lives with the arrangement rather than on the bot's own `ui_meta` section
   * for the reason `mutes` and `myChats` give beside it: a gateway offers a
   * client no way to write a profile's `display_name` — the only route that
   * touches it renames the profile instead — so this name is the reader's, not
   * the profile's, and two people sharing a gateway do not have to agree on it.
   */
  labels?: Record<string, string>
  /** Bot name -> the second its silence lapses, or 0 for forever. */
  mutes?: Mutes
  /**
   * Whether the owner has hidden the list on the wide layout.
   *
   * ABSENT is a third value and it is the one that matters: it means nobody has
   * asked for either, so the window's own width decides (`resolveSidebarCollapsed`
   * below). Stored as a boolean once the owner touches the control, and stored
   * HERE rather than in the settings store because the question it answers is
   * "how is this gateway's chat list arranged", which is what ADR-0012 scopes to
   * a gateway: the arrangement survives Sign out, because the address and the list
   * it described both survive, and starts empty after Change gateway, because a
   * different machine's bots are a different list. A settings-store copy would
   * survive Change gateway too, which is the one thing it must not do.
   */
  sidebarCollapsed?: boolean
  /**
   * Whether the reader has hidden the conversation column on a wide window.
   *
   * Local for the reason `sidebarCollapsed` is: it is about the window in front
   * of somebody. Absent reads as "shown" — unlike the sidebar there is no width
   * band to answer for it, because the column is only ever drawn on a window
   * wide enough to hold it.
   */
  conversationsCollapsed?: boolean
}

type LayoutsOnDisk = Record<string, PersistedLayout>

export interface ChatLayoutState {
  /** The gateway this arrangement belongs to; null before the first load. */
  gatewayKey: string | null
  entries: LayoutEntry[]
  folders: Folder[]
  /** Folder ids closed on this device. Never synced; see `PersistedLayout`. */
  collapsed: Record<string, true>
  archived: Record<string, true>
  /**
   * Which chats are held at the top of their container.
   *
   * In the ARRANGEMENT slice rather than on each bot's own profile, beside the
   * order and the folders it belongs with: a pin does not describe the bot, it
   * describes where the reader keeps it — which is the same thing `entries` and
   * `folders` describe, and the same reason they are all in one section.
   *
   * It is a display SORT and never a move. The arrangement underneath is
   * untouched, so unpinning a chat puts it back exactly where it was rather than
   * wherever the top of the list has drifted to since. That is the whole reason
   * this is a separate key instead of `moveBotTo(0)`.
   */
  pinned: Record<string, true>
  /**
   * Which bots this reader talks to in a chat of their own.
   *
   * In the app-wide section rather than on each bot's profile, beside `mutes`
   * and for the same reason: it is a fact about the READER, not about the bot.
   * Two people sharing a gateway do not share a choice about whose transcript
   * they are in — that is the entire point of the feature.
   */
  myChats: Record<string, true>
  /**
   * Which of the reader's own chats each bot is on: bot name -> stored session
   * id. A bot missing here is on its group chat, or — while `myChats` still
   * names it — on the legacy bare-lead chat nobody has resolved yet. Read it
   * through `currentTargetOf`, which says which of the three it is.
   *
   * Synced (app-wide section, `current`) and dated as a choice, so the device
   * where somebody last picked a conversation is the one every other device
   * follows on its next open.
   */
  current: Record<string, string>
  accents: Record<string, AccentName>
  /**
   * What this reader calls each bot, by handle. Absent where they have not said.
   *
   * The editable name on the bot's own sheet. It wins over the roster's
   * `display_name`, which is read-only over every call a client has — see
   * `PersistedLayout.labels` and `features/bot-rename`.
   */
  labels: Record<string, string>
  /**
   * Which chats are silent, and until when.
   *
   * Unlike `archived` and `accents` this is about the READER rather than about
   * the bot, so it rides in the app-wide section beside the order and the theme
   * rather than on the bot's own profile: two people sharing a gateway do not
   * share a bedtime.
   */
  mutes: Mutes
  /**
   * The owner's explicit choice about the wide layout's sidebar, or `undefined`
   * while they have not made one. Read through `resolveSidebarCollapsed`, never
   * directly: on its own it does not say what the shell should draw.
   */
  sidebarCollapsed?: boolean
  /** The reader's Hide/Show of the conversation column. Never synced; see `PersistedLayout`. */
  conversationsCollapsed?: boolean
  /** False until the disk read finishes; the list paints the roster order meanwhile. */
  loaded: boolean
  /**
   * How many writes this store has made that NOBODY ASKED FOR.
   *
   * Two of them: the live roster being folded into the arrangement, and the
   * sweep that forgets mutes which have already lapsed. Both change the section
   * and both must be sent, and neither is a decision anybody made — from outside
   * this store they look exactly like a rearrangement.
   *
   * `store/ui-meta-bridge.ts` reads the counter to tell them apart. The
   * arrangement is one person's, shared by all their devices, and the newest
   * CHOICE has to win on every one of them, so the bridge dates a change the
   * reader made and pointedly does not date these.
   *
   * It was: a second device folded a roster of six bots into an arrangement it
   * had not read yet, that fold was dated as though somebody had just dragged
   * six rows, and it won. The folders the person had made on their desktop were
   * then gone from the gateway as well, for every device.
   */
  chores: number

  load: (gatewayKey: string) => Promise<void>
  reconcile: (botNames: readonly string[]) => void
  /** One position up or down within whatever container the bot is in. */
  moveBy: (botName: string, offset: number) => void
  /** Put a chat at the end of a folder; `null` is the loose top level. */
  moveToFolder: (botName: string, folderId: string | null) => void
  /** Commit a drag: `index` is read against the target container as it is. */
  dropBot: (botName: string, folderId: string | null, index: number) => void
  /** Commit a drag of a folder itself, to `index` of the top level. */
  dropFolder: (folderId: string, index: number) => void
  /**
   * One step up or down among the TOP-LEVEL entries.
   *
   * The folder twin of `moveBy`, and it exists for the same readers: the grip
   * is a gesture, and a keyboard and a screen reader need a way to reorder that
   * is not one. A step counts every top-level entry — folders and loose chats
   * alike — because that is what "up" means to somebody looking at the rows.
   */
  moveFolderBy: (folderId: string, offset: number) => void
  /** A new, empty folder at the end. Answers its id, for the rename field. */
  addFolder: (name: string) => string
  /** A new folder holding just this chat, so the row you asked from starts it. */
  addFolderAround: (botName: string, name: string) => string
  renameFolder: (id: string, name: string) => void
  setFolderColour: (id: string, colour: AccentName) => void
  /** Drop a folder; its bots come back to the top level where it stood. */
  removeFolder: (id: string) => void
  /** Open or close a folder on this device. */
  setFolderOpen: (id: string, open: boolean) => void
  setArchived: (botName: string, archived: boolean) => void
  /** Hold this chat at the top of its container, or let it go. */
  setPinned: (botName: string, pinned: boolean) => void
  /** The row menu's and the popover's one-press form of the above. */
  togglePinned: (botName: string) => void
  /**
   * Open this bot as the reader's own chat, or back to the shared one.
   *
   * The two-position switch's setter, kept until the switch goes. "Mine" is a
   * legacy entry — the bare-lead chat, no id — and "shared" also forgets any
   * `current` id, because the switch means the group chat.
   */
  setMyChat: (botName: string, mine: boolean) => void
  /**
   * Remember which conversation a bot is on: a stored session id for one of the
   * reader's own chats, `null` for the group chat.
   *
   * `myChats` follows as the projection older builds read: an id adds the bot,
   * `null` removes it together with any legacy entry, because the reader has now
   * said where this bot is.
   *
   * By default this is the READER's choice and the bridge dates it, so it wins
   * over older copies on every device. `{ chore: true }` is for the app's own
   * corrections — an id the gateway no longer lists being forgotten, a legacy
   * entry being resolved to the id it names — which must be sent but must never
   * outrank a choice somebody made on another device (see `chores`).
   */
  setCurrent: (botName: string, sessionId: string | null, options?: { chore?: boolean }) => void
  setAccent: (botName: string, accent: AccentName) => void
  /** Name this bot in this reader's own list; an empty string clears it. */
  setLabel: (botName: string, label: string) => void
  /** Silence one chat until `until` seconds, `0` for forever, `null` to stop. */
  setMute: (botName: string, until: number | null) => void
  /**
   * Forget the mutes that have lapsed.
   *
   * An optimisation, never a correctness step: every reader already compares
   * the deadline against the clock, so a mute nobody has swept is a mute that
   * has already stopped working. This keeps the section from accumulating
   * deadlines from last spring. A no-op when nothing expired, so it can be
   * called on every foreground without sending the section again.
   */
  dropExpiredMutes: (now: number) => void
  /** Record an explicit Hide/Show. There is no "back to automatic" — see the type. */
  setSidebarCollapsed: (collapsed: boolean) => void
  /** Hide or show the conversation column on this device. */
  setConversationsCollapsed: (collapsed: boolean) => void
  /**
   * Replace the parts ADR-0016 syncs with the gateway's copy.
   *
   * `sidebarCollapsed` and `conversationsCollapsed` are deliberately NOT in here. It is about the WINDOW the
   * reader is looking at — a phone has no sidebar and a Mac window has one at a
   * different width — so a desktop hiding its list must not collapse a tablet's.
   * It stays what ADR-0012 made it: local to the device.
   *
   * The arrival is persisted like any other change, because the device's own copy
   * is what the UI paints from and a copy that only lived in memory would be gone
   * on the next launch.
   */
  applyRemote: (patch: {
    arrangement?: Arrangement
    archived?: string[]
    pinned?: string[]
    myChats?: string[]
    current?: Record<string, string>
    accents?: Record<string, AccentName>
    labels?: Record<string, string>
    mutes?: Mutes
  }) => void
  reset: () => void
}

const INITIAL = {
  gatewayKey: null as string | null,
  entries: [] as LayoutEntry[],
  folders: [] as Folder[],
  collapsed: {} as Record<string, true>,
  archived: {} as Record<string, true>,
  pinned: {} as Record<string, true>,
  myChats: {} as Record<string, true>,
  current: {} as Record<string, string>,
  accents: {} as Record<string, AccentName>,
  labels: {} as Record<string, string>,
  mutes: {} as Mutes,
  sidebarCollapsed: undefined as boolean | undefined,
  conversationsCollapsed: undefined as boolean | undefined,
  loaded: false,
  chores: 0
}

let writeQueue: Promise<void> = Promise.resolve()

/**
 * Persist one gateway's arrangement, leaving every other gateway's alone.
 *
 * Read-modify-write rather than a key per gateway: the alternative needs a
 * second index to know which keys exist, and losing that index orphans every
 * arrangement it pointed at.
 */
function persist(gatewayKey: string, layout: PersistedLayout): void {
  writeQueue = writeQueue
    .then(async () => {
      const all = (await keyValueStore.getJson<LayoutsOnDisk>(CHAT_LAYOUT_KEY)) ?? {}

      await keyValueStore.setJson(CHAT_LAYOUT_KEY, { ...all, [gatewayKey]: layout })
    })
    .catch(() => {
      // A lost arrangement costs the owner their ordering, not their data. It is
      // not worth an error in front of someone who was only dragging a row.
    })
}

/**
 * The longest name a reader may give a bot.
 *
 * The same 64 the gateway's own display-name setter applies
 * (`hermes_cli/profiles.py::set_profile_display_name`). Matching it is not
 * imitation for its own sake: the two names sit in the same place on every row,
 * so a limit that let one of them be twice as long would let a list drawn from
 * this store lay out differently from a list drawn from the roster.
 */
export const BOT_LABEL_MAX = 64

/**
 * Read a map of reader-given names defensively.
 *
 * It arrives from disk AND from a gateway, so every value is checked: a name is
 * a non-empty trimmed string within the limit, and anything else is dropped
 * rather than repaired. An over-long one is CUT rather than discarded — somebody
 * typed it, and the first sixty-four characters are much closer to what they
 * meant than nothing at all.
 */
function labelsOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [bot, label] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    if (!bot || typeof label !== 'string') {
      continue
    }

    const trimmed = label.trim().slice(0, BOT_LABEL_MAX)

    if (trimmed) {
      out[bot] = trimmed
    }
  }

  return out
}

/**
 * Read a map of bot name -> stored session id defensively.
 *
 * It arrives from disk and from a gateway, so a key or a value that is not a
 * non-empty string is dropped. Nothing is repaired: an id is an address, and a
 * guessed one is worse than none — the bot then opens its group chat, which is
 * always there.
 */
export function currentOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return out
  }

  for (const [bot, id] of Object.entries(value as Record<string, unknown>)) {
    if (bot && typeof id === 'string' && id.length > 0) {
      out[bot] = id
    }
  }

  return out
}

/**
 * `myChats` as older builds must read it: every bot with a `current` id, plus
 * the legacy entries nobody has resolved yet.
 *
 * Imposed wherever either map is written, so the invariant holds whichever
 * build wrote which half: an older build replaces `myChats` and says nothing
 * about `current`, and a bot this device holds an id for must not drop out of
 * the projection because of it.
 */
function withProjection(myChats: Record<string, true>, current: Record<string, string>): Record<string, true> {
  const missing = Object.keys(current).filter(bot => !myChats[bot])

  if (!missing.length) {
    return myChats
  }

  const next = { ...myChats }

  for (const bot of missing) {
    next[bot] = true
  }

  return next
}

/**
 * The part of `myChats` that is NOT a projection of `current`: legacy entries.
 *
 * What survives when a `current` arrives without a `myChats` beside it — a bot
 * the arriving map moved back to its group chat must leave the projection with
 * it, rather than turn into a legacy entry nobody chose.
 */
function legacyEntries(myChats: Record<string, true>, current: Record<string, string>): Record<string, true> {
  const out: Record<string, true> = {}

  for (const bot of Object.keys(myChats)) {
    if (!(bot in current)) {
      out[bot] = true
    }
  }

  return out
}

/** Read a stored blob defensively: an older build may have written anything. */
function asLayout(value: unknown): PersistedLayout {
  const raw = (value ?? {}) as Partial<PersistedLayout>
  // `readArrangement` also migrates: a blob written before folders carries
  // `divider` entries inline, and each one becomes a folder holding the chats
  // below it up to the next divider.
  const arrangement = readArrangement(raw.entries, raw.folders)
  const accents: Record<string, AccentName> = {}

  for (const [bot, accent] of Object.entries(raw.accents ?? {})) {
    if (typeof accent === 'string' && accent in ACCENTS) {
      accents[bot] = accent as AccentName
    }
  }

  return {
    entries: arrangement.entries,
    folders: arrangement.folders,
    labels: labelsOf(raw.labels),
    collapsed: (Array.isArray(raw.collapsed) ? raw.collapsed : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    ),
    archived: (Array.isArray(raw.archived) ? raw.archived : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    pinned: (Array.isArray(raw.pinned) ? raw.pinned : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    myChats: (Array.isArray(raw.myChats) ? raw.myChats : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    current: currentOf(raw.current),
    accents,
    mutes: mutesOf(raw.mutes),
    ...(typeof raw.conversationsCollapsed === 'boolean' ? { conversationsCollapsed: raw.conversationsCollapsed } : {}),
    // Only a real boolean counts. Anything else — a missing key, a string an
    // older build wrote — has to read as "never chosen", because that is the
    // value the width bands are allowed to answer for.
    ...(typeof raw.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: raw.sidebarCollapsed } : {})
  }
}

/**
 * A loose chat's position among the LOOSE chats, as a position among entries.
 *
 * The top level interleaves folders and chats, so "second loose chat" and
 * "entry 2" are only the same number on a list with no folders in it. `moveBy`
 * thinks in loose positions, because that is what up and down mean to a reader
 * looking at rows; everything below it thinks in entry positions.
 *
 * `from` is the moving chat's own loose index, and it is what turns a step DOWN
 * into the right entry: `moveBotTo` reads its index against the list without the
 * moving row, so landing after the chat currently below means taking that chat's
 * entry position rather than the one after it.
 */
function looseToEntryIndex(arrangement: Arrangement, loose: number, from: number): number {
  const positions: number[] = []

  arrangement.entries.forEach((entry, index) => {
    if (entry.kind === 'chat') {
      positions.push(index)
    }
  })

  const target = positions[loose]

  if (target === undefined) {
    return arrangement.entries.length
  }

  // Moving down: the row at `loose` keeps its entry position once ours is gone,
  // so landing after it is that position. Moving up: land on it.
  return loose > from ? target : target
}

export const useChatLayoutStore = create<ChatLayoutState>((set, get) => {
  const save = (): void => {
    const {
      gatewayKey,
      entries,
      folders,
      collapsed,
      archived,
      pinned,
      myChats,
      current,
      accents,
      labels,
      mutes,
      sidebarCollapsed,
      conversationsCollapsed
    } = get()

    if (gatewayKey) {
      persist(gatewayKey, {
        entries,
        folders,
        collapsed: Object.keys(collapsed),
        archived: Object.keys(archived),
        pinned: Object.keys(pinned),
        myChats: Object.keys(myChats),
        current,
        accents,
        labels,
        mutes,
        ...(conversationsCollapsed === undefined ? {} : { conversationsCollapsed }),
        // Omitted while nobody has chosen, so that "never chosen" survives a
        // round trip as the absence it is rather than as a `false` the width
        // bands would then never get to answer for.
        ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed })
      })
    }
  }

  /** Every arrangement edit lands here, so every one of them is persisted. */
  const write = (arrangement: Arrangement): void => {
    set({ entries: arrangement.entries, folders: arrangement.folders })
    save()
  }

  const arrangementOf = (): Arrangement => ({ entries: get().entries, folders: get().folders })

  return {
    ...INITIAL,

    async load(gatewayKey) {
      const all = await keyValueStore.getJson<LayoutsOnDisk>(CHAT_LAYOUT_KEY)
      const stored = asLayout(all?.[gatewayKey])
      const archived: Record<string, true> = {}

      for (const name of stored.archived) {
        archived[name] = true
      }

      const collapsed: Record<string, true> = {}

      for (const id of stored.collapsed ?? []) {
        collapsed[id] = true
      }

      const pinned: Record<string, true> = {}

      for (const name of stored.pinned ?? []) {
        pinned[name] = true
      }

      const myChats: Record<string, true> = {}

      for (const name of stored.myChats ?? []) {
        myChats[name] = true
      }

      const current = stored.current ?? {}

      set({
        gatewayKey,
        entries: stored.entries,
        folders: stored.folders ?? [],
        collapsed,
        archived,
        pinned,
        myChats: withProjection(myChats, current),
        current,
        accents: stored.accents,
        labels: stored.labels ?? {},
        mutes: stored.mutes ?? {},
        sidebarCollapsed: stored.sidebarCollapsed,
        conversationsCollapsed: stored.conversationsCollapsed,
        loaded: true
      })
    },

    /**
     * Fold the live roster into the arrangement.
     *
     * New bots land at the end of the loose top-level run, before the first
     * folder — the end of the list would bury them inside whatever folder is
     * last, and the top would push them in front of the chat the owner is
     * reading. Bots that no longer exist are dropped from wherever they were.
     */
    reconcile(botNames) {
      const next = reconcileBots(arrangementOf(), botNames)

      if (next === arrangementOf()) {
        return
      }

      /*
        Counted as well as written, so that the bridge can tell this from a drag.

        It is persisted and sent like any other change — a bot that has appeared
        belongs in the list, and the gateway should hear about it — but it is not
        a choice anybody made, and the bridge dates choices. See `chores`.
      */
      set({ entries: next.entries, folders: next.folders, chores: get().chores + 1 })
      save()
    },

    /**
     * Move one chat up or down WITHIN its own container.
     *
     * Deliberately not across containers any more. When the groups were
     * headings, stepping past one was how a bot changed section and the same
     * gesture as stepping past another bot — one flat array made the two
     * identical. A folder is a container: "down" inside it means the next row
     * inside it, and running off the end into the next folder is not a step
     * anybody asked for. Moving BETWEEN folders is `moveToFolder`, the drag, or
     * the row menu, all of which say which folder out loud.
     */
    moveBy(botName, offset) {
      if (offset === 0) {
        return
      }

      const arrangement = arrangementOf()
      const folderId = arrangement.folders.find(folder => folder.bots.includes(botName))?.id ?? null
      const container =
        folderId === null
          ? arrangement.entries.flatMap(entry => (entry.kind === 'chat' ? [entry.name] : []))
          : (arrangement.folders.find(folder => folder.id === folderId)?.bots ?? [])
      const from = container.indexOf(botName)

      if (from === -1) {
        return
      }

      const to = Math.max(0, Math.min(container.length - 1, from + offset))

      if (to === from) {
        return
      }

      /*
        `moveBotTo` reads its index against the container WITHOUT the moving
        row, so a step down is `to + 1` before the removal and `to` after it.
        At the top level the index counts folders too, so the loose position is
        translated back into an entry position here.
      */
      const target = folderId === null ? looseToEntryIndex(arrangement, to, from) : to

      write(moveBotTo(arrangement, botName, folderId, target))
    },

    moveToFolder(botName, folderId) {
      write(moveBotToFolder(arrangementOf(), botName, folderId))
    },

    /**
     * Commit a drag.
     *
     * `index` is read against the target container AS IT IS, including the
     * dragged row when it is already in that container — the number a caller
     * can actually compute, because a drop line sits between two rows it can
     * see. `features/bots/folder-rows.ts` does the correction for the removal,
     * which is what keeps "same container" and "different container" one path.
     */
    dropBot(botName, folderId, index) {
      write(moveBotTo(arrangementOf(), botName, folderId, index))
    },

    dropFolder(folderId, index) {
      write(moveFolderTo(arrangementOf(), folderId, index))
    },

    moveFolderBy(folderId, offset) {
      if (offset === 0) {
        return
      }

      const arrangement = arrangementOf()
      const from = arrangement.entries.findIndex(entry => entry.kind === 'folder' && entry.id === folderId)

      if (from === -1) {
        return
      }

      const to = Math.max(0, Math.min(arrangement.entries.length - 1, from + offset))

      if (to === from) {
        return
      }

      /*
        `to` unchanged, in BOTH directions, and it is worth saying why the
        correction `moveBy` needs is absent here.

        `moveFolderTo` splices into the list it has ALREADY taken the folder out
        of. Stepping down, the entry the folder is moving past has shifted up by
        one, so the full-list position `to` and the reduced-list insertion point
        `to` are the same index. Stepping up, nothing above the folder moved, so
        `to` is unchanged for the other reason. `moveBotTo` differs because it
        is given a position in the container as the CALLER sees it.
      */
      write(moveFolderTo(arrangement, folderId, to))
    },

    addFolder(name) {
      const id = newFolderId()

      write(addFolder(arrangementOf(), name, id))

      return id
    },

    /**
     * A new folder around one chat.
     *
     * "New folder" on a row you are looking at means that row is what the folder
     * is for, which is the same intent "Add divider above" served and a better
     * outcome: the divider left the chat where it was and hoped, and this puts
     * it inside.
     */
    addFolderAround(botName, name) {
      const id = newFolderId()

      write(moveBotToFolder(addFolder(arrangementOf(), name, id), botName, id))

      return id
    },

    renameFolder(id, name) {
      write(renameFolder(arrangementOf(), id, name))
    },

    setFolderColour(id, colour) {
      write(setFolderColour(arrangementOf(), id, colour))
    },

    removeFolder(id) {
      const collapsed = { ...get().collapsed }

      delete collapsed[id]
      set({ collapsed })
      write(removeFolder(arrangementOf(), id))
    },

    setFolderOpen(id, open) {
      const collapsed = { ...get().collapsed }

      if (open) {
        delete collapsed[id]
      } else {
        collapsed[id] = true
      }

      set({ collapsed })
      save()
    },

    setArchived(botName, archived) {
      const next = { ...get().archived }

      if (archived) {
        next[botName] = true
      } else {
        delete next[botName]
      }

      set({ archived: next })
      save()
    },

    setPinned(botName, pinned) {
      const next = { ...get().pinned }

      if (pinned) {
        next[botName] = true
      } else {
        delete next[botName]
      }

      set({ pinned: next })
      save()
    },

    togglePinned(botName) {
      const { pinned, setPinned } = get()

      setPinned(botName, !pinned[botName])
    },

    setMyChat(botName, mine) {
      const next = { ...get().myChats }

      // The shared Bot Chat is the absence of a choice rather than a choice of
      // its own, so it is stored as nothing. A roster of forty bots nobody has
      // moved then costs forty fewer entries and reads as "never asked".
      if (mine) {
        next[botName] = true
        set({ myChats: next })
      } else {
        const current = { ...get().current }

        delete next[botName]
        delete current[botName]
        set({ myChats: next, current })
      }

      save()
    },

    setCurrent(botName, sessionId, options = {}) {
      const { current, myChats } = get()

      // The same answer is no change: re-picking the row a bot is already on
      // must not re-date the section, or a device that merely re-opened a chat
      // would outrank a choice made since on another one.
      if (sessionId === null ? !(botName in current) && !myChats[botName] : current[botName] === sessionId) {
        return
      }

      const nextCurrent = { ...current }
      const nextMine = { ...myChats }

      if (sessionId === null) {
        // The group chat is the absence of a choice, as with `setMyChat`, and it
        // clears the legacy entry too: the reader has said where this bot is.
        delete nextCurrent[botName]
        delete nextMine[botName]
      } else {
        nextCurrent[botName] = sessionId
        nextMine[botName] = true
      }

      set({
        current: nextCurrent,
        myChats: nextMine,
        // One `set`, so the bridge sees the chore and the change in the same
        // notification and does not date it. See `chores`.
        ...(options.chore ? { chores: get().chores + 1 } : {})
      })
      save()
    },

    setAccent(botName, accent) {
      const accents = { ...get().accents }

      // Default is the absence of a choice rather than a choice of its own, so
      // it is stored as nothing. A roster of forty bots on the default colour
      // then costs forty fewer entries on disk and reads as "never set".
      if (accent === 'default') {
        delete accents[botName]
      } else {
        accents[botName] = accent
      }

      set({ accents })
      save()
    },

    setLabel(botName, label) {
      const labels = { ...get().labels }
      const trimmed = label.trim().slice(0, BOT_LABEL_MAX)

      // An empty name is the absence of one rather than a name of its own, so it
      // is stored as nothing and the row falls back to the roster's own label
      // and then to the handle. That is also what makes "clear it" a thing a
      // reader can do by emptying the field.
      if (trimmed) {
        labels[botName] = trimmed
      } else {
        delete labels[botName]
      }

      set({ labels })
      save()
    },

    setMute(botName, until) {
      const mutes = { ...get().mutes }

      if (until === null) {
        delete mutes[botName]
      } else {
        mutes[botName] = Math.floor(until)
      }

      set({ mutes })
      save()
    },

    dropExpiredMutes(now) {
      const swept = withoutExpired(get().mutes, now)

      // `null` is "nothing had lapsed", and returning early on it is what lets
      // this be called on every foreground: an equal copy would still count as
      // a change to the projection and send the whole section again.
      if (!swept) {
        return
      }

      // A CHORE, like the roster's fold above: the deadlines it forgets had
      // already stopped silencing anything, so the section changed without
      // anybody deciding that it should. Dating it would make this device the
      // one that chose last, on a foreground, and win an argument about a theme
      // it had nothing to say about. See `chores`.
      set({ mutes: swept, chores: get().chores + 1 })
      save()
    },

    setSidebarCollapsed(collapsed) {
      set({ sidebarCollapsed: collapsed })
      save()
    },

    setConversationsCollapsed(collapsed) {
      set({ conversationsCollapsed: collapsed })
      save()
    },

    applyRemote(patch) {
      const archived: Record<string, true> = {}

      for (const name of patch.archived ?? []) {
        archived[name] = true
      }

      const pinned: Record<string, true> = {}

      for (const name of patch.pinned ?? []) {
        pinned[name] = true
      }

      const myChats: Record<string, true> = {}

      for (const name of patch.myChats ?? []) {
        myChats[name] = true
      }

      // Absent is not empty, and here it is the rule older builds lean on: a
      // section written before `current` existed says nothing about which of the
      // reader's chats each bot is on, so this device keeps its own map.
      const current = patch.current ? currentOf(patch.current) : get().current

      set({
        ...(patch.arrangement ? { entries: patch.arrangement.entries, folders: patch.arrangement.folders } : {}),
        ...(patch.archived ? { archived } : {}),
        // Absent is not empty: a section written by a build that predates the
        // field says nothing about pins, and reading that as "none" would
        // unpin every chat the moment an older device wrote the section.
        ...(patch.pinned ? { pinned } : {}),
        // Absent is not empty here either: a build that predates the field says
        // nothing about which chats are the reader's own, and reading that as
        // "none" would put them back in the shared transcript without asking.
        // The projection is re-imposed over whichever half arrived, so a bot this
        // device holds an id for stays in the list older builds read even when one
        // of them wrote that list without it.
        myChats: withProjection(patch.myChats ? myChats : legacyEntries(get().myChats, get().current), current),
        current,
        ...(patch.accents ? { accents: patch.accents } : {}),
        // Absent is not empty once more: a build that predates the field says
        // nothing about what this reader calls their bots, and reading that as
        // "nothing" would un-name every one of them.
        ...(patch.labels ? { labels: labelsOf(patch.labels) } : {}),
        ...(patch.mutes ? { mutes: patch.mutes } : {})
      })
      save()
    },

    reset() {
      set(INITIAL)
    }
  }
})

/** Archived bots, in the order they sit in the arrangement. */
export function archivedOf(arrangement: Arrangement, archived: Record<string, true>): string[] {
  return botsInOrder(arrangement).filter(name => archived[name])
}

/** Every folder, for the row menu's "Move to folder". */
export function foldersOf(arrangement: Arrangement): { id: string; name: string }[] {
  return arrangement.folders.map(folder => ({ id: folder.id, name: folder.name }))
}

/**
 * Is this chat silent, as of now?
 *
 * The clock is read at render rather than subscribed to, which means a mute
 * that lapses while the list is on screen is not noticed until something else
 * re-renders it. That is the right trade for a feature whose whole point is
 * that nothing happens: the cost of being late is one row that goes on looking
 * quiet, and the alternative is a timer per row.
 */
export function useChatMuted(botName: string): boolean {
  const mutes = useChatLayoutStore(state => state.mutes)

  return isMuted(mutes, botName, Math.floor(Date.now() / 1000))
}

/** Is this chat held at the top of its container? */
export function useChatPinned(botName: string): boolean {
  return useChatLayoutStore(state => Boolean(state.pinned[botName]))
}

/** Is this bot opened as the reader's own chat rather than the shared one? */
export function useMyChat(botName: string): boolean {
  return useChatLayoutStore(state => Boolean(state.myChats[botName]))
}

/**
 * Where a bot is, as the conversation directory needs to ask it.
 *
 *  - a stored session id: one of the reader's own chats, by address;
 *  - `null`: a legacy entry — `myChats` names the bot and no build has resolved
 *    it to an id yet, so it means "the bare-lead chat", found by title, never
 *    minted;
 *  - `undefined`: the group chat.
 *
 * Pure over the state so a controller can ask it without a hook.
 */
export function currentTargetOf(
  state: Pick<ChatLayoutState, 'current' | 'myChats'>,
  botName: string
): string | null | undefined {
  return state.current[botName] ?? (state.myChats[botName] ? null : undefined)
}

/**
 * The stored id of the reader's own chat this bot is on, or `undefined` for the
 * group chat (and for a legacy entry nobody has resolved yet). A string, so a
 * row does not re-render because a different bot moved.
 */
export function useCurrentConversation(botName: string): string | undefined {
  return useChatLayoutStore(state => state.current[botName])
}

/**
 * One chat's colour. Part 2's header and outgoing bubble read this too.
 *
 * `accentOrBrand` is what makes a team's accent (ADR-0025, part 2) mean
 * anything: it stands in for "the reader has not coloured this chat", and a
 * chat they HAVE coloured is untouched.
 */
export function useChatAccent(botName: string): AccentName {
  return accentOrBrand(useChatLayoutStore(state => state.accents[botName] ?? 'default'))
}

/**
 * What this reader calls one bot, or `''`.
 *
 * A string rather than the map, for the reason `useBotDisplayName` selects one:
 * a row must not re-render because somebody renamed a different bot.
 */
export function useBotLabel(botName: string | undefined): string {
  return useChatLayoutStore(state => (botName === undefined ? '' : (state.labels[botName] ?? '')))
}

/**
 * Whether the wide layout should be drawing the sidebar collapsed.
 *
 * Two inputs and one rule, and the rule is the owner's: **the window decides
 * only where the owner has not.** An explicit Hide or Show wins at every width,
 * for as long as it is stored; with no choice on record the band answers, and the
 * band is a comparison against one number, which is what makes the second half of
 * the owner's rule true by construction — the same window width cannot produce two
 * answers, so nothing flips while the reader sits still and looks at it.
 *
 * Pure, and exported separately from the store because the shell, the rail, the
 * header button and the Mac's menu bar all have to agree about the answer. Three
 * copies of this comparison is how they would stop agreeing.
 *
 * Resizing DOES change the answer where there is no choice on record — dragging a
 * Mac window from 1200 to 800 collapses the list — which is the intended reading of
 * "start collapsed below 900": the window size is what changed, so the rule about
 * not flipping under a still reader does not apply.
 */
export function resolveSidebarCollapsed(choice: boolean | undefined, windowWidth: number): boolean {
  return choice ?? windowWidth < SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH
}
