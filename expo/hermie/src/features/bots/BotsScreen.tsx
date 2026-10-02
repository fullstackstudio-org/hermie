/**
 * The chat list — the first thing the app shows, and the owner's own
 * arrangement of it.
 *
 * Two halves that are easy to confuse. The ROSTER is the gateway's: which bots
 * exist, what they last said, whether they are running. The LAYOUT is this
 * device's: the order, the named dividers, what is archived, what colour each
 * chat carries (ADR-0012). The roster decides which rows can exist; the layout
 * decides where they sit. `reconcile` is the one place the two meet.
 *
 * Three pieces of state are deliberately NOT roster fields and cannot be:
 *
 *  - "working" has two sources, and needs both. `session.active_list` is polled
 *    while this list is mounted, because an unwatched roster has nothing to
 *    animate; it answers for the whole gateway process and carries no profile,
 *    so the roster controller attributes each busy row to a bot by session id.
 *    The chat's own streaming `turn.active` is the second source: it is true the
 *    moment a turn is sent, for that bot alone, without waiting for a poll.
 *  - "needs input" comes from the open approvals and clarifies the chat store
 *    already holds, so it survives a roster refresh and is true even for a
 *    question that arrived while this screen was not on top.
 *  - "unread" is a timestamp comparison against a per-bot watermark.
 *
 * The same component is the wide layout's sidebar and the phone's Chats screen.
 * The only difference is density and the title size — the tab strip and the
 * gateway card are in both, because both mockup frames show them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  FlatList,
  LayoutAnimation,
  Pressable,
  RefreshControl,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'

import { snippetSegments, tidySnippet } from '@hermie/gateway-client'
import { hasOpenRequest, unreadBadgeLabel, unreadCountSince } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { gatewayStop } from '../../gateway/gateway-stop'
import { GatewayStoppedPanel } from '../../gateway/GatewayStoppedPanel'
import { chatGatewayFor } from '../../gateway/link'
import { strings } from '../../i18n/strings'
import { ContextMenuHost, HAS_NATIVE_CONTEXT_MENU } from '../../platform/context-menu'
import { setMenuBar } from '../../platform/desktop-shortcuts'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSafeAreaInsets } from '../../platform/safe-area'
import { isUnread, useBotsStore, type Bot } from '../../store/bots'
import { BotProfileSheet } from '../bot-profile'
import { MemoryBotsScreen } from '../memory'
import { archivedOf, foldersOf, useChatLayoutStore } from '../../store/chat-layout'
import type { Folder } from '../../store/folders'
import { isMuted, MUTE_FOREVER, muteUntil, mutedUntil as mutedUntilOf, type Mutes } from '../../store/mute'
import { useChatsStore } from '../../store/chats'
import { Appear } from '../../ui/Appear'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { durationFor, easing, NATIVE_DRIVER } from '../../ui/motion'
import { RoundIconButton, SearchField, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHover } from '../../ui/useHover'
import { useNumberedShortcuts, useShortcut } from '../../ui/useShortcut'
import { CONTROL_MIN_HEIGHT, CONTROL_SIZE, TAP_SLOP, type AccentName } from '../../ui/tokens'
import { formatListTime } from '../../chat-ui'
import { useChatRuntime } from '../chats/ChatRuntime'
import { type MessageMatch, useMessageSearch } from '../search'
import { BotRow } from './BotRow'
import { NewBotFlow } from '../profiles/NewBotFlow'
import { KanbanScreen, kanbanStrings, useBoardsOpener } from '../kanban'
import { profileStrings } from '../profiles/strings'
import { ConnectionLine } from './ConnectionLine'
import { FolderGroup, type FolderGroupEdge } from './FolderGroup'
import { GatewayTitle } from './GatewayTitle'
import {
  clampToPinnedBand,
  committedRowIndex,
  dragAnchors,
  folderRowKey,
  folderRows,
  isSameRowPlace,
  parseRowKey,
  type DropTarget,
  type FolderCounts,
  type RowsInput
} from './folder-rows'
import { consumeRevealFolder, onRevealFolder } from './folder-reveal'
import { presenceOf, type Presence } from './presence'
import { folderMenuItems, parseFolderMenuAction, parseRowMenuAction, rowMenuItems } from './row-menu-items'
import { RowMenu } from './RowMenu'
import { SidebarFooter, type BotsSection, type TabKey } from './SidebarFooter'
import { SidebarRail } from './SidebarRail'
import { DragCell, DragCellProvider } from './DragCell'
import { LIFT_SCALE, useRowDrag } from './use-row-drag'

export type { BotsSection }

/** What a tap on a row asks the shell for, beyond the bot itself. */
export interface OpenBotOptions {
  /**
   * Words to land on rather than the bottom of the chat.
   *
   * It is TEXT and not a row id because the gateway's search cannot name a row
   * — see `features/search/find-in-chat.ts`. The chat screen looks for it in
   * what it has loaded and says so when it is not there.
   */
  findText?: string
}

export interface BotsScreenProps {
  /** Compact shell: navigate. Regular shell: select in place. */
  onOpenBot?: (bot: Bot, options?: OpenBotOptions) => void
  selectedBot?: string | undefined
  /**
   * Open one of the other three destinations.
   *
   * `options.create` is the difference between "show me the crons" and "make
   * me a cron". This screen only ever asks for the first: the header's `+`,
   * which asked for the second, is gone — a cron is made on the Crons tab,
   * with that tab's own button. The option stays in the signature because the
   * shells still honour it on the way in from elsewhere.
   */
  onOpenSection?: (section: BotsSection, options?: { create?: boolean }) => void
  /**
   * Open one bot's other conversations, from its profile sheet.
   *
   * Absent where the shell has nowhere to put the page, which drops the row on
   * that sheet rather than leaving it pointing at nothing.
   */
  onOpenConversations?: (botName: string) => void
  /** Which footer tab reads as current; the wide shell drives this from its overlay. */
  currentTab?: TabKey
  /**
   * `rail` is the collapsed wide layout: the same component, the same state, the
   * slim column instead of the list.
   *
   * It is a variant rather than a component of its own because ⌘1…9, ⌘↑/↓ and the
   * Mac menu bar's nine named chats all hang off state only this component derives.
   * Swapping it out to draw a rail would take those with the rows — see
   * `SidebarRail`'s own note.
   */
  variant?: 'screen' | 'sidebar' | 'rail'
  /** Rail only: ask the shell for the list back. */
  onShowList?: () => void
}

/**
 * An archived bot is shown as offline whatever the roster says. It is excluded
 * from the polls and the counts, so any other bead would be a stale claim.
 * Shared rather than built per render, so `BotRow`'s memo holds.
 */
const ARCHIVED_PRESENCE: Presence = { state: 'offline' }

/**
 * How the drawer's rows are keyed.
 *
 * An archived chat is not in the arrangement's rows, so it cannot carry a
 * `bot:` key without standing for a position the drag can aim at.
 */
const ARCHIVED_ROW_PREFIX = 'archived:'

type ListItem =
  | { key: string; kind: 'folder'; folder: Folder; open: boolean; counts: FolderCounts }
  | { key: string; kind: 'folderEmpty'; id: string; colour: AccentName }
  | {
      key: string
      kind: 'bot'
      bot: Bot
      archived: boolean
      /** Which folder draws this row, and therefore which plate it sits on. */
      folderId: string | null
      /** The colour of that plate; ignored for a loose row. */
      folderColour: AccentName
      /** The bottom slice of the plate: the last chat shown inside its folder. */
      lastInFolder: boolean
    }
  | { key: string; kind: 'archiveHeader'; count: number }
  | { key: string; kind: 'noNameMatch'; query: string }
  | { key: string; kind: 'messagesHeader'; searching: boolean; count: number }
  | { key: string; kind: 'message'; match: MessageMatch; bot: Bot }

/** Name or description, case-insensitively — what a reader would type. */
function matches(bot: Bot, query: string): boolean {
  if (!query) {
    return true
  }

  const needle = query.trim().toLowerCase()

  return (
    bot.displayName.toLowerCase().includes(needle) ||
    bot.name.toLowerCase().includes(needle) ||
    bot.description.toLowerCase().includes(needle)
  )
}

/**
 * The chat a row key's fallback menu belongs to, or `null` for a row that has no
 * sheet.
 *
 * Two spellings, because the drawer draws its own rows: a chat in the list is
 * `bot:<name>` and an archived one is `archived:<name>`, which is the key this
 * screen gives it so that the two cannot collide in the list. `parseRowKey` only
 * speaks the arrangement's half — a folder is not a chat and has no sheet — so
 * the drawer's spelling is read here, next to the code that writes it.
 */
function menuTargetOf(rowKey: string): string | null {
  const row = parseRowKey(rowKey)

  if (row?.kind === 'bot') {
    return row.name
  }

  return rowKey.startsWith(ARCHIVED_ROW_PREFIX) ? rowKey.slice(ARCHIVED_ROW_PREFIX.length) : null
}

/** The part of a host component `measureListTop` needs; see its narrowing. */
interface Measurable {
  measureInWindow: (callback: (x: number, y: number) => void) => void
}

