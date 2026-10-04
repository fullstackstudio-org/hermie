/**
 * The bots, as a list of conversations: the sidebar's body.
 *
 * It reads the roster, the arrangement, the connection and the plugin advert from their stores
 * and fetches nothing: the roster is read, kept fresh and painted from the cache
 * by the connection (`core/gateway-client.ts`), and the running poll is started
 * by the session (`features/shell/session.ts`).
 *
 * **The arrangement** (`state/layout.ts`, edited in Settings, Chat list, and mirrored on `ui_meta`) is
 * drawn with the native apps' rules (`arrangement-list.ts`): its order, a chat the roster has and the
 * arrangement has not placed yet where the native rule puts it, a removed chat dropped, pinned chats
 * first, each chat's colour on its row and a mark on a pinned and a muted one. Folders are groups with a
 * header, one button that opens and closes them (the reader's choice, kept on this device); the archived
 * chats are one more group at the bottom, closed until opened. A search shows its matches in the same
 * groups, all open, so a match is never behind a closed one.
 *
 * The rows are one tab stop. Tab lands on the open chat's row (or the row last
 * focused, or the first), the arrow keys, Home and End move between rows (across groups, and from a
 * group's header too), and Enter follows the link: a row is an `<a href="#/chat/<bot>">`, so everything a
 * link does, it does. A header is a button of its own: Enter and Space operate it, and Right and Left
 * open and close it.
 *
 * States, all in words: the roster is being read, it is empty, it could not be
 * read. When the gateway has no Hermie plugin the client still works; a hint
 * says that notifications need it.
 *
 * **Search** (`features/search`). A field above the list narrows it to the bots
 * whose names hold the words, at once and on this device (`name-filter.ts`), and
 * below the rows the gateway's search over every bot's transcripts answers after
 * a pause in typing (`MessageHits`): a hit opens that chat at the words. Escape
 * empties the field.
 */
import { type KeyboardEvent, type ReactElement, type ReactNode, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type Bot, botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { isMuted } from '../../state/mute'
import { pluginPresence, pluginStore } from '../../state/plugin'
import { Icon } from '../../ui/icons'
import { useOwnAuthorId } from '../chat/use-own-author'
import { MessageHits } from '../search/MessageHits'
import { filterByName } from '../search/name-filter'
import { type ListFolder, listView } from './arrangement-list'
import { BotRow } from './BotRow'
import { useMuteClock } from './use-mute-clock'
import './bots.css'
import './list-arrangement.css'

export interface ChatListProps {
  /** The bot whose chat is the open route, if any. */
  selectedBot: string | undefined
}

export function ChatList({ selectedBot }: ChatListProps): ReactElement {
  useLocale()

  const bots = useStore(botsStore, state => state.bots)
  const avatars = useStore(botsStore, state => state.avatars)
  const error = useStore(botsStore, state => state.error)
  const read = useStore(botsStore, state => state.refreshedAt !== null || state.bots.length > 0)
  const status = useStore(connectionStore, state => state.status)
  const author = useOwnAuthorId()
  const presence = useStore(pluginStore, pluginPresence)

  const entries = useStore(layoutStore, state => state.entries)
  const folders = useStore(layoutStore, state => state.folders)
  const collapsed = useStore(layoutStore, state => state.collapsed)
  const archived = useStore(layoutStore, state => state.archived)
  const pinned = useStore(layoutStore, state => state.pinned)
  const accents = useStore(layoutStore, state => state.accents)
  const mutes = useStore(layoutStore, state => state.mutes)
  const now = useMuteClock(mutes)

  const [query, setQuery] = useState('')
  const narrowed = query.trim() !== ''
  const shown = useMemo(() => filterByName(bots, query), [bots, query])
  const view = useMemo(
    () => listView({ entries, folders }, archived, pinned, shown),
    [entries, folders, archived, pinned, shown]
  )

  // The archive is closed until opened (this window only). A search opens every group.
  const [archiveOpen, setArchiveOpen] = useState(false)
  const archiveShown = narrowed || archiveOpen

  // The rows that are on the page, top to bottom: what the arrow keys can reach and a Tab can land on.
  const reachable = useMemo(
    () => [
      ...view.entries.flatMap(entry =>
        entry.kind === 'chat'
          ? [entry.bot.name]
          : narrowed || !collapsed[entry.id]
            ? entry.chats.map(bot => bot.name)
            : []
      ),
      ...(archiveShown ? view.archived.map(bot => bot.name) : [])
    ],
    [view, collapsed, narrowed, archiveShown]
  )

  const listRef = useRef<HTMLDivElement>(null)
  // The row a Tab lands on: wherever focus last was, else the open chat, else the first.
  const [focused, setFocused] = useState<string | null>(null)
  const tabbableBot =
    (focused && reachable.includes(focused) ? focused : null) ??
    (selectedBot && reachable.includes(selectedBot) ? selectedBot : null) ??
    reachable[0] ??
    null

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']

    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    const rows = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-bot]') ?? [])]

    if (!rows.length) {
      return
    }

    const target = event.target as Node
    const at = rows.findIndex(row => row === target || row.contains(target))
    const down = event.key === 'ArrowDown'
    // From a group's header, which is not a row, a step goes to the row after it or the one before it.
    const beside = (): number =>
      down
        ? rows.findIndex(row => Boolean(target.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING))
        : rows.findLastIndex(row => Boolean(target.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING))
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : at === -1
            ? beside()
            : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)))

    if (next === -1) {
      return
    }

    event.preventDefault()
    rows[next]?.focus()
  }

  const row = (bot: Bot): ReactElement => (
    <BotRow
      key={bot.name}
      bot={bot}
      avatarUri={avatars[bot.name]}
      selected={bot.name === selectedBot}
      tabbable={bot.name === tabbableBot}
      gatewayReady={status === 'ready'}
      ownAuthorId={author}
      accent={accents[bot.name] ?? 'default'}
      muted={isMuted(mutes, bot.name, now)}
      pinned={Boolean(pinned[bot.name])}
    />
  )

  const loading = bots.length === 0 && !read && !error

  return (
    <div className="hm-chat-list">
      {bots.length > 0 ? (
        <div className="hm-search" role="search">
          <input
            className="hm-search__field"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault()
                setQuery('')
              }
            }}
            aria-label={strings.app.bots.search}
            placeholder={strings.app.bots.search}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </div>
      ) : null}

      {error && bots.length === 0 ? (
        <p className="hm-note" role="alert">
          {strings.app.bots.failed({ message: error })}
        </p>
      ) : null}

      {loading ? (
        <p className="hm-note" role="status">
          {strings.app.bots.loading}
        </p>
      ) : null}

      {read && bots.length === 0 && !error ? <p className="hm-note">{strings.app.bots.empty}</p> : null}

      {narrowed && bots.length > 0 && shown.length === 0 ? (
        <p className="hm-note">{strings.app.bots.noMatches({ query: query.trim() })}</p>
      ) : null}

      {shown.length > 0 ? (
        <div
          className="hm-groups"
          ref={listRef}
          onKeyDown={onKeyDown}
          onFocus={event => {
            const name = (event.target as HTMLElement).closest<HTMLElement>('[data-bot]')?.dataset.bot

            if (name) {
              setFocused(name)
            }
          }}
        >
          {view.entries.length > 0 ? (
            <ul className="hm-rows">
              {view.entries.map(entry =>
                entry.kind === 'chat' ? (
                  row(entry.bot)
                ) : (
                  <FolderGroup
                    key={entry.id}
                    folder={entry}
                    open={narrowed || !collapsed[entry.id]}
                    fixed={narrowed}
                    onToggle={() => layoutStore.getState().setFolderOpen(entry.id, Boolean(collapsed[entry.id]))}
                    row={row}
                  />
                )
              )}
            </ul>
          ) : null}

          {view.archived.length > 0 ? (
            <Group
              kind="archived"
              title={strings.app.layout.archived({ count: view.archived.length })}
              open={archiveShown}
              fixed={narrowed}
              onToggle={() => setArchiveOpen(!archiveOpen)}
            >
              <ul className="hm-rows" aria-label={strings.app.layout.archived({ count: view.archived.length })}>
                {view.archived.map(row)}
              </ul>
            </Group>
          ) : null}
        </div>
      ) : null}

      {narrowed ? <MessageHits query={query} /> : null}

      {presence === 'absent' ? (
        <p className="hm-note hm-note--plugin">
          <Icon name="plug" size={16} />
          <span>{webStrings.shell.noPlugin}</span>
        </p>
      ) : null}
    </div>
  )
}

