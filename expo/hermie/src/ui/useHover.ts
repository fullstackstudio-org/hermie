/**
 * Is the pointer over this control?
 *
 * React Native 0.81 delivers `onPointerEnter` / `onPointerLeave` on every view, on
 * every platform — they simply never fire where there is no pointer. So this needs
 * no platform check: on a phone `hovered` is false forever and the branch it feeds
 * costs one boolean.
 *
 * A hook rather than a copied `useState` pair, because the same three lines were
 * about to appear in a dozen components and a hover that is spelled differently in
 * two of them is a hover that behaves differently in two of them.
 *
 * `props` is spread onto the control; `hovered` picks the surface. Deliberately not
 * a render-prop or a wrapper component: a wrapper would add a view to every row in
 * the transcript, and the whole point is that hover is nearly free.
 */
import { useState } from 'react'

export interface Hover {
  hovered: boolean
  props: { onPointerEnter: () => void; onPointerLeave: () => void }
}

export function useHover(): Hover {
  const [hovered, setHovered] = useState(false)

  return {
    hovered,
    props: {
      onPointerEnter: () => setHovered(true),
      // Never conditional on anything: a pointer that leaves while the view is
      // mid-update must still clear the highlight, or the row stays lit forever.
      onPointerLeave: () => setHovered(false)
    }
  }
}