export function BotsScreen({
  currentTab = 'chats',
  onOpenBot,
  onOpenSection,
  onOpenConversations,
  onShowList,
  selectedBot,
  variant = 'screen'
}: BotsScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const runtime = useChatRuntime()
  // `signOut` is read with a guard rather than destructured plainly: the
  // narrow shells that render this list stub the provider, and the footer's
  // identity row is written to draw without a way out rather than to insist on
  // one.
  const { config, connection, gatewayId, http, status, signOut } = useGateway()
  const bots = useBotsStore(state => state.bots)
  const byName = useBotsStore(state => state.byName)
  const running = useBotsStore(state => state.running)
  const lastSeen = useBotsStore(state => state.lastSeen)
  const avatars = useBotsStore(state => state.avatars)
  const loading = useBotsStore(state => state.loading)
  const error = useBotsStore(state => state.error)
  const chats = useChatsStore(state => state.chats)

  const entries = useChatLayoutStore(state => state.entries)
  const archivedSet = useChatLayoutStore(state => state.archived)
  const accents = useChatLayoutStore(state => state.accents)
  const mutes = useChatLayoutStore(state => state.mutes)
  const pinned = useChatLayoutStore(state => state.pinned)
  const reconcile = useChatLayoutStore(state => state.reconcile)

  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * The one folder whose name is a field right now, or `null`.
   *
   * What is left of edit mode, and deliberately not a mode: a folder is renamed
   * where it is drawn, one at a time, from its own menu or because it has just
   * been made and has no name yet. Everything else that mode used to switch on —
   * the grips, the reorder actions, the bar at the bottom — is either
   * unconditional now or reached from a menu, so there is nothing left for a
   * reader to turn on before the list will let them arrange it.
   */
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  /*
    The New-bot form. A sheet rather than a destination, because making a bot
    is a thing you do once and then leave — and the flow it wraps ends by
    OPENING the new bot's chat, so pushing a screen first would mean popping
    it again a moment later.
  */
  const [creatingBot, setCreatingBot] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** The bot whose profile sheet is open, by name. */
  const [profileFor, setProfileFor] = useState<string | null>(null)
  /* The memory browser REPLACES this screen, the way Settings' pages do. */
  const [memoryFor, setMemoryFor] = useState<string | null>(null)
  const [showBoards, setShowBoards] = useState(false)
  /*
    The (…) menu's way into the boards. This list IS the sidebar on a wide
    window — 300 to 340pt — so a board rendered in place here could never reach
    the 700pt its side-by-side layout needs. Where the shell offers a content
    column the board goes there instead; `showBoards` above is the phone's
    answer. See `features/kanban/boards-host.tsx`.
  */
  const openBoards = useBoardsOpener(() => setShowBoards(true))

  /*
    The profile sheet's connection. Built from the live socket rather than taken
    from the runtime, because `profiles.configure` and `profiles.set_asset` are
    plain gateway calls with nothing to do with a chat's session.
  */
  const profileGateway = useMemo(() => (connection ? chatGatewayFor(connection) : null), [connection])

  /**
   * The gateway half of the search.
   *
   * Names are matched on this device and are instant; messages are a fan-out
   * over the gateway behind a 300 ms debounce, so they land under the rows they
   * belong beneath rather than reordering a list somebody is already reading.
   */
  const messageSearch = useMessageSearch(query)

  const rail = variant === 'rail'
  const sidebar = variant === 'sidebar'
  const signedOut = status === 'needs_signin'

  // Stable identities, so that `BotRow`'s memo survives a roster refresh. A
  // fresh arrow per render would re-render forty rows because one of them
  // changed, which is the whole cost the memo is there to avoid.
  // The options argument is omitted rather than passed as `undefined` when there
  // are none: a tap on a row is the same call it has always been, and every
  // shell's handler can keep reading its second parameter as "somebody asked for
  // something extra".
  const openBot = useCallback(
    (bot: Bot, options?: OpenBotOptions) => (options ? onOpenBot?.(bot, options) : onOpenBot?.(bot)),
    [onOpenBot]
  )
  const moveBot = useCallback((name: string, offset: number) => {
    useChatLayoutStore.getState().moveBy(name, offset)
  }, [])
  const moveFolder = useCallback((folderId: string, offset: number) => {
    useChatLayoutStore.getState().moveFolderBy(folderId, offset)
  }, [])

  useEffect(() => {
    // Running state is polled only while this list is mounted; an unwatched
    // roster has nothing to animate.
    return runtime?.bots.watchRunning()
  }, [runtime])

  useEffect(() => {
    reconcile(bots.map(bot => bot.name))
  }, [bots, reconcile])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await runtime?.bots.refresh()
    } catch {
      // The store already holds the message; the list keeps what it had.
    } finally {
      setRefreshing(false)
    }
  }, [runtime])

  /**
   * One pass over the roster for every derived thing a row needs.
   *
   * Computed here rather than per row so that the filter chips can filter on
   * presence: a chip that hides everything except "Working" has to know which
   * rows those are before it renders any of them.
   */
  const presence = useMemo(() => {
    const map = new Map<string, Presence>()

    for (const bot of bots) {
      const chat = chats[bot.name]
      const needsInput = chat ? hasOpenRequest(chat) : false

      map.set(
        bot.name,
        presenceOf({
          gatewayReady: status === 'ready',
          needsInput,
          sessionAttached: Boolean(bot.canonical?.id),
          working: Boolean(running[bot.name]) || (chat?.turn.active ?? false),
          ...(bot.canonical?.lastActive ? { lastActive: bot.canonical.lastActive } : {})
        })
      )
    }

    return map
  }, [bots, chats, running, status])

  const unreadFor = useCallback(
    (name: string) => {
      const chat = chats[name]
      const count = chat ? unreadCountSince(chat, lastSeen[name] ?? 0) : 0

      return { count, unread: isUnread({ byName, lastSeen }, name) || count > 0 }
    },
    [byName, chats, lastSeen]
  )

  const folders = useChatLayoutStore(state => state.folders)
  const collapsed = useChatLayoutStore(state => state.collapsed)
  const arrangement = useMemo(() => ({ entries, folders }), [entries, folders])
  const archivedNames = useMemo(() => archivedOf(arrangement, archivedSet), [arrangement, archivedSet])
  const folderList = useMemo(() => foldersOf(arrangement), [arrangement])

  /**
   * Everything the rows and the anchors are derived from, in one object.
   *
   * Built here rather than inside each memo because `folderRows` and
   * `dragAnchors` have to be looking at the SAME arrangement: rows the reader
   * can see and positions a drop can land on that disagreed by one folder would
   * be a drag that lands a row somewhere nobody pointed at.
   */
  const rowsInput = useMemo<RowsInput>(
    () => ({
      arrangement,
      archived: archivedSet,
      collapsed,
      mutes,
      pinned,
      now: Math.floor(Date.now() / 1000),
      countsFor: (name: string) => {
        const counts = unreadFor(name)

        return { unread: counts.count, needsInput: presence.get(name)?.state === 'needsInput' }
      }
    }),
    [arrangement, archivedSet, collapsed, mutes, pinned, presence, unreadFor]
  )

  const rows = useMemo(() => folderRows(rowsInput), [rowsInput])

  /**
   * Each folder's colour, by id.
   *
   * The rows INSIDE a folder are drawn on that folder's plate, so they have to
   * know its colour — and a row cannot look it up, because a row is handed a bot
   * and not a container. One map, built with the folders, rather than a `find`
   * per row per render.
   */
  const folderColours = useMemo(() => {
    const out: Record<string, AccentName> = {}

    for (const folder of folders) {
      out[folder.id] = folder.colour ?? 'default'
    }

    return out
  }, [folders])

  /**
   * The list, flattened.
   *
   * Archived bots are excluded from the filters and from the unread totals —
   * archiving a bot is how you stop it counting — so they are appended after
   * the filter has run rather than passed through it.
   *
   * **An empty named section keeps its heading and gets a row of its own.** It
   * used to be dropped unless the list was in edit mode, which had two costs: a
   * section the owner had made vanished as soon as its last chat moved out, so
   * there was nothing left to move a chat back INTO; and in edit mode two
   * headings then landed back to back with only a heading's own padding between
   * them, which reads as one run-on line rather than as two sections. A heading
   * plus an explicit empty row cannot do either.
   *
   * A search is the exception: it narrows the list on purpose, and answering
   * "no matches" once per section would bury the matches.
   */
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = []
    const narrowed = Boolean(query.trim())
    const colourOfFolder = (id: string | null): AccentName => (id ? (folderColours[id] ?? 'default') : 'default')
    const shown = (name: string): Bot | null => {
      const bot = byName[name]

      return bot && matches(bot, query) ? bot : null
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]

      if (!row) {
        continue
      }

      if (row.kind === 'bot') {
        const bot = shown(row.name)

        if (bot) {
          out.push({
            archived: false,
            bot,
            folderColour: colourOfFolder(row.folderId),
            folderId: row.folderId,
            key: row.key,
            kind: 'bot',
            // Filled in below: which row is last inside a folder depends on
            // which rows the search dropped, and that is not known yet.
            lastInFolder: false
          })
        }

        continue
      }

      if (row.kind === 'folderEmpty') {
        out.push({ colour: colourOfFolder(row.folderId), id: row.folderId, key: row.key, kind: 'folderEmpty' })
        continue
      }

      if (row.kind !== 'folder') {
        continue
      }

      /*
        A search narrows the list on purpose, so a folder with nothing matching
        in it goes away rather than saying "no matches" once per folder and
        burying the matches. A folder being renamed stays: the field is on its
        header, and a header that disappeared under the caret would take the
        keyboard with it.
      */
      const hits = row.open
        ? row.folder.bots.filter(name => !archivedSet[name] && shown(name))
        : row.folder.bots.filter(name => !archivedSet[name] && shown(name))

      if (narrowed && row.folder.id !== renamingFolder && !hits.length) {
        // Skip the folder AND the rows it owns, which are the ones that follow.
        while (index + 1 < rows.length && rows[index + 1]?.kind !== 'folder') {
          index += 1
        }

        continue
      }

      out.push({ counts: row.counts, folder: row.folder, key: row.key, kind: 'folder', open: row.open })
    }

    /*
      Which member is the LAST one drawn inside its folder, which is the cell that
      rounds the bottom of the plate. Computed here, over the rows that survived
      the search, rather than from the arrangement: a folder whose final chat was
      filtered out still has to close its plate under the chat above it.
    */
    for (let index = 0; index < out.length; index += 1) {
      const item = out[index]
      const next = out[index + 1]

      if (item?.kind === 'bot' && item.folderId) {
        item.lastInFolder = !(next?.kind === 'bot' && next.folderId === item.folderId)
      }
    }

    if (archivedNames.length) {
      out.push({ count: archivedNames.length, key: 'archive', kind: 'archiveHeader' })

      if (archiveOpen) {
        for (const name of archivedNames) {
          const bot = byName[name]

          if (bot) {
            // The drawer is its own group and has no folder plate under it.
            out.push({
              archived: true,
              bot,
              folderColour: 'default',
              folderId: null,
              key: `${ARCHIVED_ROW_PREFIX}${name}`,
              kind: 'bot',
              lastInFolder: false
            })
          }
        }
      }
    }

    /*
     * The message matches, last.
     *
     * Below every row the local filter produced, because a name match is
     * instant and certain and a message match is neither: it is one round trip
     * per bot behind a debounce, and putting it above would shuffle the list
     * under a finger that was already reaching for a row.
     *
     * The block is keyed on the query these results ANSWER rather than on the
     * field's current value, so a stale section cannot survive a new query by
     * looking similar enough to be reused.
     */
    if (narrowed) {
      /*
       * "No conversation matches" used to be the list's EMPTY component, and a
       * list with a message section in it is never empty. So the line moves
       * into the list, where it can sit above the matches rather than being
       * switched off by them.
       */
      if (!out.some(item => item.kind === 'bot')) {
        out.push({ key: 'no-name-match', kind: 'noNameMatch', query: query.trim() })
      }
    }

    if (narrowed && messageSearch.query === query.trim()) {
      out.push({
        count: messageSearch.matches.length,
        key: 'messages',
        kind: 'messagesHeader',
        searching: messageSearch.searching
      })

      for (const match of messageSearch.matches) {
        const bot = byName[match.bot]

        if (bot) {
          out.push({ bot, key: `message:${match.bot}`, kind: 'message', match })
        }
      }
    }

    return out
  }, [archiveOpen, archivedNames, archivedSet, byName, folderColours, messageSearch, query, renamingFolder, rows])

  const hasRows = items.some(item => item.kind === 'bot')

  /**
   * The visible chats, in the order the reader sees them.
   *
   * ⌘1…9 and ⌘↑/↓ count in THIS order rather than in the roster's or the
   * arrangement's, because it is the only one the reader can see — a search or a
   * filter narrows the list, and a shortcut that skipped a hidden row would land
   * somewhere nobody pointed at. It is also what the Mac's menu bar names.
   */
  const visibleBots = useMemo(
    () => items.filter(item => item.kind === 'bot' && !item.archived).map(item => (item as { bot: Bot }).bot),
    [items]
  )

  /**
   * Unread messages across the visible chats, for the rail's badge.
   *
   * The one fact a hidden list would otherwise swallow: the rows are gone, so every
   * bead and every per-row badge is gone with them, and a message arriving while the
   * sidebar is collapsed would leave nothing at all on screen to say so.
   */
  const unreadTotal = useMemo(
    // Muted chats are left out. The rail's badge is the one number a reader who
    // has hidden the list is going to react to, and a chat they told the app to
    // be quiet about has no business pulling them back to it. The row itself
    // still carries its own count, for when they do look.
    () => {
      const now = Math.floor(Date.now() / 1000)

      return visibleBots.reduce(
        (total, bot) => total + (isMuted(mutes, bot.name, now) ? 0 : unreadFor(bot.name).count),
        0
      )
    },
    [mutes, unreadFor, visibleBots]
  )

  /** One stable array for every row's menu; see `BotRow.menuFolders`. */
  /*
    Read out of the table HERE rather than inside the memos below, and then
    depended on by name.

    A memo that produces TEXT has to recompute when the language changes, and
    `folderList` can sit still for hours. Depending on the SENTENCE rather than
    on the locale says why in the dependency array itself, and it is the thing
    that actually changed — `useLocale()` in the deps would be a value the
    callback never reads, which is both a lint warning and a worse explanation.
  */
  const topGroupName = strings.layout.topGroup
  const unnamedFolderName = strings.layout.unnamedFolder

  const menuFolders = useMemo(
    () => [
      { id: null, name: topGroupName },
      ...folderList.map(folder => ({ id: folder.id, name: folder.name || unnamedFolderName }))
    ],
    [folderList, topGroupName, unnamedFolderName]
  )

  const listRef = useRef<FlatList<ListItem>>(null)
  /**
   * `onListTop`, held so `measureList` can report into it.
   *
   * The measurement is asked for by the hook and answered by this screen, and the
   * two halves are created in the same call — so one of them has to be reached
   * through a ref rather than through the closure.
   */
  const dragTop = useRef<((y: number) => void) | null>(null)
  const searchRef = useRef<TextInput>(null)
  const scrollOffset = useRef(0)

  /**
   * Where the list's top edge is, in the window.
   *
   * It cannot be read off a touch and it cannot be assumed: on the phone the list
   * sits under a search field, on the iPad under a floating header and beside the
   * rail, and in a Mac window under a title bar that is outside the app entirely.
   * `getNativeScrollRef` is the scroll view itself, which is the view the cells were
   * measured inside, so the two coordinate spaces meet exactly here.
   */
  const measureListTop = useCallback(() => {
    // `getNativeScrollRef` is typed as the union of everything a scrollable host
    // can be, and only one arm of it declares the measuring methods every host
    // component actually has. The narrowing says what is being relied on.
    const scroll = listRef.current?.getNativeScrollRef() as Measurable | null | undefined

    scroll?.measureInWindow((_x: number, y: number) => {
      dragTop.current?.(y)
    })
  }, [])

  /*
    Anchors come from the ARRANGEMENT rather than from the rendered items, and
    that is the one thing to be careful about here. With dividers the two were
    the same list filtered; with folders a position is a container and an index
    inside it, and the rendered list has rows that stand for no position at all
    (a folder's own header stands for two) and hides rows that still have one (a
    collapsed folder's children). Deriving the drop targets from what is drawn
    would put a row into whichever folder happened to be above the gap.
  */
  const anchors = useMemo(() => dragAnchors(rowsInput), [rowsInput])

  /**
   * The row whose fallback sheet this press has asked for, until the gesture says
   * which of the two things it was.
   *
   * Only where there is no native menu. UIKit opens its own on the hold and
   * cancels it the moment the touch moves, which is the behaviour being copied
   * here: the sheet is held back until the press ENDS, and a press that became a
   * drag clears it on the way (`onDragStart`). Without that, holding a row on a
   * phone would lift it under a sheet that had already covered it.
   *
   * A ref rather than state: nothing is drawn from it, and a re-render per press
   * is forty rows re-rendered for a question that is answered a moment later.
   */
  const pendingMenu = useRef<string | null>(null)

  const drag = useRowDrag({
    anchors,
    /*
      A pinned row stays among the pinned rows, and an unpinned one below them.

      Applied to the SLOT rather than to the commit, which is what keeps the
      drop line the reader watches and the arrangement they end up with from
      being two different answers: the sort re-runs on every arrangement change,
      so a pinned row "dropped" below the band would spring back to the top and
      the gesture would look undone. See `clampToPinnedBand`.
    */
    clampSlot: useCallback(
      (rowKey: string, slot: number) => clampToPinnedBand(anchors, pinned, rowKey, slot),
      [anchors, pinned]
    ),
    // Past the last row is the end of the TOP LEVEL, never the end of whichever
    // folder happened to be last: dragging to the bottom is how a chat gets out
    // of the last folder.
    fallbackTarget: useMemo<DropTarget>(() => ({ folderId: null, index: entries.length }), [entries.length]),
    measureList: measureListTop,
    onAutoScroll: useCallback((delta: number) => {
      const next = Math.max(0, scrollOffset.current + delta)

      listRef.current?.scrollToOffset({ animated: false, offset: next })
    }, []),
    onDragStart: useCallback(() => {
      // The hold was a drag after all, so the sheet it was holding never opens.
      pendingMenu.current = null
    }, []),
    onCommit: useCallback(
      (rowKey: string, target: DropTarget) => {
        const row = parseRowKey(rowKey)

        if (!row) {
          return
        }

        // Dropping a row immediately before or immediately after itself is the
        // same arrangement, and committing it would churn the disk and the
        // gateway for nothing. The comparison is per CONTAINER: index 2 of the
        // top level and index 2 of a folder are different places.
        if (isSameRowPlace(arrangement, rowKey, target)) {
          return
        }

        const index = committedRowIndex(arrangement, rowKey, target)

        if (row.kind === 'folder') {
          /*
            A folder only ever lands at the TOP LEVEL, because folders do not
            nest: an arrangement is a top level and a set of folders holding
            chat names. `committedRowIndex` has already turned a target inside
            some other folder into the position that folder occupies, which is
            what "drop it next to that one" means — see `topLevelIndexOf`.
          */
          useChatLayoutStore.getState().dropFolder(row.id, index)

          return
        }

        useChatLayoutStore.getState().dropBot(row.name, target.folderId, index)
      },
      [arrangement]
    ),
    reduceMotion: theme.reduceMotion
  })

  dragTop.current = drag.onListTop

  /*
    The two halves of the gesture, taken out of the drag ONE level up.

    `arm` and `disarm` never change identity; the object holding them changes
    whenever a row is lifted or put down. Reading them here is what lets the two
    handlers below keep their own identity across a drag — and a handler that did
    not would re-render every row in the list twice per gesture, which is the
    cost `BotRow`'s memo exists to avoid.
  */
  const { arm, disarm } = drag

  /**
   * A row was held: arm the drag, and remember the menu that hold might mean.
   *
   * One handler for both kinds of row, because a row key is all either of them
   * needs.
   */
  const armRow = useCallback(
    (rowKey: string) => {
      pendingMenu.current = HAS_NATIVE_CONTEXT_MENU ? null : rowKey
      arm(rowKey)
    },
    [arm]
  )

  /**
   * The press ended. If it never became a drag, THIS is the long press's menu.
   *
   * Fired from every press-out, including the ones that end an ordinary tap —
   * which is why the pending key is only ever set by a long press. A folder has
   * no sheet to fall back to, so it simply has nothing to open here.
   */
  const releaseRow = useCallback(() => {
    const rowKey = pendingMenu.current

    pendingMenu.current = null
    disarm()

    const name = rowKey ? menuTargetOf(rowKey) : null

    if (name) {
      setMenuFor(name)
    }
  }, [disarm])

  /** The name of whatever is currently lifted, for the live region below. */
  const draggingLabel = useMemo(() => {
    const row = drag.draggingKey ? parseRowKey(drag.draggingKey) : null

    if (!row) {
      return null
    }

    if (row.kind === 'folder') {
      return folders.find(folder => folder.id === row.id)?.name || unnamedFolderName
    }

    return byName[row.name]?.displayName ?? row.name
  }, [byName, drag.draggingKey, folders, unnamedFolderName])

  /**
   * What every cell has to know, and nothing more.
   *
   * A new object here re-renders the cells, so it is memoized on the only two
   * things they read — which means a drag costs one re-render of the list's cells
   * when it starts and one when it ends, and none of the sixty in between.
   */
  const cellState = useMemo(
    () => ({ liftedKey: drag.liftedKey, measure: drag.measure }),
    [drag.liftedKey, drag.measure]
  )

  const openIndex = useCallback(
    (index: number) => {
      const bot = visibleBots[index]

      if (bot) {
        openBot(bot)
      }
    },
    [openBot, visibleBots]
  )

  // ⌘K on the rail has no field to land in, so it asks for the list back instead —
  // which is where the field is. Silently focusing a ref that is null would be a
  // shortcut that reports success and does nothing.
  useShortcut('search', () => (rail ? onShowList?.() : searchRef.current?.focus()))
  useNumberedShortcuts(openIndex)

  /**
   * ⌘↑ / ⌘↓ and ⌃Tab, relative to the row that is open.
   *
   * With nothing open the first press lands on the first chat rather than on the
   * last: a reader who has just started the app and reaches for "next" means the
   * top of the list.
   */
  const step = useCallback(
    (offset: number) => {
      const at = visibleBots.findIndex(bot => bot.name === selectedBot)

      openIndex(at === -1 ? 0 : Math.max(0, Math.min(visibleBots.length - 1, at + offset)))
    },
    [openIndex, selectedBot, visibleBots]
  )

  useShortcut('nextChat', () => step(1))
  useShortcut('previousChat', () => step(-1))

  /**
   * One ref, two readers. The list is held so a drag can auto-scroll it, and
   * `applyDirectTouchPan` still has to see the same view — a Mac must not pan this
   * list under a pointer either (`platform/pointer-drag`). `useCallback`, because a
   * fresh callback ref per render is a detach and a re-attach per render.
   */
  const attachList = useCallback((view: FlatList<ListItem> | null) => {
    listRef.current = view
    directTouchPanRef(view)
  }, [])

  /** Rename from a folder's own menu: the caret goes into that folder's header. */
  const renameFolder = useCallback((id: string) => setRenamingFolder(id), [])

  /** A folder made from a menu is a folder with no name yet, so it opens in one. */
  const addFolder = useCallback(() => setRenamingFolder(useChatLayoutStore.getState().addFolder('')), [])

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffset.current = event.nativeEvent.contentOffset.y
      drag.onListScroll(scrollOffset.current)
    },
    [drag]
  )

  /**
   * Scroll to the folder a widget tap named.
   *
   * The folder has already been OPENED by the shell that read the link — that is
   * a write to the arrangement and works whether or not this list exists — so
   * all that is left here is to put it in the window. Both halves are needed:
   * an open folder twelve rows down a list somebody has scrolled is a folder
   * they will not find.
   *
   * Two sources, exactly as `useHermieLink` has two. `consume` answers the cold
   * start, where the link was read during the first mount and this list did not
   * exist yet; the subscription answers a tap on an app that was already open.
   * A folder id that is not in the list any more scrolls nothing rather than
   * throwing — `scrollToIndex` on -1 is a crash on some versions.
   *
   * `items` is in the dependencies on purpose: on a cold start the list is
   * empty on the first pass and the roster arrives a moment later, so the
   * consumed id has to be re-applied once there is something to scroll to.
   */
  const revealed = useRef<string | null>(null)

  useEffect(() => {
    const reveal = (folderId: string): void => {
      const index = items.findIndex(item => item.kind === 'folder' && item.folder.id === folderId)

      if (index < 0) {
        // Remembered, not dropped: the roster is very often still loading on the
        // launch a widget tap produces, and the row appears a render later.
        revealed.current = folderId

        return
      }

      revealed.current = null
      listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0 })
    }

    const pending = revealed.current ?? consumeRevealFolder()

    if (pending) {
      reveal(pending)
    }

    return onRevealFolder(reveal)
  }, [items])

  /**
   * Hand the Mac's menu bar the same nine chats ⌘1…9 reaches, with the app's own
   * wording. A no-op on every other platform — see `platform/desktop-shortcuts`.
   *
   * The sidebar item's wording is resolved HERE because `variant` is the answer: a
   * rail is a hidden list and a sidebar is a showing one, so the menu says the
   * thing the keystroke will do without anybody measuring a window. On the phone's
   * Chats screen the item is still sent and still does nothing — the same as ⌘W on
   * a bare list, and a phone has no menu bar to read it in.
   */
  const toggleSidebarItem = rail ? strings.menuBar.showSidebar : strings.menuBar.hideSidebar

  useEffect(() => {
    setMenuBar(
      { ...strings.menuBar, toggleSidebar: toggleSidebarItem },
      visibleBots.slice(0, 9).map(bot => bot.displayName)
    )
    // `toggleSidebarItem` stands in for `rail` as well as for the language: it
    // is the one value here that moves when either of them does, so a menu bar
    // built in English is replaced the moment the reader picks another
    // language rather than waiting for the roster to change.
  }, [toggleSidebarItem, visibleBots])

  /**
   * One selection from either menu.
   *
   * The native menu and the fallback sheet report the same ids (`row-menu-items`),
   * so this is the only handler for both and there is no second table of what a row
   * can do sitting beside the first one.
   */
  const onMenuSelect = useCallback(
    (name: string, id: string) => {
      const action = parseRowMenuAction(id)
      const layout = useChatLayoutStore.getState()

      switch (action?.kind) {
        case 'open': {
          const bot = byName[name]

          if (bot) {
            openBot(bot)
          }

          return
        }

        case 'markRead':
          useBotsStore.getState().markSeen(name, byName[name]?.canonical?.lastActive)

          return

        case 'accent':
          layout.setAccent(name, action.accent)

          return

        case 'pinToggle':
          layout.togglePinned(name)

          return

        case 'folder':
          layout.moveToFolder(name, action.folderId)

          return

        case 'move':
          layout.moveBy(name, action.offset)

          return

        case 'archiveToggle':
          layout.setArchived(name, !layout.archived[name])

          return

        case 'editProfile':
          setProfileFor(name)

          return

        case 'mute':
          layout.setMute(name, muteUntil(action.duration, Math.floor(Date.now() / 1000)))

          return

        case 'unmute':
          layout.setMute(name, null)

          return

        case 'newFolder': {
          const id = layout.addFolderAround(name, '')

          // Straight into the field: a folder that stays untitled is what put two
          // headings next to each other.
          if (id) {
            setRenamingFolder(id)
          }

          return
        }

        default:
          return
      }
    },
    [byName, openBot]
  )

  /**
   * The folder a drop would land in, or `null`.
   *
   * Read off the anchor's TARGET rather than off its key, which is what makes
   * one answer cover three gestures: onto the folder's own header
   * (`folderIn:<id>`), into an empty one (`folderEmpty:<id>`), and between two
   * chats already inside it (a `bot:` anchor whose target names the folder).
   * All three mean "in here", and the plate has to say so for all three.
   *
   * A FOLDER being dragged is excluded. Folders do not nest — `topLevelIndexOf`
   * maps any target inside a folder back to that folder's own position — so
   * lighting the plate would promise a containment the arrangement cannot hold.
   */
  const dropFolderId = useMemo(() => {
    const dragged = drag.draggingKey ? parseRowKey(drag.draggingKey) : null

    if (!drag.dropKey || dragged?.kind !== 'bot') {
      return null
    }

    return anchors.find(anchor => anchor.key === drag.dropKey)?.target.folderId ?? null
  }, [anchors, drag.draggingKey, drag.dropKey])

  /**
   * Open or close a folder. Local to this device; see `PersistedLayout`.
   *
   * The rows arrive and leave with a layout animation, which is the difference
   * between a folder opening and a list suddenly being longer. One frame of
   * configuration for the next commit, and `durationFor` collapses it to zero
   * under Reduce Motion — the same rule every other motion in the app follows.
   * `create`/`delete` fade rather than scale: the rows are full-width and a scale
   * on one reads as the list breathing.
   */
  const toggleFolder = useCallback(
    (id: string, open: boolean) => {
      const duration = durationFor('row', theme.reduceMotion)

      if (duration > 0) {
        LayoutAnimation.configureNext({
          duration,
          create: { type: 'easeInEaseOut', property: 'opacity' },
          delete: { type: 'easeInEaseOut', property: 'opacity' },
          update: { type: 'easeInEaseOut' }
        })
      }

      useChatLayoutStore.getState().setFolderOpen(id, open)
    },
    [theme.reduceMotion]
  )

  /**
   * A folder's own menu, which is the row menu's alphabet one level up.
   *
   * Mute is the one line that fans out: a folder has no mute of its own, it
   * just applies the chosen span to every chat inside it at once. Storing a
   * mute on the folder would be a second place a chat can be silent from, and
   * then a chat dragged out of a muted folder would be carrying a mute nobody
   * could see or lift.
   */
  const onFolderMenuSelect = useCallback((folderId: string, id: string) => {
    const action = parseFolderMenuAction(id)
    const layout = useChatLayoutStore.getState()
    const folder = layout.folders.find(entry => entry.id === folderId)

    if (!action || !folder) {
      return
    }

    switch (action.kind) {
      case 'colour':
        layout.setFolderColour(folderId, action.accent)

        return

      case 'delete':
        layout.removeFolder(folderId)

        return

      case 'newFolder':
        setRenamingFolder(layout.addFolder(''))

        return

      case 'move':
        layout.moveFolderBy(folderId, action.offset)

        return

      case 'mute': {
        const until = muteUntil(action.duration, Math.floor(Date.now() / 1000))

        for (const name of folder.bots) {
          layout.setMute(name, until)
        }

        return
      }

      case 'unmute':
        for (const name of folder.bots) {
          layout.setMute(name, null)
        }

        return

      default:
        return
    }
  }, [])

  // A chat-level failure must not compete with the signed-out card: a dead
  // session is not a roster problem and showing both makes neither readable.
  const rosterError = signedOut ? null : error

  /*
   * The collapsed sidebar, after every hook above has run.
   *
   * Placed here rather than at the top of the component on purpose: the roster
   * poll, the layout reconcile, the numbered shortcuts and the menu bar are all
   * registered above, and they are exactly what a rail must not switch off. An
   * early return before them would be the bug this variant exists to avoid.
   */
  if (rail) {
    return (
      <SidebarRail
        current={currentTab}
        unread={unreadTotal}
        {...(onOpenSection ? { onOpenSection } : {})}
        {...(onShowList ? { onShowList } : {})}
      />
    )
  }

  if (memoryFor) {
    return <MemoryBotsScreen initialProfile={memoryFor} onClose={() => setMemoryFor(null)} />
  }

  /*
    Boards REPLACES the chat list, which is what Memory above already does and
    for the same reason: this screen lives in a native stack on a phone and
    inside a panel with no navigator on a wide window, so pushing would only
    ever be right on one of them.
  */
  if (showBoards) {
    return <KanbanScreen backLabel={strings.bots.title} onClose={() => setShowBoards(false)} />
  }

  return (
    // The sidebar sits inside a panel the shell has already inset; the phone
    // screen is full-bleed and has to clear the notch and the home bar itself.
    <View style={sidebar ? { flex: 1 } : { flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
      <Head sidebar={sidebar} onBoards={openBoards} onNewBot={() => setCreatingBot(true)} onNewFolder={addFolder} />

      {/*
        One connection line, on every layout, under the title. It draws nothing
        while the connection is healthy — see `ConnectionLine`.
      */}
      <ConnectionLine />

      <SearchField
        inputRef={searchRef}
        label={strings.bots.search}
        onChangeText={setQuery}
        // Return in the search field opens the first match, which is what Return in
        // a search field does everywhere. It is the visible order, so it is the same
        // row ⌘1 would open.
        onSubmit={() => openIndex(0)}
        style={{ marginBottom: theme.space.md, marginHorizontal: theme.space.lg }}
        testID="bots-search"
        value={query}
      />

      {signedOut ? (
        <Text
          color="warnText"
          style={{ paddingBottom: theme.space.sm, paddingHorizontal: theme.space.lg }}
          variant="meta"
        >
          {strings.signedOut.listNote}
        </Text>
      ) : null}

      <DragCellProvider value={cellState}>
        <FlatList
          CellRendererComponent={DragCell}
          ref={attachList}
          ListEmptyComponent={
            <EmptyState error={rosterError} loading={loading} query={query} searching={Boolean(query.trim())} />
          }
          data={items}
          extraData={hasRows}
          keyExtractor={item => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onLayout={event => {
            drag.onListLayout(event.nativeEvent.layout.height)
            // A layout is the only moment the list's place in the window can have
            // changed without anybody touching it — a rotation, the sidebar opening,
            // a Mac window resized.
            measureListTop()
          }}
          onScroll={onListScroll}
          refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
          renderItem={({ item }) => {
            if (item.kind === 'archiveHeader') {
              return (
                <ArchiveHeader count={item.count} onToggle={() => setArchiveOpen(open => !open)} open={archiveOpen} />
              )
            }

            if (item.kind === 'noNameMatch') {
              return (
                <Text
                  color="textMuted"
                  style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md }}
                  testID="bots-empty"
                >
                  {strings.bots.noMatches(item.query)}
                </Text>
              )
            }

            if (item.kind === 'messagesHeader') {
              return <MessagesHeader count={item.count} searching={item.searching} />
            }

            if (item.kind === 'message') {
              return (
                <MessageHit
                  bot={item.bot}
                  match={item.match}
                  onPress={() => openBot(item.bot, { findText: query.trim() })}
                />
              )
            }

            if (item.kind === 'folder') {
              const liftedFolder = drag.draggingKey === item.key
              /*
                A closed folder IS the whole group, so it rounds all four
                corners. An open one is the top of a plate the rows below it
                continue — including the placeholder row an empty open folder
                draws, which is why `size` is not the test.
              */
              const edge: FolderGroupEdge = item.open ? 'top' : 'only'

              return (
                /*
                  The same wrapper a chat row gets, and deliberately the same
                  one: the lift, the shadow and the neighbour offset are the
                  drag's, not the row's, so a folder that animated differently
                  from a chat would be a second implementation of the gesture
                  to keep in step with the first.
                */
                <Animated.View
                  {...drag.rowHandlers(item.key)}
                  style={
                    liftedFolder
                      ? {
                          elevation: 8,
                          shadowColor: '#000',
                          shadowOffset: { height: 6, width: 0 },
                          shadowOpacity: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
                          shadowRadius: 12,
                          transform: [
                            { translateY: drag.translateY },
                            { scale: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [1, LIFT_SCALE] }) }
                          ]
                        }
                      : { transform: [{ translateY: drag.offsetFor(item.key) }] }
                  }
                  testID={liftedFolder ? `folder-row-lifted-${item.folder.id}` : undefined}
                >
                  <FolderGroup
                    colour={item.folder.colour ?? 'default'}
                    edge={edge}
                    targeted={dropFolderId === item.folder.id}
                    testID={`folder-group-${item.folder.id}`}
                  >
                    <FolderHeader
                      counts={item.counts}
                      folder={item.folder}
                      naming={item.folder.id === renamingFolder}
                      onArm={armRow}
                      onDisarm={releaseRow}
                      onMenuSelect={onFolderMenuSelect}
                      onMove={moveFolder}
                      onNamed={() => setRenamingFolder(null)}
                      onRename={renameFolder}
                      onToggle={toggleFolder}
                      open={item.open}
                    />
                  </FolderGroup>
                </Animated.View>
              )
            }

            if (item.kind === 'folderEmpty') {
              return (
                <Animated.View style={{ transform: [{ translateY: drag.offsetFor(item.key) }] }}>
                  <FolderGroup colour={item.colour} edge="bottom" indent targeted={dropFolderId === item.id}>
                    <FolderEmpty id={item.id} />
                  </FolderGroup>
                </Animated.View>
              )
            }

            const state = presence.get(item.bot.name) ?? ARCHIVED_PRESENCE
            const { count, unread } = unreadFor(item.bot.name)
            const lifted = drag.draggingKey === item.key
            const inFolder = item.folderId

            const row =
              (
                /*
                 * The wrapper carries three things a row cannot carry itself: the
                 * measurement the drop arithmetic needs, the pan responder that claims
                 * the gesture once a long press has armed it, and the lift.
                 *
                 * The lift is a TRANSFORM on the row in place rather than a separate drag
                 * layer. A portal would let the row leave the list, which nothing here
                 * needs — the drop targets are all inside it — and it would cost a second
                 * copy of the row to keep in sync with the first.
                 *
                 * What it cannot carry is the z-order or the measurement: both belong to
                 * the cell this wrapper sits inside, which is `DragCell`.
                 */
                <Animated.View
                  {...(item.archived ? {} : drag.rowHandlers(item.key))}
                  /*
                   * Two states, one style: LIFTED reads off the drag's own `lift`
                   * value, everything else off its row offset. Neither is a boolean
                   * in a style object any more — a row that changed size in one frame
                   * was the tell that this was a transform applied rather than a row
                   * picked up.
                   */
                  style={
                    lifted
                      ? {
                          elevation: 8,
                          shadowColor: '#000',
                          shadowOffset: { height: 6, width: 0 },
                          // Interpolated off the lift so the shadow arrives with the
                          // scale and leaves with it, rather than blinking on.
                          shadowOpacity: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
                          shadowRadius: 12,
                          transform: [
                            { translateY: drag.translateY },
                            { scale: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [1, LIFT_SCALE] }) }
                          ]
                        }
                      : { transform: [{ translateY: drag.offsetFor(item.key) }] }
                  }
                  testID={lifted ? `bot-row-lifted-${item.bot.name}` : undefined}
                >
                  <BotRow
                    accent={accents[item.bot.name] ?? 'default'}
                    archived={item.archived}
                    bot={item.bot}
                    compact={!sidebar}
                    menuFolders={menuFolders}
                    mutedUntil={mutedUntilOf(mutes, item.bot.name, Math.floor(Date.now() / 1000))}
                    pinned={Boolean(pinned[item.bot.name])}
                    onArm={armRow}
                    onDisarm={releaseRow}
                    onMenuSelect={onMenuSelect}
                    onMove={moveBot}
                    onOpenMenu={setMenuFor}
                    onPress={openBot}
                    presence={item.archived ? ARCHIVED_PRESENCE : state}
                    rowKey={item.key}
                    selected={item.bot.name === selectedBot}
                    unread={item.archived ? false : unread}
                    unreadCount={item.archived ? 0 : count}
                    {...(avatars[item.bot.name] ? { avatarUri: avatars[item.bot.name] } : {})}
                  />
                </Animated.View>
              )

            /*
              A chat inside a folder is drawn ON the folder's plate and stepped in
              from it, which is the other half of what makes a folder read as a
              container rather than as a heading. A loose chat is the row on its
              own, exactly as it was.

              The plate is OUTSIDE the drag wrapper, so a lifted row rises out of
              its folder rather than carrying a slice of the plate with it.
            */
            if (!inFolder) {
              return row
            }

            return (
              <FolderGroup
                colour={item.folderColour}
                edge={item.lastInFolder ? 'bottom' : 'middle'}
                indent
                targeted={dropFolderId === inFolder}
                testID={`folder-member-${item.bot.name}`}
              >
                {row}
              </FolderGroup>
            )
          }}
          // While a row is lifted the list must not also pan: the auto-scroll at the
          // edges is what moves it, and two scrollers would fight over one finger.
          scrollEnabled={drag.draggingKey === null}
          scrollEventThrottle={16}
          style={{ flex: 1 }}
          testID="bots-list"
        />
      </DragCellProvider>

      {/*
        What is being dragged, said out loud.

        It names the ROW rather than the key: a folder is announced by its own
        name and a chat by its display name, because `folder:d3f` read out to
        somebody who cannot see the lift is worse than saying nothing.
      */}
      {draggingLabel ? (
        <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
          {strings.layout.dragging(draggingLabel)}
        </Text>
      ) : null}

      {/*
        Unconditional, where it used to be gated on `onOpenSection`. The footer
        is two things and only one of them is the tab strip: the identity row
        above it is who this device is signed in as, which is true of the list
        whether or not the list is also the place the four destinations are
        reached from. `SidebarFooter` draws the strip only when there is
        somewhere to send it, and `SidebarIdentity` draws nothing at all where
        there is no account — so a screen with neither is unchanged.
      */}
      <SidebarFooter
        current={currentTab}
        {...(onOpenSection ? { onOpenSection } : {})}
        {...(signOut ? { onSignOut: () => void signOut() } : {})}
      />

      {menuFor ? (
        /*
          The same list the native menu draws, and the same handler it reports to.

          It used to build its own — which is how it came to offer a colour, an
          Archive and one line per section, and nothing that reorders. See
          `RowMenu`.
        */
        <RowMenu
          accent={accents[menuFor] ?? 'default'}
          botName={menuFor}
          displayName={byName[menuFor]?.displayName ?? menuFor}
          items={rowMenuItems({
            accent: accents[menuFor] ?? 'default',
            archived: Boolean(archivedSet[menuFor]),
            botName: menuFor,
            displayName: byName[menuFor]?.displayName ?? menuFor,
            movable: !archivedSet[menuFor],
            mutedUntil: mutedUntilOf(mutes, menuFor, Math.floor(Date.now() / 1000)),
            pinned: Boolean(pinned[menuFor]),
            folders: menuFolders,
            unread: unreadFor(menuFor).unread
          })}
          onClose={() => setMenuFor(null)}
          onSelect={id => onMenuSelect(menuFor, id)}
          visible
        />
      ) : null}

      {/*
        The profile editor, opened from the row menu's Edit profile.

        A sibling of the row menu rather than a page inside it: the menu is a
        list of intentions and this is a form, and `RowMenu` closes on every
        selection — including this one — so the two are never on screen at once.
      */}
      {profileFor && byName[profileFor] ? (
        <BotProfileSheet
          avatarUri={avatars[profileFor]}
          bot={byName[profileFor]}
          gateway={profileGateway}
          gatewayId={gatewayId}
          http={http}
          gatewayVersion={config?.version ?? ''}
          onClose={() => setProfileFor(null)}
          onOpenMemory={() => {
            // The sheet goes first, so the page is not a second modal over it.
            setProfileFor(null)
            setMemoryFor(profileFor)
          }}
          {...(onOpenConversations
            ? {
                onOpenConversations: () => {
                  // The sheet closes first: the page it opens is a full screen,
                  // and leaving a sheet behind it would put the reader back on
                  // this bot's profile when they press Back.
                  setProfileFor(null)
                  onOpenConversations(profileFor)
                }
              }
            : {})}
          onSaved={() => void runtime?.bots.refresh()}
          visible
        />
      ) : null}

      {/*
        `onOpened` is what makes this the chat list's entry point rather than
        Settings': a bot made here lands the reader in its conversation, which
        is the only reason they made it. The chat it opens is the canonical one,
        resolved the ordinary way — `NewBotFlow` never mints a session itself.
      */}
      <NewBotFlow onClose={() => setCreatingBot(false)} onOpened={bot => openBot(bot)} visible={creatingBot} />
    </View>
  )
}