interface GroupProps {
  kind: 'folder' | 'archived'
  title: string
  /** How many chats are in it (a folder's; the archive's count is in its title). */
  count?: number
  colour?: ListFolder<Bot>['colour']
  open: boolean
  /** Held open (a search is showing its matches): the header says what the group is and does nothing. */
  fixed: boolean
  onToggle: () => void
  children: ReactNode
}

/**
 * A group of rows under a header: a folder, or the archive. The header is one button, named by the
 * group's own words, with `aria-expanded` saying the rest. The rows are not on the page while it is closed.
 */
function Group({ kind, title, count, colour, open, fixed, onToggle, children }: GroupProps): ReactElement {
  const id = useId()
  const face = (
    <>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      {colour && colour !== 'default' ? (
        <span className="hm-group__dot" data-accent={colour} aria-hidden="true" />
      ) : null}
      <span className="hm-group__title">{title}</span>
      {count === undefined ? null : (
        <span className="hm-group__count" aria-hidden="true">
          {count}
        </span>
      )}
    </>
  )

  return (
    <div className="hm-group" data-group={kind} data-open={open ? 'true' : 'false'}>
      {fixed ? (
        <div className="hm-group__head hm-group__head--fixed">{face}</div>
      ) : (
        <button
          type="button"
          className="hm-group__head"
          aria-expanded={open}
          {...(open ? { 'aria-controls': id } : {})}
          onClick={onToggle}
          onKeyDown={event => {
            if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) {
              event.preventDefault()
              onToggle()
            }
          }}
        >
          {face}
        </button>
      )}
      {open ? <div id={id}>{children}</div> : null}
    </div>
  )
}

interface FolderGroupProps {
  folder: ListFolder<Bot>
  open: boolean
  fixed: boolean
  onToggle: () => void
  row: (bot: Bot) => ReactElement
}

function FolderGroup({ folder, open, fixed, onToggle, row }: FolderGroupProps): ReactElement {
  const title = folder.name || strings.app.layout.unnamedFolder

  return (
    <li className="hm-row-item hm-row-item--group" data-folder={folder.id}>
      <Group
        kind="folder"
        title={title}
        count={folder.chats.length}
        colour={folder.colour}
        open={open}
        fixed={fixed}
        onToggle={onToggle}
      >
        <ul className="hm-rows" aria-label={title}>
          {folder.chats.map(row)}
        </ul>
      </Group>
    </li>
  )
}
