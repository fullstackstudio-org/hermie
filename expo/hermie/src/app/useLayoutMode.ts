import { useEffect, useState } from 'react'
import { useWindowDimensions } from 'react-native'

import { traceSidebar, traceWidthSeen, traceWidthSettled } from '../dev/trace-layout'
import { resolveSidebarCollapsed, useChatLayoutStore } from '../store/chat-layout'
import { REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH, sidebarWidth } from '../ui/tokens'

export type LayoutMode = 'compact' | 'regular'

/**
 * `compact` is a single navigation stack (phone, narrow iPad split view);
 * `regular` is sidebar plus detail.
 *
 * The window's width decides, on every platform. A Mac window is the same
 * question as an iPad one — it is the same build (ADR-0011) — so a Mac gets the
 * sidebar shell at any usable window size and folds to the compact stack if it
 * is dragged narrower than two panes fit.
 *
 * The SETTLED width, like the other two answers, and this one is the report the
 * previous round missed. The collapse and the sidebar's width were both moved
 * onto a settled measurement and this was left on the live one — so a window
 * that reported 688pt for two frames during a full-screen transition swapped the
 * whole shell for the compact stack and back. Everything in `RegularShell` is
 * state: the temporary list overlay, which chat is selected, which panel is
 * open. A remount is not a sidebar closing, it is every one of those going at
 * once, which is what "it closes by itself" looks like from the outside.
 */
export function useLayoutMode(): LayoutMode {
  return useSettledWidth() >= REGULAR_LAYOUT_MIN_WIDTH ? 'regular' : 'compact'
}

/**
 * How wide the sidebar is in this window.
 *
 * A SECOND breakpoint, above the one that picks the shell, and the reason it is
 * not folded into `LayoutMode`: whether there are two panels and how wide the
 * first one is are different questions with different answers. Every window from
 * 700 to a Mac full screen is `regular`, and the 11" portrait end of that range
 * is where 344 stopped being a sidebar and started being a third of the screen.
 */
export function useSidebarWidth(): number {
  return sidebarWidth(useSettledWidth())
}

/**
 * How long a window width has to hold still before it counts as the window's
 * width.
 *
 * A resize animation, a sheet being presented and a Mac window coming back from
 * the background all walk `useWindowDimensions` through values the window never
 * really had. Two frames at 60Hz is 33ms, a UIKit sheet animation is ~300ms of
 * which only the first frames report anything odd; 150ms sits above the noise and
 * below anything a hand can do on a resize handle.
 */
const WIDTH_SETTLE_MS = 150

/**
 * The settled width, as ONE value for the whole app.
 *
 * It is module state rather than a hook's own state, and that is the second
 * thing the previous round got wrong. `useSettledWidth` was written with the
 * comment "the two questions must be asked of ONE number", and then every caller
 * got its own `useState` and its own timer — three independent settlings of the
 * same window, each seeded at whatever the width was when ITS component mounted.
 * A component that mounts during a transition therefore settles on the
 * transition's width and nothing ever tells it otherwise, because the width it
 * is watching has not changed since.
 *
 * One value, one timer, and every subscriber hears the same answer at the same
 * time.
 */
let settledWidth = 0
let pending: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(width: number) => void>()

/**
 * Take the first believable width as the starting point.
 *
 * Without this every caller's first render would answer 0 and the app would
 * spend 150ms as a compact shell before becoming itself. A width that is not a
 * real one — zero, negative, or the `NaN` a detached window has been seen to
 * report — seeds nothing, so the next render tries again.
 */
function seedWidth(width: number): number {
  if (!settledWidth && Number.isFinite(width) && width > 0) {
    settledWidth = width
  }

  return settledWidth || width
}

function proposeWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) {
    return
  }

  traceWidthSeen(width)

  if (pending) {
    clearTimeout(pending)
    pending = null
  }

  // Back to where it already was: whatever the window did in between, it did not
  // do it for long enough to be a width, and the timer that was going to believe
  // the intermediate value has just been cleared.
  if (width === settledWidth) {
    return
  }

  pending = setTimeout(() => {
    pending = null
    settledWidth = width
    traceWidthSettled(width)

    for (const listener of [...listeners]) {
      listener(width)
    }
  }, WIDTH_SETTLE_MS)
}

/**
 * The window's width, once it has stopped moving.
 *
 * This is the whole of "the sidebar collapsed by itself on the Mac". Nothing is
 * flipping: `resolveSidebarCollapsed` is a comparison against one number and a
 * still window cannot produce two answers. The number was the problem. A window
 * going to the background, a sheet being presented, a full-screen transition and
 * a live resize each push intermediate widths through `useWindowDimensions`, and
 * one of them dipping under a breakpoint for a frame is indistinguishable, to a
 * function that compares, from the owner dragging the window narrow.
 *
 * So the comparison is fed a width that HELD, and every question about the
 * layout is fed the same one.
 */
export function useSettledWidth(): number {
  const { width } = useWindowDimensions()
  const [settled, setSettled] = useState(() => seedWidth(width))

  useEffect(() => {
    listeners.add(setSettled)

    // A width that settled while this component was mounting is already the
    // answer; without this the component would keep its seed until the NEXT
    // change.
    if (settledWidth && settledWidth !== settled) {
      setSettled(settledWidth)
    }

    return () => {
      listeners.delete(setSettled)
    }
    // Once, on mount: `settled` is in the body above only to compare against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    proposeWidth(width)
  }, [width])

  return settled || width
}

/** Test seam: forget the window this process has been measuring. */
export function resetSettledWidth(): void {
  if (pending) {
    clearTimeout(pending)
    pending = null
  }

  settledWidth = 0
  listeners.clear()
}

/**
 * Whether the sidebar is collapsed right now, and whether hiding it at this width
 * means a rail or an overlay.
 *
 * Both answers come from the same window measurement, which is why they are one
 * hook: a shell that read the collapse from here and the band from somewhere else
 * would be two readings of one number.
 *
 * `overlays` is the second half of the owner's decision. Below 900pt the chat
 * column is the thing worth protecting, so asking for the list back must not push
 * the chat aside again — it lays the list OVER it and takes it away on the next
 * tap. At 900 and above there is room for both, so Show simply shows.
 */
export function useSidebarState(): { collapsed: boolean; overlays: boolean } {
  // The SETTLED width, not the live one. Everything the two answers are used for
  // is a panel appearing or disappearing, and neither should happen because a
  // window was mid-animation — see `useSettledWidth`.
  const width = useSettledWidth()
  const choice = useChatLayoutStore(state => state.sidebarCollapsed)
  const collapsed = resolveSidebarCollapsed(choice, width)

  useEffect(() => {
    traceSidebar(!collapsed, choice === undefined ? `width ${width}, no stored choice` : `stored choice: ${choice}`)
  }, [choice, collapsed, width])

  return { collapsed, overlays: width < SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH }
}
