/**
 * Under the chats field: the chats whose messages hold the words.
 *
 * The gateway's search answers one conversation per bot and never a message
 * (`@hermie/gateway-client`'s `session-search.ts`; `message-search.ts` here), so
 * each hit is a bot, the time of the conversation and the gateway's snippet with
 * what FTS5 matched marked (`>>>`/`<<<` around it, which is not always what was
 * typed: a prefix term matches a longer word). A hit is a link to the bot's chat;
 * following it leaves a `FindRequest` for the chat screen, which scrolls to the
 * row the words are in.
 *
 * One status line says what the section is doing (searching, nothing found, or
 * that only the best match per chat is shown), as a polite live region that
 * exists before its words change, so a screen reader hears each of them once.
 *
 * Everything shown is the gateway's text or a bot's name, drawn as characters:
 * the name cleaned and bounded by `displayText` and isolated in `<bdi>`, the
 * snippet's runs without control or format characters, in an element of its own
 * whose direction is its own.
 */
import { snippetSegments, tidySnippet } from '@hermie/gateway-client'
import { type ReactElement, useId, useMemo } from 'react'
import { useStore } from 'zustand'

import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { formatListTime } from '../bots/list-time'
import { chatHref } from '../shell/router'
import { findRequests, type FindRequests } from './find-request'
import type { MessageMatch } from './message-search'
import { useMessageSearch } from './use-message-search'
import './search.css'

/** The longest run of a snippet drawn, in UTF-16 units; the gateway's whole snippet is about forty tokens. */
const SNIPPET_LIMIT = 400

/**
 * One run of a snippet as characters that cannot reorder or hide anything:
 * control, format (the bidirectional overrides among them) and separator
 * characters become spaces. Not `displayText`, which trims: the spaces at the
 * edges of a run are the spaces between it and the match.
 */
const cleanRun = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, SNIPPET_LIMIT)

export interface MessageHitsProps {
  /** What is in the chats field. */
  query: string
  requests?: FindRequests
}

function Hit({ match, query, requests }: { match: MessageMatch; query: string; requests: FindRequests }): ReactElement {
  const displayName = useStore(botsStore, state => state.byName[match.bot]?.displayName ?? match.bot)
  const name = displayText(displayName, BOT_NAME_LIMIT) || match.bot
  const segments = useMemo(() => snippetSegments(tidySnippet(match.snippet)), [match.snippet])
  const time = formatListTime(match.at)

  return (
    <li className="hm-search-hit">
      <a
        className="hm-search-hit__link"
        href={chatHref(match.bot)}
        data-hit={match.bot}
        // Before the address changes, so the chat screen that opens finds it waiting.
        onClick={() => requests.request(match.bot, query)}
      >
        <span className="hm-search-hit__top">
          <bdi className="hm-search-hit__name">{name}</bdi>
          {time ? <span className="hm-search-hit__time">{time}</span> : null}
        </span>
        <span className="hm-search-hit__snippet" dir="auto">
          {segments.map((segment, index) =>
            segment.match ? (
              <mark key={index}>{cleanRun(segment.text)}</mark>
            ) : (
              <span key={index}>{cleanRun(segment.text)}</span>
            )
          )}
        </span>
      </a>
    </li>
  )
}

export function MessageHits({ query, requests = findRequests }: MessageHitsProps): ReactElement | null {
  useLocale()

  const headingId = useId()
  const search = useMessageSearch(query)
  const trimmed = query.trim()

  if (!trimmed) {
    return null
  }

  const answered = search.query === trimmed && !search.searching
  const status = search.searching
    ? strings.app.bots.messagesSearching
    : answered
      ? search.matches.length > 0
        ? strings.app.bots.messagesHint
        : strings.app.bots.messagesNone
      : ''

  return (
    <section className="hm-search-hits" aria-labelledby={headingId}>
      <h3 className="hm-search-hits__title" id={headingId}>
        {strings.app.bots.messagesHeader}
      </h3>
      {answered && search.matches.length > 0 ? (
        <ul className="hm-search-hits__list">
          {search.matches.map(match => (
            <Hit key={`${match.bot}:${match.sessionId}`} match={match} query={trimmed} requests={requests} />
          ))}
        </ul>
      ) : null}
      <p className="hm-search-hits__status" role="status">
        {status}
      </p>
    </section>
  )
}