/** The compact shell's Chats screen shows the stopped-gateway card in place of the list. */
export function BotsScreenOrSignedOut(props: BotsScreenProps) {
  const { config, lastError, status } = useGateway()

  // Every stop, not only a signed-out one: a gateway that refuses this address
  // has no roster to list either, and the list's "showing the last saved list"
  // reads as a delay rather than as a dead end.
  return gatewayStop({ config, error: lastError, status }) ? <GatewayStoppedPanel /> : <BotsScreen {...props} />
}

/**
 * The secondary actions, behind one `…`, at every width.
 *
 * The owner's report was about the Mac sidebar — this row was "all very
 * cramped", under a screenshot of `Boards  Nieuwe bot…  ⊕  Bewerken` pressed
 * into one line above the search field. Four controls beside a `flex: 1` title,
 * three of them WORDS that do not shrink, and in Dutch and German those words
 * are longer than the English they were measured in.
 *
 * The previous answer folded them away below a measured width and kept all four
 * inline above it. That fixed the narrow sidebar and left the cramped one
 * exactly as it was: 340pt is wide enough to FIT four controls and not wide
 * enough to make them read as four separate things. So the fold is gone and the
 * menu is unconditional — one arrangement at 300pt, at 900pt and everywhere
 * between, which is also one arrangement to hold in mind.
 *
 * Edit used to stay out of it, on the argument that a MODE is toggled too often
 * to sit two taps deep. There is no mode any more — a row is held and moved, a
 * folder is renamed in place from its own menu — so what is left of it is the one
 * action that had nowhere else to live: **New folder**. It belongs here rather
 * than beside the title for the reason the rest of this menu does: it is used
 * once in a while, and a word that never shrinks is what made this row cramped.
 *
 * Drawn the way every other floating menu in the app is drawn — an opaque glass
 * surface, absolutely positioned so that opening it lays nothing out, arriving
 * from above because that is where the button is, Escape closing one level.
 * That is the same host `ChatOptionsPopover` uses, for the reasons it gives. It
 * is NOT `ContextMenuHost`, which the row menu uses: that one is a long-press
 * and secondary-click host backed by a native Mac view, it cannot be opened by
 * a tap at all, and on an iPad it would render no menu, so the actions would
 * simply be gone.
 */
