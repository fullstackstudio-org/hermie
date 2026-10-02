/**
 * Escape, delivered to whatever opened last.
 *
 * Escape arrives from the keyboard seam as one global event (see
 * `src/platform/keyboard-modifiers.ts`) with no notion of what is on screen, so
 * something has to decide who gets it. A stack does, and the rule is the one a
 * reader already expects from every other app: **the thing that opened last
 * closes first**. Mount order is registration order, and a sheet mounts after the
 * composer that is running a turn, so the sheet wins while it is up and the
 * composer gets Escape back when it closes.
 *
 * A handler that does nothing is a legitimate registration, and it is how a
 * blocking sheet works: ADR-0010 says an agent's question is answered by an
 * explicit tap, so Escape must neither dismiss it nor fall through to something
 * underneath it. Registering a no-op swallows the key, which is the whole
 * difference between "ignores Escape" and "is modal".
 *
 * One native subscription is held for the whole stack rather than one per
 * caller, because the event is global anyway and a listener per open sheet would
 * make the delivery order depend on the subscription order instead of on this.
 */
import { useEffect, useRef } from 'react'

import { subscribeToEscape } from '../platform/keyboard-modifiers'

type Entry = { fire: () => void }

const stack: Entry[] = []
let detach: (() => void) | null = null

function deliver(): void {
  stack[stack.length - 1]?.fire()
}

/**
 * Close one level, the way Escape does, from something that is not Escape.
 *
 * ⌘W is the only caller. The owner asked for it to close the overlay or the sheet
 * — "one level, like Esc" — and the honest way to make that true is for it to be
 * the same delivery rather than a second rule that agrees with this one until it
 * does not. Returns whether anything was registered to take it, so ⌘W on a bare
 * chat list can be a no-op rather than a mystery.
 */
export function closeTopmost(): boolean {
  if (!stack.length) {
    return false
  }

  deliver()

  return true
}

/**
 * Take Escape while `enabled`.
 *
 * `enabled` is the visibility of whatever is registering — a sheet that is
 * mounted, a popover that is showing, a turn that is running. Flipping it is what
 * pushes and pops, so a caller never has to think about ordering.
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  // The handler is read through a ref so that a new closure on every render does
  // not re-order the stack.
  const latest = useRef(handler)

  latest.current = handler

  useEffect(() => {
    if (!enabled) {
      return
    }

    const entry: Entry = { fire: () => latest.current() }

    stack.push(entry)

    if (stack.length === 1) {
      detach = subscribeToEscape(deliver)
    }

    return () => {
      const index = stack.lastIndexOf(entry)

      if (index >= 0) {
        stack.splice(index, 1)
      }

      if (stack.length === 0) {
        detach?.()
        detach = null
      }
    }
  }, [enabled])
}
