/**
 * Which bubbles belong together, and where a date stamp goes.
 *
 * A pure pass over the visible items, done once per render of the list rather
 * than guessed at by each row. That matters for one reason above the others: the
 * tail is drawn only on the LAST bubble of a group (§6.1), and "last" is a fact
 * about the item's neighbours, which a row cannot see.
 *
 * Only speech groups. A tool row, a cron card or a bot-to-bot line between two
 * replies ends the run — the reply after it is a new thought, and drawing it as a
 * continuation of the one before the machinery would be a lie about the order
 * things happened in.
 */
import type { TranscriptItem, VisibleItem } from './types'

/** How far apart two turns from one sender may be and still read as one run. */
export const GROUP_WINDOW_SECONDS = 300

export interface RowLayout {
  /** Continues the run above it: tighter gap, squarer top corner. */
  grouped: boolean
  /** Last of its run, so it carries the tail. */
  tail: boolean
  /**
   * Follows another bot-to-bot aside BETWEEN THE SAME PAIR.
   *
   * Not `grouped`: bot-to-bot traffic is not speech, so it has no tail and no
   * corner to tuck. It does have a rhythm of its own — nine points between
   * consecutive asides instead of a turn gap — and that is the only thing this
   * says.
   *
   * "The same pair" is what makes it tight rather than merely consecutive. A
   * dispatch to @writer followed by one to @builder is two separate errands, and
   * running them together reads as one exchange that never happened. Both
   * directions count: a message out and the answer coming back in are the two
   * halves of one exchange, and the gap between them is the thing the owner
   * asked to close.
   */
  ledgerRun: boolean
  /** A date stamp belongs directly ABOVE this row. */
  dateStamp?: string
}

/**
 * The speaker a bubble belongs to, or `null` for anything that is not speech.
 *
 * A human turn whose author is not yet known (`unknownAuthor`, a turn somebody
 * else started in this session) is deliberately its own key: grouping it with
 * the owner's own bubbles would claim it was theirs.
 *
 * `ownAuthorId` is the reader's own identity, `<provider>:<user_id>` exactly
 * as the gateway spelled it — and it is also the whole of the attribution
 * gate (HERM-83, D6). A caller passes it only where a row's `author` may be
 * trusted and shown at all (the group chat, with the reader's own identity
 * known); everywhere else it is left `undefined`, which is what keeps a
 * personal sub-chat, a branch and a retired conversation drawing exactly as
 * they did before this field existed — every `user` row its own silhouette,
 * `author` or not. With it, a row whose author is not the reader keys its OWN
 * run by identity (`user:<id>`) rather than folding into `'own'`, which is
 * what lets two people alternating in the group chat break each other's runs.
 */
export function speakerKey(item: TranscriptItem, ownAuthorId?: string): string | null {
  switch (item.kind) {
    case 'user':
      if (item.unknownAuthor) {
        return 'foreign'
      }

      if (ownAuthorId && item.author) {
        return item.author.id === ownAuthorId ? 'own' : `user:${item.author.id}`
      }

      return 'own'
    case 'assistant':
      // An interim note and the answer are the same bot, but the note is muted
      // and the answer is not, so a run that mixes them reads as a rendering
      // bug. They stay apart.
      if (item.interim) {
        return 'bot-interim'
      }

      // A reply addressed at a teammate bot is its own turn, not a continuation
      // of the one before it: it carries the "REPLY TO @handle" eyebrow, and an
      // eyebrow is a heading. Grouped, it was drawn 3pt under the previous
      // bubble's bottom edge with nothing between them, which is what the owner
      // read as jammed. Keyed by the HANDLE so two consecutive replies to the
      // same teammate still group — and then only the first of that run carries
      // the eyebrow, which is the point of having one.
      return item.replyToBotHandle ? `bot-reply:${item.replyToBotHandle}` : 'bot'
    default:
      /*
        A bot-to-bot row is deliberately NOT a speaker.

        It used to key on `dm:<handle>`, which grouped consecutive inbound DMs
        into one run of bubbles — correct while an inbound DM WAS a bubble, and
        a lie now that it is an aside. An aside has no tail to withhold and no
        corner to tuck, so a speaker key would only make `layoutRows` promise a
        silhouette nothing draws. Their spacing is `ledgerRun`'s answer instead.
      */
      return null
  }
}