function HeadOverflowMenu({
  onBoards,
  onNewBot,
  onNewFolder
}: {
  onBoards?: () => void
  onNewBot?: () => void
  onNewFolder?: () => void
}) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)

  useEscapeKey(() => setOpen(false), open)

  const rows: { id: string; label: string; onPress: () => void }[] = [
    ...(onNewBot ? [{ id: 'new-bot', label: profileStrings.settings.newBot, onPress: onNewBot }] : []),
    ...(onNewFolder ? [{ id: 'new-folder', label: strings.layout.newFolder, onPress: onNewFolder }] : []),
    ...(onBoards ? [{ id: 'boards', label: kanbanStrings.menu, onPress: onBoards }] : [])
  ]

  // A `…` that opens an empty surface is worse than no `…` at all. This screen
  // hands over both actions; the guard is for a shell that hands over neither.
  if (!rows.length) {
    return null
  }

  return (
    <View>
      {/*
        The chat header's button, not a glyph in a gap.

        It was a bare `ellipsis` with a tap target around it — the owner's
        verdict was that it "could be prettier" — and the shape this app already
        has for "a control that floats over a surface" is `RoundIconButton`: a
        glass circle at `CONTROL_SIZE.regular` with a 19pt mark centred in it,
        which is exactly what the chat's own back, sidebar and options buttons
        are. One component, so the two headers cannot drift apart, and `opaque`
        for the same reason they are: the list scrolls under this row.

        `aria-expanded` travels with it (`expanded`), because a button that
        opens a menu has to say so and react-native-web drops the
        `accessibilityState` spelling on the floor — see
        `accessibility-state.test.tsx`.
      */}
      <RoundIconButton
        expanded={open}
        icon="ellipsis"
        label={strings.bots.moreActions}
        onPress={() => setOpen(current => !current)}
        opaque
        size={CONTROL_SIZE.regular}
        testID="bots-head-overflow"
      />

      <Appear
        rise={-6}
        style={{
          position: 'absolute',
          right: 0,
          // Clear of the button rather than measured off it: the button's box IS
          // the circle's diameter, and a menu that overlapped the thing that
          // opened it would take its own next tap. One `space.xs` below it, so
          // the two read as a control and its menu rather than as one shape.
          top: CONTROL_SIZE.regular + 4,
          zIndex: 2
        }}
        visible={open}
      >
        {/*
          `float`, which is the app's own name for a surface that hangs over
          content rather than holding a screen together, and which already
          carries the radius and the shadow that go with it.

          `opaque` for the reason `AttachMenu` gives: a text-heavy surface takes
          the solid rung under its wash, so its contrast is a fixed number
          rather than a function of whatever is behind it. Without it this menu
          floats over the chat list at the wash's own alpha, and the simulator
          showed a menu line printed across the name of the chat underneath —
          two strings at the same weight in the same place.
        */}
        <GlassSurface contentStyle={{ minWidth: 168, paddingVertical: theme.space.xxs }} opaque variant="float">
          {rows.map(row => (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              key={row.id}
              onPress={() => {
                setOpen(false)
                row.onPress()
              }}
              style={{
                cursor: 'pointer',
                justifyContent: 'center',
                minHeight: CONTROL_MIN_HEIGHT,
                paddingHorizontal: theme.space.md
              }}
              testID={`bots-head-overflow-${row.id}`}
            >
              <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
                {row.label}
              </Text>
            </Pressable>
          ))}
        </GlassSurface>
      </Appear>
    </View>
  )
}

