/**
 * Activity: `#/activity`, one timeline of everything the bots said to each other.
 *
 * Bot-to-bot traffic is invisible in any per-chat view, because it is by definition spread across two chats. Rows
 * read as sentences (`researcher → writer`), grouped by day, newest first, and each one is a door into the chat
 * where it happened: a link to that bot's chat that leaves a request to scroll to the message (the same hand-off a
 * search hit makes, `features/search/find-request.ts`).
 *
 * Three counters sit above the timeline, the only thing here that is not derived from the transcripts: bots
 * working, sub-agents running, deliveries in flight. They are polled while the page is shown and dropped when it is
 * not.
 *
 * What is said, and when: loading while the first read is on its way, a failure with a way to try again, the
 * gateway being out of reach, or that nothing has happened yet. Each is a sentence in a live region that exists
 * before it speaks. Bot names and message text are the gateway's: cleaned and bounded (`displayText`), isolated
 * where they sit in a sentence, and drawn as characters.
 *
 * The Expo app's `ActivityScreen`, on the web's shell.
 */
import type { ActivityEntry } from '@hermie/transcript'
import { type ReactElement, useId, useMemo } from 'react'
import { useStore } from 'zustand'

import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'
import { formatTime } from '../../i18n/format'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { Button } from '../../ui/primitives'
import { useChatRuntime } from '../chat/chat-runtime'
import { findRequests } from '../search/find-request'
import { chatHref } from '../shell/router'
import { findQueryFor, groupByDay } from './activity-model'
import { useActivity } from './use-activity'
import './activity.css'

/** The longest message drawn on a row, in code points: the entry's text is already one line. */
const TEXT_LIMIT = 200

/** What a status the timeline derived says, in the reader's language. */
function statusText(entry: ActivityEntry): string {
  if (entry.kind === 'delegation') {
    return strings.app.activity.groupStatus[entry.status ?? ''] ?? displayText(entry.status ?? '', 40)
  }

  switch (entry.status) {
    case undefined:
    case '':
      return ''
    case 'Replied':
      return cronWebStrings.activity.replied
    case 'Queued':
      return cronWebStrings.activity.queued
    case 'Sending':
      return cronWebStrings.activity.sending
    case 'Sent':
      return cronWebStrings.activity.sent
    case 'Failed':
      return strings.chat.botDm.failed
    case 'Ambiguous target':
      return strings.chat.botDm.ambiguous
    default:
      return displayText(entry.status, 40)
  }
}

export function ActivityPage(): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const { entries, counters, loading, offline, error, refresh } = useActivity(runtime?.controller)
  const byName = useStore(botsStore, state => state.byName)
  const days = useMemo(() => groupByDay(entries, Date.now()), [entries])
  const countersId = useId()

  /** A bot's name for a routing handle (`researcher`): the roster's display name, else the handle. */
  const label = (handle: string): string => {
    const bot = byName[handle] ?? Object.values(byName).find(entry => entry.name.toLowerCase() === handle)

    return displayText(bot?.displayName ?? handle, BOT_NAME_LIMIT) || handle
  }

  return (
    <div className="hm-main__body hm-activity">
      <p className="hm-activity__lead">{strings.app.activity.subtitle}</p>

      <ul className="hm-activity__counters">
        <Counter label={strings.app.activity.counters.working} value={counters.botsWorking} />
        <Counter label={strings.app.activity.counters.subagents} value={counters.activeSubagents} />
        <Counter label={strings.app.activity.counters.deliveries} value={counters.inFlightDeliveries} />
      </ul>

      {/* Present before it speaks, so a screen reader hears each state once. */}
      <p className={loading ? 'hm-activity__state' : 'hm-sr'} role="status">
        {loading ? strings.app.activity.loading : ''}
      </p>
      {error !== null ? (
        <div className="hm-activity__state" data-tone="danger" role="alert">
          <p>{strings.app.activity.failed({ message: error })}</p>
          <Button variant="quiet" onClick={() => void refresh()}>
            {strings.app.common.retry}
          </Button>
        </div>
      ) : null}
      {offline && error === null ? <p className="hm-activity__state">{strings.app.activity.emptyOffline}</p> : null}
      {!loading && !offline && error === null && entries.length === 0 ? (
        <p className="hm-activity__state">{strings.app.activity.empty}</p>
      ) : null}

      {days.map(day => (
        <section className="hm-activity__day" key={day.key} aria-labelledby={`${countersId}-${day.key}`}>
          <h2 className="hm-activity__day-title" id={`${countersId}-${day.key}`}>
            {day.label}
          </h2>
          <ul className="hm-activity__rows">
            {day.entries.map(entry => (
              <Row key={entry.id} entry={entry} label={label} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Counter({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <li className="hm-activity__counter" data-active={value > 0 ? 'true' : 'false'}>
      <span className="hm-activity__counter-value">{value}</span> {label}
    </li>
  )
}

/**
 * One line of traffic: the sentence, the time, what was said and how it stands. The whole row is the link to the
 * chat where it happened, so one Tab stop is one row.
 */
function Row({ entry, label }: { entry: ActivityEntry; label: (handle: string) => string }): ReactElement {
  const from = label(entry.fromHandle)
  const to = label(entry.toHandle ?? '')
  const heading =
    entry.kind === 'delegation'
      ? strings.app.activity.spawned({ bot: from, count: entry.agentCount ?? 0 })
      : entry.kind === 'dm_reply'
        ? strings.app.activity.reply({ from, to })
        : strings.app.activity.to({ from, to })
  const status = statusText(entry)
  const text = displayText(entry.text, TEXT_LIMIT)
  const query = findQueryFor(entry)

  return (
    <li className="hm-activity__row" data-kind={entry.kind} data-failed={entry.failed ? 'true' : undefined}>
      <a
        className="hm-activity__link"
        href={chatHref(entry.botName)}
        title={strings.app.activity.openChat({ bot: label(entry.botName) })}
        // Before the address changes, so the chat screen that opens finds the request waiting.
        onClick={() => {
          if (query) {
            findRequests.request(entry.botName, query)
          }
        }}
      >
        <span className="hm-activity__top">
          <bdi className="hm-activity__heading">{heading}</bdi>
          {entry.at ? (
            <time className="hm-activity__time" dateTime={new Date(entry.at * 1000).toISOString()}>
              {formatTime(entry.at * 1000)}
            </time>
          ) : null}
        </span>
        {text ? (
          <span className="hm-activity__text" dir="auto">
            {text}
          </span>
        ) : null}
        {status ? (
          <span
            className="hm-activity__status"
            data-tone={entry.failed ? 'danger' : entry.pending ? 'working' : undefined}
          >
            {status}
          </span>
        ) : null}
      </a>
    </li>
  )
}
