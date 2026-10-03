import type { ReactElement } from 'react'

import './primitives.css'

/** What a bead can say, in the order of how badly each wants the reader. */
export type PresenceState = 'online' | 'working' | 'needsInput' | 'offline'

export interface PresenceBeadProps {
  state: PresenceState
  /** `inline` is the small one that stands in a line of text. */
  size?: 'avatar' | 'inline'
}

/**
 * One bead, four states (the shapes are in `primitives.css`). Decoration: the
 * state is said in words wherever a bead is drawn, so a bead alone is hidden
 * from assistive technology.
 */
export function PresenceBead({ state, size = 'avatar' }: PresenceBeadProps): ReactElement {
  return <span aria-hidden="true" className="hm-bead" data-state={state} data-size={size} />
}