/**
 * The chat list's head row: the screen's name, and two controls.
 *
 * ## One, and always the same one
 *
 * The `…`. Everything this row used to offer is behind it (see
 * `HeadOverflowMenu`), including New folder; the `+` that used to sit beside it
 * is GONE rather than moved, because it was labelled New cron, it made a cron,
 * and a cron is made on the Crons tab — which has its own `cron-create` button
 * for exactly that. A second door to one screen's primary action, parked in
 * another screen's header, is a door that has to be kept in step with the room
 * behind it.
 *
 * **Edit went with it, and that is this round's change.** It was the header's
 * only mode: a word the reader pressed to reveal a grip on every row and a bar
 * at the bottom of the list, pressed again when they had finished. The owner's
 * verdict was that it should not be there at all — _"When I hold a chat I want
 * to be able to move it right away"_ — which is how the rest of the platform
 * behaves, and what the list does now. Nothing that mode switched on was lost:
 * the drag is a hold, the reorder actions are on every row, a folder is renamed
 * in place from its own menu, and New folder is in the `…`.
 *
 * ## The air
 *
 * Taken from the search field directly below, so the two rows read as one stack
 * rather than as a tight row above a comfortable one:
 *
 *  - the row's horizontal padding is `space.lg`, the search pill's own
 *    `marginHorizontal`, so the title's left edge and Edit's right edge sit on
 *    that pill's edges;
 *  - the title is `space.lg` from the control, so the two read as a row rather
 *    than as one run-on line;
 *  - and the control is a `CONTROL_SIZE.regular` circle, the same button the
 *    chat header carries, which gives the row the height the 38pt `+` used to
 *    give it.
 */
