/**
 * Raw gateway enums, in words.
 *
 * The gateway speaks in identifiers — `ok`, `pending`, `dm_reply` — and several
 * of them used to reach the screen untranslated. The cron detail was the one
 * that gave it away: it printed a humanised `Success` and, two rows under it,
 * the same fact as `ok`. A reader cannot tell whether that is a second,
 * different status or the same one twice, and either reading is worse than the
 * value not being there.
 *
 * Two rules, and the second is the one that makes this worth a module:
 *
 *  - A status this app KNOWS gets the word the design board uses, so `ok` and
 *    `success` are one label rather than two.
 *  - A status it does not know is still made readable rather than dropped. A
 *    gateway is free to add one, and `rate_limited` shown as "Rate limited" is
 *    honest; hiding it would lose information the reader might need, and
 *    printing it raw is the thing this exists to stop.
 */
import { translatedStatus } from './status-words'

const KNOWN: Record<string, string> = {
  active: 'Active',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  complete: 'Complete',
  completed: 'Complete',
  done: 'Done',
  error: 'Failed',
  failed: 'Failed',
  failure: 'Failed',
  ok: 'Success',
  paused: 'Paused',
  pending: 'Waiting',
  queued: 'Waiting',
  running: 'Running',
  skipped: 'Skipped',
  success: 'Success',
  timeout: 'Timed out',
  timed_out: 'Timed out',
  waiting: 'Waiting'
}

/**
 * One raw status as a label, or null when there is nothing to say.
 *
 * Null rather than a placeholder: a caller that has a row to fill decides what
 * an absent status looks like, and that decision differs between a detail row
 * and a ledger line.
 */
export function humaniseStatus(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()

  if (!trimmed) {
    return null
  }

  const lower = trimmed.toLowerCase()
  // The reader's language first, the English table second. A status the
  // catalogue has no word for is still a status this app KNOWS, so it gets the
  // English label rather than falling through to the generic capitalisation
  // below — which would print a raw `timed_out` at somebody reading Dutch.
  const known = translatedStatus(lower) ?? KNOWN[lower]

  if (known) {
    return known
  }

  const words = trimmed.replace(/[_-]+/gu, ' ').trim()

  // `toLocaleUpperCase` rather than `toUpperCase`: the capitalisation of an
  // unknown status is the one place this function shapes a letter rather than
  // looking one up, and Turkish dotted i is the standing reminder that those
  // are not the same operation.
  return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : null
}
