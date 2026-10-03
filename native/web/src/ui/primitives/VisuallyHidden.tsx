import type { ReactElement, ReactNode } from 'react'

import './primitives.css'

/** Text for assistive technology that the eye does not need (the row's "Online", "3 unread"). */
export function VisuallyHidden({ children }: { children: ReactNode }): ReactElement {
  return <span className="hm-sr">{children}</span>
}