function Head({
  onBoards,
  onNewBot,
  onNewFolder,
  sidebar
}: {
  onBoards?: () => void
  onNewBot?: () => void
  onNewFolder?: () => void
  sidebar: boolean
}) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.lg,
        paddingBottom: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.panel,
        // The overflow menu is absolutely positioned inside this row and has to
        // be allowed to hang below it.
        zIndex: 1
      }}
      testID="bots-head"
    >
      {/*
        The screen's name — or, once there is a second gateway, that gateway's
        name with the screen's underneath it and a menu behind it. See
        `GatewayTitle`: the switch is the LIST's, because every row in the list
        belongs to one gateway and a chat header had no room for it.
      */}
      <View style={{ flex: 1 }}>
        <GatewayTitle sidebar={sidebar} />
      </View>

      <HeadOverflowMenu
        {...(onBoards ? { onBoards } : {})}
        {...(onNewBot ? { onNewBot } : {})}
        {...(onNewFolder ? { onNewFolder } : {})}
      />
    </View>
  )
}

/*
  There is no drop LINE any more, and the objection that put one here is worth
  keeping rather than deleting.

  It said: a gap that opens up moves every row below it on every slot change,
  which on a list of forty is forty layout passes per centimetre of finger
  travel. That was true of a gap made of LAYOUT. The gap under the finger is now
  made of `transform: translateY` on the native driver (`use-row-drag.ts`), which
  triggers no layout at all and does not touch the JavaScript thread — and
  `rowShift` moves only the rows BETWEEN the lifted row's own place and the gap,
  so the count is the distance dragged rather than the length of the list.

  With the gap affordable, the line is redundant: every native list answers
  "where would this land" with the shape of the list, and a line as well is a
  second answer to a question already answered.
*/

