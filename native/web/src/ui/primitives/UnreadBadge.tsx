import { unreadBadgeLabel } from '@hermie/transcript'
import type { ReactElement } from 'react'

import './primitives.css'

export interface UnreadBadgeProps {
  /** How many messages are unread; 0 with nothing counted draws a dot ("something is new"). */
  count: number
}

/** The unread marker: `3`, `99+`, or a dot. Decoration: the row says "N unread" in words. */
export function UnreadBadge({ count }: UnreadBadgeProps): ReactElement {
  return (
    <span aria-hidden="true" className="hm-badge" data-dot={count > 0 ? 'false' : 'true'}>
      {unreadBadgeLabel(count)}
    </span>
  )
}
