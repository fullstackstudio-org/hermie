/**
 * Consecutive bot-to-bot asides, rolled up.
 *
 * More than three bot-to-bot rows in a row become one line,
 * `5 messages with @writer · 4 replies`, that opens in place (the Expo app's
 * `dm-rollup.ts`, the Swift `TranscriptRowBuilder`). The run spans both
 * directions: since an inbound message and a dispatch are the same aside, an
 * answer in the middle of an errand does not break it in two.
 *
 * "Consecutive" is a question about what is visible: a hidden placeholder draws
 * nothing and does not break a run (it is left out, as the Swift builder leaves
 * it out), but a tool row does, because the reader can see it standing between
 * the asides.
 *
 * The roll-up is a row of the screen's own, like a date separator: a `status`
 * item under a `web:` kind the gateway cannot send, carrying its members. Its
 * id is the first member's, so opening it survives a fifth message joining the
 * run; its `version` is a hash over every member's id, version and
 * presentation, so the list's memo (`sameRow`) draws it again exactly when
 * something it shows changed.
 */
import type { BotDmInItem, BotDmOutItem, StatusItem, TranscriptItem, VisibleItem } from '@hermie/transcript'

/** More than this many asides in a row roll up. Three is the design's number. */
export const ROLLUP_THRESHOLD = 3

/** The status kind of a roll-up row. */
export const ROLLUP_ROW_KIND = 'web:dm-rollup'

export type BotDmRowItem = BotDmInItem | BotDmOutItem

/** A roll-up row: a `status` item that carries the asides it stands for. */
export interface DmRollupItem extends StatusItem {
  statusKind: typeof ROLLUP_ROW_KIND
  /** The asides, oldest first, each with the presentation the selectors gave it. */
  members: VisibleItem[]
  /** The single teammate the run is about, or undefined when it touched more than one. */
  handle?: string
  /** Dispatches in the run that were answered. */
  replies: number
}

export function isDmRow(item: TranscriptItem): item is BotDmRowItem {
  return item.kind === 'bot_dm_out' || item.kind === 'bot_dm_in'
}

export const isRollupRow = (item: TranscriptItem): item is DmRollupItem =>
  item.kind === 'status' && item.statusKind === ROLLUP_ROW_KIND

/** The teammate a row is about: the target of a dispatch, the sender of an inbound message. */
export function dmRunHandle(item: BotDmRowItem): string {
  return item.kind === 'bot_dm_out'
    ? (item.targetHandle || item.target).toLowerCase()
    : (item.senderHandle ?? item.senderName).toLowerCase()
}

const PRESENTATIONS: readonly VisibleItem['presentation'][] = ['full', 'collapsed', 'chip', 'hidden-placeholder']

/** FNV-1a over the members' ids, versions and presentations: the roll-up's change key. */
function stamp(members: readonly VisibleItem[]): number {
  let hash = 0x811c9dc5
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }

  for (const member of members) {
    mix(`${member.item.id}\u0000${member.item.version}\u0000${PRESENTATIONS.indexOf(member.presentation)}\u0001`)
  }

  return hash >>> 0
}

function rollupOf(run: readonly VisibleItem[]): VisibleItem {
  const head = run[0] as VisibleItem
  const items = run.map(member => member.item as BotDmRowItem)
  const handles = new Set(items.map(dmRunHandle))
  const item: DmRollupItem = {
    kind: 'status',
    statusKind: ROLLUP_ROW_KIND,
    id: `rollup:${head.item.id}`,
    seq: head.item.seq,
    origin: 'live',
    version: stamp(run),
    text: '',
    members: [...run],
    ...(handles.size === 1 ? { handle: dmRunHandle(items[0] as BotDmRowItem) } : {}),
    // Answered dispatches only: an inbound row is somebody else's message, not an answer to one of ours.
    replies: items.filter(member => member.kind === 'bot_dm_out' && member.reply && !member.reply.error).length,
    ...(head.item.ts === undefined ? {} : { ts: head.item.ts })
  }

  return { item, presentation: 'collapsed' }
}

/**
 * `visible` with every run of more than `ROLLUP_THRESHOLD` asides replaced by
 * one roll-up row. A list with no such run comes back as the same array.
 */
export function rollupDmRuns(visible: readonly VisibleItem[]): readonly VisibleItem[] {
  const out: VisibleItem[] = []
  // The rows of the run being walked, in order: its asides and the placeholders between them.
  let pending: VisibleItem[] = []
  let members: VisibleItem[] = []
  let rolled = false

  const flush = () => {
    if (members.length > ROLLUP_THRESHOLD) {
      out.push(rollupOf(members))
      rolled = true
    } else {
      out.push(...pending)
    }

    pending = []
    members = []
  }

  for (const row of visible) {
    if (isDmRow(row.item)) {
      pending.push(row)
      members.push(row)
      continue
    }

    // A placeholder draws nothing, so it does not break a run; a rolled-up run leaves it out.
    if (row.presentation === 'hidden-placeholder' && members.length > 0) {
      pending.push(row)
      continue
    }

    if (members.length > 0) {
      flush()
    }

    out.push(row)
  }

  if (members.length > 0) {
    flush()
  }

  return rolled ? out : visible
}
