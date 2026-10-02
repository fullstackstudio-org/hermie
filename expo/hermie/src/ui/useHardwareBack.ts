/**
 * Android's back button, delivered to whatever opened last.
 *
 * The same shape as `useEscapeKey`, and deliberately NOT the same stack.
 *
 * Escape and Back look like the same idea and are not. Escape reaches a Mac
 * keyboard, where "stop the running turn" is a reasonable thing for it to do,
 * and `Composer` registers exactly that. Back is the only way out of a screen on
 * a phone, so routing it through the Escape stack would make a back press stop
 * generating instead of leaving the chat — a surface nobody asked to change.
 * Two stacks, each fed by the gesture that belongs to it.
 *
 * What this exists for is the gap measured on an emulator: a `Modal` consumes
 * the back press itself and answers `onRequestClose`, so every sheet in the app
 * was already correct. `OverlayPanel` is not a Modal — it is an absolutely
 * positioned view inside the wide layout — and nothing else handled the key, so
 * a back press on Activity, Crons or Settings left the app entirely instead of
 * closing the panel.
 *
 * The last-wins rule is what makes "one level" fall out: a sub page inside the
 * panel registers after the panel, so the first back returns to the list and the
 * second closes the panel. Mount order does the ordering, exactly as it does for
 * Escape.
 *
 * Returning `true` from the listener is what stops the press propagating, and it
 * is why an entry with nothing above it still has to be on the stack rather than
 * absent: a handler that runs is also a handler that swallows.
 */
import { useEffect, useRef } from 'react'
import { BackHandler } from 'react-native'

type Entry = { fire: () => void }

const stack: Entry[] = []
let subscription: { remove: () => void } | null = null

function deliver(): boolean {
  const top = stack[stack.length - 1]

  if (!top) {
    return false
  }

  top.fire()

  return true
}

/**
 * Take the hardware back press while `enabled`.
 *
 * `enabled` is the visibility of whatever is registering, so flipping it pushes
 * and pops and a caller never has to think about ordering. On every platform
 * without a back button this is inert: `BackHandler.addEventListener` is a no-op
 * whose subscription never fires.
 */
export function useHardwareBack(handler: () => void, enabled = true): void {
  // Read through a ref so a fresh closure per render does not re-order the stack.
  const latest = useRef(handler)

  latest.current = handler

  useEffect(() => {
    if (!enabled) {
      return
    }

    const entry: Entry = { fire: () => latest.current() }

    stack.push(entry)

    if (stack.length === 1) {
      subscription = BackHandler.addEventListener('hardwareBackPress', deliver)
    }

    return () => {
      const index = stack.lastIndexOf(entry)

      if (index >= 0) {
        stack.splice(index, 1)
      }

      if (stack.length === 0) {
        subscription?.remove()
        subscription = null
      }
    }
  }, [enabled])
}
