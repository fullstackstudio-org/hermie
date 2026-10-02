/**
 * Consecutive bot-to-bot asides, rolled up.
 *
 * §6.6: a collapsed bot-to-bot row is a LINE, not a bubble and not a pill, and
 * more than three in a row roll up into `5 messages with @writer · 4 replies`,
 * which expands in place.
 *
 * The run spans BOTH DIRECTIONS. It used to gather only dispatches, which was
 * true while an inbound message was a bubble — a bubble is not part of a run of
 * lines — and became wrong the moment both directions turned into the same aside.
 * An exchange of eight rows then rolled up as two runs of four with an answer
 * standing between them, and a single answer in the middle of a long errand broke
 * the run in half. Consecutive asides are one group, whichever way each of them
 * went.
 *
 * This is the whole rule as one pure function over the visible list, for two
 * reasons. A row cannot see its neighbours, so it cannot know it is the fourth of
 * a run. And "consecutive" is a question about what is VISIBLE: a hidden
 * placeholder between two rows does not break the run, but a tool row does — the
 * reader can see the tool row, so the asides are not adjacent on screen.
 */
import type { BotDmInItem, BotDmOutItem, TranscriptItem, VisibleItem } from './types'

/** More than this many in a row roll up. Three is the mockup's number. */
export const ROLLUP_THRESHOLD = 3

export type BotDmRowItem = BotDmInItem | BotDmOutItem

export interface DmRun {
  /** The id the roll-up's own disclosure state is keyed on: the first line's. */
  id: string
  items: BotDmRowItem[]
  /** The single counterpart, or undefined when the run involved more than one. */
  handle?: string
  replies: number
}

/**
 * How one outgoing DM row is drawn: on its own, or swallowed by a roll-up.
 *
 * `rollupHead` carries the run so the row that renders it does not have to walk
 * the list a second time; `rollupMember` rows render nothing while the roll-up is
 * collapsed, and render their own line once it is expanded.
 */
export type DmRowRole = { role: 'line' } | { role: 'rollupHead'; run: DmRun } | { role: 'rollupMember'; runId: string }

export function isDmOut(item: TranscriptItem): item is BotDmOutItem {
  return item.kind === 'bot_dm_out'
}

/** A bot-to-bot aside, either direction: the rows a run is made of. */
export function isDmRow(item: TranscriptItem): item is BotDmRowItem {
  return item.kind === 'bot_dm_out' || item.kind === 'bot_dm_in'
}

/**
 * The teammate a row is about: the target of a dispatch, the sender of an inbound
 * message. A run naming one of them can say so; a run that touched two cannot.
 */
export function dmRunHandle(item: BotDmRowItem): string {
  return item.kind === 'bot_dm_out'
    ? item.targetHandle || item.target.toLowerCase()
    : (item.senderHandle ?? item.senderName.toLowerCase())
}

/**
 * A reply that actually came back.
 *
 * `reply` with an `error` on it is a failure, not an answer — counting it would
 * make `5 messages · 5 replies` out of five failures.
 */
export function hasReply(item: BotDmOutItem): boolean {
  return Boolean(item.reply && !item.reply.error)
}

/** Index every bot-to-bot row in the visible list by how it should be drawn. */
export function rollupDmRuns(entries: readonly VisibleItem[]): Record<string, DmRowRole> {
  const roles: Record<string, DmRowRole> = {}
  let run: BotDmRowItem[] = []

  const flush = () => {
    if (run.length === 0) {
      return
    }

    if (run.length <= ROLLUP_THRESHOLD) {
      for (const item of run) {
        roles[item.id] = { role: 'line' }
      }

      run = []

      return
    }

    const head = run[0]

    if (!head) {
      run = []

      return
    }

    const handles = new Set(run.map(dmRunHandle))

    roles[head.id] = {
      role: 'rollupHead',
      run: {
        id: head.id,
        items: [...run],
        ...(handles.size === 1 ? { handle: dmRunHandle(head) } : {}),
        // Answered dispatches only. An inbound row is somebody else's message,
        // not an answer to one of ours, and counting it would make `6 messages ·
        // 6 replies` out of three errands nobody has come back on.
        replies: run.filter(item => isDmOut(item) && hasReply(item)).length
      }
    }

    for (const item of run.slice(1)) {
      roles[item.id] = { role: 'rollupMember', runId: head.id }
    }

    run = []
  }

  for (const entry of entries) {
    if (entry.presentation === 'hidden-placeholder') {
      continue
    }

    if (isDmRow(entry.item)) {
      run.push(entry.item)

      continue
    }

    flush()
  }

  flush()

  return roles
}
