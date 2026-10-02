/**
 * A trace of every width the window claimed to be, and of every change of the
 * sidebar that followed one.
 *
 * **Why this is in the repository rather than in a scratch patch.** The bug it
 * exists for — the sidebar closing itself on the Mac — has been reasoned about
 * twice and fixed twice, and it is still being reported. It leaves nothing
 * behind that a screenshot or a state dump can show: by the time anyone looks,
 * the window is back to the width it was supposed to have all along and the only
 * evidence is a panel that is not there. The one thing that would settle it is a
 * list of the widths the window actually reported, in order, with what each one
 * did to the layout. That is what this prints.
 *
 * Turn it on with `--hermieTraceLayout`:
 *
 * ```sh
 * xcrun simctl launch <udid> dev.hermie.app \
 *   --hermieGateway http://localhost:9119 --hermieToken demo \
 *   --hermieTraceLayout
 * ```
 *
 * ```
 * [width] +1284 saw 1366.0
 * [width] +1520 saw 688.0            ← a transition, not a resize
 * [width] +1602 saw 1366.0
 * [width] +1752 settled 1366.0       ← 688 never settled, so nothing moved
 * [sidebar] +1752 open  (width 1366, no stored choice)
 * ```
 *
 * When it is off it costs one boolean test per width change, and in a production
 * bundle nothing at all: `TRACING` folds through the same `__DEV__` gate
 * `trace-scroll.ts` documents and measures.
 */
import { DEV_LAUNCH_INTENT } from './launch-intent'

export const TRACING_LAYOUT: boolean = __DEV__ && DEV_LAUNCH_INTENT?.traceLayout === true

let origin = 0

function stamp(): string {
  const now = Date.now()

  if (!origin) {
    origin = now
  }

  return `+${Math.round(now - origin)}`
}

/** One width the window reported, before anything has decided what it means. */
export function traceWidthSeen(width: number): void {
  if (!TRACING_LAYOUT) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[width] ${stamp()} saw ${width.toFixed(1)}`)
}

/** One width that held still long enough to be believed. */
export function traceWidthSettled(width: number): void {
  if (!TRACING_LAYOUT) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[width] ${stamp()} settled ${width.toFixed(1)}`)
}

/**
 * The sidebar's state, and WHY it is that.
 *
 * The reason is the whole point of the line. "Closed" on its own is what the
 * owner can already see; whether it is closed because they asked for it or
 * because some transition reported a narrow window for a moment is the question
 * three rounds have failed to answer from the outside.
 */
export function traceSidebar(open: boolean, reason: string): void {
  if (!TRACING_LAYOUT) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[sidebar] ${stamp()} ${open ? 'open ' : 'closed'} (${reason})`)
}