/**
 * A folder's own row: the top of the plate, with the disclosure on it.
 *
 * It replaced the named divider ADR-0012 drew, and the first attempt replaced
 * only the BEHAVIOUR — it collapsed, it counted, a drop could land in it — while
 * still drawing a line with a word on it. The owner's verdict was exactly that:
 * _"only the name has gone from divider to folder"_. So the drawing says it now:
 * a folder mark in the folder's own colour, a chevron that turns rather than
 * being swapped for a different glyph, and a plate (`FolderGroup`) that this row
 * is the top of and its chats continue.
 *
 * The badge appears ONLY while the folder is closed. Open, every row inside is
 * on screen carrying its own count, and a total above them would be the same
 * information twice.
 *
 * ## Naming happens here, on this row, one folder at a time
 *
 * The name used to become a field for EVERY folder at once, because that is
 * what a list-wide edit mode can express. There is no such mode any more, so
 * `naming` is the folder the caret is in: a folder that has just been made and
 * has no name yet, or the one whose menu said Rename. It is still a field in
 * place rather than a dialog — the name is already drawn here, and a modal to
 * change one word would be a second sheet on a screen that has one for the row
 * menu — and it closes itself when the reader is done with it.
 */
function FolderHeader({
  counts,
  folder,
  naming = false,
  onArm,
  onDisarm,
  onMenuSelect,
  onMove,
  onNamed,
  onRename,
  onToggle,
  open
}: {
  counts: FolderCounts
  folder: Folder
  /** This folder's name is a field right now, with the caret in it. */
  naming?: boolean
  /** Arm the drag for this folder's row key. The header's `onLongPress`. */
  onArm?: (rowKey: string) => void
  onDisarm?: () => void
  onMenuSelect: (folderId: string, id: string) => void
  /** One position up or down among the top-level entries. */
  onMove?: (folderId: string, offset: number) => void
  /** The field is finished with: Return, or the caret leaving it. */
  onNamed?: () => void
  /** Puts the caret in this folder's name; the menu's Rename. */
  onRename?: (id: string) => void
  onToggle: (id: string, open: boolean) => void
  open: boolean
}) {
  const theme = useTheme()
  const hover = useHover()
  const mutes = useChatLayoutStore(state => state.mutes)
  const swatch = theme.accent(folder.colour ?? 'default')

  /*
    The chevron TURNS. It used to be two glyphs — `chevronRight` closed,
    `chevronDown` open — which is a cut between two drawings, and a cut is what a
    web page does. One mark rotating a quarter turn is what every native
    disclosure does, and it is the cheapest possible animation: one transform on
    the native driver, no layout, no re-render.

    `press` rather than `row`: the mark is small and travels nothing, so the
    duration a whole row gets would read as the chevron lagging the rows.
  */
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current

  useEffect(() => {
    Animated.timing(spin, {
      toValue: open ? 1 : 0,
      duration: durationFor('press', theme.reduceMotion),
      easing: easing.standard,
      useNativeDriver: NATIVE_DRIVER
    }).start()
  }, [open, spin, theme.reduceMotion])

  const menu = useMemo(
    () =>
      folderMenuItems({
        colour: folder.colour ?? 'default',
        mutedUntil: folderMuteState(folder, mutes, Math.floor(Date.now() / 1000)),
        name: folder.name
      }),
    [folder, mutes]
  )

  const label = [
    folder.name || strings.layout.unnamedFolder,
    open || counts.unread === 0 ? '' : strings.layout.folderUnread(counts.unread),
    open || !counts.needsInput ? '' : strings.layout.folderNeedsInput
  ]
    .filter(Boolean)
    .join(', ')

  /* The same pair the chat rows carry, for the readers a drag does not serve. */
  const reorderable = Boolean(onMove)

  const heading = (
    <Pressable
      {...(reorderable
        ? {
            accessibilityActions: [
              { name: 'moveUp', label: strings.layout.moveUp },
              { name: 'moveDown', label: strings.layout.moveDown }
            ],
            onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === 'moveUp') {
                onMove?.(folder.id, -1)
              } else if (event.nativeEvent.actionName === 'moveDown') {
                onMove?.(folder.id, 1)
              }
            }
          }
        : {})}
      accessibilityHint={open ? strings.layout.collapseFolder(folder.name) : strings.layout.expandFolder(folder.name)}
      accessibilityLabel={label}
      accessibilityRole="button"
      aria-expanded={open}
      delayLongPress={300}
      /*
        The same split a chat row makes, for the same reason: a hold arms the
        drag, and where the platform draws a context menu it is already showing
        one — hold still for the menu, hold and move for the drag. A folder has
        no fallback sheet, so where there is no native menu a hold means the drag
        and nothing else.
      */
      onLongPress={() => onArm?.(folderRowKey(folder.id))}
      onPress={() => onToggle(folder.id, !open)}
      onPressOut={onDisarm}
      /*
        No margins of its own any more: the plate around it owns the inset, and a
        row that also inset itself would sit in from its own container by twice
        the amount and stop reading as the top of it.
      */
      style={{
        alignItems: 'center',
        backgroundColor: hover.hovered ? theme.glass.row.solid : 'transparent',
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      }}
      testID={`folder-${folder.id}`}
      {...hover.props}
    >
      {/* Decorative, both of them: the row's own expanded state is what a screen
          reader reads, and `Icon` keeps itself out of the tree so it cannot say
          it twice. */}
      <Animated.View
        style={{
          transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) }]
        }}
        testID={`folder-chevron-${folder.id}`}
      >
        <Icon color={theme.colors.textMuted} name="chevronRight" size={ICON_SIZE.marker} />
      </Animated.View>

      {/*
        The folder itself, in the folder's own colour.

        This is the mark that was missing. A name beside a chevron is a
        disclosure — a section that folds — and the thing the owner asked for is a
        CONTAINER, which every interface they use draws as a folder.
      */}
      <Icon color={swatch.fill} name="folder" size={ICON_SIZE.listMark} testID={`folder-mark-${folder.id}`} />

      {naming ? (
        <TextInput
          accessibilityHint={strings.layout.nameFolderHint}
          accessibilityLabel={strings.layout.folderName}
          // Focused straight into, always: this field is only ever on screen
          // because the reader asked for this folder's name, either by making it
          // or by choosing Rename.
          autoFocus
          autoCapitalize="words"
          // Both endings, because they are different gestures and both mean
          // "done": Return on the keyboard, and the caret leaving for anywhere
          // else. Without the blur a field opened by Rename would stay open
          // until something else re-rendered the row.
          onBlur={onNamed}
          onSubmitEditing={onNamed}
          onChangeText={next => useChatLayoutStore.getState().renameFolder(folder.id, next)}
          // The PLACEHOLDER, never the value. Seeding the field is what left
          // "New sectionFinance" on a real device.
          placeholder={strings.layout.folderName}
          placeholderTextColor={theme.colors.textFaint}
          returnKeyType="done"
          selectTextOnFocus
          style={{
            backgroundColor: theme.tintSunk,
            borderColor: theme.hairline,
            borderRadius: theme.radii.inset,
            borderWidth: 1,
            color: theme.colors.text,
            flex: 1,
            fontSize: 15,
            minHeight: 34,
            paddingHorizontal: theme.space.sm,
            paddingVertical: 6
          }}
          testID={`folder-name-${folder.id}`}
          value={folder.name}
        />
      ) : (
        <Text color="text" style={{ flex: 1, fontWeight: '600' }} variant="preview">
          {folder.name || strings.layout.unnamedFolder}
        </Text>
      )}

      {/* Closed only. Open, every row inside says its own number. */}
      {!open && counts.needsInput ? (
        <View
          style={{
            backgroundColor: theme.presence.needsInput,
            borderRadius: 5,
            height: 10,
            width: 10
          }}
          testID={`folder-needs-input-${folder.id}`}
        />
      ) : null}

      {!open && counts.unread > 0 ? (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: swatch.fill,
            borderRadius: 11,
            minWidth: 22,
            paddingHorizontal: 6,
            paddingVertical: 2
          }}
          testID={`folder-unread-${folder.id}`}
        >
          <Text color="onAccent" variant="meta">
            {unreadBadgeLabel(counts.unread)}
          </Text>
        </View>
      ) : null}

      {/*
        Delete, while the name is being typed, and only then.

        A folder made by mistake is deleted from its own menu everywhere that
        menu exists — but this is the one moment a reader is certainly looking at
        a folder they may not want, and on a platform with no native menu it is
        the only way out of one. It leaves with the field.
      */}
      {naming ? (
        <Pressable
          accessibilityLabel={strings.layout.removeFolder(folder.name)}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={() => useChatLayoutStore.getState().removeFolder(folder.id)}
          style={({ pressed }) => ({
            cursor: 'pointer',
            borderColor: theme.hairline,
            borderRadius: theme.radii.pill,
            borderWidth: 1,
            opacity: pressed ? 0.6 : 1,
            paddingHorizontal: theme.space.md,
            paddingVertical: 6
          })}
          testID={`folder-remove-${folder.id}`}
        >
          <Text color="dangerText" variant="meta">
            {strings.layout.remove}
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  )

  return (
    <ContextMenuHost
      items={menu}
      menuTitle={folder.name || strings.layout.unnamedFolder}
      onSelect={selected => {
        if (selected === 'rename') {
          onRename?.(folder.id)

          return
        }

        onMenuSelect(folder.id, selected)
      }}
      testID={`folder-menu-${folder.id}`}
    >
      {heading}
    </ContextMenuHost>
  )
}

