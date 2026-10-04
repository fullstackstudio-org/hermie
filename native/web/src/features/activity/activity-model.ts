/**
 * The Activity timeline's pure parts: the days it is grouped into, and the words it asks a chat to find.
 *
 * The entries themselves are `activityEntries` (`@hermie/transcript`): a view over the chat store, so a bot's
 * traffic appears here and in its chat as one set of items with one set of ids.
 */
import type { ActivityEntry } from '@hermie/transcript'

import { strings } from '../../generated/strings'
import { formatDate } from '../../i18n/format'

/** One day of the timeline. */
export interface ActivityDay {
  /** `2026-10-04`, in the reader's own calendar: stable, so React keeps the section when a row arrives. */
  key: string
  /** `Today`, `Yesterday`, `Tue, 9 Sep`: in the reader's language. */
  label: string
  /** Newest first. */
  entries: ActivityEntry[]
}

const DAY_MS = 86_400_000

const pad = (value: number): string => String(value).padStart(2, '0')

const dayKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** `Today`, `Yesterday` or the date, for the day `atSeconds` falls in. Read when called: the words are in the active language. */
export function dayLabel(atSeconds: number, now: number): string {
  const date = new Date(atSeconds * 1000)
  const midnight = new Date(now)

  midnight.setHours(0, 0, 0, 0)

  const start = midnight.getTime()

  if (date.getTime() >= start) {
    return strings.app.activity.today
  }

  if (date.getTime() >= start - DAY_MS) {
    return strings.app.activity.yesterday
  }

  return formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Newest day first, and newest row first inside it: a timeline is read backwards. */
export function groupByDay(entries: readonly ActivityEntry[], now: number): ActivityDay[] {
  const days: ActivityDay[] = []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (!entry) {
      continue
    }

    const key = entry.at > 0 ? dayKey(new Date(entry.at * 1000)) : 'undated'
    const last = days[days.length - 1]

    if (last?.key === key) {
      last.entries.push(entry)
    } else {
      days.push({ key, label: dayLabel(entry.at, now), entries: [entry] })
    }
  }

  return days
}

/** The most of an entry's text a chat is asked to find: a phrase, not the whole message. */
const FIND_CHARS = 48

/**
 * What to ask the bot's chat to scroll to for this entry, or empty when there is nothing to find.
 *
 * The chat finds a row by words (`features/search/find-in-chat.ts`), and a quoted phrase is matched as one
 * contiguous piece of the row's text, which survives punctuation that a loose search would trip on. A delegation is
 * a card with no text of its own, so it opens the chat and asks for nothing.
 */
export function findQueryFor(entry: Pick<ActivityEntry, 'kind' | 'text'>): string {
  if (entry.kind === 'delegation') {
    return ''
  }

  const text = entry.text.replace(/…$/u, '').replace(/"/gu, ' ').replace(/\s+/gu, ' ').trim()

  if (text.length < 3) {
    return ''
  }

  let phrase = text.slice(0, FIND_CHARS)

  // Cut at a word, not in the middle of one.
  if (text.length > FIND_CHARS && !/\s/u.test(text.charAt(FIND_CHARS))) {
    const space = phrase.lastIndexOf(' ')

    if (space > 8) {
      phrase = phrase.slice(0, space)
    }
  }

  return `"${phrase.trim()}"`
}
