/**
 * The right-hand stamp on a chat row: `Now`, `12:47`, `Tue`, `Sep 12`.
 *
 * Relative on purpose, as in the native apps: the list is read at a glance, and
 * "Now" against "12:47" is the difference a reader is after. Ported from the
 * Expo app's `formatListTime`, but through `Intl` (`i18n/format.ts`), so the
 * weekday, the clock and the date come in the reader's language and order.
 *
 * Read when called, never at import: the word "Now" is in the active language.
 */
import { formatDate, formatTime } from '../../i18n/format'
import { webStrings } from '../../i18n/web-strings'

const DAY_SECONDS = 86_400

export function formatListTime(unixSeconds: number | undefined, now: number = Date.now() / 1000): string {
  if (!unixSeconds || unixSeconds <= 0) {
    return ''
  }

  const date = new Date(unixSeconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const age = now - unixSeconds

  if (age < 60) {
    return webStrings.shell.now
  }

  const today = new Date(now * 1000)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  if (sameDay) {
    return formatTime(date)
  }

  if (age < 7 * DAY_SECONDS) {
    return formatDate(date, { weekday: 'short' })
  }

  // A month name rather than "08/30": the order of day and month is the one thing
  // two readers of one language disagree on, and a name cannot be misread.
  return formatDate(date, { day: 'numeric', month: 'short' })
}