/**
 * An open folder with nothing in it.
 *
 * It exists so a folder somebody has just emptied still has a body to drop a
 * chat back into — without it there is no gap of its own between the header and
 * whatever follows, and a folder becomes a one-way trip.
 */
function FolderEmpty({ id }: { id: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        justifyContent: 'center',
        minHeight: 38,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg
      }}
      testID={`folder-empty-${id}`}
    >
      <Text color="textFaint" variant="meta">
        {strings.layout.folderEmpty}
      </Text>
    </View>
  )
}

/**
 * When a whole folder is silent until, or `null` when any chat in it is not.
 *
 * The menu asks one question — should this offer Mute or Unmute — and a folder
 * that is half muted has to answer "not muted", because the useful action there
 * is to silence the rest rather than to un-silence the few. `MUTE_FOREVER`
 * wins over a deadline for the same reason a deadline wins over nothing: the
 * label has to describe the state a reader would still be in.
 */
function folderMuteState(folder: Folder, mutes: Mutes, now: number): number | null {
  if (!folder.bots.length) {
    return null
  }

  let soonest: number | null = null

  for (const name of folder.bots) {
    if (!isMuted(mutes, name, now)) {
      return null
    }

    const until = mutes[name] as number

    if (until === MUTE_FOREVER) {
      continue
    }

    soonest = soonest === null || until < soonest ? until : soonest
  }

  // Every chat is muted; `null` here would mean "not muted", so a folder that is
  // muted forever reports the deadline that never comes.
  return soonest ?? MUTE_FOREVER
}

function ArchiveHeader({ count, onToggle, open }: { count: number; onToggle: () => void; open: boolean }) {
  const theme = useTheme()
  const hover = useHover()

  return (
    <Pressable
      accessibilityRole="button"
      aria-expanded={open}
      onPress={onToggle}
      style={{
        alignItems: 'center',
        backgroundColor: hover.hovered ? theme.glass.row.solid : 'transparent',
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        flexDirection: 'row',
        gap: theme.space.sm,
        marginHorizontal: theme.space.sm,
        marginTop: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      }}
      testID="archived-row"
      {...hover.props}
    >
      {/* Decorative: the row's own expanded state is what a screen reader reads,
          and `Icon` keeps itself out of the tree so it cannot say it twice. */}
      <Icon color={theme.colors.textMuted} name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.marker} />
      <Text color="textMuted" style={{ fontWeight: '600' }} variant="preview">
        {strings.layout.archived(count)}
      </Text>
    </Pressable>
  )
}

/**
 * The heading over the message matches.
 *
 * It counts CHATS, and the hint under it says why: the gateway collapses every
 * hit in a conversation onto one result, so the number of rows here is the
 * number of chats that contain the words, not the number of times they appear.
 * Writing "3 messages" over it would be a count nobody could verify by opening
 * them.
 */
function MessagesHeader({ count, searching }: { count: number; searching: boolean }) {
  const theme = useTheme()

  return (
    <View
      style={{
        gap: 2,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.lg
      }}
      testID="message-matches-header"
    >
      <Text color="textMuted" style={{ fontWeight: '600', letterSpacing: 0.6 }} variant="meta">
        {strings.bots.messagesHeader}
      </Text>

      <Text color="textFaint" variant="meta">
        {searching
          ? strings.bots.messagesSearching
          : count === 0
            ? strings.bots.messagesNone
            : strings.bots.messagesHint}
      </Text>
    </View>
  )
}

/**
 * One chat whose transcript contains the words.
 *
 * The snippet is the gateway's own, markers and all: `>>>` and `<<<` wrap what
 * FTS5 matched, which is not always what was typed — a prefix term matches a
 * longer word — so the emphasis is worth carrying rather than re-deriving here
 * and getting subtly wrong.
 */
function MessageHit({ bot, match, onPress }: { bot: Bot; match: MessageMatch; onPress: () => void }) {
  const theme = useTheme()
  const hover = useHover()
  const segments = useMemo(() => snippetSegments(tidySnippet(match.snippet)), [match.snippet])

  return (
    <Pressable
      accessibilityLabel={strings.bots.messageOpen(bot.displayName)}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: hover.hovered ? theme.glass.row.solid : 'transparent',
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        gap: 2,
        marginHorizontal: theme.space.sm,
        opacity: pressed ? 0.7 : 1,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      })}
      testID={`message-match-${bot.name}`}
      {...hover.props}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, fontWeight: '600' }} variant="preview">
          {bot.displayName}
        </Text>

        {match.at === undefined ? null : (
          <Text color="textFaint" variant="meta">
            {formatListTime(match.at)}
          </Text>
        )}
      </View>

      <Text color="textMuted" numberOfLines={2} variant="preview">
        {segments.map((segment, index) => (
          <Text
            color={segment.match ? 'accentText' : 'textMuted'}
            key={index}
            style={segment.match ? { fontWeight: '600' } : undefined}
            variant="preview"
          >
            {segment.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  )
}

function EmptyState({
  error,
  loading,
  query,
  searching
}: {
  error: string | null
  loading: boolean
  query: string
  searching: boolean
}) {
  const theme = useTheme()

  const message = error
    ? strings.bots.failed(error)
    : searching
      ? strings.bots.noMatches(query.trim())
      : loading
        ? strings.bots.loading
        : strings.bots.empty

  return (
    <View style={{ gap: theme.space.sm, padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'} testID="bots-empty">
        {message}
      </Text>
    </View>
  )
}
