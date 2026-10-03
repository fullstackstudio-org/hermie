/**
 * `Today`, `Yesterday`, `Tue 29 September`: the stamp that opens a day.
 *
 * A level-2 heading. The page's own title is the `h1`, and a day is a section of
 * the conversation, so a reader who moves by heading gets the days and still
 * knows what they belong to. A row of its own (see `rows.ts`) whose text is the
 * day's key, `20261003`; the words are made here, at the moment of drawing, so
 * "Today" is never older than the last time the row was drawn.
 */
import type { StatusItem } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { formatDate } from '../../../i18n/format'
import { useLocale } from '../../../i18n/use-locale'
import { type RowViewProps, sameRowView } from './row-view'

/** The words for a day, relative to `now`: today, yesterday, a weekday inside a week, then the date. */
export function dayLabel(dayKey: number, now: Date = new Date()): string {
  const year = Math.floor(dayKey / 10_000)
  const month = Math.floor((dayKey % 10_000) / 100) - 1
  const day = dayKey % 100
  const date = new Date(year, month, day, 12)
  const apart = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(year, month, day).getTime()) /
      86_400_000
  )

  if (apart === 0) {
    return strings.app.activity.today
  }

  if (apart === 1) {
    return strings.app.activity.yesterday
  }

  if (apart > 1 && apart < 7) {
    return formatDate(date, { weekday: 'short', day: 'numeric', month: 'long' })
  }

  return year === now.getFullYear()
    ? formatDate(date, { day: 'numeric', month: 'long' })
    : formatDate(date, { day: 'numeric', month: 'long', year: 'numeric' })
}

function DateSeparatorView({ item }: RowViewProps<StatusItem>) {
  useLocale()

  return <h2 className="hm-day">{dayLabel(Number(item.text))}</h2>
}

export const DateSeparator = memo(DateSeparatorView, sameRowView)
