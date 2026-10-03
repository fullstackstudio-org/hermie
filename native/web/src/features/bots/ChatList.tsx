/**
 * The bots, as a list of conversations: the sidebar's body.
 *
 * It reads the roster, the connection and the plugin advert from their stores
 * and fetches nothing: the roster is read, kept fresh and painted from the cache
 * by the connection (`core/gateway-client.ts`), and the running poll is started
 * by the session (`features/shell/session.ts`).
 *
 * The list is one tab stop. Tab lands on the open chat's row (or the row last
 * focused, or the first), the arrow keys, Home and End move between rows, and
 * Enter follows the link: a row is an `<a href="#/chat/<bot>">`, so everything a
 * link does, it does. Reading order is the roster's order.
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
import { type KeyboardEvent, type ReactElement, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { pluginPresence, pluginStore } from '../../state/plugin'
import { Icon } from '../../ui/icons'
import { useOwnAuthorId } from '../chat/use-own-author'
import { MessageHits } from '../search/MessageHits'
import { filterByName } from '../search/name-filter'
import { BotRow } from './BotRow'
import './bots.css'

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

  const [query, setQuery] = useState('')
  const narrowed = query.trim() !== ''
  const shown = useMemo(() => filterByName(bots, query), [bots, query])

  const listRef = useRef<HTMLUListElement>(null)
  // The row a Tab lands on: wherever focus last was, else the open chat, else the first.
  const [focused, setFocused] = useState<string | null>(null)
  const tabbableBot =
    (focused && shown.some(bot => bot.name === focused) ? focused : null) ??
    (selectedBot && shown.some(bot => bot.name === selectedBot) ? selectedBot : null) ??
    shown[0]?.name ??
    null

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']

    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    const rows = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-bot]') ?? [])]

    if (!rows.length) {
      return
    }

    const at = rows.findIndex(row => row === event.target || row.contains(event.target as Node))
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))

    event.preventDefault()
    rows[next]?.focus()
  }

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
        <ul
          className="hm-rows"
          ref={listRef}
          onKeyDown={onKeyDown}
          onFocus={event => {
            const name = (event.target as HTMLElement).closest<HTMLElement>('[data-bot]')?.dataset.bot

            if (name) {
              setFocused(name)
            }
          }}
        >
          {shown.map(bot => (
            <BotRow
              key={bot.name}
              bot={bot}
              avatarUri={avatars[bot.name]}
              selected={bot.name === selectedBot}
              tabbable={bot.name === tabbableBot}
              gatewayReady={status === 'ready'}
              ownAuthorId={author}
            />
          ))}
        </ul>
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
