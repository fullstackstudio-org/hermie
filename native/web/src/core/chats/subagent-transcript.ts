/**
 * A subagent's transcript, as the Agents panel reads it (`features/chat/AgentsBar.tsx`).
 *
 * Two sources, kept apart on purpose. `subagent.tail` is a LIVE tail that stops existing when the child does, and
 * `session.history` under the child's own session id is the stored transcript that outlives it. A reader who cannot
 * tell which one they are looking at cannot tell whether "nothing new" means finished or disconnected, so the panel
 * says which it is.
 *
 * Which one is read follows the child: a child that is running (or has no session of its own to read) is tailed,
 * and once it has finished the stored transcript is read once and left alone, because a finished session does not
 * change. `subagent.tail` is a tail, not a subscription, so a running child's output only moves if something asks:
 * `SUBAGENT_TAIL_POLL_MS` is the cadence, and the poll stops the moment the child does.
 */
import type { Subagent, TranscriptItem } from '@hermie/transcript'

/** How often the open transcript of a running child is read again. */
export const SUBAGENT_TAIL_POLL_MS = 3_000

export type TranscriptSource = 'tail' | 'stored'

/** A child that is not finished: it can still be steered and stopped, and its tail is live. */
export const isLiveSubagent = (child: Pick<Subagent, 'status'>): boolean =>
  child.status === 'running' || child.status === 'queued'

/** Where a child's transcript is read from right now. */
export function transcriptSource(child: Pick<Subagent, 'status' | 'childSessionId'>): TranscriptSource {
  return isLiveSubagent(child) || !child.childSessionId ? 'tail' : 'stored'
}

/** One stored transcript row as a plain line, for the read-only child view. A kind with nothing to say is empty. */
export function transcriptLine(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return item.text ? `> ${item.text}` : ''
    case 'assistant':
      return item.text ?? ''
    case 'tool':
      return `· ${item.context || item.summary || item.name}`
    default:
      return ''
  }
}

/** A stored child transcript as the text the panel shows: one line a row, empty rows left out. */
export const transcriptText = (items: readonly TranscriptItem[]): string =>
  items.map(transcriptLine).filter(Boolean).join('\n')

/** The earliest start among running children, in epoch milliseconds; `undefined` when none has one. */
export function oldestStartMs(children: readonly Pick<Subagent, 'startedAt'>[]): number | undefined {
  const starts = children.map(child => child.startedAt).filter(value => value > 0)

  return starts.length > 0 ? Math.min(...starts) : undefined
}
