/**
 * A transient one-liner from `status.update`: compaction, a goal, a process.
 *
 * Weather, not a message: centred and quiet, as a chip (the latest one while
 * something runs) or, at the verbose level, with its kind above it. The text is
 * the gateway's and is shown as characters.
 */
import type { StatusItem } from '@hermie/transcript'
import { memo } from 'react'

import { type RowViewProps, sameRowView } from './row-view'

function StatusRowView({ item, presentation }: RowViewProps<StatusItem>) {
  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return (
      <p className="hm-chip" data-kind="status">
        {item.text}
      </p>
    )
  }

  return (
    <div className="hm-aside" data-kind="status">
      <p className="hm-aside__eyebrow">{item.statusKind.replace(/[._-]+/gu, ' ')}</p>
      <p className="hm-aside__text">{item.text}</p>
    </div>
  )
}

export const StatusRow = memo(StatusRowView, sameRowView)