/** `Today`, `Yesterday`, `Tue 16 September`, `16 September 2025`. */
export function dateStampFor(unixSeconds: number, now = Date.now() / 1000): string {
  const date = new Date(unixSeconds * 1000)
  const today = new Date(now * 1000)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const daysApart = Math.round((startOfToday - startOfDate) / 86_400_000)

  if (daysApart === 0) {
    return 'Today'
  }

  if (daysApart === 1) {
    return 'Yesterday'
  }

  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' })
  const dayMonth = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

  return daysApart < 7
    ? `${weekday} ${dayMonth}`
    : date.getFullYear() === today.getFullYear()
      ? dayMonth
      : `${dayMonth} ${date.getFullYear()}`
}

/**
 * Lay out the whole visible list.
 *
 * Indexed by item id rather than by position, so the caller can reverse the
 * array for an inverted `FlatList` without the layout going with it.
 *
 * `ownAuthorId` is `speakerKey`'s own gate, passed through unchanged: absent
 * everywhere but the group chat with the reader's identity known (HERM-83, D6).
 */
export function layoutRows(
  entries: readonly VisibleItem[],
  now = Date.now() / 1000,
  ownAuthorId?: string
): Record<string, RowLayout> {
  const layout: Record<string, RowLayout> = {}
  let lastStamp: string | undefined

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]

    if (!entry) {
      continue
    }

    const item = entry.item
    const key = speakerKey(item, ownAuthorId)

    // A hidden row is not on the screen, so it must not break a run either —
    // otherwise turning Quiet on would visibly re-group the conversation.
    const previous = previousVisible(entries, index)
    const next = nextVisible(entries, index)

    const grouped =
      key !== null &&
      previous !== undefined &&
      speakerKey(previous, ownAuthorId) === key &&
      withinWindow(previous.ts, item.ts)

    const tail =
      key === null || next === undefined || speakerKey(next, ownAuthorId) !== key || !withinWindow(item.ts, next.ts)

    const pair = dmPairKey(item)
    const ledgerRun = pair !== null && previous !== undefined && dmPairKey(previous) === pair

    // A hidden row draws nothing, so it must not swallow the day's stamp either:
    // the stamp passes to the first row of that day the reader can actually see.
    const stamp = entry.presentation === 'hidden-placeholder' || !item.ts ? undefined : dateStampFor(item.ts, now)
    const dateStamp = stamp && stamp !== lastStamp ? stamp : undefined

    if (stamp) {
      lastStamp = stamp
    }

    layout[item.id] = { grouped, ledgerRun, tail, ...(dateStamp ? { dateStamp } : {}) }
  }

  return layout
}

/**
 * The teammate a bot-to-bot row is about, or `null` for anything that is not one.
 *
 * One key for both directions, because a dispatch to @writer and @writer's
 * answer are one exchange: keying them apart would put a turn gap in the middle
 * of the pair the reader is trying to read as a pair.
 */
function dmPairKey(item: TranscriptItem): string | null {
  switch (item.kind) {
    case 'bot_dm_out':
      return `dm:${item.targetHandle || item.target.toLowerCase()}`
    case 'bot_dm_in':
      return `dm:${item.senderHandle ?? item.senderName.toLowerCase()}`
    default:
      return null
  }
}

function withinWindow(before: number | undefined, after: number | undefined): boolean {
  // No stamp on either side means nothing to disprove the run. History rows from
  // a gateway that persisted no timestamps would otherwise never group at all.
  if (before === undefined || after === undefined) {
    return true
  }

  return Math.abs(after - before) <= GROUP_WINDOW_SECONDS
}

function previousVisible(entries: readonly VisibleItem[], index: number): TranscriptItem | undefined {
  for (let probe = index - 1; probe >= 0; probe -= 1) {
    const entry = entries[probe]

    if (entry && entry.presentation !== 'hidden-placeholder') {
      return entry.item
    }
  }

  return undefined
}

function nextVisible(entries: readonly VisibleItem[], index: number): TranscriptItem | undefined {
  for (let probe = index + 1; probe < entries.length; probe += 1) {
    const entry = entries[probe]

    if (entry && entry.presentation !== 'hidden-placeholder') {
      return entry.item
    }
  }

  return undefined
}
