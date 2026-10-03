/**
 * From what `visibleItems` returned to the rows the list draws.
 *
 * Five things the engine's selectors do not do, because they are about the
 * screen and not about a transcript:
 *
 *  - **Roll-ups.** More than three bot-to-bot asides in a row become one row
 *    that opens in place (`dm-rollup.ts`), before anything else here looks at
 *    the list: a roll-up opens a day like the aside it starts with.
 *  - **Date separators.** A day's first row gets a separator row in front of it.
 *    It is a row of its own (not a decoration on the item), because the list
 *    memoises a row on its item's id and version, and whether a row opens a day
 *    depends on its neighbour: a page of older history landing in front of a
 *    day's first row must take that day's separator away from it, and an item
 *    whose version did not change would never be drawn again to do so. A
 *    separator's key names the day AND the row it opens, so it is a different
 *    row (and the old one is a row that went away) exactly when that changes.
 *  - **The status line only while busy.** The selectors keep the latest status
 *    as a chip; a "compacting" line that is still there an hour after the work
 *    ended is stale. It is shown while something runs.
 *  - **The typing row.** The reply is coming and nothing of it is on screen yet:
 *    the turn runs and the last thing drawn is the reader's own message. Once a
 *    reply exists its own bubble holds the dots (`AssistantBubble`), so the two
 *    are never drawn at once.
 *  - **The tool being written.** The bot named the tool it is writing a call to
 *    (`tool.generating`, `turn.draftingTool`) and the call has no row yet: one
 *    row at the tail says so (`ToolGenerating`), in the typing row's place. Its
 *    id carries the name, so a second name is a new row rather than an old row
 *    the list's memo would never draw again.
 *
 * Separator, typing and tool-being-written rows are `status` items under a `web:`
 * kind the gateway cannot send, so the item union stays closed and `ChatItem` can
 * tell them from the engine's own by that kind alone.
 */
import type { StatusItem, TranscriptItem, VisibleItem } from '@hermie/transcript'

import { rollupDmRuns } from './dm-rollup'

/** The status kind of a date separator row. */
export const DATE_ROW_KIND = 'web:date'

/** The status kind of the typing row. */
export const TYPING_ROW_KIND = 'web:typing'

/** The typing row's id; there is at most one. */
export const TYPING_ROW_ID = 'web:typing'

/** The status kind of the row that names the tool the bot is writing a call to; its `text` is the name. */
export const GENERATING_ROW_KIND = 'web:generating'

const DAY_MS = 86_400_000

/** A calendar day in the reader's own time zone, as a sortable number (`20261003`). */
export function dayKeyOf(date: Date): number {
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
}

/** The local midnight that starts the day `ms` falls in. */
function startOfDay(ms: number): number {
  const date = new Date(ms)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const syntheticStatus = (
  id: string,
  statusKind: string,
  seq: number,
  ts: number | undefined,
  text: string
): VisibleItem => {
  const item: StatusItem = {
    kind: 'status',
    id,
    seq,
    origin: 'live',
    version: 0,
    statusKind,
    text,
    ...(ts === undefined ? {} : { ts })
  }

  return { item, presentation: 'full' }
}

export const isDateRow = (item: TranscriptItem): item is StatusItem =>
  item.kind === 'status' && item.statusKind === DATE_ROW_KIND

export const isTypingRow = (item: TranscriptItem): item is StatusItem =>
  item.kind === 'status' && item.statusKind === TYPING_ROW_KIND

export const isGeneratingRow = (item: TranscriptItem): item is StatusItem =>
  item.kind === 'status' && item.statusKind === GENERATING_ROW_KIND

/** Whether a row draws nothing at all, so it neither opens a day nor counts as "the last thing". */
const drawsNothing = (row: VisibleItem): boolean => row.presentation === 'hidden-placeholder'

export interface RowOptions {
  /** Something is running (`isBusy`): a status line may be shown. */
  busy: boolean
  /** The turn itself is running (`chat.turn.active`): the typing row may be shown. */
  turnActive: boolean
  /** The tool the bot named before its call exists (`chat.turn.draftingTool`). */
  draftingTool?: string | undefined
}

/**
 * The rows of the list. `text` of a separator row is its day's key; the view
 * turns it into words in the reader's language.
 */
export function transcriptRows(visible: readonly VisibleItem[], options: RowOptions): VisibleItem[] {
  const rows: VisibleItem[] = []
  // The day being walked: most rows are in the same one as the row before.
  let dayStart = Number.NaN
  let dayEnd = Number.NaN
  // The day the last separator named: a row stamped out of order (an optimistic
  // bubble's own clock, a history row with a later stamp before it) never opens a day twice.
  let lastDay = Number.NaN
  let lastDrawn: VisibleItem | undefined

  for (const row of rollupDmRuns(visible)) {
    if (row.item.kind === 'status' && row.presentation === 'chip' && !options.busy) {
      continue
    }

    const ts = row.item.ts

    if (ts !== undefined && ts > 0 && !drawsNothing(row)) {
      const ms = ts * 1000

      if (!(ms >= dayStart && ms < dayEnd)) {
        // Stepped by a day from the local midnight; DST makes a day 23 or 25 hours, so the
        // end is the next midnight and not `start + DAY_MS`.
        dayStart = startOfDay(ms)
        dayEnd = startOfDay(dayStart + DAY_MS * 1.5)

        const day = dayKeyOf(new Date(ms))

        if (day !== lastDay) {
          lastDay = day
          rows.push(syntheticStatus(`date:${day}:${row.item.id}`, DATE_ROW_KIND, row.item.seq, ts, String(day)))
        }
      }
    }

    rows.push(row)

    if (!drawsNothing(row)) {
      lastDrawn = row
    }
  }

  const drafting = options.draftingTool?.trim()

  if (options.turnActive && drafting) {
    rows.push(
      syntheticStatus(
        `${GENERATING_ROW_KIND}:${drafting}`,
        GENERATING_ROW_KIND,
        Number.MAX_SAFE_INTEGER,
        undefined,
        drafting
      )
    )
  } else if (options.turnActive && (lastDrawn === undefined || lastDrawn.item.kind === 'user')) {
    rows.push(syntheticStatus(TYPING_ROW_ID, TYPING_ROW_KIND, Number.MAX_SAFE_INTEGER, undefined, ''))
  }

  return rows
}
